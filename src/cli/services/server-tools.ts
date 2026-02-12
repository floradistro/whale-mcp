/**
 * Server Tools — loaded dynamically from ai_tool_registry
 *
 * Single source of truth: the database. Same as the MCP server (index.ts).
 * No hardcoded definitions. Tools are cached for 60s after first load.
 *
 * Execution: proxied to the agent-chat edge function (mode: "tool").
 * All business logic lives server-side — CLI is a thin client.
 * Claude formats the JSON results for the user (no client-side formatter).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { resolveConfig } from "./config-store.js";
import { getValidToken, SUPABASE_URL, createAuthenticatedClient } from "./auth-service.js";

// ============================================================================
// TYPES
// ============================================================================

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface ServerStatus {
  connected: boolean;
  storeId: string;
  storeName: string;
  toolCount: number;
  authMethod: "service_role" | "jwt" | "none";
}

// ============================================================================
// SUPABASE CLIENT (tiered: service role > user JWT)
// Used only for loading tool definitions from ai_tool_registry.
// Tool execution goes through the edge function.
// ============================================================================

let cachedClient: SupabaseClient | null = null;
let cachedStoreId: string = "";
let cachedAuthMethod: "service_role" | "jwt" | "none" = "none";
let cachedToken: string = "";

async function getSupabaseClient(): Promise<{ client: SupabaseClient; storeId: string } | null> {
  const config = resolveConfig();

  // Tier 1: Service role key (full access, MCP server mode) — never expires
  if (config.supabaseUrl && config.supabaseKey) {
    if (cachedClient && cachedAuthMethod === "service_role") {
      return { client: cachedClient, storeId: cachedStoreId };
    }
    cachedClient = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    cachedStoreId = config.storeId || "";
    cachedAuthMethod = "service_role";
    return { client: cachedClient, storeId: cachedStoreId };
  }

  // Tier 2: User JWT (CLI login) — recreate client when token refreshes
  const token = await getValidToken();
  if (token) {
    if (cachedClient && cachedToken === token) {
      cachedStoreId = config.storeId || "";
      return { client: cachedClient, storeId: cachedStoreId };
    }
    cachedClient = createAuthenticatedClient(token);
    cachedToken = token;
    cachedStoreId = config.storeId || "";
    cachedAuthMethod = "jwt";
    return { client: cachedClient, storeId: cachedStoreId };
  }

  cachedClient = null;
  cachedToken = "";
  cachedAuthMethod = "none";
  return null;
}

export function resetServerToolClient(): void {
  cachedClient = null;
  cachedStoreId = "";
  cachedToken = "";
  cachedAuthMethod = "none";
  connectionVerified = false;
  // Also clear tool cache so next load fetches fresh
  loadedTools = [];
  loadedToolNames.clear();
  toolsLoadedAt = 0;
}

// ============================================================================
// CONNECTION CHECK
// ============================================================================

let connectionVerified = false;

export async function checkConnection(): Promise<boolean> {
  if (connectionVerified) return true;

  const conn = await getSupabaseClient();
  if (!conn) return false;

  try {
    // Quick health check — query a small table
    const { error } = await conn.client.from("stores").select("id").limit(1);
    connectionVerified = !error;
    return connectionVerified;
  } catch {
    return false;
  }
}

// ============================================================================
// TOOL DEFINITIONS — loaded from ai_tool_registry (single source of truth)
// ============================================================================

let loadedTools: Anthropic.Tool[] = [];
let loadedToolNames = new Set<string>();
let toolsLoadedAt = 0;
const TOOL_CACHE_TTL = 60_000; // 1 minute

/**
 * Load server tool definitions from ai_tool_registry.
 * Same query as the MCP server (index.ts). Cached for 60s.
 * Filters out tool_mode='code' (those are local CLI tools).
 */
