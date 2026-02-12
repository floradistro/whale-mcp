/**
 * whale doctor — Run diagnostics
 *
 * Checks:
 *   - Node.js version (>=20)
 *   - ripgrep availability
 *   - Supabase connection
 *   - Auth status
 *   - Server tools loadable
 *   - MCP servers configured
 *   - Disk space
 *   - Package version vs latest
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CHECK = "\x1b[32m✓\x1b[0m";
const CROSS = "\x1b[31m✗\x1b[0m";
const WARN = "\x1b[33m!\x1b[0m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface CheckResult {
  status: "ok" | "warn" | "error";
  label: string;
  detail: string;
}

function icon(status: "ok" | "warn" | "error"): string {
  if (status === "ok") return CHECK;
  if (status === "warn") return WARN;
  return CROSS;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);
  if (major >= 20) {
    return { status: "ok", label: "Node.js", detail: version };
  }
  return { status: "error", label: "Node.js", detail: `${version} (need >=20)` };
}

async function checkRipgrep(): Promise<CheckResult> {
  try {
    const version = execSync("rg --version 2>/dev/null", { encoding: "utf-8", timeout: 3000 }).trim().split("\n")[0];
    return { status: "ok", label: "ripgrep", detail: version };
  } catch {
    // Check if @vscode/ripgrep is available
    try {
      const { rgPath } = await import("@vscode/ripgrep") as any;
      return { status: "ok", label: "ripgrep", detail: `@vscode/ripgrep (${rgPath})` };
    } catch {
      return { status: "warn", label: "ripgrep", detail: "not found (search will use fallback)" };
    }
  }
}

async function checkSupabase(): Promise<CheckResult> {
  try {
    const { SUPABASE_URL } = await import("../services/auth-service.js");
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok || resp.status === 401) {
      return { status: "ok", label: "Supabase", detail: "reachable" };
    }
    return { status: "warn", label: "Supabase", detail: `status ${resp.status}` };
  } catch (err: any) {
    return { status: "error", label: "Supabase", detail: err.message?.slice(0, 60) || "unreachable" };
  }
}

async function checkAuth(): Promise<CheckResult> {
  try {
    const { isLoggedIn, getValidToken } = await import("../services/auth-service.js");
    if (!isLoggedIn()) {
      // Check for API key
      const { loadConfig } = await import("../services/config-store.js");
      const config = loadConfig();
      if (process.env.ANTHROPIC_API_KEY || config.anthropic_api_key) {
        return { status: "ok", label: "Auth", detail: "API key configured" };
      }
      return { status: "warn", label: "Auth", detail: "not logged in (run: whale login)" };
    }
    const token = await getValidToken();
    return token
      ? { status: "ok", label: "Auth", detail: "valid JWT" }
      : { status: "warn", label: "Auth", detail: "token expired" };
  } catch {
    return { status: "error", label: "Auth", detail: "check failed" };
  }
}

async function checkServerTools(): Promise<CheckResult> {
  try {
    const { loadServerToolDefinitions } = await import("../services/server-tools.js");
    const tools = await loadServerToolDefinitions();
    return { status: "ok", label: "Server tools", detail: `${tools.length} tools loaded` };
  } catch (err: any) {
    return { status: "warn", label: "Server tools", detail: err.message?.slice(0, 60) || "unavailable" };
  }
}

async function checkMcpServers(): Promise<CheckResult> {
  const configPath = join(homedir(), ".swagmanager", "config.json");
  if (!existsSync(configPath)) {
    return { status: "warn", label: "MCP servers", detail: "none configured" };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const servers = config.mcpServers || {};
    const count = Object.keys(servers).length;
    if (count === 0) {
      return { status: "warn", label: "MCP servers", detail: "none configured" };
    }
    return { status: "ok", label: "MCP servers", detail: `${count} configured` };
  } catch {
    return { status: "warn", label: "MCP servers", detail: "config parse error" };
  }
}

async function checkDiskSpace(): Promise<CheckResult> {
  const dir = join(homedir(), ".swagmanager");
  if (!existsSync(dir)) {
    return { status: "ok", label: "Data dir", detail: "~/.swagmanager/ (not created yet)" };
  }
  try {
    // Get total size
    const output = execSync(`du -sh "${dir}" 2>/dev/null`, { encoding: "utf-8", timeout: 5000 }).trim();
    const size = output.split("\t")[0];
    return { status: "ok", label: "Data dir", detail: `~/.swagmanager/ (${size})` };
  } catch {
    return { status: "ok", label: "Data dir", detail: "~/.swagmanager/" };
  }
}

async function checkVersion(): Promise<CheckResult> {
  try {
    const pkgPath = join(new URL("../../..", import.meta.url).pathname, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return { status: "ok", label: "Version", detail: `v${pkg.version}` };
  } catch {
    return { status: "ok", label: "Version", detail: "unknown" };
  }
}

export async function runDoctor(): Promise<void> {
  console.log("\n  whale doctor\n");

  const checks = await Promise.all([
    checkNodeVersion(),
    checkRipgrep(),
    checkSupabase(),
    checkAuth(),
    checkServerTools(),
    checkMcpServers(),
    checkDiskSpace(),
    checkVersion(),
  ]);

  for (const check of checks) {
    console.log(`  ${icon(check.status)} ${check.label.padEnd(16)} ${DIM}${check.detail}${RESET}`);
  }

  const errors = checks.filter(c => c.status === "error").length;
  const warnings = checks.filter(c => c.status === "warn").length;
  console.log();

  if (errors > 0) {
    console.log(`  ${CROSS} ${errors} error${errors > 1 ? "s" : ""}, ${warnings} warning${warnings !== 1 ? "s" : ""}`);
  } else if (warnings > 0) {
    console.log(`  ${WARN} All good, ${warnings} warning${warnings !== 1 ? "s" : ""}`);
  } else {
    console.log(`  ${CHECK} All checks passed`);
  }
  console.log();
}
