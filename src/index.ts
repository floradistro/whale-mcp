#!/usr/bin/env node
/**
 * SwagManager MCP Server
 *
 * Thin proxy that connects any MCP client (Claude Code, Cursor, etc.)
 * to the SwagManager platform.
 *
 * - Tool DEFINITIONS loaded from ai_tool_registry (database-driven)
 * - Tool EXECUTION proxied to the agent-chat edge function (server-driven)
 *
 * When tools change on the server, this MCP server automatically picks
 * them up — no code changes, no rebuild, no redeploy.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { startUpdateLoop } from "./updater.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STORE_ID = process.env.STORE_ID || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables required");
  console.error("");
  console.error("Set them in your MCP client config:");
  console.error('  "env": {');
  console.error('    "SUPABASE_URL": "https://your-project.supabase.co",');
  console.error('    "SUPABASE_SERVICE_ROLE_KEY": "your-key-here"');
  console.error("  }");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Edge function URL for tool execution
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/agent-chat`;

// Session ID for tracing — links all tool calls in one conversation
const SESSION_ID = crypto.randomUUID();

// ============================================================================
// TOOL DEFINITIONS (loaded from database)
// ============================================================================

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

let toolDefinitions: ToolDefinition[] = [];
let toolsLoadedAt = 0;
const TOOL_CACHE_TTL = 60_000; // 1 minute

async function loadToolDefinitions(force = false): Promise<ToolDefinition[]> {
  if (!force && toolDefinitions.length > 0 && Date.now() - toolsLoadedAt < TOOL_CACHE_TTL) {
    return toolDefinitions;
  }

  try {
    const { data, error } = await supabase
      .from("ai_tool_registry")
      .select("name, description, definition")
      .eq("is_active", true)
      .neq("tool_mode", "code");

    if (error) {
      console.error("[MCP] Failed to load tools from registry:", error.message);
      return toolDefinitions; // Return stale cache on error
    }

    toolDefinitions = (data || []).map(t => ({
      name: t.name,
      description: t.description || t.definition?.description || `Execute ${t.name}`,
      inputSchema: t.definition?.input_schema || { type: "object", properties: {} }
    }));
    toolsLoadedAt = Date.now();

    return toolDefinitions;
  } catch (err) {
    console.error("[MCP] Error loading tool definitions:", err);
    return toolDefinitions;
  }
}

// ============================================================================
// TOOL EXECUTION (proxied to edge function)
// ============================================================================

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

async function executeToolRemote(
  toolName: string,
  args: Record<string, unknown>,
  storeId?: string
): Promise<ToolResult> {
  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        mode: "tool",
        tool_name: toolName,
        args,
        store_id: storeId,
      }),
    });

    const result = await response.json() as ToolResult;
    return result;
  } catch (err: any) {
    return {
      success: false,
      error: `Edge function call failed: ${err.message}`,
    };
  }
}

// ============================================================================
// MCP SERVER
// ============================================================================

const server = new Server(
  { name: "swagmanager", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// List available tools — from database
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = await loadToolDefinitions();
  console.error(`[MCP] Returning ${tools.length} tools`);

  return {
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

// Execute a tool — proxied to edge function
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const toolArgs = (request.params.arguments || {}) as Record<string, any>;

  console.error(`[MCP] Executing: ${toolName} → edge function`);

  const result = await executeToolRemote(toolName, toolArgs, STORE_ID || undefined);

  if (result.success) {
    return {
      content: [{
        type: "text" as const,
        text: typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data, null, 2),
      }],
    };
  } else {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ error: result.error }),
      }],
      isError: true,
    };
  }
});

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  console.error("[MCP] SwagManager MCP Server v2.0.0 (proxy mode)");
  console.error(`[MCP] Supabase: ${SUPABASE_URL}`);
  console.error(`[MCP] Edge function: ${EDGE_FUNCTION_URL}`);
  console.error(`[MCP] Store: ${STORE_ID || "(default)"}`);
  console.error(`[MCP] Session: ${SESSION_ID}`);

  // Pre-load tools from database
  const tools = await loadToolDefinitions(true);
  console.error(`[MCP] Loaded ${tools.length} tools from registry`);

  // Start OTA update checker (non-blocking, runs in background)
  startUpdateLoop(true);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Ready");
}

main().catch((err) => {
  console.error("[MCP] Fatal:", err);
  process.exit(1);
});