export async function loadServerToolDefinitions(force = false): Promise<Anthropic.Tool[]> {
  // Return cache if fresh
  if (!force && loadedTools.length > 0 && Date.now() - toolsLoadedAt < TOOL_CACHE_TTL) {
    return loadedTools;
  }

  const conn = await getSupabaseClient();
  if (!conn) return [];

  try {
    const { data, error } = await conn.client
      .from("ai_tool_registry")
      .select("name, description, definition")
      .eq("is_active", true)
      .neq("tool_mode", "code");

    if (error) {
      console.error("[server-tools] Failed to load from ai_tool_registry:", error.message);
      return loadedTools; // Return stale cache on error
    }

    loadedTools = (data || []).map(t => ({
      name: t.name,
      description: t.description || t.definition?.description || `Execute ${t.name}`,
      input_schema: t.definition?.input_schema || { type: "object" as const, properties: {} },
    }));

    // Rebuild the name set
    loadedToolNames.clear();
    for (const tool of loadedTools) {
      loadedToolNames.add(tool.name);
    }

    toolsLoadedAt = Date.now();
    connectionVerified = true;

    return loadedTools;
  } catch (err) {
    console.error("[server-tools] Error loading tool definitions:", err);
    return loadedTools;
  }
}

/**
 * Check if a tool name is a server tool.
 * After first load, checks against the dynamically loaded set.
 */
export function isServerTool(name: string): boolean {
  return loadedToolNames.has(name);
}

/**
 * Get currently loaded definitions (for /tools listing).
 * Returns whatever is cached — call loadServerToolDefinitions() first to populate.
 */
export function getAllServerToolDefinitions(): Anthropic.Tool[] {
  return loadedTools;
}

// ============================================================================
// SERVER STATUS
// ============================================================================

export async function getServerStatus(): Promise<ServerStatus> {
  const { loadConfig } = await import("./config-store.js");
  const config = loadConfig();

  // Loading tools also verifies connection
  const tools = await loadServerToolDefinitions();
  return {
    connected: tools.length > 0,
    storeId: config.store_id || "",
    storeName: config.store_name || "",
    toolCount: tools.length,
    authMethod: cachedAuthMethod,
  };
}

// ============================================================================
// EXECUTE SERVER TOOL — proxied to edge function
// ============================================================================

/**
 * Execute a server tool via the agent-chat edge function (mode: "tool").
 * Returns the raw JSON from the edge function — Claude formats it for the user.
 * No client-side formatting: the model is the presentation layer.
 */
export async function executeServerTool(
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const config = resolveConfig();
  const supabaseUrl = config.supabaseUrl || SUPABASE_URL;
  if (!supabaseUrl) {
    return { success: false, output: "No Supabase URL configured — server tools unavailable. Run: whale login" };
  }

  // Auth token: service role key preferred, user JWT fallback
  let authToken = config.supabaseKey;
  if (!authToken) {
    authToken = await getValidToken() || "";
  }
  if (!authToken) {
    return { success: false, output: "No auth token — server tools unavailable. Run: whale login" };
  }

  try {
    const edgeFunctionUrl = `${supabaseUrl}/functions/v1/agent-chat`;
    const response = await fetch(edgeFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        mode: "tool",
        tool_name: name,
        args: input,
        store_id: config.storeId || undefined,
      }),
    });

    const result = await response.json() as { success: boolean; data?: unknown; error?: string };

    if (result.success) {
      // Return raw JSON — Claude formats it for the user
      let output = typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2);

      // Pre-truncate large results to prevent context blowout
      const MAX_SERVER_RESULT_CHARS = 30_000;
      if (output.length > MAX_SERVER_RESULT_CHARS) {
        output = output.slice(0, MAX_SERVER_RESULT_CHARS)
          + `\n\n... (truncated — ${output.length.toLocaleString()} chars total. Use filters or limit param for smaller results.)`;
      }
      return { success: true, output };
    }

    return { success: false, output: result.error || "Unknown server tool error" };
  } catch (err: any) {
    return { success: false, output: `Server tool error: ${err.message || err}` };
  }
}
