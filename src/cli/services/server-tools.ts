/**
 * Server Tools — the 16 MCP server tools available in the CLI
 *
 * Tool definitions are hardcoded (same codebase — no network hop for schemas).
 * Execution: direct import of executeTool() from executor.ts.
 * Supabase client: service role key preferred, user JWT fallback.
 * Connection check: verifies Supabase is reachable before marking tools active.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { resolveConfig } from "./config-store.js";
import { getValidToken, SUPABASE_URL, createAuthenticatedClient } from "./auth-service.js";
import { executeTool, type ExecutionContext, type ToolResult as ServerToolResult } from "../../tools/executor.js";

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
// SERVER TOOL NAMES
// ============================================================================

const SERVER_TOOL_NAMES = new Set([
  "inventory",
  "inventory_query",
  "inventory_audit",
  "purchase_orders",
  "transfers",
  "collections",
  "customers",
  "products",
  "analytics",
  "locations",
  "orders",
  "suppliers",
  "email",
  "documents",
  "alerts",
  "audit_trail",
]);

export function isServerTool(name: string): boolean {
  return SERVER_TOOL_NAMES.has(name);
}

// ============================================================================
// SUPABASE CLIENT (tiered: service role > user JWT)
// ============================================================================

let cachedClient: SupabaseClient | null = null;
let cachedStoreId: string = "";
let cachedAuthMethod: "service_role" | "jwt" | "none" = "none";

async function getSupabaseClient(): Promise<{ client: SupabaseClient; storeId: string } | null> {
  if (cachedClient) {
    return { client: cachedClient, storeId: cachedStoreId };
  }

  const config = resolveConfig();

  // Tier 1: Service role key (full access, MCP server mode)
  if (config.supabaseUrl && config.supabaseKey) {
    cachedClient = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    cachedStoreId = config.storeId || "";
    cachedAuthMethod = "service_role";
    return { client: cachedClient, storeId: cachedStoreId };
  }

  // Tier 2: User JWT (CLI login)
  const token = await getValidToken();
  if (token) {
    cachedClient = createAuthenticatedClient(token);
    cachedStoreId = config.storeId || "";
    cachedAuthMethod = "jwt";
    return { client: cachedClient, storeId: cachedStoreId };
  }

  cachedAuthMethod = "none";
  return null;
}

export function resetServerToolClient(): void {
  cachedClient = null;
  cachedStoreId = "";
  cachedAuthMethod = "none";
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

export async function getServerStatus(): Promise<ServerStatus> {
  const { loadConfig } = await import("./config-store.js");
  const config = loadConfig();

  const connected = await checkConnection();
  return {
    connected,
    storeId: config.store_id || "",
    storeName: config.store_name || "",
    toolCount: connected ? SERVER_TOOL_DEFINITIONS.length : 0,
    authMethod: cachedAuthMethod,
  };
}

// ============================================================================
// HARDCODED TOOL DEFINITIONS (always available — no DB dependency)
// ============================================================================

const SERVER_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "inventory",
    description: "Manage inventory: adjust quantities, set stock levels, transfer between locations, bulk operations. Actions: adjust, set, transfer, bulk_adjust, bulk_set, bulk_clear",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["adjust", "set", "transfer", "bulk_adjust", "bulk_set", "bulk_clear"], description: "Action to perform" },
        product_id: { type: "string", description: "Product ID" },
        location_id: { type: "string", description: "Location ID" },
        quantity: { type: "number", description: "Quantity to set or transfer" },
        adjustment: { type: "number", description: "Quantity adjustment (+/-)" },
        from_location_id: { type: "string", description: "Source location for transfer" },
        to_location_id: { type: "string", description: "Destination location for transfer" },
      },
      required: ["action"],
    },
  },
  {
    name: "inventory_query",
    description: "Query inventory: summary across locations, velocity/sales trends, stock by location, in-stock items. Actions: summary, velocity, by_location, in_stock",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["summary", "velocity", "by_location", "in_stock"], description: "Query type" },
        location_id: { type: "string", description: "Filter by location" },
        days: { type: "number", description: "Number of days for velocity calculation" },
      },
      required: ["action"],
    },
  },
  {
    name: "inventory_audit",
    description: "Inventory audit workflow: start a new audit, record counts, complete audit, view summary. Actions: start, count, complete, summary",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["start", "count", "complete", "summary"], description: "Audit action" },
        location_id: { type: "string", description: "Location to audit" },
        product_id: { type: "string", description: "Product being counted" },
        counted: { type: "number", description: "Physical count" },
      },
      required: ["action"],
    },
  },
  {
    name: "purchase_orders",
    description: "Manage purchase orders: create, list, get details, add items, approve, receive inventory, cancel. Actions: create, list, get, add_items, approve, receive, cancel",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["create", "list", "get", "add_items", "approve", "receive", "cancel"], description: "Action to perform" },
        purchase_order_id: { type: "string", description: "PO ID (for get/approve/receive/cancel)" },
        supplier_id: { type: "string", description: "Supplier ID (for create)" },
        location_id: { type: "string", description: "Receiving location" },
        items: { type: "array", description: "Line items [{product_id, quantity, unit_cost}]" },
        expected_delivery_date: { type: "string", description: "Expected delivery (YYYY-MM-DD)" },
        notes: { type: "string", description: "PO notes" },
        status: { type: "string", description: "Filter by status (for list)" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["action"],
    },
  },
  {
    name: "transfers",
    description: "Transfer inventory between locations: create transfer, list transfers, get details, receive at destination, cancel. Actions: create, list, get, receive, cancel",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["create", "list", "get", "receive", "cancel"], description: "Action to perform" },
        transfer_id: { type: "string", description: "Transfer ID (for get/receive/cancel)" },
        from_location_id: { type: "string", description: "Source location" },
        to_location_id: { type: "string", description: "Destination location" },
        items: { type: "array", description: "Items to transfer [{product_id, quantity}]" },
        notes: { type: "string", description: "Transfer notes" },
        status: { type: "string", description: "Filter by status (for list)" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
      required: ["action"],
    },
  },
  {
    name: "collections",
    description: "Manage collections: find, create, get/set themes, set icons. Actions: find, create, get_theme, set_theme, set_icon",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["find", "create", "get_theme", "set_theme", "set_icon"], description: "Action to perform" },
        name: { type: "string", description: "Collection name" },
        collection_id: { type: "string", description: "Collection ID" },
        theme: { type: "object", description: "Theme object" },
        icon: { type: "string", description: "Icon name" },
      },
      required: ["action"],
    },
  },
  {
    name: "customers",
    description: "Manage customers: find/search, create new, update existing. Actions: find, create, update",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["find", "create", "update"], description: "Action to perform" },
        query: { type: "string", description: "Search query" },
        customer_id: { type: "string", description: "Customer ID (for update)" },
        first_name: { type: "string", description: "First name" },
        last_name: { type: "string", description: "Last name" },
        email: { type: "string", description: "Email address" },
        phone: { type: "string", description: "Phone number" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["action"],
    },
  },
  {
    name: "products",
    description: "Manage products: find/search, create, update, view pricing templates. Actions: find, create, update, pricing_templates",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["find", "create", "update", "pricing_templates"], description: "Action to perform" },
        query: { type: "string", description: "Search query" },
        name: { type: "string", description: "Product name" },
        sku: { type: "string", description: "SKU" },
        category: { type: "string", description: "Category filter" },
        product_id: { type: "string", description: "Product ID (for update)" },
        base_price: { type: "number", description: "Base price" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["action"],
    },
  },
  {
    name: "analytics",
    description: "Sales analytics with flexible date ranges: revenue, COGS, profit, margins, trends. Actions: summary, by_location, detailed, discover, employee",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["summary", "by_location", "detailed", "discover", "employee"], description: "Analytics type" },
        period: { type: "string", enum: ["today", "yesterday", "last_7", "last_30", "last_90", "last_180", "last_365", "ytd", "mtd", "last_year", "all_time"], description: "Preset time period" },
        days_back: { type: "integer", description: "Days to look back (overrides period)" },
        start_date: { type: "string", description: "Custom start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "Custom end date (YYYY-MM-DD)" },
        location_id: { type: "string", description: "Filter by location" },
      },
      required: ["action"],
    },
  },
  {
    name: "locations",
    description: "Find and list store locations",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Search by name" },
        is_active: { type: "boolean", description: "Filter by active status" },
      },
      required: [],
    },
  },
  {
    name: "orders",
    description: "Find and manage orders: search, get details. Actions: find, get",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["find", "get"], description: "Action to perform" },
        order_id: { type: "string", description: "Order ID (for get)" },
        customer_id: { type: "string", description: "Filter by customer" },
        status: { type: "string", description: "Filter by status" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["action"],
    },
  },
  {
    name: "suppliers",
    description: "Find and list suppliers",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Search by name" },
      },
      required: [],
    },
  },
  {
    name: "email",
    description: "Send emails and manage AI-powered inbox. Actions: send, send_template, list, get, templates (outbound); inbox, inbox_get, inbox_reply, inbox_update, inbox_stats (inbound)",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["send", "send_template", "list", "get", "templates", "inbox", "inbox_get", "inbox_reply", "inbox_update", "inbox_stats"], description: "Action to perform" },
        to: { type: "string", description: "Recipient email" },
        subject: { type: "string", description: "Email subject" },
        html: { type: "string", description: "HTML body" },
        text: { type: "string", description: "Plain text body" },
        from: { type: "string", description: "Sender email" },
        reply_to: { type: "string", description: "Reply-to address" },
        category: { type: "string", description: "Email category" },
        template: { type: "string", description: "Template slug" },
        template_data: { type: "object", description: "Template variables" },
        email_id: { type: "string", description: "Email ID (for get)" },
        thread_id: { type: "string", description: "Thread ID (for inbox operations)" },
        status: { type: "string", description: "Filter by status" },
        mailbox: { type: "string", description: "Filter by mailbox" },
        priority: { type: "string", description: "Filter by priority" },
        limit: { type: "integer", description: "Max results" },
      },
      required: ["action"],
    },
  },
  {
    name: "documents",
    description: "Generate documents (Certificates of Analysis)",
    input_schema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: "Document action" },
        product_id: { type: "string", description: "Product ID" },
        template: { type: "string", description: "Document template" },
      },
      required: [],
    },
  },
  {
    name: "alerts",
    description: "System alerts: low stock warnings, pending orders, action items",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "audit_trail",
    description: "View audit logs: recent actions, changes, tool executions",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max entries to return" },
      },
      required: [],
    },
  },
];

// ============================================================================
// LOAD DEFINITIONS (always available — checks connection for activation)
// ============================================================================

export async function loadServerToolDefinitions(): Promise<Anthropic.Tool[]> {
  const connected = await checkConnection();
  if (!connected) return [];
  return SERVER_TOOL_DEFINITIONS;
}

/** Get definitions without connection check (for /tools listing) */
export function getAllServerToolDefinitions(): Anthropic.Tool[] {
  return SERVER_TOOL_DEFINITIONS;
}

// ============================================================================
// EXECUTE SERVER TOOL
// ============================================================================

export async function executeServerTool(
  name: string,
  input: Record<string, unknown>,
  context?: ExecutionContext
): Promise<ToolResult> {
  const conn = await getSupabaseClient();
  if (!conn) {
    return { success: false, output: "No Supabase connection — server tools unavailable. Run: whale login" };
  }

  try {
    // Ensure source is always set to "whale_mcp" for MCP server tools
    const enrichedContext: ExecutionContext = {
      ...context,
      source: context?.source || "whale_mcp"
    };

    const result: ServerToolResult = await executeTool(
      conn.client,
      name,
      input,
      conn.storeId || undefined,
      enrichedContext
    );

    if (result.success) {
      const output = typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2);
      return { success: true, output };
    }

    return { success: false, output: result.error || "Unknown server tool error" };
  } catch (err: any) {
    return { success: false, output: `Server tool error: ${err.message || err}` };
  }
}
