/**
 * ChatApp — whale code CLI
 *
 * Uses Ink's <Static> for completed messages — written to stdout once,
 * never re-rendered. Only the active area (streaming, tools, input)
 * is managed by Ink's render loop. This prevents scroll bounce when
 * content exceeds the terminal height.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  runAgentLoop, canUseAgent, getServerToolCount, getServerStatus,
  setModel, getModel, getModelShortName,
  loadClaudeMd, getSessionTokens,
  saveSession, loadSession, listSessions, type SessionMeta,
  addMemory, removeMemory, listMemories,
  setPermissionMode, getPermissionMode, type PermissionMode,
} from "../services/agent-loop.js";
import { setConversationId } from "../services/telemetry.js";
import { getAllServerToolDefinitions, resetServerToolClient } from "../services/server-tools.js";
import { LOCAL_TOOL_DEFINITIONS, loadTodos, setTodoSessionId } from "../services/local-tools.js";
import { loadAgentDefinitions } from "../services/agent-definitions.js";
import { AgentEventEmitter, type AgentEvent } from "../services/agent-events.js";
import { CompletedMessage, type ChatMessage, type ToolCall } from "./MessageList.js";
import { ToolIndicator } from "./ToolIndicator.js";
import { SubagentPanel, type SubagentActivityState, type CompletedSubagentInfo } from "./SubagentPanel.js";
import { TeamPanel } from "./TeamPanel.js";
import { StreamingText } from "./StreamingText.js";
import { ChatInput, SLASH_COMMANDS, type ImageAttachment } from "./ChatInput.js";
import { StoreSelector } from "./StoreSelector.js";
import { colors, symbols } from "../shared/Theme.js";
import { loadConfig } from "../services/config-store.js";
import { getStoresForUser, getValidToken, selectStore, type StoreInfo } from "../services/auth-service.js";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Thinking verbs — rotate randomly each render (Claude Code parity)
const THINKING_VERBS = [
  "thinking…",
  "reasoning…",
  "considering…",
  "analyzing…",
  "evaluating…",
  "pondering…",
  "processing…",
  "reflecting…",
  "examining…",
  "working…",
];

function randomVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
}

const PKG_NAME = "swagmanager-mcp";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_VERSION: string = createRequire(import.meta.url)(join(__dirname, "..", "..", "..", "package.json")).version;

// ── Types for Static rendering ──

type StaticItem =
  | { id: string; type: "header" }
  | { id: string; type: "message"; msg: ChatMessage; index: number };

// ── Component ──

export function ChatApp() {
  const { exit } = useApp();

  // Core state
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolCall[]>([]);
  const [subagentActivity, setSubagentActivity] = useState<Map<string, SubagentActivityState>>(new Map());
  const [completedSubagents, setCompletedSubagents] = useState<CompletedSubagentInfo[]>([]);
  const [teamState, setTeamState] = useState<{
    name: string;
    tasksCompleted: number;
    tasksTotal: number;
    teammates: Map<string, { name: string; status: string }>; // teammateId → { name, status }
  } | null>(null);

  // UI state
  const [userLabel, setUserLabel] = useState("");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [serverToolsAvailable, setServerToolsAvailable] = useState(0);
  const [storeSelectMode, setStoreSelectMode] = useState(false);
  const [storeList, setStoreList] = useState<StoreInfo[]>([]);
  const [currentModel, setCurrentModel] = useState(getModelShortName());
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Refs
  const conversationRef = useRef<Anthropic.MessageParam[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const accTextRef = useRef(""); // Accumulates streaming text, flushed to state every 150ms
  const textTimerRef = useRef<NodeJS.Timeout | null>(null);
  const teamTimerRef = useRef<NodeJS.Timeout | null>(null); // Debounce team state updates
  const toolOutputTimerRef = useRef<NodeJS.Timeout | null>(null); // Throttle tool_output re-renders
  const thinkingVerbRef = useRef(randomVerb()); // Stable verb — doesn't change every render

  useEffect(() => {
    return () => {
      if (textTimerRef.current) clearTimeout(textTimerRef.current);
      if (teamTimerRef.current) clearTimeout(teamTimerRef.current);
      if (toolOutputTimerRef.current) clearTimeout(toolOutputTimerRef.current);
    };
  }, []);

  // ── Init ──
  useEffect(() => {
    const check = canUseAgent();
    if (!check.ready) {
      setError(check.reason || "Run 'whale login' to authenticate.");
    } else {
      const config = loadConfig();
      if (config.email) setUserLabel(config.store_name || config.email);
      setReady(true);
      getServerToolCount().then((count) => setServerToolsAvailable(count));
    }
  }, []);

  // ── Keys ──
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (abortRef.current) abortRef.current.abort();
      exit();
    }
    if (key.escape && isStreaming && abortRef.current) {
      abortRef.current.abort();
    }
    if (input === "e" && key.ctrl) {
      setToolsExpanded((prev) => !prev);
    }
  });

  // ── Commands ──
  const handleCommand = useCallback(async (command: string) => {
    // Parse typed commands with args (e.g. "/remember always use bun")
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0]; // e.g. "/remember"
    const args = parts.slice(1).join(" "); // e.g. "always use bun"

    switch (cmd) {
      case "/help":
        setMessages((prev) => [...prev, {
          role: "assistant",
          text: SLASH_COMMANDS
            .map((c) => `  ${c.name.padEnd(12)} ${c.description}`)
            .join("\n") + "\n\n  ^C exit  esc cancel  ^E expand tools",
        }]);
        break;

      case "/clear":
        setMessages([]);
        setStreamingText("");
        setActiveTools([]);
        setTeamState(null);
        conversationRef.current = [];
        break;

      case "/exit":
        if (abortRef.current) abortRef.current.abort();
        exit();
        break;

      case "/status": {
        const config = loadConfig();
        const localCount = LOCAL_TOOL_DEFINITIONS.length;
        const toolsLine = serverToolsAvailable > 0
          ? `  tools     ${localCount} local + ${serverToolsAvailable} server`
          : `  tools     ${localCount} local`;
        const claudeMd = loadClaudeMd();
        const tokens = getSessionTokens();
        const tokenLine = tokens.input > 0
          ? `  tokens    ${(tokens.input / 1000).toFixed(1)}K in / ${(tokens.output / 1000).toFixed(1)}K out`
          : `  tokens    (no usage yet)`;
        const lines = [
          `  version   v${PKG_VERSION}`,
          `  user      ${config.email || "—"}`,
          `  store     ${config.store_name || "—"}`,
          `  model     ${getModelShortName()}  (${getModel()})`,
          `  output    16384 max tokens`,
          toolsLine,
          tokenLine,
          `  session   ${sessionId || "(unsaved)"}`,
          `  CLAUDE.md ${claudeMd ? claudeMd.path : "not found"}`,
          `  mode      ${getPermissionMode()}`,
          `  context   ${conversationRef.current.length} messages`,
          `  expand    ${toolsExpanded ? "on" : "off"}  (^E)`,
        ];
        setMessages((prev) => [...prev, { role: "assistant", text: lines.join("\n") }]);
        break;
      }

      case "/mcp": {
        getServerStatus().then((status) => {
          const lines: string[] = [];
          if (status.connected) {
            lines.push(`  ● Connected`);
            lines.push(`  auth      ${status.authMethod === "service_role" ? "service role" : "user JWT"}`);
            lines.push(`  store     ${status.storeName || status.storeId || "—"}`);
            lines.push(`  tools     ${status.toolCount} active`);
            lines.push("");
            const serverDefs = getAllServerToolDefinitions();
            for (const t of serverDefs) {
              lines.push(`    ${t.name.padEnd(20)} ${(t.description || "").slice(0, 45)}`);
            }
          } else {
            lines.push(`  ○ Disconnected`);
            lines.push("");
            lines.push("  Run: whale login");
          }
          setMessages((prev) => [...prev, { role: "assistant", text: lines.join("\n") }]);
        });
        break;
      }

      case "/store": {
        getValidToken().then(async (token) => {
          if (!token) {
            setMessages((prev) => [...prev, { role: "assistant", text: "  Not logged in. Run: whale login" }]);
            return;
          }
          const config = loadConfig();
          const stores = await getStoresForUser(token, config.user_id || "");
          if (stores.length === 0) {
            setMessages((prev) => [...prev, { role: "assistant", text: "  No stores found for this account." }]);
          } else if (stores.length === 1) {
            setMessages((prev) => [...prev, { role: "assistant", text: `  Only one store: ${stores[0].name}` }]);
          } else {
            setStoreList(stores);
            setStoreSelectMode(true);
          }
        });
        break;
      }

      case "/update": {
        setMessages((prev) => [...prev, { role: "assistant", text: `  Checking for updates...` }]);
        try {
          const latest = execSync(`npm view ${PKG_NAME} version 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (latest === PKG_VERSION) {
            setMessages((prev) => [...prev, { role: "assistant", text: `  ${symbols.check} Already on latest  v${PKG_VERSION}` }]);
          } else {
            setMessages((prev) => [...prev, { role: "assistant", text: `  v${PKG_VERSION} → v${latest}  Installing...` }]);
            try {
              execSync(`npm install -g ${PKG_NAME}@latest 2>&1`, { encoding: "utf-8", timeout: 30000 });
              setMessages((prev) => [...prev, { role: "assistant", text: `  ${symbols.check} Updated to v${latest}\n  Restart whale to use the new version.` }]);
            } catch (installErr: any) {
              setMessages((prev) => [...prev, { role: "assistant", text: `  ${symbols.cross} Install failed. Try manually:\n  npm install -g ${PKG_NAME}@latest` }]);
            }
          }
        } catch {
          setMessages((prev) => [...prev, { role: "assistant", text: `  ${symbols.cross} Could not check npm. Are you online?` }]);
        }
        break;
      }

      case "/model": {
        const models = ["sonnet", "opus", "haiku"];
        if (args && models.includes(args)) {
          // Explicit: /model opus
          const result = setModel(args);
          setCurrentModel(args);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${symbols.check} Model: ${args}  (${result.model})`,
          }]);
        } else {
          // Cycle through models
          const current = getModelShortName();
          const nextIdx = (models.indexOf(current) + 1) % models.length;
          const next = models[nextIdx];
          const result = setModel(next);
          setCurrentModel(next);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${symbols.check} Model: ${next}  (${result.model})`,
          }]);
        }
        break;
      }

      case "/compact": {
        setMessages((prev) => [...prev, {
          role: "assistant",
          text: `  Context management is now handled server-side by the Anthropic API. Compaction fires automatically when context exceeds 150K tokens.`,
        }]);
        break;
      }

      case "/save": {
        if (conversationRef.current.length === 0) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  Nothing to save." }]);
        } else {
          const id = saveSession(conversationRef.current, sessionId || undefined);
          setSessionId(id);
          setTodoSessionId(id);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${symbols.check} Session saved: ${id}`,
          }]);
        }
        break;
      }

      case "/sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  No saved sessions." }]);
        } else {
          const lines = sessions.map((s, i) =>
            `  ${String(i + 1).padStart(2)}. ${s.title.slice(0, 40).padEnd(42)} ${s.messageCount} msgs  ${s.updatedAt.slice(0, 10)}`
          );
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  Saved sessions:\n${lines.join("\n")}\n\n  Use /resume to load a session.`,
          }]);
        }
        break;
      }

      case "/resume": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  No saved sessions." }]);
        } else {
          const latest = sessions[0];
          const loaded = loadSession(latest.id);
          if (loaded) {
            conversationRef.current = loaded.messages;
            setSessionId(latest.id);
            setConversationId(latest.id);
            setTodoSessionId(latest.id);
            loadTodos(latest.id);
            if (loaded.meta.model) setModel(loaded.meta.model);
            setMessages((prev) => [...prev, {
              role: "assistant",
              text: `  ${symbols.check} Resumed: ${latest.title}\n  ${latest.messageCount} messages, model: ${getModelShortName()}`,
            }]);
          } else {
            setMessages((prev) => [...prev, { role: "assistant", text: "  Failed to load session." }]);
          }
        }
        break;
      }

      case "/agents": {
        const builtIn = ["explore", "plan", "general-purpose", "research"];
        const custom = loadAgentDefinitions();
        const lines: string[] = [];
        lines.push("  Built-in:");
        for (const a of builtIn) lines.push(`    ${a.padEnd(20)} (built-in)`);
        if (custom.length > 0) {
          lines.push("");
          lines.push("  Custom:");
          for (const a of custom) {
            lines.push(`    ${a.name.padEnd(20)} ${a.description || `(${a.source})`}`);
          }
        } else {
          lines.push("");
          lines.push("  No custom agents. Add .md files to .whale/agents/ or ~/.swagmanager/agents/");
        }
        setMessages((prev) => [...prev, { role: "assistant", text: lines.join("\n") }]);
        break;
      }

      case "/remember": {
        if (!args) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  Usage: /remember <fact to remember>" }]);
        } else {
          const result = addMemory(args);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${result.success ? symbols.check : symbols.cross} ${result.message}`,
          }]);
        }
        break;
      }

      case "/forget": {
        if (!args) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  Usage: /forget <pattern to match>" }]);
        } else {
          const result = removeMemory(args);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${result.success ? symbols.check : symbols.cross} ${result.message}`,
          }]);
        }
        break;
      }

      case "/memory": {
        const memories = listMemories();
        if (memories.length === 0) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  No memories stored. Use /remember <fact> to add one." }]);
        } else {
          const lines = memories.map((m, i) => `  ${i + 1}. ${m}`);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${memories.length} remembered fact${memories.length !== 1 ? "s" : ""}:\n${lines.join("\n")}`,
          }]);
        }
        break;
      }

      case "/mode": {
        const modeDesc: Record<PermissionMode, string> = {
          default: "all tools, normal operation",
          plan: "read-only tools only (no writes, no commands)",
          yolo: "all tools, no confirmation",
        };
        const modes: PermissionMode[] = ["default", "plan", "yolo"];

        if (args && modes.includes(args as PermissionMode)) {
          // Explicit mode set: /mode plan
          setPermissionMode(args as PermissionMode);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${symbols.check} Mode: ${args}  (${modeDesc[args as PermissionMode]})`,
          }]);
        } else {
          // Cycle through modes
          const current = getPermissionMode();
          const nextIdx = (modes.indexOf(current) + 1) % modes.length;
          const next = modes[nextIdx];
          setPermissionMode(next);
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${symbols.check} Mode: ${next}  (${modeDesc[next]})`,
          }]);
        }
        break;
      }

      case "/tools": {
        const lines: string[] = [];
        lines.push(`  Local (${LOCAL_TOOL_DEFINITIONS.length})`);
        for (const t of LOCAL_TOOL_DEFINITIONS) {
          lines.push(`    ${t.name.padEnd(20)} ${t.description.slice(0, 48)}`);
        }
        lines.push("");
        if (serverToolsAvailable > 0) {
          lines.push(`  Server (${serverToolsAvailable})`);
          const serverDefs = getAllServerToolDefinitions();
          for (const t of serverDefs) {
            lines.push(`    ${t.name.padEnd(20)} ${(t.description || "").slice(0, 48)}`);
          }
        } else {
          lines.push("  Server (unavailable — /mcp for details)");
        }
        setMessages((prev) => [...prev, { role: "assistant", text: lines.join("\n") }]);
        break;
      }
    }
  }, [exit, toolsExpanded, serverToolsAvailable]);

  // ── Store Select ──
  const handleStoreSelect = useCallback((store: StoreInfo) => {
    selectStore(store.id, store.name);
    resetServerToolClient();
    setStoreSelectMode(false);
    setStoreList([]);
    setUserLabel(store.name);
    setMessages((prev) => [...prev, {
      role: "assistant",
      text: `  ${symbols.check} Switched to ${store.name}`,
    }]);
    getServerToolCount().then((count) => setServerToolsAvailable(count));
  }, []);

  const handleStoreCancel = useCallback(() => {
    setStoreSelectMode(false);
    setStoreList([]);
  }, []);

  // ── Send ──
  const handleSend = useCallback(async (userMessage: string, images?: ImageAttachment[]) => {
    if (isStreaming) return;
    setMessages((prev) => [...prev, {
      role: "user",
      text: userMessage,
      images: images?.map(img => img.name),
    }]);
    setStreamingText("");
    setActiveTools([]);
    setSubagentActivity(new Map());
    setCompletedSubagents([]);
    setTeamState(null);
    setIsStreaming(true);
    thinkingVerbRef.current = randomVerb(); // Pick new verb per request, not per render

    const abort = new AbortController();
    abortRef.current = abort;
    accTextRef.current = "";
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    // Flush accumulated streaming text to the permanent message feed
    const flushText = () => {
      const text = accTextRef.current;
      if (text.trim()) {
        setMessages(prev => [...prev, { role: "assistant" as const, text }]);
      }
      accTextRef.current = "";
      if (textTimerRef.current) { clearTimeout(textTimerRef.current); textTimerRef.current = null; }
      setStreamingText("");
    };

    // Emitter for text streaming + team/subagent events
    const emitter = new AgentEventEmitter();

    // Team tracking (refs to avoid stale closures)
    let teamName = "";
    let teamTotal = 0;
    let teamCompleted = 0;
    const teammateStatus = new Map<string, { name: string; status: string }>(); // id → { name, status }

    // Helper: flush batched team state to React
    const flushTeamState = () => {
      if (teamTimerRef.current) { clearTimeout(teamTimerRef.current); teamTimerRef.current = null; }
      setTeamState({ name: teamName, tasksCompleted: teamCompleted, tasksTotal: teamTotal, teammates: new Map(teammateStatus) });
    };

    // Helper: schedule debounced team state update (batches rapid events)
    const scheduleTeamFlush = () => {
      if (!teamTimerRef.current) {
        teamTimerRef.current = setTimeout(() => {
          teamTimerRef.current = null;
          flushTeamState();
        }, 200);
      }
    };

    const unsub = emitter.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case "text":
          accTextRef.current += event.text;
          if (!textTimerRef.current) {
            textTimerRef.current = setTimeout(() => {
              textTimerRef.current = null;
              setStreamingText(accTextRef.current);
            }, 150);
          }
          break;

        case "tool_output": {
          // Update running tool's partial result for live streaming display
          const idx = toolCalls.findIndex(t => t.name === event.toolName && t.status === "running");
          if (idx >= 0) {
            const prev = toolCalls[idx].result || "";
            const lines = (prev + "\n" + event.line).split("\n");
            toolCalls[idx].result = lines.slice(-4).join("\n").trim();
            // Throttle re-renders — batch rapid output lines (250ms)
            if (!toolOutputTimerRef.current) {
              toolOutputTimerRef.current = setTimeout(() => {
                toolOutputTimerRef.current = null;
                setActiveTools([...toolCalls]);
              }, 250);
            }
          }
          break;
        }

        case "team_start":
          teamName = event.name;
          teamTotal = event.taskCount;
          teamCompleted = 0;
          teammateStatus.clear();
          flushTeamState(); // Immediate — show panel right away
          break;

        case "team_task":
          if (event.status === "started") {
            const existing = teammateStatus.get(event.teammateId);
            teammateStatus.set(event.teammateId, { name: existing?.name || event.teammateId, status: event.taskDescription.slice(0, 50) });
          } else if (event.status === "completed") {
            teamCompleted++;
            const existing = teammateStatus.get(event.teammateId);
            teammateStatus.set(event.teammateId, { name: existing?.name || event.teammateId, status: "done" });
          } else if (event.status === "failed") {
            const existing = teammateStatus.get(event.teammateId);
            teammateStatus.set(event.teammateId, { name: existing?.name || event.teammateId, status: "failed" });
          }
          // Task status changes are important — flush immediately
          flushTeamState();
          break;

        case "team_progress":
          teammateStatus.set(event.teammateId, { name: event.teammateName || event.teammateId, status: event.message.slice(0, 50) });
          // Progress updates are frequent — debounce to avoid excessive re-renders
          scheduleTeamFlush();
          break;

        case "team_done":
          // Flush any pending timer before clearing
          if (teamTimerRef.current) { clearTimeout(teamTimerRef.current); teamTimerRef.current = null; }
          setTeamState(null);
          // Clear stale pre-team streaming text to prevent flash
          accTextRef.current = "";
          if (textTimerRef.current) { clearTimeout(textTimerRef.current); textTimerRef.current = null; }
          setStreamingText("");
          break;

        case "subagent_start":
          setSubagentActivity(prev => {
            const next = new Map(prev);
            next.set(event.id, {
              type: event.agentType,
              model: event.model,
              description: event.description,
              turn: 0,
              message: "starting…",
              tools: [],
              startTime: Date.now(),
            });
            return next;
          });
          break;

        case "subagent_progress":
          setSubagentActivity(prev => {
            const next = new Map(prev);
            const existing = next.get(event.id);
            if (existing) {
              next.set(event.id, {
                ...existing,
                turn: event.turn || existing.turn,
                message: event.message,
              });
            }
            return next;
          });
          break;

        case "subagent_tool_start":
          setSubagentActivity(prev => {
            const next = new Map(prev);
            const existing = next.get(event.agentId);
            if (existing) {
              next.set(event.agentId, {
                ...existing,
                tools: [...existing.tools, {
                  name: event.toolName,
                  status: "running" as const,
                  input: event.toolInput,
                }],
              });
            }
            return next;
          });
          break;

        case "subagent_tool_end":
          setSubagentActivity(prev => {
            const next = new Map(prev);
            const existing = next.get(event.agentId);
            if (existing) {
              // Find the last running instance of this tool and mark it done
              const tools = [...existing.tools];
              for (let i = tools.length - 1; i >= 0; i--) {
                if (tools[i].name === event.toolName && tools[i].status === "running") {
                  tools[i] = { ...tools[i], status: event.success ? "success" : "error", durationMs: event.durationMs };
                  break;
                }
              }
              next.set(event.agentId, { ...existing, tools });
            }
            return next;
          });
          break;

        case "subagent_done":
          setSubagentActivity(prev => {
            const existing = prev.get(event.id);
            const next = new Map(prev);
            next.delete(event.id);
            // Move to completed list with stats
            if (existing) {
              setCompletedSubagents(prevCompleted => [...prevCompleted, {
                id: event.id,
                type: event.agentType,
                description: existing.description || "",
                toolCount: event.tools.length,
                tokens: event.tokens,
                durationMs: event.durationMs,
                success: event.success,
              }]);
            }
            return next;
          });
          break;

        case "done":
          // Flush any pending text timer before capturing final text
          if (textTimerRef.current) {
            clearTimeout(textTimerRef.current);
            textTimerRef.current = null;
          }
          // Capture last-turn text from agent-loop (fixes multi-tool duplication)
          accTextRef.current = event.text;
          break;
      }
    });

    await runAgentLoop({
      message: userMessage,
      images: images?.map(img => ({ base64: img.base64, mediaType: img.mediaType })),
      conversationHistory: conversationRef.current,
      abortSignal: abort.signal,
      emitter,
      callbacks: {
        onText: () => {}, // Handled by emitter
        onToolStart: (name, input) => {
          if (input) {
            // Update: input is now ready for a running tool — attach it
            const idx = toolCalls.findIndex(t => t.name === name && t.status === "running" && !t.input);
            if (idx >= 0) {
              toolCalls[idx].input = input;
              setActiveTools([...toolCalls]);
            }
            return;
          }
          flushText(); // Commit any accumulated text before tool starts
          toolCalls.push({ name, status: "running" });
          setActiveTools([...toolCalls]);
        },
        onToolResult: (name, success, result, input, durationMs) => {
          // Flush any pending tool output timer
          if (toolOutputTimerRef.current) { clearTimeout(toolOutputTimerRef.current); toolOutputTimerRef.current = null; }
          // Build the completed tool object
          const completedTool: ToolCall = {
            name,
            status: success ? "success" : "error",
            result: typeof result === "string" ? result : JSON.stringify(result),
            input,
            durationMs,
          };
          // Remove from running tools
          const idx = toolCalls.findIndex((t) => t.name === name && t.status === "running");
          if (idx >= 0) toolCalls.splice(idx, 1);
          // Batch: append to last message if it's a tool-only assistant message (no text, no usage).
          // This groups parallel tool calls from one API response into a single message,
          // preventing spammy duplicate rows when the model requests many similar tools.
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && !last.text && !last.usage && last.toolCalls?.length) {
              const updated = { ...last, toolCalls: [...last.toolCalls, completedTool] };
              return [...prev.slice(0, -1), updated];
            }
            return [...prev, { role: "assistant" as const, text: "", toolCalls: [completedTool] }];
          });
          setActiveTools([...toolCalls]);
          // Reset streaming text for next chunk
          accTextRef.current = "";
          if (textTimerRef.current) { clearTimeout(textTimerRef.current); textTimerRef.current = null; }
          setStreamingText("");
        },
        onUsage: (input_tokens, output_tokens) => {
          usage = { input_tokens, output_tokens };
        },
        onAutoCompact: (before, after, tokensSaved) => {
          setMessages((prev) => [...prev, {
            role: "assistant" as const,
            text: `  Context auto-compacted: ${before} messages -> ${after} messages (~${(tokensSaved / 1000).toFixed(0)}K tokens freed)`,
          }]);
        },
        onDone: (finalMessages) => {
          unsub();
          emitter.destroy();
          if (textTimerRef.current) { clearTimeout(textTimerRef.current); textTimerRef.current = null; }
          // Commit completed subagent summaries to the feed
          setCompletedSubagents(prevCompleted => {
            if (prevCompleted.length > 0) {
              setMessages(prev => [...prev, {
                role: "assistant" as const,
                text: "",
                completedSubagents: prevCompleted,
              }]);
            }
            return [];
          });
          // Commit final text + usage to the feed (text/tools already committed incrementally)
          const finalText = accTextRef.current;
          if (finalText.trim() || usage) {
            setMessages((prev) => [...prev, {
              role: "assistant" as const,
              text: finalText,
              usage,
            }]);
          }
          setStreamingText("");
          setActiveTools([]);
          setSubagentActivity(new Map());
          setTeamState(null);
          setIsStreaming(false);
          abortRef.current = null;
          conversationRef.current = finalMessages;
        },
        onError: (err, partialMessages) => {
          unsub();
          emitter.destroy();
          if (textTimerRef.current) { clearTimeout(textTimerRef.current); textTimerRef.current = null; }
          if (err !== "Cancelled") {
            setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${err}` }]);
          }
          setStreamingText("");
          setActiveTools([]);
          setSubagentActivity(new Map());
          setCompletedSubagents([]);
          setTeamState(null);
          setIsStreaming(false);
          abortRef.current = null;
          // Preserve conversation history even on error/cancel so next turn has context
          if (partialMessages && partialMessages.length > 0) {
            conversationRef.current = partialMessages;
          }
        },
      },
    });
  }, [isStreaming]);

  // ── Render ──

  const termWidth = process.stdout.columns || 80;
  const contentWidth = Math.max(20, termWidth - 2);

  // Split messages: all-but-last go to Static (stdout, never re-rendered),
  // the last message stays in the dynamic area so content doesn't vanish
  // from the user's viewport when generation finishes.
  // IMPORTANT: Must be above early returns so hooks are called unconditionally.
  const { staticItems, dynamicMessages } = useMemo(() => {
    const items: StaticItem[] = [{ id: "header", type: "header" }];
    // Keep last message in dynamic area; commit everything else to Static
    const cutoff = Math.max(0, messages.length - 1);
    for (let i = 0; i < cutoff; i++) {
      items.push({ id: `msg-${i}`, type: "message", msg: messages[i], index: i });
    }
    const tail = messages.length > 0 ? [messages[messages.length - 1]] : [];
    return { staticItems: items, dynamicMessages: tail };
  }, [messages]);

  if (error) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Text>{" "}</Text>
        <Text color={colors.brand} bold>◆ whale code</Text>
        <Text>{" "}</Text>
        <Text color={colors.error}>{error}</Text>
      </Box>
    );
  }

  if (!ready) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Text color={colors.tertiary}>loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Static area: header + all-but-last messages — committed to stdout, immune to re-renders */}
      <Static items={staticItems}>
        {(item: StaticItem) => {
          if (item.type === "header") {
            return (
              <Box key={item.id} flexDirection="column">
                <Text>{" "}</Text>
                <Text>
                  <Text color={colors.brand} bold>◆ whale code</Text>
                  {userLabel ? <Text color={colors.dim}>  {userLabel}</Text> : null}
                  <Text color={colors.dim}>  {currentModel}</Text>
                  {serverToolsAvailable > 0 ? (
                    <Text color={colors.tertiary}>  {symbols.dot} {serverToolsAvailable} server tools</Text>
                  ) : null}
                </Text>
                <Text color={colors.separator}>{"─".repeat(contentWidth)}</Text>
              </Box>
            );
          }
          return <CompletedMessage key={item.id} msg={item.msg} index={item.index} toolsExpanded={toolsExpanded} />;
        }}
      </Static>

      {/* Last completed message — stays in dynamic area so content doesn't vanish from viewport */}
      {dynamicMessages.map((msg, i) => (
        <CompletedMessage key={`dynamic-${messages.length - 1}`} msg={msg} index={messages.length - 1} toolsExpanded={toolsExpanded} />
      ))}

      {/* During team mode: tree-style teammate status */}
      {teamState ? (
        <TeamPanel team={teamState} />
      ) : (
        <>
          {/* Thinking */}
          {isStreaming && !streamingText && activeTools.length === 0 && (
            <Text>
              <Text color="#0A84FF">  </Text>
              <Text color="#0A84FF"><Spinner type="dots" /></Text>
              <Text color="#86868B">  {thinkingVerbRef.current}</Text>
            </Text>
          )}

          {/* Running tools (completed tools are already in the message feed) */}
          {activeTools.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {activeTools.map((tc, i) => (
                <Box key={`live-${tc.name}-${i}`} flexDirection="column">
                  <ToolIndicator
                    id={`live-${tc.name}-${i}`}
                    name={tc.name}
                    status={tc.status}
                    input={tc.input}
                    expanded={toolsExpanded}
                  />
                  {/* Show subagent activity below running task tools */}
                  {tc.name === "task" && tc.status === "running" && (subagentActivity.size > 0 || completedSubagents.length > 0) && (
                    <SubagentPanel running={subagentActivity} completed={completedSubagents} />
                  )}
                </Box>
              ))}
            </Box>
          )}

          {/* Streaming text */}
          {streamingText && (
            <Box marginLeft={2}>
              <StreamingText text={streamingText} />
            </Box>
          )}
        </>
      )}

      {/* Input */}
      {storeSelectMode ? (
        <StoreSelector
          stores={storeList}
          currentStoreId={loadConfig().store_id || ""}
          onSelect={handleStoreSelect}
          onCancel={handleStoreCancel}
        />
      ) : (
        <ChatInput
          onSubmit={handleSend}
          onCommand={handleCommand}
          disabled={isStreaming}
          agentName="whale code"
        />
      )}
    </Box>
  );
}
