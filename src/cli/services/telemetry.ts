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

let conversationId: string = crypto.randomUUID();
let turnNumber = 0;

/**
 * Set the conversation ID (used by worker threads to share parent's conversation)
 */
export function setConversationId(id: string): void {
  conversationId = id;
}

/**
 * Get the current conversation ID
 */
export function getConversationId(): string {
  return conversationId;
}
let supabaseClient: SupabaseClient | null = null;

/**
 * Initialize the telemetry client with a specific auth token.
 * Used by worker threads that receive the token from the parent.
 */
export function initializeTelemetryClient(authToken: string): void {
  if (supabaseClient) return; // Already initialized

  supabaseClient = createAuthenticatedClient(authToken);
  if (process.env.DEBUG_TELEMETRY) {
    process.stderr.write(`[telemetry] initialized client with provided auth token\n`);
  }
}

// ============================================================================
// W3C TRACE CONTEXT GENERATORS
// ============================================================================

export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function generateSpanId(): string {
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
    if (process.env.DEBUG_TELEMETRY) {
      process.stderr.write(`[telemetry] using service role key\n`);
    }
    return supabaseClient;
  }

  // Fallback: user JWT
  const token = await getValidToken();
  if (token) {
    supabaseClient = createAuthenticatedClient(token);
    if (process.env.DEBUG_TELEMETRY) {
      process.stderr.write(`[telemetry] using user JWT token\n`);
    }
    return supabaseClient;
  }

  if (process.env.DEBUG_TELEMETRY) {
    process.stderr.write(`[telemetry] NO CLIENT - no service key and no valid token\n`);
    process.stderr.write(`[telemetry]   config.supabaseUrl: ${config.supabaseUrl}\n`);
    process.stderr.write(`[telemetry]   config.supabaseKey: ${config.supabaseKey ? 'set' : 'not set'}\n`);
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
  // Fire-and-forget — don't await, log errors in debug mode
  _logSpan(opts).catch((err) => {
    if (process.env.DEBUG_TELEMETRY) {
      process.stderr.write(`[telemetry error] ${opts.action}: ${err.message}\n`);
    }
  });
}

async function _logSpan(opts: SpanOptions): Promise<void> {
  if (process.env.DEBUG_TELEMETRY) {
    process.stderr.write(`[telemetry] _logSpan called for ${opts.action}\n`);
  }

  const client = await getClient();
  if (!client) {
    if (process.env.DEBUG_TELEMETRY) {
      process.stderr.write(`[telemetry] no client for ${opts.action}\n`);
    }
    return;
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - opts.durationMs);
  const ctx = opts.context;

  // Debug: log team-related spans (only when DEBUG_TELEMETRY is set)
  if (process.env.DEBUG_TELEMETRY && (opts.action.startsWith("team.") || opts.details?.parent_conversation_id)) {
    process.stderr.write(`[telemetry:team] action=${opts.action}\n`);
    process.stderr.write(`[telemetry:team]   conversation_id=${ctx.conversationId}\n`);
    process.stderr.write(`[telemetry:team]   parent_conversation_id=${opts.details?.parent_conversation_id}\n`);
  }

  const { error } = await client.from("audit_logs").insert({
    action: opts.action,
    severity: opts.severity || (opts.error ? "error" : "info"),
    store_id: opts.storeId || resolveConfig().storeId || null,
    user_id: ctx.userId || null,
    user_email: ctx.userEmail || null,
    resource_type: "cli_span",
    resource_id: opts.action,
    request_id: ctx.traceId,
    // parent_id is UUID type, but OTEL span IDs are not UUIDs - store in details instead
    parent_id: null,
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

    // AI telemetry — use ?? to handle 0 correctly
    model: ctx.model || null,
    input_tokens: ctx.inputTokens ?? null,
    output_tokens: ctx.outputTokens ?? null,
    total_cost: ctx.totalCost ?? null,
    turn_number: ctx.turnNumber ?? null,
    conversation_id: ctx.conversationId || null,

    details: {
      source: ctx.source || "whale_cli",
      conversation_id: ctx.conversationId || conversationId,
      turn_number: ctx.turnNumber ?? turnNumber,
      parent_span_id: ctx.parentSpanId || null,
      ...opts.details,
    },
  });

  if (error) {
    if (process.env.DEBUG_TELEMETRY) {
      process.stderr.write(`[telemetry db error] ${opts.action}: ${error.message}\n`);
      process.stderr.write(`[telemetry db error]   code: ${error.code}\n`);
      process.stderr.write(`[telemetry db error]   hint: ${error.hint}\n`);
    }
  } else if (opts.details?.is_teammate && process.env.DEBUG_TELEMETRY) {
    process.stderr.write(`[telemetry] teammate span logged: ${opts.action}\n`);
  }
}
