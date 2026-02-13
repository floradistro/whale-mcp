/**
 * Serve Mode — WebSocket agent server for WhaleChat desktop app
 *
 * Speaks the exact bidirectional JSON protocol that AgentClient.swift expects.
 * Runs the full agent loop with all local + server tools.
 *
 * Usage:
 *   whale serve                     Start on default port 3847
 *   whale serve --port 6090         Custom port
 *   whale serve --host 0.0.0.0      Bind to all interfaces
 *
 * Protocol: WebSocket (ws://host:port)
 *
 * Client → Server messages:
 *   query, abort, ping, get_tools, new_conversation, load_conversation, get_conversations
 *
 * Server → Client messages:
 *   ready, started, text, tool_start, tool_result, done, error, aborted,
 *   pong, tools, debug, conversation_created, conversations, conversation_loaded
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type Anthropic from "@anthropic-ai/sdk";
import {
  runAgentLoop,
  setModel,
  setPermissionMode,
  getModel,
  estimateCostUsd,
  type AgentLoopCallbacks,
  type AgentLoopOptions,
} from "./services/agent-loop.js";
import { resolveConfig } from "./services/config-store.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getValidToken, createAuthenticatedClient } from "./services/auth-service.js";
import { loadServerToolDefinitions } from "./services/server-tools.js";
import { LOCAL_TOOL_DEFINITIONS } from "./services/local-tools.js";

// ============================================================================
// TYPES
// ============================================================================

export interface ServeModeOptions {
  port: number;
  host: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  debug?: boolean;
  verbose?: boolean;
}

interface ClientSession {
  ws: WebSocket;
  abortController: AbortController | null;
  conversationHistory: Anthropic.MessageParam[];
  conversationId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ============================================================================
// SUPABASE CLIENT (for conversation persistence)
// ============================================================================

let supabase: SupabaseClient | null = null;

async function getSupabase(): Promise<SupabaseClient | null> {
  if (supabase) return supabase;

  const config = resolveConfig();

  // Tier 1: Service role key
  if (config.supabaseUrl && config.supabaseKey) {
    supabase = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return supabase;
  }

  // Tier 2: User JWT
  try {
    const token = await getValidToken();
    if (token) {
      supabase = createAuthenticatedClient(token);
      return supabase;
    }
  } catch {
    // Fall through
  }

  return null;
}

// ============================================================================
// CONVERSATION PERSISTENCE
// ============================================================================

async function createConversation(
  storeId: string | null,
  title: string,
  agentName?: string,
): Promise<string | null> {
  const db = await getSupabase();
  if (!db) return null;

  try {
    const { data, error } = await db
      .from("ai_conversations")
      .insert({
        store_id: storeId || null,
        title: title.substring(0, 100),
        messages: [],
        metadata: {
          source: "whale-serve",
          agentName: agentName || "whale",
        },
        status: "active",
      })
      .select("id")
      .single();

    if (error) {
      console.error("[serve] Failed to create conversation:", error.message);
      return null;
    }
    return data?.id || null;
  } catch (err) {
    console.error("[serve] Conversation create error:", err);
    return null;
  }
}

async function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  tokenCount?: number,
  toolNames?: string[],
): Promise<void> {
  const db = await getSupabase();
  if (!db || !conversationId) return;

  try {
    // Insert into ai_messages for individual message tracking
    await db.from("ai_messages").insert({
      conversation_id: conversationId,
      role,
      content: [{ type: "text", text: content }],
      is_tool_use: (toolNames && toolNames.length > 0) || false,
      tool_names: toolNames || [],
      token_count: tokenCount || 0,
    });
  } catch {
    // Non-fatal — persistence is best-effort
  }
}

async function updateConversationMetadata(
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const db = await getSupabase();
  if (!db || !conversationId) return;

  try {
    // Fetch current metadata, merge, and update
    const { data } = await db
      .from("ai_conversations")
      .select("metadata")
      .eq("id", conversationId)
      .single();

    const existing = (data?.metadata as Record<string, unknown>) || {};
    await db
      .from("ai_conversations")
      .update({ metadata: { ...existing, ...metadata }, updated_at: new Date().toISOString() })
      .eq("id", conversationId);
  } catch {
    // Non-fatal
  }
}

async function loadConversation(
  conversationId: string,
): Promise<{ id: string; title: string; messages: Record<string, unknown>[] } | null> {
  const db = await getSupabase();
  if (!db) return null;

  try {
    const { data, error } = await db
      .from("ai_conversations")
      .select("id, title, messages")
      .eq("id", conversationId)
      .single();

    if (error || !data) return null;
    return {
      id: data.id,
      title: data.title || "Untitled",
      messages: (data.messages as Record<string, unknown>[]) || [],
    };
  } catch {
    return null;
  }
}

async function listConversations(
  storeId: string,
  limit: number = 20,
): Promise<Record<string, unknown>[]> {
  const db = await getSupabase();
  if (!db) return [];

  try {
    const { data, error } = await db
      .from("ai_conversations")
      .select("id, title, agent_id, metadata, turn_count, created_at, updated_at")
      .eq("store_id", storeId)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data.map((c) => ({
      id: c.id,
      title: c.title || "Untitled",
      agentId: c.agent_id || null,
      agentName: (c.metadata as Record<string, unknown>)?.agentName || null,
      messageCount: c.turn_count || 0,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// TOOL LIST (for ready/tools messages)
// ============================================================================

async function getToolList(): Promise<{ id: string; name: string; description: string; category: string }[]> {
  const tools: { id: string; name: string; description: string; category: string }[] = [];

  // Local tools
  for (const t of LOCAL_TOOL_DEFINITIONS) {
    tools.push({
      id: `local-${t.name}`,
      name: t.name,
      description: t.description,
      category: "local",
    });
  }

  // Server tools
  try {
    const serverTools = await loadServerToolDefinitions();
    for (const t of serverTools) {
      if (!tools.some((existing) => existing.name === t.name)) {
        tools.push({
          id: `server-${t.name}`,
          name: t.name,
          description: t.description || "",
          category: "server",
        });
      }
    }
  } catch {
    // Server tools unavailable — local-only mode
  }

  return tools;
}

// ============================================================================
// WEBSOCKET MESSAGE HELPERS
// ============================================================================

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendDebug(ws: WebSocket, level: string, message: string, data?: Record<string, unknown>): void {
  send(ws, { type: "debug", level, message, data });
}

// ============================================================================
// QUERY HANDLER — runs the full agent loop
// ============================================================================

async function handleQuery(
  session: ClientSession,
  msg: Record<string, unknown>,
  opts: ServeModeOptions,
): Promise<void> {
  const { ws } = session;
  const prompt = msg.prompt as string;
  if (!prompt) {
    send(ws, { type: "error", error: "Missing 'prompt' field" });
    return;
  }

  const storeId = (msg.storeId as string) || resolveConfig().storeId || null;
  const config = (msg.config as Record<string, unknown>) || {};
  const requestedConvId = (msg.conversationId as string) || session.conversationId;

  // Apply model from config or server defaults
  const model = (config.model as string) || opts.model;
  if (model) setModel(model);

  // Create or continue conversation
  let conversationId = requestedConvId;
  if (!conversationId) {
    conversationId = await createConversation(storeId, prompt, config.agentName as string);
    if (conversationId) {
      send(ws, {
        type: "conversation_created",
        conversation: {
          id: conversationId,
          title: prompt.substring(0, 100),
          agentId: config.agentId || null,
          agentName: config.agentName || "whale",
          messageCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }
  session.conversationId = conversationId;

  // Persist user message
  if (conversationId) {
    appendMessage(conversationId, "user", prompt);
  }

  // Signal started
  send(ws, {
    type: "started",
    model: getModel(),
    conversationId,
  });

  // Set up abort controller
  const abortController = new AbortController();
  session.abortController = abortController;

  let totalIn = 0;
  let totalOut = 0;
  let fullText = "";
  const toolsUsed: string[] = [];
  const startTime = Date.now();

  try {
    const callbacks: AgentLoopCallbacks = {
      onText: (text: string) => {
        fullText += text;
        send(ws, { type: "text", text });
      },

      onToolStart: (name: string, input?: Record<string, unknown>) => {
        if (!toolsUsed.includes(name)) toolsUsed.push(name);
        send(ws, { type: "tool_start", tool: name, input: input || {} });
      },

      onToolResult: (
        name: string,
        success: boolean,
        result: unknown,
        _input?: Record<string, unknown>,
        durationMs?: number,
      ) => {
        // Truncate large results for the wire
        let wireResult = result;
        if (typeof result === "string" && result.length > 10000) {
          wireResult = result.substring(0, 10000) + "\n... (truncated)";
        }
        send(ws, {
          type: "tool_result",
          tool: name,
          success,
          result: wireResult,
          error: success ? undefined : (typeof result === "string" ? result : "Tool failed"),
          duration_ms: durationMs,
        });
      },

      onUsage: (input_tokens: number, output_tokens: number) => {
        totalIn += input_tokens;
        totalOut += output_tokens;
      },

      onDone: (finalMessages: Anthropic.MessageParam[]) => {
        session.conversationHistory = finalMessages;
      },

      onError: (error: string) => {
        send(ws, { type: "error", error });
      },

      onAutoCompact: (before: number, after: number, tokensSaved: number) => {
        sendDebug(ws, "info", `Context compacted: ${before} → ${after} messages (saved ~${tokensSaved} tokens)`);
      },
    };

    const loopOpts: AgentLoopOptions = {
      message: prompt,
      conversationHistory: session.conversationHistory,
      callbacks,
      abortSignal: abortController.signal,
      maxTurns: (config.maxTurns as number) || opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      effort: (opts.effort || "medium") as "low" | "medium" | "high",
      allowedTools: (config.enabledTools as string[]) || opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      fallbackModel: opts.fallbackModel,
    };

    await runAgentLoop(loopOpts);

    // Calculate cost
    session.totalInputTokens += totalIn;
    session.totalOutputTokens += totalOut;
    const totalCost = estimateCostUsd(session.totalInputTokens, session.totalOutputTokens);
    const durationMs = Date.now() - startTime;

    // Persist assistant response
    if (conversationId && fullText) {
      appendMessage(conversationId, "assistant", fullText, totalOut, toolsUsed);
    }

    // Update conversation metadata
    if (conversationId) {
      updateConversationMetadata(conversationId, {
        lastTurnTokens: { input: totalIn, output: totalOut },
        lastToolCalls: toolsUsed,
        lastDurationMs: durationMs,
        model: getModel(),
      });
    }

    // Send done
    send(ws, {
      type: "done",
      status: "complete",
      conversationId: conversationId || "",
      usage: {
        inputTokens: session.totalInputTokens,
        outputTokens: session.totalOutputTokens,
        totalCost,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted) {
      send(ws, { type: "aborted" });
    } else {
      send(ws, { type: "error", error: errorMsg });
    }
  } finally {
    session.abortController = null;
  }
}

// ============================================================================
// CONNECTION HANDLER
// ============================================================================

async function handleConnection(ws: WebSocket, opts: ServeModeOptions): Promise<void> {
  const session: ClientSession = {
    ws,
    abortController: null,
    conversationHistory: [],
    conversationId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  // Send ready with tool list
  const tools = await getToolList();
  send(ws, {
    type: "ready",
    version: "4.7.0",
    tools,
  });

  if (opts.verbose) {
    console.log("[serve] Client connected, sent ready with", tools.length, "tools");
  }

  ws.on("message", async (data: Buffer | string) => {
    let msg: Record<string, unknown>;
    try {
      const text = typeof data === "string" ? data : data.toString("utf-8");
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      send(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    const type = msg.type as string;
    if (!type) {
      send(ws, { type: "error", error: "Missing 'type' field" });
      return;
    }

    switch (type) {
      case "query":
        await handleQuery(session, msg, opts);
        break;

      case "abort":
        if (session.abortController) {
          session.abortController.abort();
          // aborted message is sent by handleQuery's catch block
        }
        break;

      case "ping":
        send(ws, { type: "pong" });
        break;

      case "get_tools": {
        const toolList = await getToolList();
        send(ws, { type: "tools", tools: toolList });
        break;
      }

      case "new_conversation":
        session.conversationHistory = [];
        session.conversationId = null;
        session.totalInputTokens = 0;
        session.totalOutputTokens = 0;
        if (opts.verbose) {
          console.log("[serve] New conversation started");
        }
        break;

      case "get_conversations": {
        const storeId = msg.storeId as string;
        const limit = (msg.limit as number) || 20;
        if (!storeId) {
          send(ws, { type: "conversations", conversations: [] });
          break;
        }
        const convs = await listConversations(storeId, limit);
        send(ws, { type: "conversations", conversations: convs });
        break;
      }

      case "load_conversation": {
        const convId = msg.conversationId as string;
        if (!convId) {
          send(ws, { type: "error", error: "Missing conversationId" });
          break;
        }
        const conv = await loadConversation(convId);
        if (conv) {
          session.conversationId = conv.id;
          send(ws, {
            type: "conversation_loaded",
            conversationId: conv.id,
            title: conv.title,
            messages: conv.messages,
          });
        } else {
          send(ws, { type: "error", error: `Conversation not found: ${convId}` });
        }
        break;
      }

      default:
        if (opts.verbose) {
          console.log("[serve] Unknown message type:", type);
        }
        break;
    }
  });

  ws.on("close", () => {
    // Abort any running query when client disconnects
    if (session.abortController) {
      session.abortController.abort();
    }
    if (opts.verbose) {
      console.log("[serve] Client disconnected");
    }
  });

  ws.on("error", (err: Error) => {
    console.error("[serve] WebSocket error:", err.message);
    if (session.abortController) {
      session.abortController.abort();
    }
  });
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

export async function runServeMode(opts: ServeModeOptions): Promise<void> {
  // Apply global settings
  if (opts.model) setModel(opts.model);
  setPermissionMode((opts.permissionMode as "default" | "plan" | "yolo") || "yolo");

  const port = opts.port;
  const host = opts.host;

  // HTTP server for health check + WebSocket upgrade
  const server = createServer((req, res) => {
    // Health check endpoint
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: "4.7.0",
          model: getModel(),
          port,
          uptime: Math.floor(process.uptime()),
        }),
      );
      return;
    }

    // Everything else: 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Connect via WebSocket." }));
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket) => {
    handleConnection(ws, opts);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[serve] Shutting down...");
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, "Server shutting down");
      }
    });
    server.close(() => {
      console.log("[serve] Server stopped.");
      process.exit(0);
    });
    // Force exit after 3s
    setTimeout(() => process.exit(0), 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Verify Supabase connectivity (non-blocking)
  getSupabase().then((db) => {
    if (db) {
      console.log("[serve] Supabase connected — conversation persistence enabled");
    } else {
      console.log("[serve] Supabase not configured — conversations are session-only");
    }
  });

  // Start listening
  return new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[serve] Port ${port} is already in use.`);
        console.error(`[serve] Try: whale serve --port ${port + 1}`);
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, host, () => {
      const d = "\x1b[2m";
      const B = "\x1b[1m";
      const r = "\x1b[0m";
      const c = "\x1b[38;2;99;102;241m";

      console.log();
      console.log(`  ${c}${B}◆ whale serve${r}  ${d}v4.7.0${r}`);
      console.log();
      console.log(`  ${B}WebSocket${r}  ${d}ws://${host}:${port}${r}`);
      console.log(`  ${B}Health${r}     ${d}http://${host}:${port}/health${r}`);
      console.log(`  ${B}Model${r}      ${d}${getModel()}${r}`);
      console.log(`  ${B}Mode${r}       ${d}yolo (local server trusts local client)${r}`);
      console.log();
      console.log(`  ${d}WhaleChat will auto-connect on port 3847${r}`);
      console.log(`  ${d}Press Ctrl+C to stop${r}`);
      console.log();

      resolve();
    });
  });
}
