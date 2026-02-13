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
} from "./telemetry.js";
// Re-exported at bottom; not used directly in this file
// hooks.js and slash-commands.js are re-exported for ChatApp
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
  images?: { base64: string; mediaType: string }[]; // Image attachments (base64-encoded)
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

let activeModel = "claude-opus-4-6";

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
 * Model-aware: compact_20260112 only supported on Opus 4.6.
 * clear_tool_uses_20250919 supported on all Claude 4+ models.
 */
function getContextManagement(model: string): { betas: string[]; config: { edits: any[] } } {
  const edits: any[] = [];
  const betas: string[] = ["context-management-2025-06-27"];

  // Compaction: only supported on Opus 4.6
  if (model.includes("opus-4-6")) {
    edits.push({
      type: "compact_20260112" as const,
      trigger: { type: "input_tokens" as const, value: 120_000 },
    });
    betas.push("compact-2026-01-12");
  }

  // Tool result clearing: supported on all Claude 4+ models
  edits.push({
    type: "clear_tool_uses_20250919" as const,
    trigger: { type: "input_tokens" as const, value: 80_000 },
    keep: { type: "tool_uses" as const, value: 3 },
  });

  return { betas, config: { edits } };
}

// ============================================================================
// CLIENT-SIDE COMPACTION — for Sonnet/Haiku (no server-side compact support)
// ============================================================================

const COMPACTION_SUMMARY_PROMPT = `Summarize this conversation transcript concisely. Preserve:
- The user's task/goal
- Key decisions made and reasoning
- Important file paths, function names, and code snippets
- Current state of work (what's done, what's remaining)
- Any errors encountered and how they were resolved
- Next steps the assistant was about to take

Output your summary inside <summary></summary> tags. Be thorough but concise.`;

/**
 * Serialize messages into a readable transcript for the compaction summarizer.
 * Handles text, tool_use, tool_result, and compaction blocks.
 */
