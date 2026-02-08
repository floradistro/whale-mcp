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
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import {
  LOCAL_TOOL_DEFINITIONS,
  executeLocalTool,
  isLocalTool,
} from "./local-tools.js";
import { loadConfig, resolveConfig } from "./config-store.js";
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
  onAutoCompact?: (beforeMessages: number, afterMessages: number, tokensSaved: number) => void;
}

export interface AgentLoopOptions {
  message: string;
  conversationHistory: Anthropic.MessageParam[];
  callbacks: AgentLoopCallbacks;
  abortSignal?: AbortSignal;
  model?: string;
}

// ============================================================================
// MODEL MANAGEMENT
// ============================================================================

const MODEL_MAP: Record<string, string> = {
  "sonnet":  "claude-sonnet-4-20250514",
  "opus":    "claude-opus-4-6",
  "haiku":   "claude-haiku-4-5-20251001",
};

let activeModel = "claude-sonnet-4-20250514";

export function setModel(name: string): { success: boolean; model: string } {
  const key = name.toLowerCase().replace(/^claude-?/, "").replace(/-.*/, "");
  const modelId = MODEL_MAP[key] || MODEL_MAP["sonnet"];
  activeModel = modelId;
  return { success: true, model: activeModel };
}

export function getModel(): string {
  return activeModel;
}

export function getModelShortName(): string {
  if (activeModel.includes("opus")) return "opus";
  if (activeModel.includes("haiku")) return "haiku";
  return "sonnet";
}

// ============================================================================
// CLAUDE.MD LOADING — auto-load project instructions from cwd + parents
// ============================================================================

let cachedClaudeMd: string | null = null;
let cachedClaudeMdPath: string | null = null;

function findClaudeMd(startDir?: string): { content: string; path: string } | null {
  const cwd = startDir || process.cwd();
  const checked = new Set<string>();

  // Walk up from cwd looking for CLAUDE.md
  let dir = resolve(cwd);
  while (dir && !checked.has(dir)) {
    checked.add(dir);
    const candidates = [
      join(dir, "CLAUDE.md"),
      join(dir, ".claude", "CLAUDE.md"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        try {
          const content = readFileSync(candidate, "utf-8");
          if (content.trim()) return { content: content.trim(), path: candidate };
        } catch { /* skip unreadable */ }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadClaudeMd(): { content: string; path: string } | null {
  if (cachedClaudeMd !== null) return cachedClaudeMd ? { content: cachedClaudeMd, path: cachedClaudeMdPath! } : null;
  const result = findClaudeMd();
  cachedClaudeMd = result?.content || "";
  cachedClaudeMdPath = result?.path || null;
  return result;
}

export function reloadClaudeMd(): { content: string; path: string } | null {
  cachedClaudeMd = null;
  cachedClaudeMdPath = null;
  return loadClaudeMd();
}

// ============================================================================
// SESSION PERSISTENCE — save/load conversations to disk
// ============================================================================

const SESSIONS_DIR = join(homedir(), ".swagmanager", "sessions");

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export function saveSession(
  messages: Anthropic.MessageParam[],
  sessionId?: string
): string {
  ensureSessionsDir();
  const id = sessionId || `session-${Date.now()}`;
  const meta: SessionMeta = {
    id,
    title: extractSessionTitle(messages),
    model: activeModel,
    messageCount: messages.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const data = JSON.stringify({ meta, messages }, null, 2);
  writeFileSync(join(SESSIONS_DIR, `${id}.json`), data, "utf-8");
  return id;
}

export function loadSession(sessionId: string): { meta: SessionMeta; messages: Anthropic.MessageParam[] } | null {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch { return null; }
}

export function listSessions(limit = 20): SessionMeta[] {
  ensureSessionsDir();
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);
  const sessions: SessionMeta[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      if (data.meta) sessions.push(data.meta);
    } catch { /* skip corrupted */ }
  }
  return sessions;
}

function extractSessionTitle(messages: Anthropic.MessageParam[]): string {
  // Use first user message as title (truncated)
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      return m.content.slice(0, 60) + (m.content.length > 60 ? "..." : "");
    }
    if (m.role === "user" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if ("text" in block && typeof block.text === "string") {
          return block.text.slice(0, 60) + (block.text.length > 60 ? "..." : "");
        }
      }
    }
  }
  return "Untitled session";
}

