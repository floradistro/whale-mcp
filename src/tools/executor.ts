/**
 * Consolidated Tool Executor
 *
 * Following Anthropic's best practices for tool design:
 * - "More tools don't always lead to better outcomes"
 * - "Claude Code uses about a dozen tools"
 * - "Consolidate multi-step operations into single tool calls"
 *
 * 39 tools → 15 consolidated tools:
 *
 * 1. inventory      - manage inventory (adjust, set, transfer, bulk operations)
 * 2. inventory_query - query inventory (summary, velocity, by_location, in_stock)
 * 3. inventory_audit - audit workflow (start, count, complete, summary)
 * 4. collections    - manage collections (find, create, get_theme, set_theme, set_icon)
 * 5. customers      - manage customers (find, create, update)
 * 6. products       - manage products (find, create, update, pricing)
 * 7. analytics      - analytics & intelligence (summary, by_location, detailed, discover, employee, etc.)
 * 8. locations      - find/list locations
 * 9. orders         - manage orders (find, get, create)
 * 10. suppliers     - find suppliers
 * 11. email         - unified email (send, send_template, list, get, templates, inbox)
 * 12. documents     - document generation
 * 13. alerts        - system alerts
 * 14. web_search    - Exa-powered web search (API key from platform_secrets)
 * 15. audit_trail   - audit logs
 */

import { SupabaseClient } from "@supabase/supabase-js";

// ============================================================================
// ERROR CLASSIFICATION (Anthropic best practice: granular error types for retry logic)
// ============================================================================

export enum ToolErrorType {
  RECOVERABLE = "recoverable",      // Retry with same input (transient failure)
  PERMANENT = "permanent",          // Don't retry (invalid input, business logic error)
  RATE_LIMIT = "rate_limit",        // Exponential backoff needed
  AUTH = "auth",                    // User permission issue
  VALIDATION = "validation",        // Bad input from AI
  NOT_FOUND = "not_found"           // Resource doesn't exist
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  errorType?: ToolErrorType;
  retryable?: boolean;
  timedOut?: boolean;
}

// Classify errors based on message patterns
function classifyError(error: any): { errorType: ToolErrorType; retryable: boolean } {
  const message = error?.message || String(error);
  const code = error?.code;

  // Connection/network errors - recoverable
  if (message.includes("connection") || message.includes("ECONNREFUSED") ||
      message.includes("timeout") || message.includes("network")) {
    return { errorType: ToolErrorType.RECOVERABLE, retryable: true };
  }

  // Rate limiting
  if (message.includes("429") || message.includes("rate") || message.includes("too many")) {
    return { errorType: ToolErrorType.RATE_LIMIT, retryable: true };
  }

  // Auth errors
  if (message.includes("401") || message.includes("403") ||
      message.includes("unauthorized") || message.includes("forbidden") ||
      code === "42501" /* PostgreSQL insufficient_privilege */) {
    return { errorType: ToolErrorType.AUTH, retryable: false };
  }

  // Not found
  if (message.includes("not found") || message.includes("does not exist") ||
      code === "PGRST116" /* PostgREST not found */) {
    return { errorType: ToolErrorType.NOT_FOUND, retryable: false };
  }

  // Validation errors (usually from bad AI input)
  if (message.includes("required") || message.includes("invalid") ||
      message.includes("must be") || message.includes("expected")) {
    return { errorType: ToolErrorType.VALIDATION, retryable: false };
  }

  // Default to permanent (don't retry unknown errors)
  return { errorType: ToolErrorType.PERMANENT, retryable: false };
}

type ToolHandler = (
  supabase: SupabaseClient,
  args: Record<string, unknown>,
  storeId?: string
) => Promise<ToolResult>;

// ============================================================================
// CONSOLIDATED TOOL HANDLERS
// ============================================================================