function serializeMessagesForSummary(messages: Anthropic.MessageParam[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "user" ? "Human" : "Assistant";
    if (typeof msg.content === "string") {
      lines.push(`[${role}]: ${msg.content}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if ("text" in block && typeof block.text === "string") {
        lines.push(`[${role}]: ${block.text}`);
      } else if ("type" in block && block.type === "tool_use") {
        const tu = block as any;
        const inputStr = JSON.stringify(tu.input || {}).slice(0, 500);
        lines.push(`[Called tool: ${tu.name}(${inputStr})]`);
      } else if ("type" in block && block.type === "tool_result") {
        const tr = block as any;
        const content = typeof tr.content === "string"
          ? tr.content.slice(0, 500)
          : JSON.stringify(tr.content || "").slice(0, 500);
        lines.push(`[Tool result]: ${content}`);
      } else if ("type" in block && (block as any).type === "compaction") {
        const cb = block as any;
        if (cb.content) lines.push(`[Previous summary]: ${cb.content}`);
      }
    }
  }
  return lines.join("\n");
}

interface CompactionResult {
  compacted: boolean;
  beforeCount: number;
  afterCount: number;
  tokensSaved: number;
}

/**
 * Client-side compaction for non-Opus models.
 * Summarizes conversation history when input tokens exceed threshold.
 * Non-fatal: catches all errors and returns no-op result.
 */
async function maybeCompactClientSide(
  messages: Anthropic.MessageParam[],
  model: string,
): Promise<CompactionResult> {
  const noOp: CompactionResult = { compacted: false, beforeCount: messages.length, afterCount: messages.length, tokensSaved: 0 };

  // Guard: Opus uses server-side compaction
  if (model.includes("opus-4-6")) return noOp;
  // Guard: not enough tokens to warrant compaction
  if (lastKnownInputTokens < 150_000) return noOp;
  // Guard: too few messages to compact
  if (messages.length < 4) return noOp;

  try {
    const beforeCount = messages.length;
    // Serialize all but the last 2 messages (preserve recent context)
    const toSummarize = messages.slice(0, -2);
    const preserved = messages.slice(-2);
    let transcript = serializeMessagesForSummary(toSummarize);
    // Cap transcript to avoid blowing context on the summarization call itself
    if (transcript.length > 100_000) {
      transcript = transcript.slice(0, 100_000) + "\n\n... (transcript truncated)";
    }

    // Make a non-streaming summarization call
    const apiKey = process.env.ANTHROPIC_API_KEY || loadConfig().anthropic_api_key;
    let summaryText: string | null = null;

    if (apiKey) {
      // Direct API call
      const anthropic = new Anthropic({ apiKey });
      const resp = await anthropic.messages.create({
        model,
        max_tokens: 8192,
        messages: [
          { role: "user", content: `${COMPACTION_SUMMARY_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>` },
        ],
      });
      for (const block of resp.content) {
        if (block.type === "text") {
          summaryText = block.text;
          break;
        }
      }
      // Track compaction call tokens
      sessionInputTokens += resp.usage.input_tokens;
      sessionOutputTokens += resp.usage.output_tokens;
    } else {
      // Proxy fallback (non-streaming)
      const token = await getValidToken();
      if (!token) return noOp;
      const response = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: `${COMPACTION_SUMMARY_PROMPT}\n\n<transcript>\n${transcript}\n</transcript>` },
          ],
          model,
          max_tokens: 8192,
          stream: false,
        }),
      });
      if (!response.ok) return noOp;
      const json = await response.json() as any;
      for (const block of (json.content || [])) {
        if (block.type === "text") {
          summaryText = block.text;
          break;
        }
      }
      // Track proxy compaction tokens
      if (json.usage) {
        sessionInputTokens += json.usage.input_tokens || 0;
        sessionOutputTokens += json.usage.output_tokens || 0;
      }
    }

    if (!summaryText) return noOp;

    // Extract <summary> content
    const summaryMatch = summaryText.match(/<summary>([\s\S]*?)<\/summary>/);
    const summary = summaryMatch ? summaryMatch[1].trim() : summaryText.trim();
    if (!summary) return noOp;

    // Replace messages in-place: [summary user msg] → [ack assistant msg] → [preserved last 2]
    messages.length = 0;
    messages.push({
      role: "user",
      content: `[This conversation was automatically summarized to save context space]\n\n${summary}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I have the conversation context from the summary. Let me continue where we left off.",
    });
    messages.push(...preserved);

    const afterCount = messages.length;
    // Rough token savings estimate: ~4 tokens per message on average overhead
    const tokensSaved = Math.max(0, lastKnownInputTokens - 50_000);
    return { compacted: true, beforeCount, afterCount, tokensSaved };
  } catch {
    // Non-fatal: continue with un-compacted messages
    return noOp;
  }
}

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
  const sections: string[] = [];

  // ── Identity ──
  sections.push(`You are whale code, an interactive CLI agent for software engineering and business operations.
You help users with coding tasks, debugging, refactoring, and managing business data through tools.`);

  // ── Environment ──
  const envLines = [
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().split("T")[0]}`,
  ];
  const gitContext = gatherGitContext();
  if (gitContext) envLines.push(`\n${gitContext}`);
  sections.push(`# Environment\n${envLines.join("\n")}`);

  // ── Doing tasks ──
  sections.push(`# Doing tasks
- The user will primarily request software engineering tasks: solving bugs, adding features, refactoring, explaining code, and more.
- You are highly capable and can complete ambitious, multi-step tasks autonomously. Defer to user judgement about scope.
- ALWAYS read relevant code before proposing changes. Do not modify files you haven't read. Understand existing patterns before editing.
- Prefer editing existing files over creating new ones. Do not create files unless absolutely necessary.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
  - Don't add features, refactor code, or make "improvements" beyond what was asked.
  - Don't add error handling or validation for scenarios that can't happen.
  - Don't create abstractions for one-time operations.
- Be careful not to introduce security vulnerabilities (command injection, XSS, SQL injection, etc.). If you notice insecure code you wrote, fix it immediately.
- If your approach is blocked, do not brute force. Consider alternative approaches or ask the user.`);

  // ── Coding workflow ──
  sections.push(`# Mandatory coding workflow
When making code changes, ALWAYS follow this sequence:

1. **Read** — Read the files you intend to modify. Understand the existing code, imports, types, and patterns.
2. **Plan** — For non-trivial changes, briefly state what you'll change and why BEFORE editing. For multi-file changes, list the files and the change for each.
3. **Edit** — Make targeted, minimal changes. Keep edit batches small (5 or fewer edits before verifying).
4. **Verify** — After each batch of edits, run the build or tests (e.g. \`npm run build\`, \`tsc --noEmit\`, \`pytest\`). Read the output. Fix errors before making more edits.
5. **Report** — Summarize what you changed and the verification results.

CRITICAL RULES:
- NEVER skip step 1. Do not edit files you haven't read in this session.
- NEVER make more than 5-8 edits without running a verification step.
- If a build or test fails, read the error output carefully before attempting a fix. Do not guess.
- If the same fix approach fails twice, STOP. Re-read the relevant code and try a fundamentally different approach.
- If you are stuck after 3 failed attempts, explain what you've tried and ask the user for guidance.`);

  // ── Actions with care ──
  sections.push(`# Executing actions with care
Consider the reversibility and blast radius of your actions:
- Freely take local, reversible actions like editing files or running tests.
- For hard-to-reverse or shared-state actions (deleting files, force-pushing, modifying CI, sending messages), check with the user first.
- Do not use destructive actions as shortcuts. Identify root causes rather than bypassing safety checks.
- If you encounter unexpected state (unfamiliar files, branches, config), investigate before overwriting — it may be the user's in-progress work.`);

  // ── Tool use ──
  let toolSection = `# Using tools
- Use the RIGHT tool for the job. Do NOT use run_command when a dedicated tool exists:
  - read_file to read files (not \`cat\` or \`head\`)
  - edit_file or multi_edit to edit files (not \`sed\` or \`awk\`)
  - write_file to create files (not \`echo >\` or heredocs)
  - glob to find files by pattern (not \`find\` or \`ls\`)
  - grep to search content (not \`grep\` or \`rg\` via run_command)
  - run_command ONLY for shell operations: build, test, git, install, etc.
- Call multiple INDEPENDENT tools in a single response for parallel execution. Do not chain when results are independent.
- Only chain across turns when a result is needed for the next call.
- If a tool fails, read the error. If it fails 3 times, try a different tool or approach entirely.

## Subagents (task tool)
- Use subagents for PARALLEL, INDEPENDENT research (e.g., searching different parts of the codebase simultaneously).
- Use task with run_in_background:true for long-running tasks; check with task_output, stop with task_stop.
- Do NOT spawn subagents for tasks you can do with a single glob or read_file.
- Do NOT use team_create for bug fixes or single-file changes — work directly. Teams are for large features with 3+ independent workstreams.
- Prefer "explore" type for quick codebase searches (2-4 turns). Prefer "general-purpose" for autonomous multi-step tasks.
- Cost-aware model routing for subagents:
  - model:"haiku" — file searches, schema lookups, simple reads, pattern matching
  - model:"sonnet" — code analysis, multi-step research, plan design
  - Only use model:"opus" for subagents needing complex reasoning (rarely needed)`;

  if (hasServerTools) {
    toolSection += `

## Server tools (business operations)
- Server tools (analytics, products, inventory, email, etc.) require UUIDs for mutations.
- ALWAYS look up IDs first: use find/list actions to resolve names to UUIDs before calling create/update/delete.
- Use audit_trail for store activity history (inventory changes, orders, transfers).
- Use telemetry for AI system metrics (conversations, tool performance, errors).`;
  }
  sections.push(toolSection);

  // ── Permission mode ──
  if (activePermissionMode === "plan") {
    sections.push(`# Mode: Plan (read-only)
You are in plan mode. Only read and search tools are available. No file writes or commands.`);
  } else if (activePermissionMode === "yolo") {
    sections.push(`# Mode: Yolo
All tools available without confirmation prompts.`);
  }

  // ── Effort ──
  if (effort === "low") {
    sections.push(`# Effort: Low
Be concise and direct. Minimize exploration. Give brief answers. Skip verification for trivial changes.`);
  } else if (effort === "high") {
    sections.push(`# Effort: High
Be thorough and exhaustive. Explore deeply. Verify all changes. Consider edge cases.`);
  }

  // ── Tone and style ──
  sections.push(`# Tone and style
- Be concise. Use tools to do work — don't just explain what you would do.
- NEVER use emojis — terminal renders them as broken glyphs.
- Include $ on monetary values, % on percentages.
- When referencing code, include file_path:line_number for easy navigation.
- Keep output clean and monospace-aligned.
- Use markdown tables for multi-column data.
- Use \`\`\`chart code blocks for bar charts:
\`\`\`chart
Title
Label: $value
\`\`\``);

  // ── Persistent memory ──
  const memory = loadMemory();
  if (memory) {
    sections.push(`# Memory (persistent across sessions)\n${memory}`);
  }

  // ── Project instructions ──
  const claudeMd = loadClaudeMd();
  if (claudeMd) {
    sections.push(`# Project Instructions (${claudeMd.path})\n${claudeMd.content}`);
  }

  return sections.join("\n\n");
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

// Module-level loop detector — persists session error state across turns
let sessionLoopDetector: LoopDetector | null = null;

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
// PROMPT CACHING — multi-breakpoint (up to 4 cache_control markers)
// ============================================================================

/**
 * Add prompt cache breakpoints to tools and messages.
 * Anthropic allows up to 4 breakpoints. We use:
 * 1. System prompt (handled separately in API call)
 * 2. Last tool definition (stable across turns)
 * 3. Turn boundary (second-to-last message — everything before is unchanged)
 */
function addPromptCaching(
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[]
): { tools: any[]; messages: any[] } {
  // Cache breakpoint 2: last tool definition
  const cachedTools: any[] = tools.length > 0
    ? [...tools.slice(0, -1), { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } }]
    : [...tools];

  // Cache breakpoint 3: turn boundary (second-to-last message)
  const cachedMessages = [...messages];
  if (cachedMessages.length >= 2) {
    const idx = cachedMessages.length - 2;
    const msg = cachedMessages[idx];
    if (typeof msg.content === "string") {
      cachedMessages[idx] = {
        ...msg,
        content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }],
      };
    } else if (Array.isArray(msg.content)) {
      const blocks = [...(msg.content as any[])];
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
      cachedMessages[idx] = { ...msg, content: blocks };
    }
  }

  return { tools: cachedTools, messages: cachedMessages };
}