// ============================================================================
// CONTEXT MANAGEMENT — token-aware compression matching Claude Code behavior
// ============================================================================

// Token budget: 200K context window, leave room for output + system prompt
const CONTEXT_TOKEN_BUDGET = 160_000;
// Rough chars-per-token ratio for estimation (actual tracked via API usage)
const CHARS_PER_TOKEN = 3.5;

// Session-wide token tracking (actual counts from API responses)
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let lastKnownInputTokens = 0; // most recent API call's input token count

export function getSessionTokens(): { input: number; output: number } {
  return { input: sessionInputTokens, output: sessionOutputTokens };
}

/** Estimate token count from message content (fallback when no API count available) */
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ("text" in block) chars += (block.text as string).length;
        else chars += JSON.stringify(block).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Check if context needs compression — uses actual token count if available */
function needsCompaction(messages: Anthropic.MessageParam[]): boolean {
  // Use actual count from last API call if available, otherwise estimate
  const tokenCount = lastKnownInputTokens > 0
    ? lastKnownInputTokens
    : estimateTokens(messages);
  return tokenCount > CONTEXT_TOKEN_BUDGET && messages.length >= 6;
}

/**
 * Compress conversation context — keeps recent messages, summarizes older ones.
 * Proportional: keeps ~40% of messages (min 6) to preserve more context than naive truncation.
 */
export function compressContext(
  messages: Anthropic.MessageParam[],
  callback?: (before: number, after: number, tokensSaved: number) => void
): Anthropic.MessageParam[] {
  if (!needsCompaction(messages)) return messages;

  const beforeCount = messages.length;
  const beforeTokens = estimateTokens(messages);

  // Keep 40% of messages (min 6, max 20) — more proportional than fixed 4
  const keepCount = Math.max(6, Math.min(20, Math.ceil(messages.length * 0.4)));
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  // Build a compact summary of older messages
  const summaryParts: string[] = [];
  let toolsUsed: string[] = [];

  for (const m of toSummarize) {
    if (m.role === "user") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
          : "";
      if (text) summaryParts.push(`User: ${text.slice(0, 300)}`);
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        summaryParts.push(`Assistant: ${m.content.slice(0, 300)}`);
      } else if (Array.isArray(m.content)) {
        const textParts = m.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text.slice(0, 200));
        const tools = m.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => b.name);
        toolsUsed.push(...tools);
        if (textParts.length) {
          summaryParts.push(`Assistant: ${textParts.join(" ")}`);
        }
      }
    }
  }

  // Deduplicate tool list
  const uniqueTools = [...new Set(toolsUsed)];
  const toolsSummary = uniqueTools.length > 0
    ? `\nTools used in earlier context: ${uniqueTools.join(", ")}`
    : "";

  const summary = `[Context auto-compacted — ${toSummarize.length} earlier messages summarized]${toolsSummary}\n\n${summaryParts.join("\n")}`;

  const compressed = [
    { role: "user" as const, content: summary },
    { role: "assistant" as const, content: "Understood, I have the context from our earlier conversation. I'll continue from where we left off." },
    ...toKeep,
  ];

  const afterTokens = estimateTokens(compressed);
  const tokensSaved = beforeTokens - afterTokens;

  // Reset last known input tokens so next API call refreshes it
  lastKnownInputTokens = 0;

  if (callback) callback(beforeCount, compressed.length, tokensSaved);

  return compressed;
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

const LOCAL_TOOLS_DESC = `You have access to local tools for working with the user's filesystem, searching, and running commands:

File operations:
- read_file: Read file contents (supports offset/limit for large files)
- write_file: Write/create files (creates parent dirs)
- edit_file: Make targeted edits via find-and-replace (supports replace_all)
- list_directory: List files and folders

Search tools:
- glob: Fast file pattern matching (e.g. "**/*.ts", "src/**/*.tsx")
- grep: Search file contents with regex, context lines, output modes (content/files/count)
- search_files: Find files by name pattern (simple, use glob for advanced)
- search_content: Search file contents (simple, use grep for advanced)

Shell:
- run_command: Execute shell commands with configurable timeout

Web:
- web_fetch: Fetch URL content as cleaned markdown text

Notebooks:
- notebook_edit: Edit Jupyter notebook cells (replace, insert, delete)

Task tracking:
- todo_write: Manage a session todo list with status tracking`;

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
- web_search: Search the web via Exa AI (neural, keyword, or auto search with domain filtering)
- alerts: System alerts (low stock, pending orders)
- audit_trail: View audit logs