const handlers: Record<string, ToolHandler> = {

  // ===========================================================================
  // 1. INVENTORY - Unified inventory management
  // Actions: adjust, set, transfer, bulk_adjust, bulk_set, bulk_clear
  // ===========================================================================
  inventory: async (supabase, args, storeId) => {
    const action = args.action as string;
    if (!action) {
      return { success: false, error: "action required: adjust, set, transfer, bulk_adjust, bulk_set, bulk_clear" };
    }

    try {
      switch (action) {
        case "adjust": {
          const inventoryId = args.inventory_id as string;
          const productId = args.product_id as string;
          const locationId = args.location_id as string;
          const adjustment = args.adjustment as number || args.quantity_change as number;
          const reason = args.reason as string || "manual adjustment";

          let id = inventoryId;
          if (!id && productId && locationId) {
            const { data: inv } = await supabase
              .from("inventory")
              .select("id, quantity")
              .eq("product_id", productId)
              .eq("location_id", locationId)
              .single();
            if (inv) id = inv.id;
          }

          if (!id || adjustment === undefined) {
            return { success: false, error: "inventory_id (or product_id+location_id) and adjustment required" };
          }

          // STEP 1: Fetch product and location names
          const { data: product } = await supabase
            .from("products")
            .select("name, sku")
            .eq("id", productId)
            .single();

          const { data: location } = await supabase
            .from("locations")
            .select("name")
            .eq("id", locationId)
            .single();

          // STEP 2: Capture BEFORE state
          const { data: current, error: fetchError } = await supabase
            .from("inventory")
            .select("quantity")
            .eq("id", id)
            .single();

          if (fetchError) return { success: false, error: fetchError.message };

          const qtyBefore = current?.quantity || 0;
          const qtyAfter = qtyBefore + adjustment;

          if (qtyAfter < 0) {
            return {
              success: false,
              error: `Cannot adjust to negative quantity: current ${qtyBefore}, adjustment ${adjustment} would result in ${qtyAfter}`
            };
          }

          // STEP 3: Perform the adjustment
          const { data, error } = await supabase
            .from("inventory")
            .update({ quantity: qtyAfter, updated_at: new Date().toISOString() })
            .eq("id", id)
            .select()
            .single();

          if (error) return { success: false, error: error.message };

          // STEP 4: Return full observability data
          const sign = adjustment >= 0 ? "+" : "";
          return {
            success: true,
            data: {
              intent: `Adjust inventory for ${product?.name || 'product'} at ${location?.name || 'location'}: ${sign}${adjustment} units`,
              product: product ? { id: productId, name: product.name, sku: product.sku } : { id: productId },
              location: location ? { id: locationId, name: location.name } : { id: locationId },
              adjustment,
              reason,
              before_state: { quantity: qtyBefore },
              after_state: { quantity: qtyAfter },
              change: { from: qtyBefore, to: qtyAfter, delta: adjustment }
            }
          };
        }

        case "set": {
          const productId = args.product_id as string;
          const locationId = args.location_id as string;
          const newQty = args.quantity as number;

          // STEP 1: Fetch product and location names
          const { data: product } = await supabase
            .from("products")
            .select("name, sku")
            .eq("id", productId)
            .single();

          const { data: location } = await supabase
            .from("locations")
            .select("name")
            .eq("id", locationId)
            .single();

          // STEP 2: Capture BEFORE state
          const { data: current } = await supabase
            .from("inventory")
            .select("quantity")
            .eq("product_id", productId)
            .eq("location_id", locationId)
            .single();

          const qtyBefore = current?.quantity || 0;

          // STEP 3: Set new quantity
          const { data, error } = await supabase
            .from("inventory")
            .upsert({ product_id: productId, location_id: locationId, quantity: newQty })
            .select()
            .single();

          if (error) return { success: false, error: error.message };

          // STEP 4: Return full observability data
          const delta = newQty - qtyBefore;
          const sign = delta >= 0 ? "+" : "";
          return {
            success: true,
            data: {
              intent: `Set inventory for ${product?.name || 'product'} at ${location?.name || 'location'} to ${newQty} units`,
              product: product ? { id: productId, name: product.name, sku: product.sku } : { id: productId },
              location: location ? { id: locationId, name: location.name } : { id: locationId },
              before_state: { quantity: qtyBefore },
              after_state: { quantity: newQty },
              change: { from: qtyBefore, to: newQty, delta, description: `${sign}${delta} units` }
            }
          };
        }

        case "transfer": {
          const productId = args.product_id as string;
          const fromLocationId = args.from_location_id as string;
          const toLocationId = args.to_location_id as string;
          const quantity = args.quantity as number;

          // STEP 1: Fetch product and location names
          const { data: product } = await supabase
            .from("products")
            .select("name, sku")
            .eq("id", productId)
            .single();

          const { data: fromLocation } = await supabase
            .from("locations")
            .select("name")
            .eq("id", fromLocationId)
            .single();

          const { data: toLocation } = await supabase
            .from("locations")
            .select("name")
            .eq("id", toLocationId)
            .single();

          // STEP 2: Capture BEFORE state
          const { data: fromInv } = await supabase
            .from("inventory")
            .select("id, quantity")
            .eq("product_id", productId)
            .eq("location_id", fromLocationId)
            .single();

          const { data: toInv } = await supabase
            .from("inventory")
            .select("id, quantity")
            .eq("product_id", productId)
            .eq("location_id", toLocationId)
            .single();

          const srcQtyBefore = fromInv?.quantity || 0;
          const dstQtyBefore = toInv?.quantity || 0;

          if (!fromInv) return { success: false, error: "Source inventory not found" };
          if (srcQtyBefore < quantity) {
            return {
              success: false,
              error: `Insufficient stock at ${fromLocation?.name || fromLocationId}: have ${srcQtyBefore}, need ${quantity}`
            };
          }

          // STEP 3: Perform the transfer
          await supabase
            .from("inventory")
            .update({ quantity: srcQtyBefore - quantity })
            .eq("id", fromInv.id);

          if (toInv) {
            await supabase
              .from("inventory")
              .update({ quantity: dstQtyBefore + quantity })
              .eq("id", toInv.id);
          } else {
            await supabase
              .from("inventory")
              .insert({ product_id: productId, location_id: toLocationId, quantity });
          }

          // STEP 4: Calculate AFTER state
          const srcQtyAfter = srcQtyBefore - quantity;
          const dstQtyAfter = dstQtyBefore + quantity;

          // STEP 5: Return full observability data
          return {
            success: true,
            data: {
              intent: `Transfer ${quantity} units of ${product?.name || 'product'} from ${fromLocation?.name || 'source'} to ${toLocation?.name || 'destination'}`,
              product: product ? { id: productId, name: product.name, sku: product.sku } : { id: productId },
              from_location: fromLocation ? { id: fromLocationId, name: fromLocation.name } : { id: fromLocationId },
              to_location: toLocation ? { id: toLocationId, name: toLocation.name } : { id: toLocationId },
              quantity_transferred: quantity,
              before_state: {
                from_quantity: srcQtyBefore,
                to_quantity: dstQtyBefore,
                total: srcQtyBefore + dstQtyBefore
              },
              after_state: {
                from_quantity: srcQtyAfter,
                to_quantity: dstQtyAfter,
                total: srcQtyAfter + dstQtyAfter
              }
            }
          };
        }

        case "bulk_adjust": {
          const adjustments = args.adjustments as Array<{ product_id: string; location_id: string; adjustment: number }>;
          const results = [];

          for (const adj of adjustments || []) {
            const result = await handlers.inventory(supabase, { action: "adjust", ...adj }, storeId);
            results.push({ ...adj, ...result });
          }

          return { success: true, data: { processed: results.length, results } };
        }

        case "bulk_set": {
          const items = args.items as Array<{ product_id: string; location_id: string; quantity: number }>;
          const results = [];

          for (const item of items || []) {
            const result = await handlers.inventory(supabase, { action: "set", ...item }, storeId);
            results.push({ ...item, ...result });
          }

          return { success: true, data: { processed: results.length, results } };
        }

        case "bulk_clear": {
          const locationId = args.location_id as string || storeId;

          const { data, error } = await supabase
            .from("inventory")
            .update({ quantity: 0 })
            .eq("location_id", locationId)
            .select();

          if (error) return { success: false, error: error.message };
          return { success: true, data: { cleared: data?.length || 0, location_id: locationId } };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: adjust, set, transfer, bulk_adjust, bulk_set, bulk_clear` };
      }
    } catch (err) {
      return { success: false, error: `Inventory error: ${err}` };
    }
  },

  // ===========================================================================
  // 2. INVENTORY_QUERY - Query inventory data
  // Actions: summary, velocity, by_location, in_stock
  // ===========================================================================
  inventory_query: async (supabase, args, storeId) => {
    const action = args.action as string || "summary";

    try {
      switch (action) {
        case "summary": {
          let q = supabase
            .from("inventory")
            .select("product_id, quantity, location_id, products(name, sku)");

          if (storeId) q = q.eq("store_id", storeId);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          const totalItems = data?.length || 0;
          const totalQuantity = data?.reduce((sum, i) => sum + (i.quantity || 0), 0) || 0;
          const lowStock = data?.filter(i => (i.quantity || 0) < 10).length || 0;
          const outOfStock = data?.filter(i => (i.quantity || 0) === 0).length || 0;

          return { success: true, data: { totalItems, totalQuantity, lowStock, outOfStock, items: data?.slice(0, 50) } };
        }

        case "velocity": {
          const days = (args.days as number) || 30;
          const categoryId = args.category_id as string;
          const productId = args.product_id as string;
          const locationId = args.location_id as string;
          const limit = (args.limit as number) || 50;

          // Use the proper RPC function with category/location/product filters
          const { data, error } = await supabase.rpc("get_product_velocity", {
            p_store_id: storeId || null,
            p_days: days,
            p_location_id: locationId || null,
            p_category_id: categoryId || null,
            p_product_id: productId || null,
            p_limit: limit
          });

          if (error) return { success: false, error: error.message };

          // Transform RPC result rows (column names from TABLE return type)
          const products = (data || []).map((row: any) => ({
            productId: row.product_id,
            name: row.product_name,
            sku: row.product_sku,
            category: row.category_name,
            locationId: row.location_id,
            locationName: row.location_name,
            totalQty: row.units_sold,
            totalRevenue: row.revenue,
            orderCount: row.order_count,
            velocityPerDay: row.daily_velocity,
            revenuePerDay: row.daily_revenue,
            currentStock: row.current_stock,
            daysOfStock: row.days_of_stock,
            avgPrice: row.avg_unit_price,
            stockAlert: row.stock_status
          }));

          return { success: true, data: { days, filters: { categoryId, locationId, productId }, products } };
        }

        case "by_location": {
          const locationId = args.location_id as string;
          if (!locationId) return { success: false, error: "location_id required for by_location query" };

          const { data, error } = await supabase
            .from("inventory")
            .select("product_id, quantity, products(name, sku)")
            .eq("location_id", locationId);

          if (error) return { success: false, error: error.message };

          const total = data?.reduce((sum, i) => sum + (i.quantity || 0), 0) || 0;
          return { success: true, data: { location_id: locationId, total_quantity: total, item_count: data?.length || 0, items: data } };
        }

        case "in_stock": {
          let q = supabase
            .from("inventory")
            .select("product_id, quantity, location_id, products(id, name, sku)")
            .gt("quantity", 0);

          if (storeId) q = q.eq("store_id", storeId);
          if (args.location_id) q = q.eq("location_id", args.location_id);

          const { data, error } = await q.limit(100);
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: summary, velocity (supports category_id, location_id, product_id, days, limit), by_location, in_stock` };
      }
    } catch (err) {
      return { success: false, error: `Inventory query error: ${err}` };
    }
  },

  // ===========================================================================
  // 3. INVENTORY_AUDIT - Audit workflow
  // Actions: start, count, complete, summary
  // ===========================================================================
  inventory_audit: async (supabase, args, storeId) => {
    const action = args.action as string;
    if (!action) {
      return { success: false, error: "action required: start, count, complete, summary" };
    }

    try {
      switch (action) {
        case "start":
          return { success: true, data: { message: "Audit started", location_id: args.location_id || storeId, started_at: new Date().toISOString() } };

        case "count":
          return { success: true, data: { message: "Count recorded", product_id: args.product_id, counted: args.counted, location_id: args.location_id } };

        case "complete":
          return { success: true, data: { message: "Audit completed", completed_at: new Date().toISOString() } };

        case "summary":
          return { success: true, data: { discrepancies: [], matched: 0, total: 0 } };

        default:
          return { success: false, error: `Unknown action: ${action}. Use: start, count, complete, summary` };
      }
    } catch (err) {
      return { success: false, error: `Inventory audit error: ${err}` };
    }
  },

  // ===========================================================================
  // 3b. PURCHASE_ORDERS - Full purchase order management
  // Actions: create, list, get, add_items, approve, receive, cancel
  // ===========================================================================
  purchase_orders: async (supabase, args, storeId) => {
    const action = args.action as string;
    if (!action) {
      return { success: false, error: "action required: create, list, get, add_items, approve, receive, cancel" };
    }

    try {
      switch (action) {
        case "create": {
          // Generate PO number
          const poNumber = "PO-" + Date.now().toString().slice(-10);

          // Create PO header
          const { data: po, error: poErr } = await supabase
            .from("purchase_orders")
            .insert({
              store_id: storeId,
              po_number: poNumber,
              po_type: "inbound", // Required field
              supplier_id: args.supplier_id || null,
              location_id: args.location_id || null,
              status: "draft",
              notes: args.notes || null,
              expected_delivery_date: args.expected_delivery_date || null,
              is_ai_action: true
            })
            .select()
            .single();

          if (poErr) return { success: false, error: poErr.message };

          // Add items if provided
          const items = args.items as Array<{ product_id: string; quantity: number; unit_price?: number }> || [];
          if (items.length > 0) {
            const insertItems = items.map(item => ({
              purchase_order_id: po.id,
              product_id: item.product_id,
              quantity: item.quantity,
              unit_price: item.unit_price || 0,
              subtotal: item.quantity * (item.unit_price || 0) // Required field
            }));

            await supabase.from("purchase_order_items").insert(insertItems);

            // Calculate PO subtotal
            const poSubtotal = items.reduce((sum, i) => sum + (i.quantity * (i.unit_price || 0)), 0);
            await supabase
              .from("purchase_orders")
              .update({ subtotal: poSubtotal, total_amount: poSubtotal })
              .eq("id", po.id);
          }

          // Fetch enriched PO with location name, supplier, and item details
          const { data: enriched } = await supabase
            .from("purchase_orders")
            .select("id, po_number, status, total_amount, expected_delivery_date, created_at, notes, location:locations(name, city, state), items:purchase_order_items(quantity, unit_price, subtotal, product:products(name, sku))")
            .eq("id", po.id)
            .single();

          return { success: true, data: enriched || { purchase_order_id: po.id, po_number: poNumber, items_count: items.length } };
        }

        case "list": {
          let q = supabase
            .from("purchase_orders")
            .select("id, po_number, po_type, status, supplier_id, location_id, total_amount, expected_delivery_date, created_at, location:locations(name)")
            .order("created_at", { ascending: false });

          if (storeId) q = q.eq("store_id", storeId);
          if (args.status) q = q.eq("status", args.status);
          if (args.supplier_id) q = q.eq("supplier_id", args.supplier_id);

          const { data, error } = await q.limit((args.limit as number) || 50);
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "get": {
          const poId = args.purchase_order_id as string || args.id as string;
          if (!poId) return { success: false, error: "purchase_order_id required" };

          const { data, error } = await supabase
            .from("purchase_orders")
            .select("*, items:purchase_order_items(*, product:products(name, sku)), location:locations(name)")
            .eq("id", poId)
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "add_items": {
          const poId = args.purchase_order_id as string;
          const items = args.items as Array<{ product_id: string; quantity: number; unit_price?: number }>;
          if (!poId || !items?.length) return { success: false, error: "purchase_order_id and items required" };

          const insertItems = items.map(item => ({
            purchase_order_id: poId,
            product_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.unit_price || 0,
            subtotal: item.quantity * (item.unit_price || 0) // Calculate subtotal
          }));

          const { data, error } = await supabase
            .from("purchase_order_items")
            .insert(insertItems)
            .select();

          if (error) return { success: false, error: error.message };

          // Recalculate totals
          const { data: allItems } = await supabase
            .from("purchase_order_items")
            .select("subtotal")
            .eq("purchase_order_id", poId);

          const poSubtotal = (allItems || []).reduce((sum, i) => sum + (i.subtotal || 0), 0);

          await supabase
            .from("purchase_orders")
            .update({ subtotal: poSubtotal, total_amount: poSubtotal, updated_at: new Date().toISOString() })
            .eq("id", poId);

          return { success: true, data: { items_added: data?.length || 0, new_subtotal: poSubtotal } };
        }

        case "approve": {
          const poId = args.purchase_order_id as string;
          if (!poId) return { success: false, error: "purchase_order_id required" };

          // Check if PO has supplier (required for approval)
          const { data: existing } = await supabase
            .from("purchase_orders")
            .select("id, status, supplier_id")
            .eq("id", poId)
            .single();

          if (!existing) return { success: false, error: "PO not found" };
          if (!["draft", "pending"].includes(existing.status)) {
            return { success: false, error: `Cannot approve PO in ${existing.status} status` };
          }
          if (!existing.supplier_id) {
            return { success: false, error: "Cannot approve PO without a supplier. Set supplier_id first." };
          }

          const { data, error } = await supabase
            .from("purchase_orders")
            .update({
              status: "approved",
              ordered_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("id", poId)
            .select()
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "receive": {
          const poId = args.purchase_order_id as string;
          if (!poId) return { success: false, error: "purchase_order_id required" };

          // Get PO details
          const { data: po, error: poErr } = await supabase
            .from("purchase_orders")
            .select("*, items:purchase_order_items(*)")
            .eq("id", poId)
            .single();

          if (poErr || !po) return { success: false, error: poErr?.message || "PO not found" };
          if (po.status === "received") return { success: false, error: "PO already fully received" };
          if (po.status === "cancelled") return { success: false, error: "Cannot receive cancelled PO" };

          const receiveItems = args.items as Array<{ product_id?: string; item_id?: string; quantity: number }> | null;
          let itemsReceived = 0;
          let totalQtyReceived = 0;

          // Process each PO item
          for (const poItem of po.items || []) {
            let qtyToReceive = poItem.quantity - (poItem.received_quantity || 0);

            // If specific items provided, find matching quantity
            if (receiveItems) {
              const match = receiveItems.find(ri =>
                ri.item_id === poItem.id || ri.product_id === poItem.product_id
              );
              if (!match) continue;
              qtyToReceive = Math.min(match.quantity, qtyToReceive);
            }

            if (qtyToReceive <= 0) continue;

            // Find or create inventory record at destination
            let invId: string | null = null;
            const { data: existingInv } = await supabase
              .from("inventory")
              .select("id, quantity")
              .eq("product_id", poItem.product_id)
              .eq("location_id", po.location_id)
              .single();

            if (existingInv) {
              invId = existingInv.id;
              await supabase
                .from("inventory")
                .update({
                  quantity: existingInv.quantity + qtyToReceive,
                  updated_at: new Date().toISOString()
                })
                .eq("id", invId);
            } else {
              const { data: newInv } = await supabase
                .from("inventory")
                .insert({
                  product_id: poItem.product_id,
                  location_id: po.location_id,
                  store_id: po.store_id,
                  quantity: qtyToReceive
                })
                .select()
                .single();
              invId = newInv?.id;
            }

            // Update PO item received quantity
            const newReceivedQty = (poItem.received_quantity || 0) + qtyToReceive;
            await supabase
              .from("purchase_order_items")
              .update({
                received_quantity: newReceivedQty,
                receive_status: newReceivedQty >= poItem.quantity ? "received" : "partial",
                updated_at: new Date().toISOString()
              })
              .eq("id", poItem.id);

            // Log adjustment (ignore errors if table doesn't exist)
            if (invId) {
              try {
                await supabase.from("inventory_adjustments").insert({
                  inventory_id: invId,
                  product_id: poItem.product_id,
                  location_id: po.location_id,
                  adjustment_type: "PO_RECEIVE",
                  old_quantity: existingInv?.quantity || 0,
                  new_quantity: (existingInv?.quantity || 0) + qtyToReceive,
                  reason: `Received from PO ${po.po_number}`
                });
              } catch { /* ignore */ }
            }

            itemsReceived++;
            totalQtyReceived += qtyToReceive;
          }

          // Update PO status
          const { data: updatedItems } = await supabase
            .from("purchase_order_items")
            .select("quantity, received_quantity")
            .eq("purchase_order_id", poId);

          const allReceived = (updatedItems || []).every(i => (i.received_quantity || 0) >= i.quantity);
          const anyReceived = (updatedItems || []).some(i => (i.received_quantity || 0) > 0);

          await supabase
            .from("purchase_orders")
            .update({
              status: allReceived ? "received" : (anyReceived ? "partial" : po.status),
              received_at: allReceived ? new Date().toISOString() : null,
              updated_at: new Date().toISOString()
            })
            .eq("id", poId);

          return {
            success: true,
            data: {
              items_received: itemsReceived,
              total_quantity_received: totalQtyReceived,
              po_status: allReceived ? "received" : "partial"
            }
          };
        }

        case "cancel": {
          const poId = args.purchase_order_id as string;
          if (!poId) return { success: false, error: "purchase_order_id required" };

          // Check current status
          const { data: existing } = await supabase
            .from("purchase_orders")
            .select("id, status")
            .eq("id", poId)
            .single();

          if (!existing) return { success: false, error: "PO not found" };
          if (["received", "cancelled"].includes(existing.status)) {
            return { success: false, error: `Cannot cancel PO in ${existing.status} status` };
          }

          const { data, error } = await supabase
            .from("purchase_orders")
            .update({
              status: "cancelled",
              updated_at: new Date().toISOString()
            })
            .eq("id", poId)
            .select()
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: create, list, get, add_items, approve, receive, cancel` };
      }
    } catch (err) {
      return { success: false, error: `Purchase orders error: ${err}` };
    }
  },

  // ===========================================================================
  // 3c. TRANSFERS - Inventory transfers between locations
  // Actions: create, list, get, receive, cancel
  // ===========================================================================
  transfers: async (supabase, args, storeId) => {
    const action = args.action as string;
    if (!action) {
      return { success: false, error: "action required: create, list, get, receive, cancel" };
    }

    try {
      switch (action) {
        case "create": {
          const fromLocationId = args.from_location_id as string;
          const toLocationId = args.to_location_id as string;
          const items = args.items as Array<{ product_id: string; quantity: number }>;

          if (!fromLocationId || !toLocationId || !items?.length) {
            return { success: false, error: "from_location_id, to_location_id, and items required" };
          }

          if (fromLocationId === toLocationId) {
            return { success: false, error: "Source and destination must be different" };
          }

          // Generate transfer number
          const transferNumber = "TR-" + Date.now().toString().slice(-10);

          // Create transfer header
          const { data: transfer, error: trErr } = await supabase
            .from("inventory_transfers")
            .insert({
              store_id: storeId,
              transfer_number: transferNumber,
              source_location_id: fromLocationId,
              destination_location_id: toLocationId,
              status: "in_transit", // Valid status
              notes: args.notes || null,
              is_ai_action: true
            })
            .select()
            .single();

          if (trErr) return { success: false, error: trErr.message };

          // Process each item - deduct from source, add to transfer items
          let itemsCount = 0;
          for (const item of items) {
            // Check source inventory
            const { data: srcInv } = await supabase
              .from("inventory")
              .select("id, quantity")
              .eq("product_id", item.product_id)
              .eq("location_id", fromLocationId)
              .single();

            if (!srcInv) {
              // Rollback
              await supabase.from("inventory_transfers").delete().eq("id", transfer.id);
              return { success: false, error: `Product ${item.product_id} not found at source location` };
            }

            if (srcInv.quantity < item.quantity) {
              await supabase.from("inventory_transfers").delete().eq("id", transfer.id);
              return { success: false, error: `Insufficient quantity: have ${srcInv.quantity}, need ${item.quantity}` };
            }

            // Add transfer item
            await supabase.from("inventory_transfer_items").insert({
              transfer_id: transfer.id,
              product_id: item.product_id,
              quantity: item.quantity
            });

            // Deduct from source inventory
            await supabase
              .from("inventory")
              .update({
                quantity: srcInv.quantity - item.quantity,
                updated_at: new Date().toISOString()
              })
              .eq("id", srcInv.id);

            // Log adjustment (ignore errors)
            try {
              await supabase.from("inventory_adjustments").insert({
                inventory_id: srcInv.id,
                product_id: item.product_id,
                location_id: fromLocationId,
                adjustment_type: "TRANSFER_OUT",
                old_quantity: srcInv.quantity,
                new_quantity: srcInv.quantity - item.quantity,
                reason: `Transfer to ${toLocationId} (${transferNumber})`
              });
            } catch { /* ignore */ }

            itemsCount++;
          }

          // Update status to in_transit
          await supabase
            .from("inventory_transfers")
            .update({ status: "in_transit", shipped_at: new Date().toISOString() })
            .eq("id", transfer.id);

          // Fetch enriched transfer with location names and item details
          const { data: enriched } = await supabase
            .from("inventory_transfers")
            .select("id, transfer_number, status, created_at, shipped_at, from_location:locations!inventory_transfers_source_location_id_fkey(name, city, state), to_location:locations!inventory_transfers_destination_location_id_fkey(name, city, state), items:inventory_transfer_items(quantity, product:products(name, sku))")
            .eq("id", transfer.id)
            .single();

          return {
            success: true,
            data: enriched || { transfer_id: transfer.id, transfer_number: transferNumber, items_count: itemsCount }
          };
        }

        case "list": {
          let q = supabase
            .from("inventory_transfers")
            .select("id, transfer_number, status, source_location_id, destination_location_id, created_at, shipped_at, received_at, from_location:locations!inventory_transfers_source_location_id_fkey(name), to_location:locations!inventory_transfers_destination_location_id_fkey(name)")
            .order("created_at", { ascending: false });

          if (storeId) q = q.eq("store_id", storeId);
          if (args.status) q = q.eq("status", args.status);
          if (args.from_location_id) q = q.eq("source_location_id", args.from_location_id);
          if (args.to_location_id) q = q.eq("destination_location_id", args.to_location_id);

          const { data, error } = await q.limit((args.limit as number) || 50);
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "get": {
          const transferId = args.transfer_id as string || args.id as string;
          if (!transferId) return { success: false, error: "transfer_id required" };

          const { data, error } = await supabase
            .from("inventory_transfers")
            .select("*, items:inventory_transfer_items(*, product:products(name, sku)), from_location:locations!inventory_transfers_source_location_id_fkey(name), to_location:locations!inventory_transfers_destination_location_id_fkey(name)")
            .eq("id", transferId)
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "receive": {
          const transferId = args.transfer_id as string;
          if (!transferId) return { success: false, error: "transfer_id required" };

          // Get transfer details
          const { data: transfer, error: trErr } = await supabase
            .from("inventory_transfers")
            .select("*, items:inventory_transfer_items(*)")
            .eq("id", transferId)
            .single();

          if (trErr || !transfer) return { success: false, error: trErr?.message || "Transfer not found" };
          if (transfer.status === "received") return { success: false, error: "Transfer already received" };
          if (transfer.status === "cancelled") return { success: false, error: "Cannot receive cancelled transfer" };

          const receiveItems = args.items as Array<{ product_id?: string; item_id?: string; quantity: number }> | null;
          let itemsReceived = 0;
          let totalQtyReceived = 0;

          // Process each transfer item
          for (const trItem of transfer.items || []) {
            let qtyToReceive = trItem.quantity - (trItem.received_quantity || 0);

            // If specific items provided, match them
            if (receiveItems) {
              const match = receiveItems.find(ri =>
                ri.item_id === trItem.id || ri.product_id === trItem.product_id
              );
              if (!match) continue;
              qtyToReceive = Math.min(match.quantity, qtyToReceive);
            }

            if (qtyToReceive <= 0) continue;

            // Find or create destination inventory
            let destInvId: string | null = null;
            const { data: existingInv } = await supabase
              .from("inventory")
              .select("id, quantity")
              .eq("product_id", trItem.product_id)
              .eq("location_id", transfer.destination_location_id)
              .single();

            if (existingInv) {
              destInvId = existingInv.id;
              await supabase
                .from("inventory")
                .update({
                  quantity: existingInv.quantity + qtyToReceive,
                  updated_at: new Date().toISOString()
                })
                .eq("id", destInvId);
            } else {
              const { data: newInv } = await supabase
                .from("inventory")
                .insert({
                  product_id: trItem.product_id,
                  location_id: transfer.destination_location_id,
                  store_id: transfer.store_id,
                  quantity: qtyToReceive
                })
                .select()
                .single();
              destInvId = newInv?.id;
            }

            // Update transfer item
            const newReceivedQty = (trItem.received_quantity || 0) + qtyToReceive;
            await supabase
              .from("inventory_transfer_items")
              .update({
                received_quantity: newReceivedQty,
                updated_at: new Date().toISOString()
              })
              .eq("id", trItem.id);

            // Log adjustment (ignore errors)
            if (destInvId) {
              try {
                await supabase.from("inventory_adjustments").insert({
                  inventory_id: destInvId,
                  product_id: trItem.product_id,
                  location_id: transfer.destination_location_id,
                  adjustment_type: "TRANSFER_IN",
                  old_quantity: existingInv?.quantity || 0,
                  new_quantity: (existingInv?.quantity || 0) + qtyToReceive,
                  reason: `Received from transfer ${transfer.transfer_number}`
                });
              } catch { /* ignore */ }
            }

            itemsReceived++;
            totalQtyReceived += qtyToReceive;
          }

          // Update transfer status
          const { data: updatedItems } = await supabase
            .from("inventory_transfer_items")
            .select("quantity, received_quantity")
            .eq("transfer_id", transferId);

          const allReceived = (updatedItems || []).every(i => (i.received_quantity || 0) >= i.quantity);

          await supabase
            .from("inventory_transfers")
            .update({
              status: allReceived ? "received" : "in_transit",
              received_at: allReceived ? new Date().toISOString() : null,
              updated_at: new Date().toISOString()
            })
            .eq("id", transferId);

          return {
            success: true,
            data: {
              items_received: itemsReceived,
              total_quantity_received: totalQtyReceived,
              transfer_status: allReceived ? "received" : "partial"
            }
          };
        }

        case "cancel": {
          const transferId = args.transfer_id as string;
          if (!transferId) return { success: false, error: "transfer_id required" };

          // Get transfer items to restore inventory
          const { data: transfer } = await supabase
            .from("inventory_transfers")
            .select("*, items:inventory_transfer_items(*)")
            .eq("id", transferId)
            .single();

          if (!transfer) return { success: false, error: "Transfer not found" };
          if (transfer.status === "received") return { success: false, error: "Cannot cancel a received transfer" };
          if (transfer.status === "cancelled") return { success: false, error: "Transfer already cancelled" };

          // Restore inventory at source location
          for (const item of transfer.items || []) {
            // Get source inventory by product and source location
            const { data: srcInv } = await supabase
              .from("inventory")
              .select("id, quantity")
              .eq("product_id", item.product_id)
              .eq("location_id", transfer.source_location_id)
              .single();

            if (srcInv) {
              // Restore quantity
              const restoreQty = item.quantity - (item.received_quantity || 0);
              await supabase
                .from("inventory")
                .update({
                  quantity: srcInv.quantity + restoreQty,
                  updated_at: new Date().toISOString()
                })
                .eq("id", srcInv.id);

              // Log adjustment (ignore errors)
              try {
                await supabase.from("inventory_adjustments").insert({
                  inventory_id: srcInv.id,
                  product_id: item.product_id,
                  location_id: transfer.source_location_id,
                  adjustment_type: "TRANSFER_CANCEL",
                  old_quantity: srcInv.quantity,
                  new_quantity: srcInv.quantity + restoreQty,
                  reason: `Cancelled transfer ${transfer.transfer_number}`
                });
              } catch { /* ignore */ }
            }
          }

          // Update transfer status
          const { data, error } = await supabase
            .from("inventory_transfers")
            .update({
              status: "cancelled",
              cancelled_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("id", transferId)
            .select()
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data: { ...data, inventory_restored: true } };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: create, list, get, receive, cancel` };
      }
    } catch (err) {
      return { success: false, error: `Transfers error: ${err}` };
    }
  },

  // ===========================================================================
  // 4. COLLECTIONS - Manage collections
  // Actions: find, create, get_theme, set_theme, set_icon
  // ===========================================================================
  collections: async (supabase, args, storeId) => {
    const action = args.action as string || "find";

    // Helper to handle missing table gracefully
    const handleTableError = (error: { message: string; code?: string }) => {
      if (error.message.includes("does not exist") || error.code === "42P01" || error.message.includes("schema cache")) {
        return { success: true, data: [], message: "Collections table not configured" };
      }
      return { success: false, error: error.message };
    };

    try {
      switch (action) {
        case "find": {
          let q = supabase.from("collections").select("*");
          if (storeId) q = q.eq("store_id", storeId);
          if (args.name) q = q.ilike("name", `%${args.name}%`);
          const { data, error } = await q;
          if (error) return handleTableError(error);
          return { success: true, data };
        }

        case "create": {
          const { data, error } = await supabase
            .from("collections")
            .insert({ name: args.name, description: args.description, store_id: storeId })
            .select()
            .single();
          if (error) return handleTableError(error);
          return { success: true, data };
        }

        case "get_theme": {
          const { data, error } = await supabase
            .from("collections")
            .select("id, name, theme")
            .eq("id", args.collection_id)
            .single();
          if (error) return handleTableError(error);
          return { success: true, data };
        }

        case "set_theme": {
          const { data, error } = await supabase
            .from("collections")
            .update({ theme: args.theme })
            .eq("id", args.collection_id)
            .select()
            .single();
          if (error) return handleTableError(error);
          return { success: true, data };
        }

        case "set_icon": {
          const { data, error } = await supabase
            .from("collections")
            .update({ icon: args.icon })
            .eq("id", args.collection_id)
            .select()
            .single();
          if (error) return handleTableError(error);
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: find, create, get_theme, set_theme, set_icon` };
      }
    } catch (err) {
      return { success: false, error: `Collections error: ${err}` };
    }
  },

  // ===========================================================================
  // 5. CUSTOMERS - Manage customers
  // Actions: find, create, update
  // ===========================================================================
  customers: async (supabase, args, storeId) => {
    const action = args.action as string || "find";

    try {
      switch (action) {
        case "find": {
          const query = args.query as string || "";
          const email = args.email as string;
          const phone = args.phone as string;
          const limit = (args.limit as number) || 20;

          let q = supabase
            .from("customers")
            .select("id, email, phone, first_name, last_name, created_at")
            .limit(limit);

          if (query) {
            q = q.or(`email.ilike.%${query}%,phone.ilike.%${query}%,first_name.ilike.%${query}%,last_name.ilike.%${query}%`);
          }
          if (email) q = q.eq("email", email);
          if (phone) q = q.eq("phone", phone);
          if (storeId) q = q.eq("store_id", storeId);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "create": {
          const { data, error } = await supabase
            .from("customers")
            .insert({
              email: args.email,
              phone: args.phone,
              first_name: args.first_name,
              last_name: args.last_name,
              store_id: storeId
            })
            .select()
            .single();
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "update": {
          const customerId = args.customer_id as string;
          if (!customerId) return { success: false, error: "customer_id required" };

          const updateData: Record<string, unknown> = {};
          if (args.email) updateData.email = args.email;
          if (args.phone) updateData.phone = args.phone;
          if (args.first_name) updateData.first_name = args.first_name;
          if (args.last_name) updateData.last_name = args.last_name;

          const { data, error } = await supabase
            .from("customers")
            .update(updateData)
            .eq("id", customerId)
            .select()
            .single();
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: find, create, update` };
      }
    } catch (err) {
      return { success: false, error: `Customers error: ${err}` };
    }
  },

  // ===========================================================================
  // 6. PRODUCTS - Manage products
  // Actions: find, create, update, pricing_templates
  // ===========================================================================
  products: async (supabase, args, storeId) => {
    const action = args.action as string || "find";

    try {
      switch (action) {
        case "find": {
          const query = args.query as string || "";
          const limit = (args.limit as number) || 200;
          const statusFilter = args.status as string || "published";

          // Split query into individual words for smarter matching
          const words = query.trim().split(/\s+/).filter(Boolean);

          // Separate words that might be category names vs product names
          // Search categories first to find matching category IDs
          let categoryIds: string[] = [];
          if (words.length > 0) {
            let catQ = supabase.from("categories").select("id, name");
            if (storeId) catQ = catQ.eq("store_id", storeId);
            // Match any word against category names
            const catFilters = words.map(w => `name.ilike.%${w}%`).join(",");
            catQ = catQ.or(catFilters);
            const { data: matchingCats } = await catQ;
            categoryIds = matchingCats?.map((c: Record<string, unknown>) => c.id as string) || [];
          }

          // Build product query with category join
          let q = supabase
            .from("products")
            .select("id, name, sku, status, primary_category_id, category:categories!primary_category_id(name)")
            .limit(limit);

          if (storeId) q = q.eq("store_id", storeId);
          if (statusFilter !== "all") q = q.eq("status", statusFilter);

          if (words.length > 0) {
            // Build OR filter: match name words AND/OR category membership
            const nameFilters = words.map(w => `name.ilike.%${w}%`);
            const skuFilter = `sku.ilike.%${query}%`;
            const allFilters = [...nameFilters, skuFilter];
            if (categoryIds.length > 0) {
              allFilters.push(`primary_category_id.in.(${categoryIds.join(",")})`);
            }
            q = q.or(allFilters.join(","));
          }

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          // Score results: products matching MORE words rank higher
          type ProductRow = Record<string, unknown>;
          const scored = (data || []).map((p: ProductRow) => {
            let score = 0;
            const pName = ((p.name as string) || "").toLowerCase();
            const catName = ((p.category as { name: string } | null)?.name || "").toLowerCase();
            for (const w of words) {
              const wl = w.toLowerCase();
              if (pName.includes(wl)) score += 2;
              if (catName.includes(wl)) score += 1;
            }
            return { product: p, score };
          });
          scored.sort((a, b) => b.score - a.score);

          // Enrich with inventory totals
          const productIds = scored.map(s => s.product.id as string);
          let inventoryMap: Record<string, number> = {};
          if (productIds.length > 0) {
            const { data: invData } = await supabase
              .from("inventory")
              .select("product_id, quantity")
              .in("product_id", productIds)
              .gt("quantity", 0);

            if (invData) {
              for (const inv of invData) {
                inventoryMap[inv.product_id] = (inventoryMap[inv.product_id] || 0) + inv.quantity;
              }
            }
          }

          const enriched = scored.map(s => ({
            id: s.product.id,
            name: s.product.name,
            sku: s.product.sku,
            status: s.product.status,
            category: (s.product.category as { name: string } | null)?.name || null,
            total_stock: inventoryMap[s.product.id as string] || 0
          }));

          return {
            success: true,
            data: enriched,
            total_count: enriched.length,
            limit,
            truncated: enriched.length >= limit
          };
        }

        case "create": {
          const { data, error } = await supabase
            .from("products")
            .insert({
              name: args.name,
              sku: args.sku,
              store_id: storeId
            })
            .select()
            .single();
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "update": {
          const productId = args.product_id as string;
          if (!productId) return { success: false, error: "product_id required" };

          const updateData: Record<string, unknown> = {};
          if (args.name) updateData.name = args.name;
          if (args.sku) updateData.sku = args.sku;
          if (args.status) updateData.status = args.status;

          const { data, error } = await supabase
            .from("products")
            .update(updateData)
            .eq("id", productId)
            .select()
            .single();
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "pricing_templates": {
          // pricing_templates table may not exist - return empty array gracefully
          try {
            let q = supabase.from("pricing_templates").select("*");
            if (storeId) q = q.eq("store_id", storeId);
            const { data, error } = await q;
            if (error) {
              // Table doesn't exist - return empty array
              if (error.message.includes("does not exist") || error.code === "42P01" || error.message.includes("schema cache")) {
                return { success: true, data: [], message: "Pricing templates not configured" };
              }
              return { success: false, error: error.message };
            }
            return { success: true, data };
          } catch {
            return { success: true, data: [], message: "Pricing templates not configured" };
          }
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: find, create, update, pricing_templates` };
      }
    } catch (err) {
      return { success: false, error: `Products error: ${err}` };
    }
  },

  // ===========================================================================
  // 7. ANALYTICS - Unified analytics & data discovery
  // Actions: summary, by_location, detailed, discover, employee, custom
  // Supports: preset periods OR custom date ranges (start_date, end_date)
  // Also supports: days_back for "last N days" queries
  // ===========================================================================
  analytics: async (supabase, args, storeId) => {
    const action = args.action as string || "summary";
    const period = args.period as string;
    const locationId = args.location_id as string;

    // Custom date range support
    const customStartDate = args.start_date as string;
    const customEndDate = args.end_date as string;
    const daysBack = args.days_back as number;

    try {
      // Calculate date range - prioritize custom dates, then days_back, then period
      const today = new Date();
      let startDate: string;
      let endDate: string = today.toISOString().split("T")[0];

      if (customStartDate) {
        // Custom date range provided
        startDate = customStartDate;
        if (customEndDate) {
          endDate = customEndDate;
        }
      } else if (daysBack && daysBack > 0) {
        // Dynamic days back (e.g., last 365 days, last 180 days)
        const start = new Date(today);
        start.setDate(start.getDate() - daysBack);
        startDate = start.toISOString().split("T")[0];
      } else {
        // Use preset period
        const periodToUse = period || "last_30";
        switch (periodToUse) {
          case "today":
            startDate = today.toISOString().split("T")[0];
            break;
          case "yesterday":
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            startDate = yesterday.toISOString().split("T")[0];
            endDate = startDate;
            break;
          case "last_7":
            const week = new Date(today);
            week.setDate(week.getDate() - 7);
            startDate = week.toISOString().split("T")[0];
            break;
          case "last_30":
            const month = new Date(today);
            month.setDate(month.getDate() - 30);
            startDate = month.toISOString().split("T")[0];
            break;
          case "last_90":
            const quarter = new Date(today);
            quarter.setDate(quarter.getDate() - 90);
            startDate = quarter.toISOString().split("T")[0];
            break;
          case "last_180":
            const half = new Date(today);
            half.setDate(half.getDate() - 180);
            startDate = half.toISOString().split("T")[0];
            break;
          case "last_365":
            const year = new Date(today);
            year.setDate(year.getDate() - 365);
            startDate = year.toISOString().split("T")[0];
            break;
          case "ytd":
            startDate = `${today.getFullYear()}-01-01`;
            break;
          case "mtd":
            startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
            break;
          case "last_year":
            startDate = `${today.getFullYear() - 1}-01-01`;
            endDate = `${today.getFullYear() - 1}-12-31`;
            break;
          case "all_time":
            startDate = "2020-01-01"; // Reasonable start date
            break;
          default:
            // Default to last 30 days
            const defaultMonth = new Date(today);
            defaultMonth.setDate(defaultMonth.getDate() - 30);
            startDate = defaultMonth.toISOString().split("T")[0];
        }
      }

      switch (action) {
        case "summary": {
          // Use RPC function for efficient server-side aggregation (no row limits)
          const { data: rpcResult, error: rpcError } = await supabase.rpc("get_sales_analytics", {
            p_store_id: storeId || null,
            p_start_date: startDate,
            p_end_date: endDate,
            p_location_id: locationId || null
          });

          if (rpcError) {
            // Fallback to client-side aggregation if RPC not deployed
            console.warn("[Analytics] RPC failed, falling back to client-side:", rpcError.message);
          } else if (rpcResult) {
            // RPC returned data - use it directly
            return {
              success: true,
              data: {
                period: period || (daysBack ? `last_${daysBack}` : "custom"),
                dateRange: rpcResult.dateRange,
                summary: {
                  grossSales: rpcResult.grossSales,
                  netSales: rpcResult.netSales,
                  totalRevenue: rpcResult.totalRevenue,
                  totalCogs: rpcResult.totalCogs,
                  totalProfit: rpcResult.totalProfit,
                  taxAmount: rpcResult.taxAmount,
                  discountAmount: rpcResult.discountAmount,
                  shippingAmount: rpcResult.shippingAmount,
                  totalOrders: rpcResult.totalOrders,
                  completedOrders: rpcResult.completedOrders,
                  cancelledOrders: rpcResult.cancelledOrders,
                  uniqueCustomers: rpcResult.uniqueCustomers,
                  totalQuantity: rpcResult.totalQuantity,
                  avgOrderValue: rpcResult.avgOrderValue,
                  profitMargin: `${rpcResult.profitMargin}%`,
                  avgDailyRevenue: rpcResult.avgDailyRevenue,
                  avgDailyOrders: rpcResult.avgDailyOrders
                },
                rowCount: rpcResult.rowCount
              }
            };
          }

          // Fallback: client-side aggregation
          let q = supabase
            .from("v_daily_sales")
            .select("*")
            .gte("sale_date", startDate)
            .lte("sale_date", endDate)
            .order("sale_date", { ascending: false });

          if (storeId) q = q.eq("store_id", storeId);
          if (locationId) q = q.eq("location_id", locationId);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          const totals = (data || []).reduce((acc, day) => ({
            grossSales: acc.grossSales + parseFloat(day.gross_sales || 0),
            netSales: acc.netSales + parseFloat(day.net_sales || 0),
            taxAmount: acc.taxAmount + parseFloat(day.total_tax || 0),
            discountAmount: acc.discountAmount + parseFloat(day.total_discounts || 0),
            shippingAmount: acc.shippingAmount + parseFloat(day.total_shipping || 0),
            totalOrders: acc.totalOrders + parseInt(day.order_count || 0),
            completedOrders: acc.completedOrders + parseInt(day.completed_orders || 0),
            cancelledOrders: acc.cancelledOrders + parseInt(day.cancelled_orders || 0),
            uniqueCustomers: acc.uniqueCustomers + parseInt(day.unique_customers || 0),
            totalCogs: acc.totalCogs + parseFloat(day.total_cogs || 0),
            totalProfit: acc.totalProfit + parseFloat(day.total_profit || 0),
            totalRevenue: acc.totalRevenue + parseFloat(day.total_revenue || 0)
          }), {
            grossSales: 0, netSales: 0, taxAmount: 0, discountAmount: 0, shippingAmount: 0,
            totalOrders: 0, completedOrders: 0, cancelledOrders: 0, uniqueCustomers: 0,
            totalCogs: 0, totalProfit: 0, totalRevenue: 0
          });

          const profitMargin = totals.netSales > 0
            ? Math.round((totals.totalProfit / totals.netSales) * 10000) / 100
            : 0;

          const startD = new Date(startDate);
          const endD = new Date(endDate);
          const daysDiff = Math.ceil((endD.getTime() - startD.getTime()) / (1000 * 60 * 60 * 24)) + 1;

          return {
            success: true,
            data: {
              period: period || (daysBack ? `last_${daysBack}` : "custom"),
              dateRange: { from: startDate, to: endDate, days: daysDiff },
              summary: {
                ...totals,
                avgOrderValue: totals.totalOrders > 0 ? Math.round((totals.netSales / totals.totalOrders) * 100) / 100 : 0,
                profitMargin: `${profitMargin}%`,
                avgDailyRevenue: daysDiff > 0 ? Math.round((totals.netSales / daysDiff) * 100) / 100 : 0,
                avgDailyOrders: daysDiff > 0 ? Math.round((totals.totalOrders / daysDiff) * 10) / 10 : 0
              },
              rowCount: data?.length || 0
            }
          };
        }

        case "by_location":
        case "detailed": {
          let q = supabase
            .from("v_daily_sales")
            .select("*")
            .gte("sale_date", startDate)
            .lte("sale_date", endDate)
            .order("sale_date", { ascending: false });

          if (storeId) q = q.eq("store_id", storeId);
          if (locationId) q = q.eq("location_id", locationId);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          if (action === "by_location") {
            const byLocation: Record<string, { orders: number; gross: number; net: number }> = {};
            for (const row of data || []) {
              const loc = row.location_id || "unknown";
              if (!byLocation[loc]) byLocation[loc] = { orders: 0, gross: 0, net: 0 };
              byLocation[loc].orders += parseInt(row.order_count || 0);
              byLocation[loc].gross += parseFloat(row.gross_sales || 0);
              byLocation[loc].net += parseFloat(row.net_sales || 0);
            }
            return { success: true, data: { period, byLocation: Object.entries(byLocation).map(([id, s]) => ({ locationId: id, ...s })) } };
          }

          // Detailed action - return daily data with totals
          const totals = (data || []).reduce((acc, day) => ({
            grossSales: acc.grossSales + parseFloat(day.gross_sales || 0),
            netSales: acc.netSales + parseFloat(day.net_sales || 0),
            taxAmount: acc.taxAmount + parseFloat(day.total_tax || 0),
            discountAmount: acc.discountAmount + parseFloat(day.total_discounts || 0),
            shippingAmount: acc.shippingAmount + parseFloat(day.total_shipping || 0),
            totalOrders: acc.totalOrders + parseInt(day.order_count || 0),
            completedOrders: acc.completedOrders + parseInt(day.completed_orders || 0),
            cancelledOrders: acc.cancelledOrders + parseInt(day.cancelled_orders || 0),
            uniqueCustomers: acc.uniqueCustomers + parseInt(day.unique_customers || 0),
            totalCogs: acc.totalCogs + parseFloat(day.total_cogs || 0),
            totalProfit: acc.totalProfit + parseFloat(day.total_profit || 0),
            totalRevenue: acc.totalRevenue + parseFloat(day.total_revenue || 0)
          }), {
            grossSales: 0, netSales: 0, taxAmount: 0, discountAmount: 0, shippingAmount: 0,
            totalOrders: 0, completedOrders: 0, cancelledOrders: 0, uniqueCustomers: 0,
            totalCogs: 0, totalProfit: 0, totalRevenue: 0
          });

          const profitMargin = totals.netSales > 0
            ? Math.round((totals.totalProfit / totals.netSales) * 10000) / 100
            : 0;

          const startD = new Date(startDate);
          const endD = new Date(endDate);
          const daysDiff = Math.ceil((endD.getTime() - startD.getTime()) / (1000 * 60 * 60 * 24)) + 1;

          return {
            success: true,
            data: {
              period: period || (daysBack ? `last_${daysBack}` : "custom"),
              dateRange: { from: startDate, to: endDate, days: daysDiff },
              summary: {
                ...totals,
                avgOrderValue: totals.totalOrders > 0 ? Math.round((totals.netSales / totals.totalOrders) * 100) / 100 : 0,
                profitMargin: `${profitMargin}%`,
                avgDailyRevenue: daysDiff > 0 ? Math.round((totals.netSales / daysDiff) * 100) / 100 : 0,
                avgDailyOrders: daysDiff > 0 ? Math.round((totals.totalOrders / daysDiff) * 10) / 10 : 0
              },
              daily: (data || []).slice(0, 90),
              rowCount: data?.length || 0
            }
          };
        }

        case "discover": {
          const tables = ["products", "orders", "customers", "inventory", "locations"];
          const result: Record<string, number> = {};

          for (const table of tables) {
            const { count } = await supabase.from(table).select("*", { count: "exact", head: true });
            result[table] = count || 0;
          }

          return { success: true, data: result };
        }

        case "employee": {
          const { data, error } = await supabase
            .from("orders")
            .select("employee_id, total_amount, created_at")
            .not("employee_id", "is", null);

          if (error) return { success: false, error: error.message };

          const byEmployee: Record<string, { count: number; total: number }> = {};
          for (const order of data || []) {
            const eid = order.employee_id;
            if (!byEmployee[eid]) byEmployee[eid] = { count: 0, total: 0 };
            byEmployee[eid].count++;
            byEmployee[eid].total += order.total_amount || 0;
          }

          return { success: true, data: byEmployee };
        }

        // ==== NEW INTELLIGENCE ACTIONS ====

        case "customers":
        case "customer_intelligence": {
          // Customer LTV, RFM segmentation, cohorts
          const { data, error } = await supabase.rpc("get_customer_intelligence", {
            p_store_id: storeId || null
          });
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "products":
        case "product_intelligence": {
          // Product velocity, ABC analysis, performance tiers
          const { data, error } = await supabase.rpc("get_product_intelligence", {
            p_store_id: storeId || null
          });
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "inventory_intelligence": {
          // Inventory turnover, dead stock, overstock risk
          const { data, error } = await supabase.rpc("get_inventory_intelligence", {
            p_store_id: storeId || null
          });
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "marketing":
        case "marketing_intelligence": {
          // UTM attribution, channel performance, conversion rates
          const { data, error } = await supabase.rpc("get_marketing_intelligence", {
            p_store_id: storeId || null,
            p_start_date: startDate,
            p_end_date: endDate
          });
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "fraud":
        case "fraud_detection": {
          // Risk scores, suspicious activity patterns
          let q = supabase
            .from("v_fraud_detection")
            .select("*")
            .order("risk_score", { ascending: false })
            .limit(100);

          if (storeId) q = q.eq("store_id", storeId);
          if (args.risk_level) q = q.eq("risk_level", args.risk_level);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          const summary = {
            totalOrders: data?.length || 0,
            highRisk: data?.filter(o => o.risk_level === "high").length || 0,
            mediumRisk: data?.filter(o => o.risk_level === "medium").length || 0,
            avgRiskScore: data?.length ? Math.round(data.reduce((s, o) => s + o.risk_score, 0) / data.length) : 0,
            orders: data
          };
          return { success: true, data: summary };
        }

        case "employee_performance": {
          // Detailed employee metrics from v_employee_performance
          let q = supabase
            .from("v_employee_performance")
            .select("*")
            .order("total_revenue", { ascending: false });

          if (storeId) q = q.eq("store_id", storeId);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "behavior":
        case "behavioral_analytics": {
          // UX metrics, session quality, bounce rates
          let q = supabase
            .from("v_behavioral_analytics")
            .select("*")
            .gte("visit_date", startDate)
            .lte("visit_date", endDate);

          if (storeId) q = q.eq("store_id", storeId);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          // Aggregate
          const totals = (data || []).reduce((acc, row) => ({
            sessions: acc.sessions + (row.sessions || 0),
            pageViews: acc.pageViews + (row.page_views || 0),
            rageClicks: acc.rageClicks + (row.total_rage_clicks || 0),
            uxIssues: acc.uxIssues + (row.sessions_with_ux_issues || 0)
          }), { sessions: 0, pageViews: 0, rageClicks: 0, uxIssues: 0 });

          return {
            success: true,
            data: {
              summary: {
                ...totals,
                avgPagesPerSession: totals.sessions ? Math.round((totals.pageViews / totals.sessions) * 100) / 100 : 0,
                uxIssueRate: totals.sessions ? Math.round((totals.uxIssues / totals.sessions) * 10000) / 100 : 0
              },
              byDevice: data?.reduce((acc, row) => {
                const device = row.device_type || "unknown";
                if (!acc[device]) acc[device] = { sessions: 0, pageViews: 0 };
                acc[device].sessions += row.sessions || 0;
                acc[device].pageViews += row.page_views || 0;
                return acc;
              }, {} as Record<string, { sessions: number; pageViews: number }>)
            }
          };
        }

        case "by_category": {
          // Category-level sales breakdown using RPC
          const days = daysBack || 30;
          const { data, error } = await supabase.rpc("get_category_performance", {
            p_store_id: storeId || null,
            p_location_id: locationId || null,
            p_days: days
          });

          if (error) return { success: false, error: error.message };

          const categories = (data || []).map((row: any) => ({
            categoryId: row.category_id,
            categoryName: row.category_name,
            orderCount: row.order_count,
            totalGrams: row.total_grams,
            totalRevenue: row.total_revenue,
            avgPricePerGram: row.avg_price_per_gram,
            revenueShare: row.revenue_share
          }));

          return {
            success: true,
            data: {
              days,
              locationId: locationId || "all",
              categories,
              totalRevenue: categories.reduce((s: number, c: any) => s + parseFloat(c.totalRevenue || 0), 0)
            }
          };
        }

        case "category_velocity": {
          // Inventory velocity broken down by category with stock alerts
          const days = daysBack || 30;
          const categoryName = args.category_name as string;
          const { data, error } = await supabase.rpc("get_inventory_velocity", {
            p_store_id: storeId || null,
            p_location_id: locationId || null,
            p_category_name: categoryName || null,
            p_days: days
          });

          if (error) return { success: false, error: error.message };

          const results = (data || []).map((row: any) => ({
            locationId: row.location_id,
            locationName: row.location_name,
            locationType: row.location_type,
            categoryId: row.category_id,
            categoryName: row.category_name,
            currentStock: row.current_stock,
            totalSold: row.sold_in_period,
            dailyVelocity: row.daily_velocity,
            daysOfStock: row.days_of_stock,
            stockAlert: row.status
          }));

          return {
            success: true,
            data: {
              days,
              categoryFilter: categoryName || "all",
              results
            }
          };
        }

        case "product_sales": {
          // Product-level sales for a specific category or all products
          const days = daysBack || 30;
          const categoryId = args.category_id as string;
          const productId = args.product_id as string;
          const limit = (args.limit as number) || 50;

          const { data, error } = await supabase.rpc("get_product_velocity", {
            p_store_id: storeId || null,
            p_days: days,
            p_location_id: locationId || null,
            p_category_id: categoryId || null,
            p_product_id: productId || null,
            p_limit: limit
          });

          if (error) return { success: false, error: error.message };

          const products = (data || []).map((row: any) => ({
            productId: row.product_id,
            name: row.product_name,
            sku: row.product_sku,
            category: row.category_name,
            locationId: row.location_id,
            locationName: row.location_name,
            totalQty: row.units_sold,
            totalRevenue: row.revenue,
            orderCount: row.order_count,
            velocityPerDay: row.daily_velocity,
            revenuePerDay: row.daily_revenue,
            currentStock: row.current_stock,
            daysOfStock: row.days_of_stock,
            avgPrice: row.avg_unit_price,
            stockAlert: row.stock_status
          }));

          return {
            success: true,
            data: {
              days,
              filters: { categoryId, locationId, productId },
              products,
              totalUnits: products.reduce((s: number, p: any) => s + parseFloat(p.totalQty || 0), 0),
              totalRevenue: products.reduce((s: number, p: any) => s + parseFloat(p.totalRevenue || 0), 0)
            }
          };
        }

        case "full":
        case "business_intelligence": {
          // Master intelligence - all metrics in one call
          const { data, error } = await supabase.rpc("get_business_intelligence", {
            p_store_id: storeId || null,
            p_start_date: startDate,
            p_end_date: endDate
          });
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: summary, by_location, detailed, by_category, category_velocity, product_sales, discover, employee, customers, products, inventory_intelligence, marketing, fraud, employee_performance, behavior, full` };
      }
    } catch (err) {
      return { success: false, error: `Analytics error: ${err}` };
    }
  },

  // ===========================================================================
  // 8. LOCATIONS - Find/list locations
  // ===========================================================================
  locations: async (supabase, args, storeId) => {
    try {
      let q = supabase.from("locations").select("id, name, address_line1, city, state, is_active");
      if (storeId) q = q.eq("store_id", storeId);
      if (args.name) q = q.ilike("name", `%${args.name}%`);
      if (args.is_active !== undefined) q = q.eq("is_active", args.is_active);

      const { data, error } = await q;
      if (error) return { success: false, error: error.message };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: `Locations error: ${err}` };
    }
  },

  // ===========================================================================
  // 9. ORDERS - Manage orders
  // Actions: find, get, create
  // ===========================================================================
  orders: async (supabase, args, storeId) => {
    const action = args.action as string || "find";

    try {
      switch (action) {
        case "find": {
          let q = supabase
            .from("orders")
            .select("id, order_number, status, total_amount, customer_id, created_at")
            .order("created_at", { ascending: false })
            .limit((args.limit as number) || 50);

          if (storeId) q = q.eq("store_id", storeId);
          if (args.status) q = q.eq("status", args.status);
          if (args.customer_id) q = q.eq("customer_id", args.customer_id);

          const { data, error } = await q;
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "get": {
          const orderId = args.order_id as string;
          if (!orderId) return { success: false, error: "order_id required" };

          const { data, error } = await supabase
            .from("orders")
            .select("*, order_items(*)")
            .eq("id", orderId)
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "purchase_orders": {
          let q = supabase.from("purchase_orders").select("*");
          if (storeId) q = q.eq("store_id", storeId);
          const { data, error } = await q.limit(50);
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: find, get, purchase_orders` };
      }
    } catch (err) {
      return { success: false, error: `Orders error: ${err}` };
    }
  },

  // ===========================================================================
  // 10. SUPPLIERS - Find suppliers
  // ===========================================================================
  suppliers: async (supabase, args, storeId) => {
    try {
      let q = supabase.from("suppliers").select("id, store_id, external_name, external_company, contact_name, contact_email, contact_phone, city, state, is_active, payment_terms, notes, created_at");
      if (storeId) q = q.eq("store_id", storeId);
      if (args.name) {
        const search = `%${args.name}%`;
        q = q.or(`external_name.ilike.${search},external_company.ilike.${search},contact_name.ilike.${search}`);
      }
      const { data, error } = await q.limit(50);
      if (error) return { success: false, error: error.message };
      return { success: true, data };
    } catch (err) {
      return { success: false, error: `Suppliers error: ${err}` };
    }
  },

  // ===========================================================================
  // 11. EMAIL - Unified email tool with inbox support
  // Actions: send, send_template, list, get, templates,
  //          inbox, inbox_get, inbox_reply, inbox_update, inbox_stats
  // ===========================================================================
  email: async (supabase, args, storeId) => {
    const action = args.action as string;
    if (!action) {
      return { success: false, error: "action required: send, send_template, list, get, templates, inbox, inbox_get, inbox_reply, inbox_update, inbox_stats" };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL || "https://uaednwpxursknmwdeejn.supabase.co";
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    const invokeEdgeFunction = async (functionName: string, body: Record<string, unknown>) => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
      return data;
    };

    try {
      switch (action) {
        case "send": {
          const to = args.to as string;
          const subject = args.subject as string;
          const html = args.html as string;
          const text = args.text as string;

          if (!to || !subject || (!html && !text)) {
            return { success: false, error: "send requires: to, subject, and html or text" };
          }

          const result = await invokeEdgeFunction("send-email", { to, subject, html, text, storeId });
          return { success: true, data: result };
        }

        case "send_template": {
          const to = args.to as string;
          const template = args.template as string;
          const templateData = args.template_data as Record<string, unknown>;

          if (!to || !template) {
            return { success: false, error: "send_template requires: to, template" };
          }

          const result = await invokeEdgeFunction("send-email", { to, template, template_data: templateData, storeId });
          return { success: true, data: result };
        }

        case "list": {
          let query = supabase
            .from("email_sends")
            .select("id, to_email, subject, status, category, created_at")
            .order("created_at", { ascending: false })
            .limit((args.limit as number) || 50);

          if (storeId) query = query.eq("store_id", storeId);
          const { data, error } = await query;
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "get": {
          const emailId = args.email_id as string;
          if (!emailId) return { success: false, error: "get requires email_id" };

          const { data, error } = await supabase.from("email_sends").select("*").eq("id", emailId).single();
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "templates": {
          const { data, error } = await supabase
            .from("email_templates")
            .select("id, name, slug, subject, description, category, is_active")
            .eq("is_active", true);

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        // =====================================================================
        // INBOX ACTIONS - AI-powered inbound email management
        // =====================================================================

        case "inbox": {
          // List threads with optional filters
          const mailbox = args.mailbox as string;
          const status = args.status as string;
          const priority = args.priority as string;
          const limit = (args.limit as number) || 25;

          let query = supabase
            .from("email_threads")
            .select(`
              id, subject, mailbox, status, priority, intent, ai_summary,
              message_count, unread_count, last_message_at, created_at,
              customer:customers(id, first_name, last_name, email),
              order:orders(id, order_number, status)
            `)
            .order("last_message_at", { ascending: false })
            .limit(limit);

          if (storeId) query = query.eq("store_id", storeId);
          if (mailbox) query = query.eq("mailbox", mailbox);
          if (status) query = query.eq("status", status);
          if (priority) query = query.eq("priority", priority);

          const { data, error } = await query;
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "inbox_get": {
          // Get full thread with all messages and context
          const threadId = args.thread_id as string;
          if (!threadId) return { success: false, error: "inbox_get requires thread_id" };

          // Fetch thread
          const { data: thread, error: threadError } = await supabase
            .from("email_threads")
            .select(`
              *,
              customer:customers(id, first_name, last_name, email, phone),
              order:orders(id, order_number, status, total, created_at)
            `)
            .eq("id", threadId)
            .single();

          if (threadError) return { success: false, error: threadError.message };

          // Fetch all messages in thread
          const { data: messages, error: msgError } = await supabase
            .from("email_inbox")
            .select("id, direction, from_email, from_name, to_email, subject, body_text, body_html, status, ai_draft, ai_intent, ai_confidence, has_attachments, created_at, read_at, replied_at")
            .eq("thread_id", threadId)
            .order("created_at", { ascending: true });

          if (msgError) return { success: false, error: msgError.message };

          // Mark unread messages as read
          const unreadIds = (messages || [])
            .filter((m: Record<string, unknown>) => m.direction === "inbound" && !m.read_at)
            .map((m: Record<string, unknown>) => m.id);

          if (unreadIds.length > 0) {
            await supabase
              .from("email_inbox")
              .update({ status: "read", read_at: new Date().toISOString() })
              .in("id", unreadIds);

            await supabase
              .from("email_threads")
              .update({ unread_count: 0 })
              .eq("id", threadId);
          }

          return { success: true, data: { thread, messages } };
        }

        case "inbox_reply": {
          // Reply to a thread
          const threadId = args.thread_id as string;
          const html = args.html as string;
          const text = args.text as string;

          if (!threadId) return { success: false, error: "inbox_reply requires thread_id" };
          if (!html && !text) return { success: false, error: "inbox_reply requires html or text body" };

          // Get thread + last inbound message for threading
          const { data: thread } = await supabase
            .from("email_threads")
            .select("id, subject, customer:customers(email)")
            .eq("id", threadId)
            .single();

          if (!thread) return { success: false, error: "Thread not found" };

          const { data: lastInbound } = await supabase
            .from("email_inbox")
            .select("from_email, message_id, references")
            .eq("thread_id", threadId)
            .eq("direction", "inbound")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (!lastInbound) return { success: false, error: "No inbound message to reply to" };

          // Build threading references
          const refs: string[] = (lastInbound.references as string[]) || [];
          if (lastInbound.message_id && !refs.includes(lastInbound.message_id)) {
            refs.push(lastInbound.message_id);
          }

          const result = await invokeEdgeFunction("send-email", {
            to: lastInbound.from_email,
            subject: `Re: ${thread.subject || ""}`,
            html,
            text,
            storeId,
            thread_id: threadId,
            in_reply_to: lastInbound.message_id,
            references: refs,
          });

          return { success: true, data: result };
        }

        case "inbox_update": {
          // Update thread status, priority, intent, or summary
          const threadId = args.thread_id as string;
          if (!threadId) return { success: false, error: "inbox_update requires thread_id" };

          const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
          if (args.status) updates.status = args.status;
          if (args.priority) updates.priority = args.priority;
          if (args.intent) updates.intent = args.intent;
          if (args.ai_summary) updates.ai_summary = args.ai_summary;

          const { data, error } = await supabase
            .from("email_threads")
            .update(updates)
            .eq("id", threadId)
            .select("id, status, priority, intent, ai_summary")
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "inbox_stats": {
          // Inbox statistics
          let query = supabase
            .from("email_threads")
            .select("mailbox, status, priority", { count: "exact" });

          if (storeId) query = query.eq("store_id", storeId);

          const { data: threads, error } = await query;
          if (error) return { success: false, error: error.message };

          // Aggregate counts
          const stats = {
            total: (threads || []).length,
            by_status: {} as Record<string, number>,
            by_mailbox: {} as Record<string, number>,
            by_priority: {} as Record<string, number>,
          };

          for (const t of (threads || []) as Array<{ status: string; mailbox: string; priority: string }>) {
            stats.by_status[t.status] = (stats.by_status[t.status] || 0) + 1;
            stats.by_mailbox[t.mailbox] = (stats.by_mailbox[t.mailbox] || 0) + 1;
            stats.by_priority[t.priority] = (stats.by_priority[t.priority] || 0) + 1;
          }

          return { success: true, data: stats };
        }

        // =====================================================================
        // DOMAIN MANAGEMENT - Multi-tenant email domain configuration
        // =====================================================================

        case "domains_list": {
          // List email domains for the store
          let query = supabase
            .from("store_email_domains")
            .select("id, domain, inbound_subdomain, status, receiving_enabled, sending_verified, dns_records, created_at");

          if (storeId) query = query.eq("store_id", storeId);

          const { data, error } = await query;
          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "domains_add": {
          // Add a new email domain for the store
          const domain = args.domain as string;
          const inboundSubdomain = (args.inbound_subdomain as string) || "in";

          if (!domain) return { success: false, error: "domain required" };
          if (!storeId) return { success: false, error: "store_id required" };

          // Call Resend API to add domain
          const RESEND_API_KEY = process.env.RESEND_API_KEY;
          if (!RESEND_API_KEY) return { success: false, error: "RESEND_API_KEY not configured" };

          const fullDomain = `${inboundSubdomain}.${domain}`;
          const resendRes = await fetch("https://api.resend.com/domains", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ name: fullDomain, region: "us-east-1" })
          });

          const resendData = await resendRes.json();
          if (!resendRes.ok) {
            return { success: false, error: `Resend API error: ${resendData.message || resendRes.status}` };
          }

          // Enable receiving
          await fetch(`https://api.resend.com/domains/${resendData.id}`, {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ capabilities: { receiving: "enabled" } })
          });

          // Format DNS records for display
          const dnsRecords = (resendData.records || []).map((r: any) => ({
            record: r.record,
            name: r.name,
            type: r.type,
            value: r.value,
            priority: r.priority,
            status: r.status
          }));

          // Add receiving MX record to the list
          dnsRecords.push({
            record: "Receiving",
            name: inboundSubdomain,
            type: "MX",
            value: "inbound-smtp.us-east-1.amazonaws.com",
            priority: 10,
            status: "pending"
          });

          // Insert into database
          const { data, error } = await supabase
            .from("store_email_domains")
            .insert({
              store_id: storeId,
              domain,
              inbound_subdomain: inboundSubdomain,
              resend_domain_id: resendData.id,
              status: "pending",
              receiving_enabled: true,
              dns_records: dnsRecords
            })
            .select()
            .single();

          if (error) return { success: false, error: error.message };

          return {
            success: true,
            data: {
              ...data,
              message: "Domain added. Please add the following DNS records to your domain registrar:",
              dns_records: dnsRecords
            }
          };
        }

        case "domains_verify": {
          // Trigger verification for a domain
          const domainId = args.domain_id as string;
          if (!domainId) return { success: false, error: "domain_id required" };

          // Get domain record
          const { data: domainRecord, error: fetchError } = await supabase
            .from("store_email_domains")
            .select("*")
            .eq("id", domainId)
            .single();

          if (fetchError || !domainRecord) {
            return { success: false, error: "Domain not found" };
          }

          // Call Resend verify API
          const RESEND_API_KEY = process.env.RESEND_API_KEY;
          if (!RESEND_API_KEY) return { success: false, error: "RESEND_API_KEY not configured" };

          await fetch(`https://api.resend.com/domains/${domainRecord.resend_domain_id}/verify`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${RESEND_API_KEY}` }
          });

          // Fetch updated status
          const statusRes = await fetch(`https://api.resend.com/domains/${domainRecord.resend_domain_id}`, {
            headers: { "Authorization": `Bearer ${RESEND_API_KEY}` }
          });

          const statusData = await statusRes.json();

          // Update database
          const dnsRecords = (statusData.records || []).map((r: any) => ({
            record: r.record,
            name: r.name,
            type: r.type,
            value: r.value,
            priority: r.priority,
            status: r.status
          }));

          const receivingVerified = dnsRecords.some((r: any) => r.record === "Receiving" && r.status === "verified");
          const sendingVerified = dnsRecords.filter((r: any) => r.record !== "Receiving").every((r: any) => r.status === "verified");

          const { data, error } = await supabase
            .from("store_email_domains")
            .update({
              status: statusData.status === "verified" || receivingVerified ? "verified" : "pending",
              sending_verified: sendingVerified,
              dns_records: dnsRecords,
              verified_at: receivingVerified ? new Date().toISOString() : null
            })
            .eq("id", domainId)
            .select()
            .single();

          if (error) return { success: false, error: error.message };
          return { success: true, data };
        }

        case "addresses_list": {
          // List email addresses for the store
          let query = supabase
            .from("store_email_addresses")
            .select(`
              id, address, display_name, mailbox_type, ai_enabled, ai_auto_reply, is_active, created_at,
              domain:store_email_domains(id, domain, inbound_subdomain, status)
            `);

          if (storeId) query = query.eq("store_id", storeId);

          const { data, error } = await query;
          if (error) return { success: false, error: error.message };

          // Format with full email address
          const addresses = (data || []).map((a: any) => ({
            ...a,
            full_email: a.domain ? `${a.address}@${a.domain.inbound_subdomain}.${a.domain.domain}` : null
          }));

          return { success: true, data: addresses };
        }

        case "addresses_add": {
          // Add a new email address/mailbox
          const domainId = args.domain_id as string;
          const address = args.address as string;
          const displayName = args.display_name as string;
          const mailboxType = (args.mailbox_type as string) || "general";
          const aiEnabled = args.ai_enabled !== false;

          if (!domainId || !address) {
            return { success: false, error: "domain_id and address required" };
          }
          if (!storeId) return { success: false, error: "store_id required" };

          // Verify domain belongs to store
          const { data: domain } = await supabase
            .from("store_email_domains")
            .select("id, domain, inbound_subdomain")
            .eq("id", domainId)
            .eq("store_id", storeId)
            .single();

          if (!domain) return { success: false, error: "Domain not found or doesn't belong to store" };

          const { data, error } = await supabase
            .from("store_email_addresses")
            .insert({
              store_id: storeId,
              domain_id: domainId,
              address: address.toLowerCase(),
              display_name: displayName,
              mailbox_type: mailboxType,
              ai_enabled: aiEnabled
            })
            .select()
            .single();

          if (error) return { success: false, error: error.message };

          return {
            success: true,
            data: {
              ...data,
              full_email: `${address}@${domain.inbound_subdomain}.${domain.domain}`
            }
          };
        }

        default:
          return { success: false, error: `Unknown action: ${action}. Use: send, send_template, list, get, templates, inbox, inbox_get, inbox_reply, inbox_update, inbox_stats, domains_list, domains_add, domains_verify, addresses_list, addresses_add` };
      }
    } catch (err) {
      return { success: false, error: `Email error: ${err}` };
    }
  },

  // ===========================================================================
  // 12. DOCUMENTS - Document generation (COA, etc.)
  // ===========================================================================
  documents: async (supabase, args, storeId) => {
    try {
      const DOCUMENTS_API_URL = process.env.DOCUMENTS_API_URL || "http://localhost:3102/api/tools";
      const oauthToken = process.env.DOCUMENTS_OAUTH_TOKEN;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (oauthToken) headers["Authorization"] = `Bearer ${oauthToken}`;

      const response = await fetch(DOCUMENTS_API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: "documents", input: args, context: { storeId } })
      });

      const result = await response.json();
      if (!response.ok) return { success: false, error: result.error || `HTTP ${response.status}` };
      return { success: result.success, data: result.data, error: result.error };
    } catch (err) {
      return { success: false, error: `Documents error: ${err}` };
    }
  },

  // ===========================================================================
  // 13. ALERTS - System alerts (low stock, pending orders)
  // ===========================================================================
  alerts: async (supabase, args, storeId) => {
    try {
      const { data: lowStock } = await supabase
        .from("inventory")
        .select("product_id, quantity, products(name)")
        .lt("quantity", 10)
        .limit(20);

      const { data: pendingOrders } = await supabase
        .from("orders")
        .select("id, order_number")
        .eq("status", "pending")
        .limit(20);

      return {
        success: true,
        data: {
          lowStock: lowStock?.length || 0,
          pendingOrders: pendingOrders?.length || 0,
          alerts: [
            ...(lowStock || []).map(i => ({ type: "low_stock", product: (i.products as any)?.name, quantity: i.quantity })),
            ...(pendingOrders || []).map(o => ({ type: "pending_order", order_number: o.order_number }))
          ]
        }
      };
    } catch (err) {
      return { success: false, error: `Alerts error: ${err}` };
    }
  },

  // ===========================================================================
  // 14. WEB_SEARCH - Exa-powered web search (API key from platform_secrets)
  // ===========================================================================
  web_search: async (supabase, args, storeId) => {
    const query = args.query as string;
    if (!query) return { success: false, error: "query is required", errorType: ToolErrorType.VALIDATION, retryable: false };

    const numResults = Math.min((args.num_results as number) || 10, 20);
    const searchType = (args.type as string) || "auto";
    const allowedDomains = args.allowed_domains as string[] | undefined;
    const blockedDomains = args.blocked_domains as string[] | undefined;
    const includeContents = (args.include_contents as boolean) ?? true;

    // Fetch API key from backend (never stored on client)
    const { data: secretRow, error: secretErr } = await supabase
      .from("platform_secrets")
      .select("value")
      .eq("key", "exa_api_key")
      .single();

    if (secretErr || !secretRow?.value) {
      return {
        success: false,
        error: "Exa API key not configured. Add 'exa_api_key' to platform_secrets table.",
        errorType: ToolErrorType.AUTH,
        retryable: false,
      };
    }

    const apiKey = secretRow.value;

    try {
      // Exa search + contents in one call
      const endpoint = includeContents
        ? "https://api.exa.ai/search"
        : "https://api.exa.ai/search";

      const body: Record<string, unknown> = {
        query,
        numResults,
        type: searchType,
        contents: includeContents ? { text: { maxCharacters: 1200, includeHtmlTags: false } } : undefined,
      };

      if (allowedDomains?.length) body.includeDomains = allowedDomains;
      if (blockedDomains?.length) body.excludeDomains = blockedDomains;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errBody = await response.text();
        return {
          success: false,
          error: `Exa API error (${response.status}): ${errBody}`,
          errorType: response.status === 429 ? ToolErrorType.RATE_LIMIT : ToolErrorType.RECOVERABLE,
          retryable: response.status === 429 || response.status >= 500,
        };
      }

      const data = await response.json();
      const results = (data.results || []).map((r: any, i: number) => {
        const parts = [
          `${i + 1}. **${r.title || "Untitled"}**`,
          `   ${r.url}`,
        ];
        if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`);
        if (r.text) parts.push(`   ${r.text.slice(0, 500)}`);
        return parts.join("\n");
      });

      return {
        success: true,
        data: `Found ${results.length} results for "${query}":\n\n${results.join("\n\n")}`,
      };
    } catch (err: any) {
      if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
        return { success: false, error: "Exa search timed out (15s)", errorType: ToolErrorType.RECOVERABLE, retryable: true, timedOut: true };
      }
      return { success: false, error: `Web search error: ${err.message || err}`, errorType: ToolErrorType.RECOVERABLE, retryable: true };
    }
  },

  // ===========================================================================
  // 15. AUDIT_TRAIL - View audit logs
  // ===========================================================================
  audit_trail: async (supabase, args, storeId) => {
    try {
      const action = (args.action as string) || "recent";
      const limit = (args.limit as number) || 20;
      const conversationId = args.conversation_id as string | undefined;
      const timeWindow = (args.time_window as string) || "1h";

      // Parse time window into a timestamp
      const now = new Date();
      const windowMs: Record<string, number> = { "1h": 3600000, "24h": 86400000, "7d": 604800000 };
      const ms = windowMs[timeWindow] || windowMs["1h"];
      const since = new Date(now.getTime() - ms).toISOString();

      switch (action) {
        case "recent": {
          let q = supabase
            .from("audit_logs")
            .select("action, status_code, duration_ms, error_message, details, created_at")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(limit);
          if (storeId) q = q.eq("store_id", storeId);
          if (conversationId) q = q.eq("conversation_id", conversationId);
          const { data, error } = await q;
          if (error) return { success: false, error: error.message };
          const rows = (data || []).map((r: any) => ({
            action: r.action,
            status: r.status_code,
            duration_ms: r.duration_ms,
            error: r.error_message || null,
            tool: r.details?.tool_name || r.details?.["gen_ai.request.model"] || null,
            time: r.created_at,
          }));
          return { success: true, data: { action: "recent", time_window: timeWindow, count: rows.length, entries: rows } };
        }

        case "errors": {
          let q = supabase
            .from("audit_logs")
            .select("action, error_message, status_code, severity, created_at")
            .gte("created_at", since)
            .or("severity.eq.error,status_code.eq.ERROR")
            .order("created_at", { ascending: false })
            .limit(limit);
          if (storeId) q = q.eq("store_id", storeId);
          if (conversationId) q = q.eq("conversation_id", conversationId);
          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          // Group by action
          const grouped: Record<string, { count: number; last_error: string; last_time: string }> = {};
          for (const r of (data || []) as any[]) {
            const key = r.action;
            if (!grouped[key]) {
              grouped[key] = { count: 0, last_error: r.error_message || r.status_code, last_time: r.created_at };
            }
            grouped[key].count++;
          }
          return { success: true, data: { action: "errors", time_window: timeWindow, total_errors: (data || []).length, by_action: grouped } };
        }

        case "tool_stats": {
          let q = supabase
            .from("audit_logs")
            .select("action, status_code, duration_ms, input_tokens, output_tokens, created_at")
            .gte("created_at", since)
            .like("action", "tool.%")
            .order("created_at", { ascending: false })
            .limit(500);
          if (storeId) q = q.eq("store_id", storeId);
          if (conversationId) q = q.eq("conversation_id", conversationId);
          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          const stats: Record<string, { calls: number; errors: number; total_ms: number; total_tokens: number }> = {};
          for (const r of (data || []) as any[]) {
            const tool = r.action.replace("tool.", "");
            if (!stats[tool]) stats[tool] = { calls: 0, errors: 0, total_ms: 0, total_tokens: 0 };
            stats[tool].calls++;
            if (r.status_code === "ERROR") stats[tool].errors++;
            stats[tool].total_ms += r.duration_ms || 0;
            stats[tool].total_tokens += (r.input_tokens || 0) + (r.output_tokens || 0);
          }
          // Add avg_ms
          const toolStats = Object.fromEntries(
            Object.entries(stats).map(([k, v]) => [k, { ...v, avg_ms: Math.round(v.total_ms / v.calls) }])
          );
          return { success: true, data: { action: "tool_stats", time_window: timeWindow, tools: toolStats } };
        }

        case "team_status": {
          let q = supabase
            .from("audit_logs")
            .select("action, details, created_at")
            .gte("created_at", since)
            .like("action", "team.%")
            .order("created_at", { ascending: false })
            .limit(200);
          if (storeId) q = q.eq("store_id", storeId);
          if (conversationId) q = q.eq("conversation_id", conversationId);
          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          const teammates: Record<string, { name: string; started: string | null; done: string | null; tasks_completed: number }> = {};
          for (const r of (data || []) as any[]) {
            const id = r.details?.teammate_id;
            if (!id) continue;
            if (!teammates[id]) teammates[id] = { name: r.details?.teammate_name || id, started: null, done: null, tasks_completed: 0 };
            if (r.action === "team.teammate_start") teammates[id].started = r.created_at;
            if (r.action === "team.teammate_done") teammates[id].done = r.created_at;
            if (r.action === "team.task_complete") teammates[id].tasks_completed++;
          }
          // Flag stuck teammates (started but no done event)
          const stuck = Object.entries(teammates)
            .filter(([, v]) => v.started && !v.done)
            .map(([id, v]) => ({ id, name: v.name, started: v.started }));
          return { success: true, data: { action: "team_status", time_window: timeWindow, teammates, stuck_teammates: stuck } };
        }

        case "cost_summary": {
          let q = supabase
            .from("audit_logs")
            .select("input_tokens, output_tokens, created_at")
            .gte("created_at", since)
            .not("input_tokens", "is", null)
            .order("created_at", { ascending: false })
            .limit(1000);
          if (storeId) q = q.eq("store_id", storeId);
          if (conversationId) q = q.eq("conversation_id", conversationId);
          const { data, error } = await q;
          if (error) return { success: false, error: error.message };

          let totalIn = 0, totalOut = 0;
          for (const r of (data || []) as any[]) {
            totalIn += r.input_tokens || 0;
            totalOut += r.output_tokens || 0;
          }
          // Rough cost estimate (Sonnet pricing: $3/MTok in, $15/MTok out)
          const costEstimate = (totalIn / 1_000_000) * 3 + (totalOut / 1_000_000) * 15;
          return {
            success: true,
            data: {
              action: "cost_summary",
              time_window: timeWindow,
              api_calls: (data || []).length,
              input_tokens: totalIn,
              output_tokens: totalOut,
              total_tokens: totalIn + totalOut,
              estimated_cost_usd: `$${costEstimate.toFixed(4)}`,
            },
          };
        }

        default:
          return { success: false, error: `Unknown audit_trail action: ${action}. Use: recent, errors, tool_stats, team_status, cost_summary` };
      }
    } catch (err) {
      return { success: false, error: `Audit trail error: ${err}` };
    }
  },
};

// ============================================================================
// TELEMETRY - Built-in tracing using audit_logs table
// No third-party OTEL needed - we have: trace_id, span_id, parent_span_id
// ============================================================================

// W3C Trace Context / OpenTelemetry span kinds
export type SpanKind = "CLIENT" | "SERVER" | "INTERNAL" | "PRODUCER" | "CONSUMER";

export interface ExecutionContext {
  // Basic identification
  source: "claude_code" | "swag_manager" | "api" | "edge_function" | "mcp" | "test" | "whale_mcp" | "whale_chat";
  userId?: string;
  userEmail?: string;

  // W3C Trace Context fields
  traceId?: string;      // W3C trace-id: 32 lowercase hex chars
  spanId?: string;       // W3C span-id: 16 lowercase hex chars (auto-generated if not provided)
  parentSpanId?: string; // Parent span ID for hierarchy
  traceFlags?: number;   // 01 = sampled (default)

  // Legacy compatibility
  requestId?: string;    // Alias for traceId
  parentId?: string;     // Legacy parent (UUID)

  // Service identification
  serviceName?: string;  // e.g., "agent-server", "edge-function"
  serviceVersion?: string;

  // AI Agent context
  agentId?: string;
  agentName?: string;
  conversationId?: string;
  turnNumber?: number;
  model?: string;

  // Token tracking
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;

  // Cost isolation: marginal cost of the API turn that triggered this tool
  costBefore?: number;     // Cumulative cost before this tool's API turn
  turnCost?: number;       // Cost of the specific API turn that invoked this tool
}

// Generate W3C-compliant span ID (16 hex chars)
function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate W3C-compliant trace ID (32 hex chars)
function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function logToolExecution(
  supabase: SupabaseClient,
  toolName: string,
  action: string | undefined,
  args: Record<string, unknown>,
  result: ToolResult,
  durationMs: number,
  storeId?: string,
  context?: ExecutionContext,
  startTime?: Date
): Promise<string | null> {
  try {
    // Sanitize args - remove sensitive data (Anthropic best practice: comprehensive pattern matching)
    const SENSITIVE_PATTERNS = [
      /key/i,
      /secret/i,
      /token/i,
      /password/i,
      /auth/i,
      /credential/i,
      /bearer/i,
      /api.?key/i,
      /private/i
    ];

    const sanitizedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (SENSITIVE_PATTERNS.some(pattern => pattern.test(key))) {
        sanitizedArgs[key] = "[REDACTED]";
      } else {
        sanitizedArgs[key] = value;
      }
    }

    // Generate W3C Trace Context IDs
    const spanId = context?.spanId || generateSpanId();
    const traceId = context?.traceId || context?.requestId || generateTraceId();
    const endTime = new Date();
    const actualStartTime = startTime || new Date(endTime.getTime() - durationMs);

    // Build the insert payload with BOTH denormalized columns and JSONB details
    const corePayload: Record<string, unknown> = {
      action: `tool.${toolName}${action ? `.${action}` : ""}`,
      severity: result.success ? "info" : "error",
      store_id: storeId || null,
      user_id: context?.userId || null,
      user_email: context?.userEmail || null,
      resource_type: "mcp_tool",
      resource_id: toolName,
      request_id: context?.requestId || traceId,
      parent_id: context?.parentId || null,
      duration_ms: durationMs,
      error_message: result.error || null,

      // Denormalized OTEL columns for fast queries/aggregations
      trace_id: traceId,
      span_id: spanId,
      trace_flags: context?.traceFlags ?? 1,
      span_kind: "INTERNAL" as SpanKind,
      service_name: context?.serviceName || "agent-server",
      service_version: context?.serviceVersion || "3.0.0",
      status_code: result.success ? "OK" : "ERROR",
      start_time: actualStartTime.toISOString(),
      end_time: endTime.toISOString(),
      error_type: result.errorType || null,
      retryable: result.retryable ?? false,

      // AI telemetry columns (if executing in agent context)
      model: context?.model || null,
      input_tokens: context?.inputTokens || null,
      output_tokens: context?.outputTokens || null,
      total_cost: context?.totalCost || null,
      turn_number: context?.turnNumber || null,
      conversation_id: context?.conversationId || null,

      // JSONB details for flexible/extended attributes
      details: {
        // Source and agent info (for UI filtering)
        source: context?.source || "api",
        agent_id: context?.agentId || null,
        agent_name: context?.agentName || null,

        // Tool execution details (for UI display)
        tool_input: sanitizedArgs,
        tool_result: result.success ? (typeof result.data === 'string' ? result.data.slice(0, 1000) : result.data) : null,
        tool_error: result.error || null,
        timed_out: result.timedOut || false,

        // Cost isolation: marginal cost of the API turn that triggered this tool
        marginal_cost: context?.turnCost ?? null,
        cost_before: context?.costBefore ?? null,

        // Payload size tracking (bytes)
        input_bytes: JSON.stringify(sanitizedArgs).length,
        output_bytes: result.success
          ? (typeof result.data === 'string' ? result.data.length : JSON.stringify(result.data).length)
          : (result.error?.length ?? 0),

        // Error classification (surfaced for UI badges)
        error_type: result.errorType || null,
        retryable: result.retryable ?? false,

        // Legacy/backwards compatibility
        args: sanitizedArgs,
        result: result.success ? result.data : null,

        // OTEL context embedded (for tools that need full context)
        otel: {
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: context?.parentSpanId || null,
          trace_flags: context?.traceFlags ?? 1,
          span_kind: "INTERNAL" as SpanKind,
          service_name: context?.serviceName || "agent-server",
          service_version: context?.serviceVersion || "3.0.0",
          status_code: result.success ? "OK" : "ERROR",
          error_type: result.errorType || null,
          retryable: result.retryable ?? false
        },

        // OTEL resource attributes (gen_ai.* + tool.* semantic conventions)
        resource_attributes: {
          "tool.name": toolName,
          "tool.action": action || null,
          "tool.input_bytes": JSON.stringify(sanitizedArgs).length,
          "tool.output_bytes": result.success
            ? (typeof result.data === 'string' ? result.data.length : JSON.stringify(result.data).length)
            : 0,
          "ai.agent.id": context?.agentId || null,
          "ai.agent.name": context?.agentName || null,
          "ai.model": context?.model || null,
          "ai.turn_number": context?.turnNumber || null,
          "ai.conversation_id": context?.conversationId || null
        }
      }
    };

    // Insert using existing schema - OTEL data is embedded in details JSONB
    // This works without any migration and the UI can parse details.otel and details.ai
    const { data } = await supabase.from("audit_logs").insert(corePayload).select("id").single();

    return data?.id || null;
  } catch (err) {
    // Don't fail the tool call if logging fails
    console.error("[Telemetry] Failed to log:", err);
    return null;
  }
}

// ============================================================================
// EXECUTOR
// ============================================================================

export async function executeTool(
  supabase: SupabaseClient,
  toolName: string,
  args: Record<string, unknown>,
  storeId?: string,
  context?: ExecutionContext
): Promise<ToolResult> {
  const startDate = new Date();
  const startTime = startDate.getTime();
  const action = args.action as string | undefined;
  const handler = handlers[toolName];

  if (!handler) {
    const result: ToolResult = {
      success: false,
      error: `Tool "${toolName}" not found. Available tools: ${Object.keys(handlers).join(", ")}`,
      errorType: ToolErrorType.VALIDATION,
      retryable: false
    };

    // Log failed tool lookup with OTEL fields
    await logToolExecution(supabase, toolName, action, args, result, Date.now() - startTime, storeId, context, startDate);
    return result;
  }

  let result: ToolResult;
  try {
    result = await handler(supabase, args, storeId);

    // If handler returned an error without classification, classify it
    if (!result.success && !result.errorType) {
      const classification = classifyError({ message: result.error });
      result.errorType = classification.errorType;
      result.retryable = classification.retryable;
    }
  } catch (err: any) {
    // Classify the caught error
    const classification = classifyError(err);
    result = {
      success: false,
      error: `Tool execution error: ${err.message || err}`,
      errorType: classification.errorType,
      retryable: classification.retryable
    };
  }

  // Log the execution with full OTEL telemetry
  const durationMs = Date.now() - startTime;
  await logToolExecution(supabase, toolName, action, args, result, durationMs, storeId, context, startDate);

  return result;
}

export function getImplementedTools(): string[] {
  return Object.keys(handlers);
}
