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
import { LoopDetector } from "./loop-detector.js";
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
  generateSpanId,
  getTurnNumber,
} from "./telemetry.js";
import {
  runPreToolHooks,
  runPostToolHooks,
  runPromptSubmitHooks,
} from "./hooks.js";
import {
  handleSlashCommand,
  generateHelpText,
} from "./slash-commands.js";
import {
  AgentEventEmitter,
  setGlobalEmitter,
  clearGlobalEmitter,
} from "./agent-events.js";

// ============================================================================
// TYPES
// ============================================================================

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolStart: (name: string, input?: Record<string, unknown>) => void;
  onToolResult: (name: string, success: boolean, result: unknown, input?: Record<string, unknown>, durationMs?: number) => void;
  onUsage: (input_tokens: number, output_tokens: number) => void;
  onDone: (finalMessages: Anthropic.MessageParam[]) => void;
  onError: (error: string, partialMessages?: Anthropic.MessageParam[]) => void;
  onAutoCompact?: (beforeMessages: number, afterMessages: number, tokensSaved: number) => void;
}

export interface AgentLoopOptions {
  message: string;
  conversationHistory: Anthropic.MessageParam[];
  callbacks: AgentLoopCallbacks;
  abortSignal?: AbortSignal;
  model?: string;
  emitter?: AgentEventEmitter; // Event emitter for decoupled UI
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

function buildSystemPrompt(hasServerTools: boolean): string {
  let prompt = `You are whale code, a CLI AI assistant.

## Working Directory
${process.cwd()}

## Tool Use
- Call multiple independent tools in ONE response (parallel execution)
- Only chain across turns when a result is needed for the next call
- If a tool fails 3 times, try a different approach
- Use task with run_in_background:true for long tasks; check with task_output, stop with task_stop`;

  if (hasServerTools) {
    prompt += `\n- Use audit_trail for store activity, telemetry for AI system metrics`;
  }

  const claudeMd = loadClaudeMd();
  if (claudeMd) {
    prompt += `\n\n## Project Instructions (from ${claudeMd.path})\n\n${claudeMd.content}`;
  }

  prompt += `\n\n## Formatting Rules

### Bar Charts
Use \`\`\`chart code blocks for comparative data:
\`\`\`chart
Title
Label: $value
\`\`\`

### Tables
Use markdown tables for multi-column data.

### Style
- NEVER use emojis — terminal renders them as broken glyphs
- Include $ on monetary values, % on percentages
- Keep output clean and monospace-aligned

Be concise. Use tools to do work — don't just explain.`;

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

  // Deduplicate: local tools take priority over server tools with the same name
  const localNames = new Set(localTools.map(t => t.name));
  const uniqueServerTools = serverTools.filter(t => !localNames.has(t.name));

  return {
    tools: [...localTools, ...uniqueServerTools],
    serverToolCount: uniqueServerTools.length,
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
  signal?: AbortSignal,
  emitter?: AgentEventEmitter
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
          emitter?.emitToolStart(event.content_block.id, event.content_block.name);
        }
        break;

      case "content_block_delta":
        if (event.delta?.type === "text_delta") {
          text += event.delta.text;
          // Use emitter for batched text if available
          if (emitter) {
            emitter.emitText(event.delta.text);
          } else {
            callbacks.onText(event.delta.text);
          }
        } else if (event.delta?.type === "input_json_delta" && currentToolUse) {
          currentToolUse.input += event.delta.partial_json;
        }
        break;

      case "content_block_stop":
        if (currentToolUse) {
          try {
            const parsed = JSON.parse(currentToolUse.input || "{}");
            toolUseBlocks.push({
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: parsed,
            });
            // Update running tool with parsed input so UI can show context
            callbacks.onToolStart(currentToolUse.name, parsed);
          } catch { /* skip bad JSON */ }
          currentToolUse = null;
        }
        break;

      case "message_start":
        if (event.message?.usage) {
          totalIn += event.message.usage.input_tokens;
          cacheCreationTokens += event.message.usage.cache_creation_input_tokens || 0;
          cacheReadTokens += event.message.usage.cache_read_input_tokens || 0;
        }
        break;

      case "message_delta":
        if (event.usage) totalOut += event.usage.output_tokens;
        break;

      case "error": {
        // Proxy sends {"type":"error","error":"..."} for upstream API errors
        const errMsg = typeof event.error === "string" ? event.error : JSON.stringify(event.error);
        throw new Error(errMsg);
      }
    }
  }

  // Flush any remaining buffered text
  emitter?.flushText();

  // Update session-wide token tracking
  sessionInputTokens += totalIn;
  sessionOutputTokens += totalOut;
  lastKnownInputTokens = totalIn;

  // Emit usage via emitter
  if (emitter && (totalIn > 0 || totalOut > 0)) {
    emitter.emitUsage(totalIn, totalOut);
  }

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
  const { message, conversationHistory, callbacks, abortSignal, emitter } = opts;
  if (opts.model) setModel(opts.model);

  // Set global emitter for subagents to use
  if (emitter) {
    setGlobalEmitter(emitter);
  }

  const { tools, serverToolCount } = await getTools();
  const systemPrompt = buildSystemPrompt(serverToolCount > 0);

  // Apply context compression before starting — notify user if it fires
  const compressedHistory = compressContext(conversationHistory, (before, after, saved) => {
    callbacks.onAutoCompact?.(before, after, saved);
    emitter?.emitCompact(before, after, saved);
  });
  const messages: Anthropic.MessageParam[] = [
    ...compressedHistory,
    { role: "user", content: message },
  ];

  const loopDetector = new LoopDetector();

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let allAssistantText: string[] = [];

  // Telemetry: one turn per user message (not per API call)
  const sessionStart = Date.now();
  const { storeId } = resolveConfig();
  const turnNum = nextTurn(); // ONCE per user message
  const turnCtx = createTurnContext({ model: activeModel, turnNumber: turnNum });

  logSpan({
    action: "chat.user_message",
    durationMs: 0,
    context: turnCtx,
    storeId: storeId || undefined,
    details: {
      message: message,
      conversation_history_length: conversationHistory.length,
    },
  });

  try {
    for (let iteration = 0; iteration < MAX_TURNS; iteration++) {
      if (abortSignal?.aborted) { callbacks.onError("Cancelled", messages); return; }

      // Mid-loop auto-compact: if context grew large during tool use, compress before next API call
      if (iteration > 0 && needsCompaction(messages)) {
        const compactStart = Date.now();
        const beforeCount = messages.length;
        const compressed = compressContext(messages, (before, after, saved) => {
          callbacks.onAutoCompact?.(before, after, saved);
          emitter?.emitCompact(before, after, saved);

          logSpan({
            action: "chat.context_compaction",
            durationMs: Date.now() - compactStart,
            context: turnCtx,
            storeId: storeId || undefined,
            details: {
              messages_before: before,
              messages_after: after,
              tokens_saved: saved,
              iteration,
            },
          });
        });
        messages.length = 0;
        messages.push(...compressed);
      }

      const apiStart = Date.now();
      const apiSpanId = generateSpanId(); // Unique span ID for this API call — tools reference as parent

      // Get streaming events with retry logic
      let result: StreamResult | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const events = await getEventStream(messages, tools, systemPrompt, abortSignal);
          result = await processStreamEvents(events, callbacks, abortSignal, emitter);
          break; // Success
        } catch (err: any) {
          if (abortSignal?.aborted) throw err;
          if (attempt < MAX_RETRIES && isRetryableError(err)) {
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);

            logSpan({
              action: "claude_api_retry",
              durationMs: delay,
              context: { ...turnCtx, spanId: apiSpanId },
              storeId: storeId || undefined,
              error: String(err?.message || err),
              details: {
                attempt: attempt + 1,
                max_attempts: MAX_RETRIES,
                delay_ms: delay,
                error_type: classifyToolError(String(err?.message || err)),
                iteration,
              },
            });

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

      // Telemetry: log API call span (gen_ai.* OTEL convention matches UI)
      logSpan({
        action: "claude_api_request",
        durationMs: Date.now() - apiStart,
        context: {
          ...turnCtx,
          spanId: apiSpanId,
          inputTokens: result.totalIn,
          outputTokens: result.totalOut,
        },
        storeId: storeId || undefined,
        details: {
          "gen_ai.request.model": activeModel,
          "gen_ai.usage.input_tokens": result.totalIn,
          "gen_ai.usage.output_tokens": result.totalOut,
          "gen_ai.usage.cache_creation_tokens": result.cacheCreationTokens,
          "gen_ai.usage.cache_read_tokens": result.cacheReadTokens,
          stop_reason: result.toolUseBlocks.length > 0 ? "tool_use" : "end_turn",
          iteration,
          tool_count: result.toolUseBlocks.length,
          tool_names: result.toolUseBlocks.map(t => t.name),
        },
      });

      // No tool calls — we're done
      if (result.toolUseBlocks.length === 0) break;

      // Execute tools — all in parallel (up to MAX_CONCURRENT_TASKS at a time)
      const MAX_CONCURRENT_TASKS = 7;
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      const toolResultMap = new Map<string, Anthropic.ToolResultBlockParam>();

      // Helper to execute a single tool and build its result
      async function executeSingleTool(tu: { id: string; name: string; input: Record<string, unknown> }): Promise<void> {
        if (abortSignal?.aborted) return;

        // Circuit breaker check
        const loopCheck = loopDetector.recordCall(tu.name, tu.input);
        if (loopCheck.blocked) {
          const blockedResult = { success: false, output: loopCheck.reason! };

          logSpan({
            action: "tool.circuit_breaker",
            durationMs: 0,
            context: { ...turnCtx, parentSpanId: apiSpanId },
            storeId: storeId || undefined,
            severity: "warn",
            error: loopCheck.reason,
            details: {
              tool_name: tu.name,
              tool_input: tu.input,
              iteration,
            },
          });

          callbacks.onToolResult(tu.name, false, blockedResult.output, tu.input, 0);
          emitter?.emitToolEnd(tu.id, tu.name, false, blockedResult.output, tu.input, 0);
          toolResultMap.set(tu.id, {
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: blockedResult.output }),
          });
          return;
        }

        const toolStart = Date.now();
        let toolResult: { success: boolean; output: string };

        if (isLocalTool(tu.name)) {
          toolResult = await executeLocalTool(tu.name, tu.input);

          logSpan({
            action: `tool.${tu.name}`,
            durationMs: Date.now() - toolStart,
            context: { ...turnCtx, parentSpanId: apiSpanId },
            storeId: storeId || undefined,
            error: toolResult.success ? undefined : String(toolResult.output),
            details: {
              tool_type: "local",
              tool_input: tu.input,
              tool_result: truncateResult(toolResult.output, 2000),
              description: (tu.input.description || tu.input.command || tu.input.path || undefined) as string | undefined,
              error_type: toolResult.success ? undefined : classifyToolError(toolResult.output),
              iteration,
            },
          });
        } else if (isServerTool(tu.name)) {
          toolResult = await executeServerTool(tu.name, tu.input, {
            ...turnCtx,
            spanId: undefined,
          });

          logSpan({
            action: `tool.${tu.name}`,
            durationMs: Date.now() - toolStart,
            context: { ...turnCtx, parentSpanId: apiSpanId },
            storeId: storeId || undefined,
            error: toolResult.success ? undefined : String(toolResult.output),
            details: {
              tool_type: "server",
              tool_input: tu.input,
              tool_result: truncateResult(toolResult.output, 2000),
              error_type: toolResult.success ? undefined : classifyToolError(toolResult.output),
              iteration,
            },
          });
        } else {
          toolResult = { success: false, output: `Unknown tool: ${tu.name}` };
        }

        const toolDurationMs = Date.now() - toolStart;
        loopDetector.recordResult(tu.name, toolResult.success);
        callbacks.onToolResult(tu.name, toolResult.success, toolResult.output, tu.input, toolDurationMs);
        emitter?.emitToolEnd(tu.id, tu.name, toolResult.success, toolResult.output, tu.input, toolDurationMs);

        // Check for image marker — convert to image content block
        const imageMatch = toolResult.success && typeof toolResult.output === "string"
          ? toolResult.output.match(/^__IMAGE__(.+?)__(.+)$/)
          : null;

        let resultBlock: Anthropic.ToolResultBlockParam;
        if (imageMatch) {
          resultBlock = {
            type: "tool_result",
            tool_use_id: tu.id,
            content: [
              {
                type: "image" as any,
                source: {
                  type: "base64",
                  media_type: imageMatch[1],
                  data: imageMatch[2],
                },
              } as any,
            ],
          };
        } else {
          resultBlock = {
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(toolResult.success ? toolResult.output : { error: toolResult.output }),
          };
        }
        toolResultMap.set(tu.id, resultBlock);
      }

      // Execute all tools in parallel (up to MAX_CONCURRENT_TASKS)
      // All tool calls in a single model response are independent (model can't see intermediate results)
      const allBlocks = result.toolUseBlocks;
      for (let i = 0; i < allBlocks.length; i += MAX_CONCURRENT_TASKS) {
        if (abortSignal?.aborted) { callbacks.onError("Cancelled", messages); return; }
        const batch = allBlocks.slice(i, i + MAX_CONCURRENT_TASKS);
        await Promise.all(batch.map(tu => executeSingleTool(tu)));
      }

      // Collect results in original order
      for (const tu of result.toolUseBlocks) {
        const r = toolResultMap.get(tu.id);
        if (r) toolResults.push(r);
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
          ...turnCtx,
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
        ...turnCtx,
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
      },
    });

    callbacks.onUsage(totalIn, totalOut);

    // Emit done event and clean up
    // Send only the LAST turn's text (earlier turns were displayed alongside their tools)
    const finalText = allAssistantText.length > 0
      ? allAssistantText[allAssistantText.length - 1]
      : "";
    emitter?.emitDone(finalText, messages);
    if (emitter) clearGlobalEmitter();

    callbacks.onDone(messages);
  } catch (err: any) {
    const errorMsg = abortSignal?.aborted || err?.message === "Cancelled"
      ? "Cancelled"
      : String(err?.message || err);

    // Emit error event and clean up
    emitter?.emitError(errorMsg);
    if (emitter) clearGlobalEmitter();

    callbacks.onError(errorMsg, messages);
  }
}

