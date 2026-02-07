#!/usr/bin/env node
/**
 * SwagManager MCP Server
 *
 * Standalone MCP server for managing inventory, orders, analytics,
 * customers, products, and more from any MCP client (Claude Code,
 * Claude Desktop, Cursor, etc.)
 *
 * Connects to your Supabase backend. Tools are loaded dynamically
 * from the ai_tool_registry table.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import { executeTool, getImplementedTools } from "./tools/executor.js";

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

// Session ID for tracing — links all tool calls in one conversation
const SESSION_ID = crypto.randomUUID();

// ============================================================================
// TOOL DEFINITIONS
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
      .eq("is_active", true);

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
// MCP SERVER
// ============================================================================

const server = new Server(
  { name: "swagmanager", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// List available tools
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

// Execute a tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const toolArgs = (request.params.arguments || {}) as Record<string, any>;

  console.error(`[MCP] Executing: ${toolName}`);

  // Validate tool is implemented
  const implementedTools = getImplementedTools();
  if (!implementedTools.includes(toolName)) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ error: `Tool "${toolName}" not implemented` }),
      }],
      isError: true,
    };
  }

  // Execute with telemetry context
  const result = await executeTool(supabase, toolName, toolArgs, STORE_ID || undefined, {
    source: "mcp",
    requestId: SESSION_ID
  });

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
  console.error("[MCP] SwagManager MCP Server v1.0.0");
  console.error(`[MCP] Supabase: ${SUPABASE_URL}`);
  console.error(`[MCP] Store: ${STORE_ID || "(default)"}`);
  console.error(`[MCP] Session: ${SESSION_ID}`);

  // Pre-load tools
  const tools = await loadToolDefinitions(true);
  console.error(`[MCP] Loaded ${tools.length} tools`);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Ready");
}

main().catch((err) => {
  console.error("[MCP] Fatal:", err);
  process.exit(1);
});
