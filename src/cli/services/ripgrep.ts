/**
 * Ripgrep Integration — fast search via `rg` binary
 *
 * Tries system `rg` first, then falls back to @vscode/ripgrep package.
 * If neither available, callers fall back to grep/find.
 */

import { execSync, execFileSync } from "child_process";
import { join } from "path";

// ============================================================================
// RG BINARY DISCOVERY
// ============================================================================

let rgPathCache: string | null | undefined = undefined; // undefined = unchecked

function findSystemRg(): string | null {
  try {
    const path = execSync("which rg", { encoding: "utf-8", timeout: 3000 }).trim();
    if (path) return path;
  } catch { /* not on PATH */ }
  return null;
}

function findVscodeRg(): string | null {
  try {
    const rgModule = require("@vscode/ripgrep");
    if (rgModule?.rgPath) return rgModule.rgPath;
  } catch { /* package not installed */ }
  return null;
}

export function getRgPath(): string | null {
  if (rgPathCache !== undefined) return rgPathCache;
  rgPathCache = findSystemRg() || findVscodeRg();
  return rgPathCache;
}

export function isRgAvailable(): boolean {
  return getRgPath() !== null;
}

// ============================================================================
// RIPGREP GREP — content search
// ============================================================================

export interface RgGrepOptions {
  pattern: string;
  path: string;
  outputMode?: "content" | "files_with_matches" | "count";
  glob?: string;
  type?: string;
  caseInsensitive?: boolean;
  multiline?: boolean;
  context?: number;
  before?: number;
  after?: number;
  headLimit?: number;
}

export function rgGrep(opts: RgGrepOptions): string | null {
  const rg = getRgPath();
  if (!rg) return null;

  const args: string[] = [];

  // Output mode
  switch (opts.outputMode) {
    case "files_with_matches": args.push("-l"); break;
    case "count": args.push("-c"); break;
    case "content": args.push("-n"); break;
    default: args.push("-l"); break;
  }

  // Case sensitivity
  if (opts.caseInsensitive) args.push("-i");

  // Multiline
  if (opts.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  // Context lines (content mode only)
  if (opts.outputMode === "content") {
    if (opts.context) args.push("-C", String(opts.context));
    if (opts.before) args.push("-B", String(opts.before));
    if (opts.after) args.push("-A", String(opts.after));
  }

  // File type filter
  if (opts.type) args.push("--type", opts.type);
  if (opts.glob) args.push("--glob", opts.glob);

  // Exclusions
  args.push("--glob", "!node_modules", "--glob", "!.git", "--glob", "!dist");

  // Pattern and path
  args.push("--", opts.pattern, opts.path);

  const limit = opts.headLimit || 200;

  try {
    const output = execFileSync(rg, args, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"], // Suppress stderr from leaking to terminal
    });

    // Apply head limit
    const lines = output.split("\n");
    const limited = lines.slice(0, limit).join("\n");
    return limited.trim() || null;
  } catch (err: any) {
    // rg exits 1 for "no matches" — that's not an error
    if (err.status === 1) return null;
    // rg exits 2 for actual errors (permission denied etc.) — don't throw, return null
    if (err.status === 2) return null;
    throw err;
  }
}

// ============================================================================
// RIPGREP GLOB — fast file finding
// ============================================================================

export interface RgGlobOptions {
  pattern: string;
  path: string;
  headLimit?: number;
}

export function rgGlob(opts: RgGlobOptions): string | null {
  const rg = getRgPath();
  if (!rg) return null;

  const args = [
    "--files",
    "--glob", opts.pattern,
    "--glob", "!node_modules",
    "--glob", "!.git",
    "--glob", "!dist",
    opts.path,
  ];

  const limit = opts.headLimit || 200;

  try {
    const output = execFileSync(rg, args, {
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"], // Suppress stderr from leaking to terminal
    });

    const files = output.trim().split("\n").filter(Boolean);
    const limited = files.slice(0, limit);
    return limited.length > 0 ? limited.join("\n") : null;
  } catch (err: any) {
    if (err.status === 1) return null;
    if (err.status === 2) return null; // Permission errors etc.
    throw err;
  }
}
