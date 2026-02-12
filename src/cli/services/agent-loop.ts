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
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import {
  LOCAL_TOOL_DEFINITIONS,
  executeLocalTool,
  isLocalTool,
} from "./local-tools.js";
import {
  INTERACTIVE_TOOL_DEFINITIONS,
  executeInteractiveTool,
} from "./interactive-tools.js";
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
  // v4.7.0 extensions
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: "low" | "medium" | "high";
  allowedTools?: string[];
  disallowedTools?: string[];
  fallbackModel?: string;
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
// COST TRACKING — per-model pricing for budget enforcement
// ============================================================================

const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-sonnet-4-20250514":  { inputPer1M: 3.0,  outputPer1M: 15.0 },
  "claude-opus-4-6":           { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-haiku-4-5-20251001": { inputPer1M: 1.0,  outputPer1M: 5.0  },
};

export function estimateCostUsd(inputTokens: number, outputTokens: number, model?: string): number {
  const pricing = MODEL_PRICING[model || activeModel] || MODEL_PRICING["claude-sonnet-4-20250514"];
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
         (outputTokens / 1_000_000) * pricing.outputPer1M;
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
  cwd?: string;
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
    cwd: process.cwd(),
  };
  const data = JSON.stringify({ meta, messages }, null, 2);
  writeFileSync(join(SESSIONS_DIR, `${id}.json`), data, "utf-8");
  logSessionHistory(meta);
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

const HISTORY_FILE = join(homedir(), ".swagmanager", "history.jsonl");

function logSessionHistory(meta: SessionMeta): void {
  try {
    const dir = join(homedir(), ".swagmanager");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry = {
      display: meta.title,
      project: meta.cwd || process.cwd(),
      timestamp: meta.updatedAt,
      sessionId: meta.id,
      model: meta.model,
    };
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
  } catch { /* best effort */ }
}

