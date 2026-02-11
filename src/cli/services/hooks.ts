/**
 * Hooks System — Claude Code-style user-configurable shell commands
 *
 * Hooks fire on events like:
 * - PreToolCall: Before any tool execution
 * - PostToolCall: After tool returns
 * - UserPromptSubmit: Before sending to API
 * - FileWrite: After any file is written
 *
 * Configuration in ~/.swagmanager/hooks.json or .whale/hooks.json
 */

import { execSync, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================================================
// TYPES
// ============================================================================

export type HookEvent =
  | "PreToolCall"
  | "PostToolCall"
  | "UserPromptSubmit"
  | "FileWrite"
  | "SessionStart"
  | "SessionEnd";

export interface HookDefinition {
  event: HookEvent;
  command: string;
  timeout?: number;      // ms, default 10000
  cwd?: string;          // working directory
  enabled?: boolean;     // default true
  pattern?: string;      // regex to match tool name or file path
}

export interface HooksConfig {
  hooks: HookDefinition[];
}

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  filePath?: string;
  userPrompt?: string;
  cwd: string;
}

export interface HookResult {
  success: boolean;
  output?: string;
  error?: string;
  blocked?: boolean;    // If true, prevents the action
  blockedMessage?: string;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

const GLOBAL_HOOKS_PATH = join(homedir(), ".swagmanager", "hooks.json");
const LOCAL_HOOKS_PATH = ".whale/hooks.json";

let cachedConfig: HooksConfig | null = null;
let configLoadedAt = 0;
const CONFIG_TTL = 30_000; // 30 second cache

function loadHooksConfig(): HooksConfig {
  const now = Date.now();
  if (cachedConfig && now - configLoadedAt < CONFIG_TTL) {
    return cachedConfig;
  }

  const hooks: HookDefinition[] = [];

  // Load global hooks
  if (existsSync(GLOBAL_HOOKS_PATH)) {
    try {
      const global = JSON.parse(readFileSync(GLOBAL_HOOKS_PATH, "utf-8"));
      if (Array.isArray(global.hooks)) {
        hooks.push(...global.hooks);
      }
    } catch { /* skip invalid */ }
  }

  // Load local hooks (project-specific, higher priority)
  const localPath = join(process.cwd(), LOCAL_HOOKS_PATH);
  if (existsSync(localPath)) {
    try {
      const local = JSON.parse(readFileSync(localPath, "utf-8"));
      if (Array.isArray(local.hooks)) {
        hooks.push(...local.hooks);
      }
    } catch { /* skip invalid */ }
  }

  cachedConfig = { hooks };
  configLoadedAt = now;
  return cachedConfig;
}

export function reloadHooksConfig(): void {
  cachedConfig = null;
  configLoadedAt = 0;
}

// ============================================================================
// HOOK EXECUTION
// ============================================================================

function matchesPattern(value: string | undefined, pattern: string | undefined): boolean {
  if (!pattern) return true; // No pattern = match all
  if (!value) return false;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return value.includes(pattern);
  }
}

function buildEnv(context: HookContext): Record<string, string> {
  return {
    ...process.env,
    WHALE_EVENT: context.event,
    WHALE_CWD: context.cwd,
    WHALE_TOOL_NAME: context.toolName || "",
    WHALE_TOOL_INPUT: context.toolInput ? JSON.stringify(context.toolInput) : "",
    WHALE_TOOL_OUTPUT: context.toolOutput ? JSON.stringify(context.toolOutput) : "",
    WHALE_FILE_PATH: context.filePath || "",
    WHALE_USER_PROMPT: context.userPrompt || "",
  } as Record<string, string>;
}

async function runHook(
  hook: HookDefinition,
  context: HookContext
): Promise<HookResult> {
  const timeout = hook.timeout || 10_000;
  const cwd = hook.cwd || context.cwd;

  try {
    const output = execSync(hook.command, {
      encoding: "utf-8",
      timeout,
      cwd,
      env: buildEnv(context),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });

    return { success: true, output: output.trim() };
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    const output = stderr || stdout || err.message;

    // Check if hook is blocking the action
    const isBlocking = output.toLowerCase().includes("[blocked]") ||
                       err.status === 77; // Exit code 77 = blocked

    if (isBlocking) {
      return {
        success: false,
        error: output,
        blocked: true,
        blockedMessage: output.replace(/\[blocked\]/gi, "").trim(),
      };
    }

    return { success: false, error: output };
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function runHooks(
  event: HookEvent,
  context: Omit<HookContext, "event">
): Promise<HookResult[]> {
  const config = loadHooksConfig();
  const results: HookResult[] = [];

  const matchValue = event === "FileWrite" ? context.filePath :
                     event.includes("Tool") ? context.toolName :
                     undefined;

  for (const hook of config.hooks) {
    if (hook.event !== event) continue;
    if (hook.enabled === false) continue;
    if (!matchesPattern(matchValue, hook.pattern)) continue;

    const result = await runHook(hook, { ...context, event });
    results.push(result);

    // If blocked, stop processing further hooks
    if (result.blocked) break;
  }

  return results;
}

export function isBlocked(results: HookResult[]): { blocked: boolean; message?: string } {
  const blockedResult = results.find((r) => r.blocked);
  if (blockedResult) {
    return { blocked: true, message: blockedResult.blockedMessage };
  }
  return { blocked: false };
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

export async function runPreToolHooks(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<{ allowed: boolean; message?: string }> {
  const results = await runHooks("PreToolCall", {
    cwd: process.cwd(),
    toolName,
    toolInput,
  });

  const blocked = isBlocked(results);
  return { allowed: !blocked.blocked, message: blocked.message };
}

export async function runPostToolHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: unknown
): Promise<void> {
  await runHooks("PostToolCall", {
    cwd: process.cwd(),
    toolName,
    toolInput,
    toolOutput,
  });
}

export async function runPromptSubmitHooks(
  userPrompt: string
): Promise<{ allowed: boolean; message?: string }> {
  const results = await runHooks("UserPromptSubmit", {
    cwd: process.cwd(),
    userPrompt,
  });

  const blocked = isBlocked(results);
  return { allowed: !blocked.blocked, message: blocked.message };
}

export async function runFileWriteHooks(filePath: string): Promise<void> {
  await runHooks("FileWrite", {
    cwd: process.cwd(),
    filePath,
  });
}

// ============================================================================
// EXAMPLE CONFIG
// ============================================================================

export const EXAMPLE_HOOKS_CONFIG: HooksConfig = {
  hooks: [
    {
      event: "FileWrite",
      pattern: "\\.ts$",
      command: "npx eslint --fix $WHALE_FILE_PATH",
      timeout: 30000,
    },
    {
      event: "PostToolCall",
      pattern: "^edit_file$",
      command: "echo 'File edited: $WHALE_FILE_PATH'",
    },
    {
      event: "PreToolCall",
      pattern: "^run_command$",
      command: "echo 'Running command...'",
    },
  ],
};
