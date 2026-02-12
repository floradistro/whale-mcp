/**
 * Debug Logging — structured JSONL debug output
 *
 * Writes to ~/.swagmanager/debug/{sessionId}.log
 * Categories: api, tools, context, hooks, sandbox
 * Enabled via --debug flag or --debug api,tools (selective)
 */

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEBUG_DIR = join(homedir(), ".swagmanager", "debug");

let debugSessionId: string | null = null;
let debugFilter: Set<string> | null = null; // null = all categories
let debugEnabled = false;

export function initDebugLog(sessionId: string, filter?: string): void {
  debugEnabled = true;
  debugSessionId = sessionId;

  if (filter && filter !== "true" && filter !== "1") {
    debugFilter = new Set(filter.split(",").map(s => s.trim()));
  } else {
    debugFilter = null; // all categories
  }

  if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR, { recursive: true });
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function debugLog(category: string, message: string, data?: Record<string, unknown>): void {
  if (!debugEnabled || !debugSessionId) return;
  if (debugFilter && !debugFilter.has(category)) return;

  const entry = {
    ts: new Date().toISOString(),
    cat: category,
    msg: message,
    ...data,
  };

  const logPath = join(DEBUG_DIR, `${debugSessionId}.log`);

  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best effort
  }

  // Also write to stderr for --print mode visibility
  if (process.env.WHALE_DEBUG_STDERR === "1") {
    process.stderr.write(`[${category}] ${message}\n`);
  }
}