export function findLatestSessionForCwd(): SessionMeta | null {
  const cwd = process.cwd();
  const sessions = listSessions(100);
  return sessions.find(s => s.cwd === cwd) || null;
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
// CONTEXT MANAGEMENT — server-side via Anthropic beta API
// ============================================================================

// Session-wide token tracking (actual counts from API responses)
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let lastKnownInputTokens = 0; // most recent API call's input token count

export function getSessionTokens(): { input: number; output: number } {
  return { input: sessionInputTokens, output: sessionOutputTokens };
}

/**
 * Context management config — sent to Anthropic beta API.
 * Server-side compaction and tool result clearing replace our custom compressContext().
 */
const CONTEXT_MANAGEMENT_CONFIG = {
  edits: [
    {
      type: "compact_20260112" as const,
      trigger: { type: "input_tokens" as const, value: 150_000 },
    },
    {
      type: "clear_tool_uses_20250919" as const,
      trigger: { type: "input_tokens" as const, value: 100_000 },
      keep: { type: "tool_uses" as const, value: 5 },
    },
  ],
};

const CONTEXT_MANAGEMENT_BETAS: string[] = [
  "compact-2026-01-12",
  "context-management-2025-06-27",
];

// ============================================================================
// GIT CONTEXT — gather branch, status, recent commits for system prompt
// ============================================================================

let cachedGitContext: string | null = null;
let gitContextCwd: string | null = null;

function gatherGitContext(): string {
  const cwd = process.cwd();

  // Return cached if same cwd
  if (cachedGitContext !== null && gitContextCwd === cwd) return cachedGitContext;
  gitContextCwd = cwd;

  try {
    // Check if we're in a git repo
    execSync("git rev-parse --is-inside-work-tree", { cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    cachedGitContext = "";
    return "";
  }

  const parts: string[] = [];

  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (branch) parts.push(`Branch: ${branch}`);
  } catch { /* skip */ }

  try {
    const status = execSync("git status --short 2>/dev/null | head -20", { cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (status) {
      const lines = status.split("\n");
      parts.push(`Status: ${lines.length} changed file${lines.length !== 1 ? "s" : ""}`);
      parts.push(status);
    } else {
      parts.push("Status: clean");
    }
  } catch { /* skip */ }

  try {
    const log = execSync('git log --oneline -5 2>/dev/null', { cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (log) parts.push(`Recent commits:\n${log}`);
  } catch { /* skip */ }

  cachedGitContext = parts.length > 0 ? parts.join("\n") : "";
  return cachedGitContext;
}

/** Force refresh of git context (e.g. after a commit) */
export function refreshGitContext(): void {
  cachedGitContext = null;
  gitContextCwd = null;
}

// ============================================================================
// PERSISTENT MEMORY — /remember and /forget across sessions
// ============================================================================

const MEMORY_DIR = join(homedir(), ".swagmanager", "memory");
const MEMORY_FILE = join(MEMORY_DIR, "MEMORY.md");

function ensureMemoryDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

export function loadMemory(): string {
  if (!existsSync(MEMORY_FILE)) return "";
  try {
    return readFileSync(MEMORY_FILE, "utf-8").trim();
  } catch { return ""; }
}

export function addMemory(fact: string): { success: boolean; message: string } {
  ensureMemoryDir();
  const existing = loadMemory();
  const entry = `- ${fact}`;

  // Check for duplicate
  if (existing.includes(fact)) {
    return { success: false, message: "Already remembered." };
  }

  const updated = existing ? existing + "\n" + entry : entry;
  writeFileSync(MEMORY_FILE, updated + "\n", "utf-8");
  return { success: true, message: `Remembered: ${fact}` };
}

export function removeMemory(pattern: string): { success: boolean; message: string } {
  if (!existsSync(MEMORY_FILE)) return { success: false, message: "No memories stored." };

  const content = readFileSync(MEMORY_FILE, "utf-8");
  const lines = content.split("\n");
  const lower = pattern.toLowerCase();
  const filtered = lines.filter(line => !line.toLowerCase().includes(lower));

  if (filtered.length === lines.length) {
    return { success: false, message: `No memory matching "${pattern}" found.` };
  }

  const removed = lines.length - filtered.length;
  writeFileSync(MEMORY_FILE, filtered.join("\n"), "utf-8");
  return { success: true, message: `Forgot ${removed} memor${removed === 1 ? "y" : "ies"} matching "${pattern}".` };
}

export function listMemories(): string[] {
  const content = loadMemory();
  if (!content) return [];
  return content.split("\n").filter(l => l.trim().startsWith("- ")).map(l => l.replace(/^- /, "").trim());
}

// ============================================================================
// PERMISSION MODES — control tool access levels
// ============================================================================

export type PermissionMode = "default" | "plan" | "yolo";

let activePermissionMode: PermissionMode = "default";

// Tools allowed in each mode
const PLAN_MODE_TOOLS = new Set([
  "read_file", "list_directory", "search_files", "search_content",
  "glob", "grep", "web_fetch", "web_search", "task", "task_output",
  "bash_output", "list_shells", "tasks", "config", "ask_user",
  // Interactive tools (read-only by nature)
  "ask_user_question", "enter_plan_mode", "exit_plan_mode",
]);

export function setPermissionMode(mode: PermissionMode): { success: boolean; message: string } {
  activePermissionMode = mode;
  return { success: true, message: `Permission mode: ${mode}` };
}

export function getPermissionMode(): PermissionMode {
  return activePermissionMode;
}

export function isToolAllowedByPermission(toolName: string): boolean {
  switch (activePermissionMode) {
    case "yolo": return true;
    case "plan": return PLAN_MODE_TOOLS.has(toolName);
    case "default": return true; // Default allows all — UI can prompt for confirmation
  }
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

function buildSystemPrompt(hasServerTools: boolean, effort?: "low" | "medium" | "high"): string {
  let prompt = `You are whale code, a CLI AI assistant.

## Working Directory
${process.cwd()}`;

  // Git context
  const gitContext = gatherGitContext();
  if (gitContext) {
    prompt += `\n\n## Git\n${gitContext}`;
  }

  prompt += `\n\n## Tool Use
- Call multiple independent tools in ONE response (parallel execution)
- Only chain across turns when a result is needed for the next call
- If a tool fails 3 times, try a different approach
- Use task with run_in_background:true for long tasks; check with task_output, stop with task_stop`;

  if (hasServerTools) {
    prompt += `\n- Use audit_trail for store activity, telemetry for AI system metrics`;
  }

  // Permission mode hint
  if (activePermissionMode === "plan") {
    prompt += `\n\n## Mode: Plan (read-only)\nYou are in plan mode. Only read/search tools are available. No file writes or commands.`;
  } else if (activePermissionMode === "yolo") {
    prompt += `\n\n## Mode: Yolo (full access)\nAll tools available without confirmation.`;
  }

  // Effort level
  if (effort === "low") {
    prompt += `\n\n## Effort: Low\nBe concise and direct. Minimize exploration. Give brief answers.`;
  } else if (effort === "high") {
    prompt += `\n\n## Effort: High\nBe thorough and exhaustive. Explore deeply. Verify your work.`;
  }

  // Persistent memory
  const memory = loadMemory();
  if (memory) {
    prompt += `\n\n## Memory (persistent across sessions)\n${memory}`;
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

async function getTools(allowedTools?: string[], disallowedTools?: string[]): Promise<{ tools: Anthropic.Tool[]; serverToolCount: number }> {
  const localTools: Anthropic.Tool[] = LOCAL_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  // Add interactive tools (ask_user_question, enter_plan_mode, exit_plan_mode)
  const interactiveTools: Anthropic.Tool[] = INTERACTIVE_TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));
  localTools.push(...interactiveTools);

  let serverTools: Anthropic.Tool[] = [];
  try {
    serverTools = await loadServerToolDefinitions();
  } catch {
    // Server tools silently unavailable
  }

  // Deduplicate: local tools take priority over server tools with the same name
  const localNames = new Set(localTools.map(t => t.name));
  const uniqueServerTools = serverTools.filter(t => !localNames.has(t.name));

  let allTools = [...localTools, ...uniqueServerTools];

  // Apply tool filtering
  if (allowedTools && allowedTools.length > 0) {
    const allowed = new Set(allowedTools);
    allTools = allTools.filter(t => allowed.has(t.name));
  }
  if (disallowedTools && disallowedTools.length > 0) {
    const disallowed = new Set(disallowedTools);
    allTools = allTools.filter(t => !disallowed.has(t.name));
  }

  return {
    tools: allTools,
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

  // Beta API with server-side context management:
  // - compact_20260112: auto-summarizes when input exceeds 150K tokens
  // - clear_tool_uses_20250919: clears old tool results when input exceeds 100K tokens (keeps last 5)
  const stream = await anthropic.beta.messages.create({
    model: activeModel,
    max_tokens: maxTokens,
    system,
    tools: tools as any,
    messages: messages as any,
    stream: true,
    betas: CONTEXT_MANAGEMENT_BETAS,
    context_management: CONTEXT_MANAGEMENT_CONFIG,
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
  /** Compaction content from server-side context management (if fired) */
  compactionContent: string | null;
  /** Whether server-side context management applied any edits */
  contextManagementApplied: boolean;
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

  // Server-side context management tracking
  let compactionContent: string | null = null;
  let isCompactionBlock = false;
  let contextManagementApplied = false;

  for await (const event of events) {
    if (signal?.aborted) break;

    switch (event.type) {
      case "content_block_start":
        if (event.content_block?.type === "tool_use") {
          currentToolUse = { id: event.content_block.id, name: event.content_block.name, input: "" };
          callbacks.onToolStart(event.content_block.name);
          emitter?.emitToolStart(event.content_block.id, event.content_block.name);
        } else if (event.content_block?.type === "compaction") {
          // Server-side compaction block — track it for inclusion in messages
          isCompactionBlock = true;
          compactionContent = "";
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
        } else if (event.delta?.type === "compaction_delta" && isCompactionBlock) {
          // Accumulate compaction summary content
          if (event.delta.content != null) {
            compactionContent = (compactionContent || "") + event.delta.content;
          }
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
        if (isCompactionBlock) {
          isCompactionBlock = false;
          contextManagementApplied = true;
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
        // Check for context_management applied edits
        if (event.delta?.context_management?.applied_edits?.length > 0) {
          contextManagementApplied = true;
        }
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

  return { text, toolUseBlocks, totalIn, totalOut, cacheCreationTokens, cacheReadTokens, compactionContent, contextManagementApplied };
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
          betas: CONTEXT_MANAGEMENT_BETAS,
          context_management: CONTEXT_MANAGEMENT_CONFIG,
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

  const effectiveMaxTurns = opts.maxTurns || MAX_TURNS;

  const { tools, serverToolCount } = await getTools(opts.allowedTools, opts.disallowedTools);
  const systemPrompt = buildSystemPrompt(serverToolCount > 0, opts.effort);

  // Context management is now server-side (Anthropic beta API handles compaction + tool clearing)
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
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

  let sessionCostUsd = 0;

  try {
    for (let iteration = 0; iteration < effectiveMaxTurns; iteration++) {
      if (abortSignal?.aborted) { callbacks.onError("Cancelled", messages); return; }

      // Budget enforcement
      if (opts.maxBudgetUsd && sessionCostUsd >= opts.maxBudgetUsd) {
        callbacks.onError(`Budget exceeded: $${sessionCostUsd.toFixed(4)} >= $${opts.maxBudgetUsd}`, messages);
        return;
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

            // Fallback model on last retry
            if (attempt === MAX_RETRIES - 1 && opts.fallbackModel) {
              const savedModel = activeModel;
              setModel(opts.fallbackModel);
              logSpan({
                action: "claude_api_fallback",
                durationMs: 0,
                context: { ...turnCtx, spanId: apiSpanId },
                storeId: storeId || undefined,
                details: {
                  from_model: savedModel,
                  to_model: activeModel,
                  reason: String(err?.message || err),
                },
              });
            }
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

      // Track cost
      sessionCostUsd += estimateCostUsd(result.totalIn, result.totalOut);

      // Server-side context management: fire onAutoCompact callback when compaction detected
      if (result.contextManagementApplied) {
        callbacks.onAutoCompact?.(messages.length, messages.length, 0);
        emitter?.emitCompact(messages.length, messages.length, 0);

        logSpan({
          action: "chat.api_compaction",
          durationMs: Date.now() - apiStart,
          context: turnCtx,
          storeId: storeId || undefined,
          details: {
            type: "server_side",
            has_compaction_content: result.compactionContent !== null,
            iteration,
          },
        });
      }

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

        // Permission mode enforcement
        if (!isToolAllowedByPermission(tu.name)) {
          toolResult = { success: false, output: `Tool "${tu.name}" blocked by ${activePermissionMode} mode. Switch modes with /mode.` };
          const toolDurationMs = Date.now() - toolStart;
          callbacks.onToolResult(tu.name, false, toolResult.output, tu.input, toolDurationMs);
          emitter?.emitToolEnd(tu.id, tu.name, false, toolResult.output, tu.input, toolDurationMs);
          toolResultMap.set(tu.id, {
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: toolResult.output }),
          });
          return;
        }

        // Interactive tools (ask_user_question, enter_plan_mode, exit_plan_mode)
        const INTERACTIVE_TOOL_NAMES = new Set(INTERACTIVE_TOOL_DEFINITIONS.map(t => t.name));
        if (INTERACTIVE_TOOL_NAMES.has(tu.name)) {
          const interactiveResult = await executeInteractiveTool(tu.name, tu.input);
          toolResult = { success: interactiveResult.success, output: interactiveResult.output };

          logSpan({
            action: `tool.${tu.name}`,
            durationMs: Date.now() - toolStart,
            context: { ...turnCtx, parentSpanId: apiSpanId },
            storeId: storeId || undefined,
            error: toolResult.success ? undefined : String(toolResult.output),
            details: {
              tool_type: "interactive",
              tool_input: tu.input,
              tool_result: truncateResult(toolResult.output, 2000),
              iteration,
            },
          });
        } else if (isLocalTool(tu.name)) {
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
          // Server tools proxied to edge function — single source of truth.
          toolResult = await executeServerTool(tu.name, tu.input);
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
          // Cap tool result content sent to Claude (~30K chars ≈ 7.5K tokens).
          // Prevents massive JSON responses (e.g. raw DB dumps) from blowing context.
          const MAX_TOOL_RESULT_CHARS = 30_000;
          const rawContent = toolResult.success ? toolResult.output : { error: toolResult.output };
          let contentStr = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
          if (contentStr.length > MAX_TOOL_RESULT_CHARS) {
            contentStr = contentStr.slice(0, MAX_TOOL_RESULT_CHARS)
              + `\n\n... (truncated — ${contentStr.length.toLocaleString()} chars total. Ask for a narrower query.)`;
          }
          resultBlock = {
            type: "tool_result",
            tool_use_id: tu.id,
            content: contentStr,
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
      // Include compaction block if present — API requires it in subsequent turns
      const assistantContent: any[] = [];
      if (result.compactionContent !== null) {
        assistantContent.push({ type: "compaction", content: result.compactionContent });
      }
      if (result.text) {
        assistantContent.push({ type: "text" as const, text: result.text });
      }
      assistantContent.push(
        ...result.toolUseBlocks.map((t) => ({
          type: "tool_use" as const,
          id: t.id,
          name: t.name,
          input: t.input,
        })),
      );
      messages.push({ role: "assistant", content: assistantContent });
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

// Memory, permission mode, and git context are exported at their definition sites above

// Re-export event emitter for ChatApp
export { AgentEventEmitter, type AgentEvent } from "./agent-events.js";
