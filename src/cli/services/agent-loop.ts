/**
 * Agent Loop — local-first agentic CLI with server tool support
 *
 * LLM calls proxy through the `agent-proxy` edge function (server holds API key).
 * User authenticates via Supabase JWT. Local tools execute on the client.
 * Server tools execute via direct import of executeTool() (same codebase).
 *
 * Fallback: if proxy is unavailable and ANTHROPIC_API_KEY is set, calls directly.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  LOCAL_TOOL_DEFINITIONS,
  executeLocalTool,
  isLocalTool,
} from "./local-tools.js";
import { loadConfig } from "./config-store.js";
import { getValidToken, SUPABASE_URL } from "./auth-service.js";
import {
  isServerTool,
  loadServerToolDefinitions,
  executeServerTool,
  getServerStatus,
  type ServerStatus,
} from "./server-tools.js";
import {
  nextTurn,
  createTurnContext,
  logSpan,
} from "./telemetry.js";

// ============================================================================
// TYPES
// ============================================================================

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolStart: (name: string) => void;
  onToolResult: (name: string, success: boolean, result: unknown, input?: Record<string, unknown>, durationMs?: number) => void;
  onUsage: (input_tokens: number, output_tokens: number) => void;
  onDone: (finalMessages: Anthropic.MessageParam[]) => void;
  onError: (error: string) => void;
}

export interface AgentLoopOptions {
  message: string;
  conversationHistory: Anthropic.MessageParam[];
  callbacks: AgentLoopCallbacks;
  abortSignal?: AbortSignal;
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

const LOCAL_TOOLS_DESC = `You have access to local tools for working with the user's filesystem and running commands:
- read_file: Read file contents
- write_file: Write/create files
- edit_file: Make targeted edits (find and replace)
- list_directory: List files and folders
- search_files: Find files by glob pattern
- search_content: Search file contents (like grep)
- run_command: Execute shell commands`;

const SERVER_TOOLS_DESC = `You also have server tools for managing the business:
- inventory: Adjust, set, transfer stock (actions: adjust, set, transfer, bulk_adjust, bulk_set, bulk_clear)
- inventory_query: Query stock levels (actions: summary, velocity, by_location, in_stock)
- inventory_audit: Audit workflow (actions: start, count, complete, summary)
- purchase_orders: Manage POs (actions: create, list, get, add_items, approve, receive, cancel)
- transfers: Transfer between locations (actions: create, list, get, receive, cancel)
- products: Find/create/update products (actions: find, create, update, pricing_templates)
- collections: Manage collections (actions: find, create, get_theme, set_theme, set_icon)
- customers: Manage customers (actions: find, create, update)
- analytics: Sales analytics (actions: summary, by_location, detailed, discover, employee)
- orders: Find/get orders (actions: find, get)
- locations: List store locations
- suppliers: Find suppliers
- email: Send/manage email (actions: send, send_template, list, get, templates, inbox, inbox_get, inbox_reply, inbox_update, inbox_stats)
- documents: Generate documents (COAs)
- alerts: System alerts (low stock, pending orders)
- audit_trail: View audit logs

Server tools use an "action" parameter to select the operation.`;

function buildSystemPrompt(hasServerTools: boolean): string {
  let prompt = `You are whale, a CLI AI assistant similar to Claude Code.\n\n${LOCAL_TOOLS_DESC}`;
  if (hasServerTools) {
    prompt += `\n\n${SERVER_TOOLS_DESC}`;
  }
  prompt += `\n\nBe concise and direct. When the user asks you to do something, use the tools to do it — don't just explain how. Show relevant output but keep responses short.`;
  return prompt;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

async function getTools(): Promise<{ tools: Anthropic.Tool[]; serverToolCount: number }> {
  const localTools: Anthropic.Tool[] = LOCAL_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  let serverTools: Anthropic.Tool[] = [];
  try {
    serverTools = await loadServerToolDefinitions();
  } catch {
    // Server tools silently unavailable
  }

  return {
    tools: [...localTools, ...serverTools],
    serverToolCount: serverTools.length,
  };
}

/** Exposed for /status command */
export async function getServerToolCount(): Promise<number> {
  try {
    const defs = await loadServerToolDefinitions();
    return defs.length;
  } catch {
    return 0;
  }
}