Server tools use an "action" parameter to select the operation.`;

function buildSystemPrompt(hasServerTools: boolean): string {
  let prompt = `You are whale code, a CLI AI assistant similar to Claude Code.\n\n${LOCAL_TOOLS_DESC}`;
  if (hasServerTools) {
    prompt += `\n\n${SERVER_TOOLS_DESC}`;
  }

  // Load CLAUDE.md project instructions
  const claudeMd = loadClaudeMd();
  if (claudeMd) {
    prompt += `\n\n## Project Instructions (from ${claudeMd.path})\n\n${claudeMd.content}`;
  }

  prompt += `\n\nBe concise and direct. When the user asks you to do something, use the tools to do it — don't just explain how. Show relevant output but keep responses short.

## Formatting Rules — ALWAYS follow these for rich terminal output

### Bar Charts
When presenting comparative data (revenue by category, sales by location, top products, monthly trends, etc.), ALWAYS use a \`\`\`chart code block:

\`\`\`chart
Monthly Revenue
Jan: $45,200
Feb: $52,100
Mar: $61,300
\`\`\`

The first line is an optional title. Each data line is "Label: value". Values can be $dollars, percentages%, or plain numbers.

### Tables
When presenting structured data with multiple columns, ALWAYS use markdown tables:

| Product | Revenue | Units | Margin |
|---------|---------|-------|--------|
| Widget A | $12,500 | 340 | 42% |
| Widget B | $8,200 | 210 | 38% |

### Financial Data
- ALWAYS present financial summaries using charts and tables — NEVER use plain text trees or bullet points for financial data
- Use \`\`\`chart blocks for any comparison (revenue breakdown, category sales, location performance)
- Use markdown tables for detailed line-item data
- Include dollar signs ($) on all monetary values so they render in green
- Include percent signs (%) on all percentage values so they render in cyan

### Style
- NEVER use emojis (💰📊🛒 etc.) — this terminal uses JetBrains Mono which renders emojis as broken double-width glyphs
- Use plain text labels instead of emojis (e.g. "Revenue:" not "💰 Revenue:")
- Keep output clean and monospace-aligned`;

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
const MAX_TURNS = 200; // Match Claude Code — effectively unlimited within a session

/** Model-aware max output tokens */
function getMaxOutputTokens(): number {
  if (activeModel.includes("opus-4-6")) return 16384;   // Opus 4.6: up to 128K, default 16K
  if (activeModel.includes("sonnet-4-5")) return 16384; // Sonnet 4.5: up to 64K
  if (activeModel.includes("haiku")) return 16384;      // Haiku 4.5: up to 64K
  return 16384;                                          // Safe default for all Claude 4+ models
}