// ============================================================================
// TELEMETRY HELPERS
// ============================================================================

export function truncateResult(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output;
  return output.slice(0, maxLen) + `... (${output.length} chars total)`;
}

export function classifyToolError(output: string): string {
  const lower = output.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (lower.includes("permission denied") || lower.includes("eacces")) return "permission";
  if (lower.includes("not found") || lower.includes("no such file")) return "not_found";
  if (lower.includes("command not found") || lower.includes("exit code 127")) return "command_not_found";
  if (lower.includes("import") && lower.includes("error")) return "import_error";
  if (lower.includes("syntax") || lower.includes("parse")) return "syntax_error";
  if (lower.includes("externally-managed")) return "env_managed";
  return "unknown";
}

// Convenience: check if user can use the agent (logged in OR has API key)
export function canUseAgent(): { ready: boolean; reason?: string } {
  const config = loadConfig();
  const hasToken = !!(config.access_token && config.refresh_token);
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || config.anthropic_api_key);

  if (hasToken || hasApiKey) return { ready: true };
  return { ready: false, reason: "Run `whale login` to authenticate." };
}

// Re-export slash command utilities for ChatApp
export { handleSlashCommand, generateHelpText } from "./slash-commands.js";

// Re-export interactive tools for UI handling
export {
  interactiveEvents,
  getPendingQuestion,
  resolveQuestion,
  isPlanMode,
  getPlanModeState,
} from "./interactive-tools.js";

// Re-export background process listing for /tasks command
export { listProcesses, listBackgroundAgents } from "./background-processes.js";

// Re-export event emitter for ChatApp
export { AgentEventEmitter, type AgentEvent } from "./agent-events.js";