/** Exposed for /mcp command */
export { getServerStatus, type ServerStatus };

// ============================================================================
// PROXY URL
// ============================================================================

const PROXY_URL = `${SUPABASE_URL}/functions/v1/agent-proxy`;
const MAX_TURNS = 25;
const MODEL = "claude-sonnet-4-20250514";

// ============================================================================
// SSE STREAM PARSER — parses `data: {...}\n\n` events from the proxy
// ============================================================================

async function* parseSSE(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload);
        } catch { /* skip bad JSON */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// STREAM VIA DIRECT ANTHROPIC (fallback when proxy unavailable)
// ============================================================================

async function* streamDirect(
  apiKey: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  systemPrompt: string,
  signal?: AbortSignal
): AsyncGenerator<any> {
  const anthropic = new Anthropic({ apiKey });
  const stream = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    tools,
    messages,
    stream: true,
  });

  for await (const event of stream) {
    if (signal?.aborted) break;
    yield event;
  }
}

// ============================================================================
// PROCESS STREAM EVENTS — shared between proxy and direct
// ============================================================================

interface StreamResult {
  text: string;
  toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  totalIn: number;
  totalOut: number;
}

async function processStreamEvents(
  events: AsyncGenerator<any>,
  callbacks: AgentLoopCallbacks,
  signal?: AbortSignal
): Promise<StreamResult> {
  let text = "";
  const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  let currentToolUse: { id: string; name: string; input: string } | null = null;
  let totalIn = 0;
  let totalOut = 0;

  for await (const event of events) {
    if (signal?.aborted) break;

    switch (event.type) {
      case "content_block_start":
        if (event.content_block?.type === "tool_use") {
          currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: "" };
          callbacks.onToolStart(event.content_block.name);
        }
        break;

      case "content_block_delta":
        if (event.delta?.type === "text_delta") {
          text += event.delta.text;
          callbacks.onText(event.delta.text);
        } else if (event.delta?.type === "input_json_delta" && currentToolUse) {
          currentToolUse.input += event.delta.partial_json;
        }
        break;

      case "content_block_stop":
        if (currentToolUse) {
          try {
            toolUseBlocks.push({
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: JSON.parse(currentToolUse.input || "{}"),
            });
          } catch { /* skip bad JSON */ }
          currentToolUse = null;
        }
        break;

      case "message_start":
        if (event.message?.usage) totalIn += event.message.usage.input_tokens;
        break;

      case "message_delta":
        if (event.usage) totalOut += event.usage.output_tokens;
        break;
    }
  }

  return { text, toolUseBlocks, totalIn, totalOut };
}

// ============================================================================
// GET EVENT STREAM — tries proxy first, falls back to direct
// ============================================================================

async function getEventStream(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  systemPrompt: string,
  signal?: AbortSignal
): Promise<AsyncGenerator<any>> {
  // Try proxy with JWT
  const token = await getValidToken();
  if (token) {
    try {
      const response = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages,
          system: systemPrompt,
          tools,
          model: MODEL,
          max_tokens: 8192,
          stream: true,
        }),
        signal,
      });

      if (response.ok) {
        return parseSSE(response, signal);
      }

      // If 404 (not deployed), fall through to direct
      if (response.status !== 404) {
        const body = await response.text();
        throw new Error(`Proxy error (${response.status}): ${body}`);
      }
    } catch (err: any) {
      // Network errors or non-404 proxy errors
      if (err.message && !err.message.includes("404")) {
        throw err;
      }
    }
  }

  // Fallback: direct Anthropic (if user has API key)
  const apiKey = process.env.ANTHROPIC_API_KEY || loadConfig().anthropic_api_key;
  if (apiKey) {
    return streamDirect(apiKey, messages, tools, systemPrompt, signal);
  }

  throw new Error(
    token
      ? "Proxy unavailable and no ANTHROPIC_API_KEY set. Deploy agent-proxy or set API key."
      : "Not logged in and no ANTHROPIC_API_KEY set. Run: whale login"
  );
}

