/**
 * Config Store
 *
 * Persistent configuration at ~/.swagmanager/config.json
 *
 * v2.0: Raw Supabase/Anthropic keys (for MCP server env vars)
 * v2.1: Auth tokens from login flow (for CLI chat/status)
 *
 * Environment variables always override file-based config for MCP server mode.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// TYPES
// ============================================================================

export interface SwagManagerConfig {
  // v2.0 — MCP server mode (env var override)
  supabase_url?: string;
  supabase_key?: string;       // service role key for MCP server
  anthropic_api_key?: string;  // only used by MCP server setup
  default_agent_id?: string;

  // v2.1 — Auth mode (login flow)
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  email?: string;
  store_id?: string;
  store_name?: string;
  expires_at?: number;         // unix epoch seconds
}

// ============================================================================
// PATHS
// ============================================================================

const CONFIG_DIR = join(homedir(), ".swagmanager");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// ============================================================================
// READ / WRITE
// ============================================================================

export function loadConfig(): SwagManagerConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {
    // Corrupted file — return empty
  }
  return {};
}

export function saveConfig(config: SwagManagerConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function updateConfig(partial: Partial<SwagManagerConfig>): void {
  const existing = loadConfig();
  saveConfig({ ...existing, ...partial });
}

export function clearConfig(): void {
  try {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  } catch { /* ignore */ }
}

// ============================================================================
// RESOLVED CONFIG (env vars override file — used by MCP server)
// ============================================================================

export interface ResolvedConfig {
  supabaseUrl: string;
  supabaseKey: string;
  storeId: string;
  anthropicApiKey: string;
  defaultAgentId: string;
}

export function resolveConfig(): ResolvedConfig {
  const file = loadConfig();
  return {
    supabaseUrl: process.env.SUPABASE_URL || file.supabase_url || "",
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || file.supabase_key || "",
    storeId: process.env.STORE_ID || file.store_id || "",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || file.anthropic_api_key || "",
    defaultAgentId: file.default_agent_id || "",
  };
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