// ============================================================================
// STREAM VIA DIRECT ANTHROPIC (fallback when proxy unavailable)
// ============================================================================

async function* streamDirect(
  apiKey: string,
  messages: any[],
  tools: any[],
  system: any[],
  signal?: AbortSignal
): AsyncGenerator<any> {
  const anthropic = new Anthropic({ apiKey });
  const maxTokens = getMaxOutputTokens();

  const ctxMgmt = getContextManagement(activeModel);
  const stream = await anthropic.beta.messages.create({
    model: activeModel,
    max_tokens: maxTokens,
    system,
    tools: tools as any,
    messages: messages as any,
    stream: true,
    betas: ctxMgmt.betas,
    context_management: ctxMgmt.config,
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
  signal?: AbortSignal,
  costContext?: string
): Promise<AsyncGenerator<any>> {
  // Multi-breakpoint prompt caching (tools + turn boundary)
  const { tools: cachedTools, messages: cachedMessages } = addPromptCaching(tools, messages);

  // System prompt: cached block + optional dynamic cost context (after cache breakpoint)
  const system: any[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];
  if (costContext) {
    system.push({ type: "text", text: costContext });
  }

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
          messages: cachedMessages,
          system,
          tools: cachedTools,
          model: activeModel,
          max_tokens: getMaxOutputTokens(),
          stream: true,
          betas: getContextManagement(activeModel).betas,
          context_management: getContextManagement(activeModel).config,
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
    return streamDirect(apiKey, cachedMessages, cachedTools, system, signal);
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
  // Build user content — text-only string or content blocks array with images
  let userContent: string | Anthropic.ContentBlockParam[];
  if (opts.images && opts.images.length > 0) {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const img of opts.images) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: img.base64,
        },
      } as any);
    }
    blocks.push({ type: "text", text: message || "(see attached images)" });
    userContent = blocks;
  } else {
    userContent = message;
  }

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: "user", content: userContent },
  ];

  // Session-level loop detector: persists failed strategies across turns.
  // Created once per conversation, reset only when user starts a new conversation.
  if (!sessionLoopDetector || conversationHistory.length === 0) {
    sessionLoopDetector = new LoopDetector();
  }
  const loopDetector = sessionLoopDetector;
  loopDetector.resetTurn();

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
      if (abortSignal?.aborted) {
        logSpan({
          action: "chat.cancelled",
          durationMs: Date.now() - sessionStart,
          context: turnCtx,
          storeId: storeId || undefined,
          details: { iteration, reason: "user_abort" },
        });
        callbacks.onError("Cancelled", messages);
        return;
      }

      // Budget enforcement
      if (opts.maxBudgetUsd && sessionCostUsd >= opts.maxBudgetUsd) {
        logSpan({
          action: "chat.budget_exceeded",
          durationMs: Date.now() - sessionStart,
          context: turnCtx,
          storeId: storeId || undefined,
          severity: "warn",
          details: { session_cost_usd: sessionCostUsd, max_budget_usd: opts.maxBudgetUsd, iteration },
        });
        callbacks.onError(`Budget exceeded: $${sessionCostUsd.toFixed(4)} >= $${opts.maxBudgetUsd}`, messages);
        return;
      }

      const apiStart = Date.now();
      const apiSpanId = generateSpanId(); // Unique span ID for this API call — tools reference as parent

      // Dynamic cost context (placed after cached system prompt so it doesn't break prefix caching)
      const costContext = `Session cost: $${sessionCostUsd.toFixed(2)}${opts.maxBudgetUsd ? ` | Budget remaining: $${(opts.maxBudgetUsd - sessionCostUsd).toFixed(2)}` : ""}`;

      // Get streaming events with retry logic
      let result: StreamResult | null = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const events = await getEventStream(messages, tools, systemPrompt, abortSignal, costContext);
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

      // Client-side compaction for non-Opus models (Sonnet/Haiku)
      if (!activeModel.includes("opus-4-6") && lastKnownInputTokens >= 150_000 && messages.length >= 4) {
        const compactResult = await maybeCompactClientSide(messages, activeModel);
        if (compactResult.compacted) {
          callbacks.onAutoCompact?.(compactResult.beforeCount, compactResult.afterCount, compactResult.tokensSaved);
          emitter?.emitCompact(compactResult.beforeCount, compactResult.afterCount, compactResult.tokensSaved);

          logSpan({
            action: "chat.client_compaction",
            durationMs: 0,
            context: turnCtx,
            storeId: storeId || undefined,
            details: {
              type: "client_side",
              model: activeModel,
              before_messages: compactResult.beforeCount,
              after_messages: compactResult.afterCount,
              tokens_saved: compactResult.tokensSaved,
              iteration,
            },
          });
        }
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
          toolResult = await executeServerTool(tu.name, tu.input);

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
        loopDetector.recordResult(tu.name, toolResult.success, tu.input);
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
          const MAX_TOOL_RESULT_CHARS = opts.effort === "low" ? 10_000 : opts.effort === "high" ? 30_000 : 20_000;
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

      // Bail-out detection: check if the agent is stuck in a failure loop
      const bailCheck = loopDetector.endTurn();
      if (bailCheck.shouldBail && toolResults.length > 0) {
        logSpan({
          action: "chat.bail_out",
          durationMs: Date.now() - sessionStart,
          context: turnCtx,
          storeId: storeId || undefined,
          severity: "warn",
          details: {
            ...loopDetector.getSessionStats(),
            message: bailCheck.message,
            iteration,
          },
        });
        // Prepend bail-out guidance to the last tool result so the model sees it
        const lastResult = toolResults[toolResults.length - 1];
        if (typeof lastResult.content === "string") {
          lastResult.content = `[SYSTEM WARNING] ${bailCheck.message}\n\n${lastResult.content}`;
        }
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

    // Log fatal error to telemetry
    logSpan({
      action: errorMsg === "Cancelled" ? "chat.cancelled" : "chat.fatal_error",
      durationMs: Date.now() - sessionStart,
      context: { ...turnCtx, inputTokens: totalIn, outputTokens: totalOut, model: activeModel },
      storeId: storeId || undefined,
      severity: errorMsg === "Cancelled" ? "info" : "error",
      error: errorMsg === "Cancelled" ? undefined : errorMsg,
      details: {
        input_tokens: totalIn,
        output_tokens: totalOut,
        session_cost_usd: sessionCostUsd,
        model: activeModel,
      },
    });

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