// ============================================================================
// RETRY LOGIC — exponential backoff for transient API errors
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isRetryableError(err: any): boolean {
  const status = err?.status || err?.statusCode;
  if (status === 429 || status === 500 || status === 529) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("overloaded") || msg.includes("rate limit") || msg.includes("timeout");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const maxTokens = getMaxOutputTokens();

  // Use cache_control on system prompt to enable prompt caching (90% savings on cache hits)
  const system = [
    {
      type: "text" as const,
      text: systemPrompt,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const stream = await anthropic.messages.create({
    model: activeModel,
    max_tokens: maxTokens,
    system: system as any, // cache_control typed in beta API, works on all models
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
  cacheCreationTokens: number;
  cacheReadTokens: number;
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
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

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
        if (event.message?.usage) {
          totalIn += event.message.usage.input_tokens;
          // Track prompt caching metrics
          cacheCreationTokens += event.message.usage.cache_creation_input_tokens || 0;
          cacheReadTokens += event.message.usage.cache_read_input_tokens || 0;
        }
        break;

      case "message_delta":
        if (event.usage) totalOut += event.usage.output_tokens;
        break;
    }
  }

  // Update session-wide token tracking and context size awareness
  sessionInputTokens += totalIn;
  sessionOutputTokens += totalOut;
  lastKnownInputTokens = totalIn; // Track for auto-compact decisions

  return { text, toolUseBlocks, totalIn, totalOut, cacheCreationTokens, cacheReadTokens };
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
          model: activeModel,
          max_tokens: getMaxOutputTokens(),
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
  if (opts.model) setModel(opts.model);

  const { tools, serverToolCount } = await getTools();
  const systemPrompt = buildSystemPrompt(serverToolCount > 0);

  // Apply context compression before starting — notify user if it fires
  const compressedHistory = compressContext(conversationHistory, (before, after, saved) => {
    callbacks.onAutoCompact?.(before, after, saved);
  });
  const messages: Anthropic.MessageParam[] = [
    ...compressedHistory,
    { role: "user", content: message },
  ];

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let allAssistantText: string[] = [];

  // Telemetry: log user message at conversation start
  const sessionStart = Date.now();
  const { storeId } = resolveConfig();
  const initialTurnCtx = createTurnContext({ model: activeModel, turnNumber: 1 });
  logSpan({
    action: "chat.user_message",
    durationMs: 0,
    context: initialTurnCtx,
    storeId: storeId || undefined,
    details: {
      message: message,
      conversation_history_length: conversationHistory.length,
    },
  });

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (abortSignal?.aborted) { callbacks.onError("Cancelled"); return; }

      // Mid-loop auto-compact: if context grew large during tool use, compress before next API call
      if (turn > 0 && needsCompaction(messages)) {
        const beforeLen = messages.length;
        const compressed = compressContext(messages, (before, after, saved) => {
          callbacks.onAutoCompact?.(before, after, saved);
        });
        // Replace messages array content in-place
        messages.length = 0;
        messages.push(...compressed);
      }

      // Telemetry: start a new turn
      const turnNum = nextTurn();
      const turnCtx = createTurnContext({ model: activeModel, turnNumber: turnNum });
      const apiStart = Date.now();

      // Get streaming events with retry logic
      let result: StreamResult | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const events = await getEventStream(messages, tools, systemPrompt, abortSignal);
          result = await processStreamEvents(events, callbacks, abortSignal);
          break; // Success
        } catch (err: any) {
          if (abortSignal?.aborted) throw err;
          if (attempt < MAX_RETRIES && isRetryableError(err)) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
            await sleep(delay);
            continue;
          }
          throw err; // Non-retryable or exhausted retries
        }
      }

      if (!result) throw new Error("Failed to get response after retries");

      totalIn += result.totalIn;
      totalOut += result.totalOut;
      totalCacheCreation += result.cacheCreationTokens;
      totalCacheRead += result.cacheReadTokens;

      // Collect assistant text for telemetry
      if (result.text) {
        allAssistantText.push(result.text);
      }

      // Telemetry: log API call span
      logSpan({
        action: "claude_api_request",
        durationMs: Date.now() - apiStart,
        context: {
          ...turnCtx,
          inputTokens: result.totalIn,
          outputTokens: result.totalOut,
        },
        storeId: storeId || undefined,
        details: {
          cache_creation_tokens: result.cacheCreationTokens,
          cache_read_tokens: result.cacheReadTokens,
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
          toolResult = await executeLocalTool(tu.name, tu.input);

          // Telemetry: log local tool span
          logSpan({
            action: `tool.${tu.name}`,
            durationMs: Date.now() - toolStart,
            context: { ...turnCtx, spanId: undefined },
            storeId: storeId || undefined,
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

    // Telemetry: log assistant response
    const fullResponse = allAssistantText.join("\n\n");
    if (fullResponse) {
      logSpan({
        action: "chat.assistant_response",
        durationMs: Date.now() - sessionStart,
        context: {
          ...initialTurnCtx,
          inputTokens: totalIn,
          outputTokens: totalOut,
          model: activeModel,
        },
        storeId: storeId || undefined,
        details: {
          response: fullResponse,
          input_tokens: totalIn,
          output_tokens: totalOut,
          total_tokens: totalIn + totalOut,
          model: activeModel,
        },
      });
    }

    // Telemetry: log session summary
    logSpan({
      action: "chat.session_complete",
      durationMs: Date.now() - sessionStart,
      context: {
        ...initialTurnCtx,
        inputTokens: totalIn,
        outputTokens: totalOut,
        model: activeModel,
      },
      storeId: storeId || undefined,
      details: {
        input_tokens: totalIn,
        output_tokens: totalOut,
        total_tokens: totalIn + totalOut,
        cache_creation_tokens: totalCacheCreation,
        cache_read_tokens: totalCacheRead,
        session_input_tokens: sessionInputTokens,
        session_output_tokens: sessionOutputTokens,
        model: activeModel,
        turns: nextTurn(),
      },
    });

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
