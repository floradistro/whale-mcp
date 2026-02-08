/**
 * CLI Telemetry — fire-and-forget span logging to audit_logs
 *
 * Session-scoped conversationId + auto-incrementing turnNumber.
 * Uses same column schema as executor.ts telemetry (trace_id, span_id, etc).
 * Never blocks or crashes the chat.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveConfig, loadConfig } from "./config-store.js";
import { getValidToken, SUPABASE_URL, createAuthenticatedClient } from "./auth-service.js";
import type { ExecutionContext } from "../../tools/executor.js";

// ============================================================================
// SESSION STATE
// ============================================================================

const conversationId = crypto.randomUUID();
let turnNumber = 0;
let supabaseClient: SupabaseClient | null = null;

// ============================================================================
// W3C TRACE CONTEXT GENERATORS
// ============================================================================

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// SUPABASE CLIENT (lazy init)
// ============================================================================

async function getClient(): Promise<SupabaseClient | null> {
  if (supabaseClient) return supabaseClient;

  const config = resolveConfig();

  // Prefer service role key
  if (config.supabaseUrl && config.supabaseKey) {
    supabaseClient = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabaseClient;
  }

  // Fallback: user JWT
  const token = await getValidToken();
  if (token) {
    supabaseClient = createAuthenticatedClient(token);
    return supabaseClient;
  }

  return null;
}

// ============================================================================
// TURN CONTEXT
// ============================================================================

export function nextTurn(): number {
  return ++turnNumber;
}

export function createTurnContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  // Get user info from config (loadConfig, not resolveConfig which only returns env vars)
  const fileConfig = resolveConfig(); // This loads from file for storeId etc
  const { user_id, email } = loadConfig(); // Load user info directly

  return {
    source: "claude_code",
    serviceName: "whale-cli",
    serviceVersion: "2.1.0",
    conversationId,
    turnNumber,
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: 1,
    userId: user_id,
    userEmail: email,
    ...overrides,
  };
}

export function getConversationId(): string {
  return conversationId;
}

export function getTurnNumber(): number {
  return turnNumber;
}

// ============================================================================
// LOG SPAN (fire-and-forget)
// ============================================================================

export interface SpanOptions {
  action: string;                       // e.g. "claude_api_request", "tool.read_file"
  severity?: "info" | "warn" | "error";
  durationMs: number;
  context: ExecutionContext;
  storeId?: string;
  error?: string;
  details?: Record<string, unknown>;
}

export function logSpan(opts: SpanOptions): void {
  // Fire-and-forget — don't await, don't throw
  _logSpan(opts).catch(() => {});
}

async function _logSpan(opts: SpanOptions): Promise<void> {
  const client = await getClient();
  if (!client) return;

  const now = new Date();
  const startTime = new Date(now.getTime() - opts.durationMs);
  const ctx = opts.context;

  await client.from("audit_logs").insert({
    action: opts.action,
    severity: opts.severity || (opts.error ? "error" : "info"),
    store_id: opts.storeId || null,
    user_id: ctx.userId || null,
    user_email: ctx.userEmail || null,
    resource_type: "cli_span",
    resource_id: opts.action,
    request_id: ctx.traceId,
    parent_id: ctx.parentSpanId || null,
    duration_ms: opts.durationMs,
    error_message: opts.error || null,

    // OTEL columns
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    trace_flags: ctx.traceFlags ?? 1,
    span_kind: "INTERNAL",
    service_name: ctx.serviceName || "whale-cli",
    service_version: ctx.serviceVersion || "2.1.0",
    status_code: opts.error ? "ERROR" : "OK",
    start_time: startTime.toISOString(),
    end_time: now.toISOString(),

    // AI telemetry
    model: ctx.model || null,
    input_tokens: ctx.inputTokens || null,
    output_tokens: ctx.outputTokens || null,
    total_cost: ctx.totalCost || null,
    turn_number: ctx.turnNumber || null,
    conversation_id: ctx.conversationId || null,

    details: {
      source: "whale_mcp",
      conversation_id: conversationId,
      turn_number: turnNumber,
      ...opts.details,
    },
  });
}
