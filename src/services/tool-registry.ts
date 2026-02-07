/**
 * Tool Registry
 *
 * Loads tools from Supabase ai_tool_registry.
 * Used by the agent server to know which tools are available.
 */

import { createClient } from "@supabase/supabase-js";

// ============================================================================
// TYPES
// ============================================================================

export interface ToolRegistryEntry {
  id: string;
  name: string;
  category: string;
  description: string | null;
  definition: {
    name: string;
    description: string;
    input_schema: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
  rpc_function: string | null;
  edge_function: string | null;
  requires_store_id: boolean;
  requires_user_id: boolean;
  is_read_only: boolean;
  is_active: boolean;
  tool_mode: string;
}

export interface ClientToolMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
}

// ============================================================================
// TOOL REGISTRY LOADER
// ============================================================================

let cachedTools: ToolRegistryEntry[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minute cache

export function invalidateToolCache() {
  cachedTools = null;
  cacheTimestamp = 0;
}

export async function loadToolRegistry(
  supabaseUrl: string,
  supabaseKey: string,
  forceRefresh = false
): Promise<ToolRegistryEntry[]> {
  // Return cached if fresh
  if (!forceRefresh && cachedTools && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedTools;
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from("ai_tool_registry")
    .select("*")
    .eq("is_active", true)
    .order("category", { ascending: true });

  if (error) {
    console.error("[ToolRegistry] Failed to load tools:", error.message);
    return cachedTools || [];
  }

  cachedTools = data as ToolRegistryEntry[];
  cacheTimestamp = Date.now();

  // Import dynamically to avoid circular dependency
  const { getImplementedTools } = await import("../tools/executor.js");
  const implementedTools = getImplementedTools();
  const implementedCount = cachedTools.filter(t => implementedTools.includes(t.name)).length;

  console.log(`[ToolRegistry] Loaded ${cachedTools.length} tools from registry (${implementedCount} implemented locally)`);
  return cachedTools;
}

export function getToolMetadata(tools: ToolRegistryEntry[]): ClientToolMetadata[] {
  return tools.map(t => ({
    id: t.name,
    name: t.definition?.name || t.name,
    description: t.description || t.definition?.description || "",
    category: t.category
  }));
}