// ============================================================================
// MAIN LOOP
// ============================================================================

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { message, conversationHistory, callbacks, abortSignal } = opts;

  const { tools, serverToolCount } = await getTools();
  const systemPrompt = buildSystemPrompt(serverToolCount > 0);

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: "user", content: message },
  ];

  let totalIn = 0;
  let totalOut = 0;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (abortSignal?.aborted) { callbacks.onError("Cancelled"); return; }

      // Telemetry: start a new turn
      const turnNum = nextTurn();
      const turnCtx = createTurnContext({ model: MODEL, turnNumber: turnNum });
      const apiStart = Date.now();

      // Get streaming events (proxy or direct)
      const events = await getEventStream(messages, tools, systemPrompt, abortSignal);
      const result = await processStreamEvents(events, callbacks, abortSignal);

      totalIn += result.totalIn;
      totalOut += result.totalOut;

      // Telemetry: log API call span
      logSpan({
        action: "claude_api_request",
        durationMs: Date.now() - apiStart,
        context: {
          ...turnCtx,
          inputTokens: result.totalIn,
          outputTokens: result.totalOut,
        },
      });

      // No tool calls — we're done
      if (result.toolUseBlocks.length === 0) break;

      // Execute tools (local + server)
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of result.toolUseBlocks) {
        if (abortSignal?.aborted) { callbacks.onError("Cancelled"); return; }

        const toolStart = Date.now();
        let toolResult: { success: boolean; output: string };

        if (isLocalTool(tu.name)) {
          toolResult = executeLocalTool(tu.name, tu.input);

          // Telemetry: log local tool span
          logSpan({
            action: `tool.${tu.name}`,
            durationMs: Date.now() - toolStart,
            context: { ...turnCtx, spanId: undefined },
            error: toolResult.success ? undefined : String(toolResult.output),
            details: { tool_type: "local", tool_input: tu.input },
          });
        } else if (isServerTool(tu.name)) {
          // Server tool — executeTool() handles its own telemetry
          toolResult = await executeServerTool(tu.name, tu.input, {
            ...turnCtx,
            spanId: undefined, // let executor generate its own
          });
        } else {
          toolResult = { success: false, output: `Unknown tool: ${tu.name}` };
        }

        const toolDurationMs = Date.now() - toolStart;
        callbacks.onToolResult(tu.name, toolResult.success, toolResult.output, tu.input, toolDurationMs);

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(toolResult.success ? toolResult.output : { error: toolResult.output }),
        });
      }

      // Append assistant response + tool results for next turn
      messages.push({
        role: "assistant",
        content: [
          ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
          ...result.toolUseBlocks.map((t) => ({
            type: "tool_use" as const,
            id: t.id,
            name: t.name,
            input: t.input,
          })),
        ],
      });
      messages.push({ role: "user", content: toolResults });
    }

    callbacks.onUsage(totalIn, totalOut);
    callbacks.onDone(messages);
  } catch (err: any) {
    if (abortSignal?.aborted || err?.message === "Cancelled") {
      callbacks.onError("Cancelled");
    } else {
      callbacks.onError(String(err?.message || err));
    }
  }
}

// Convenience: check if user can use the agent (logged in OR has API key)
export function canUseAgent(): { ready: boolean; reason?: string } {
  const config = loadConfig();
  const hasToken = !!(config.access_token && config.refresh_token);
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || config.anthropic_api_key);

  if (hasToken || hasApiKey) return { ready: true };
  return { ready: false, reason: "Run `whale login` to authenticate." };
}
