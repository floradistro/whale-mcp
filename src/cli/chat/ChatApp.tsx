/**
 * ChatApp — whale code CLI
 *
 * Simple: render all messages, streaming section, input.
 * No height budgets, no Static, no fixed heights.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  runAgentLoop, canUseAgent, getServerToolCount, getServerStatus,
  setModel, getModel, getModelShortName,
  loadClaudeMd, compressContext, getSessionTokens,
  saveSession, loadSession, listSessions, type SessionMeta,
} from "../services/agent-loop.js";
import { getAllServerToolDefinitions, resetServerToolClient } from "../services/server-tools.js";
import { LOCAL_TOOL_DEFINITIONS, loadTodos, setTodoSessionId } from "../services/local-tools.js";
import { AgentEventEmitter, type AgentEvent } from "../services/agent-events.js";
import { CompletedMessage, type ChatMessage, type ToolCall } from "./MessageList.js";
import { ToolIndicator } from "./ToolIndicator.js";
import { SubagentPanel, type SubagentActivityState, type CompletedSubagentInfo } from "./SubagentPanel.js";
import { TeamPanel } from "./TeamPanel.js";
import { StreamingText } from "./StreamingText.js";
import { ChatInput, SLASH_COMMANDS } from "./ChatInput.js";
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

  useEffect(() => {
    return () => { if (textTimerRef.current) clearTimeout(textTimerRef.current); };
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
    switch (command) {
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
        const current = getModelShortName();
        const nextIdx = (models.indexOf(current) + 1) % models.length;
        const next = models[nextIdx];
        const result = setModel(next);
        setCurrentModel(next);
        setMessages((prev) => [...prev, {
          role: "assistant",
          text: `  ${symbols.check} Model: ${next}  (${result.model})`,
        }]);
        break;
      }

      case "/compact": {
        const before = conversationRef.current.length;
        if (before < 6) {
          setMessages((prev) => [...prev, { role: "assistant", text: "  Conversation too short to compress." }]);
        } else {
          conversationRef.current = compressContext(conversationRef.current);
          const after = conversationRef.current.length;
          setMessages((prev) => [...prev, {
            role: "assistant",
            text: `  ${symbols.check} Compressed: ${before} messages → ${after} messages`,
          }]);
        }
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
  const handleSend = useCallback(async (userMessage: string) => {
    if (isStreaming) return;
    setMessages((prev) => [...prev, { role: "user", text: userMessage }]);
    setStreamingText("");
    setActiveTools([]);
    setSubagentActivity(new Map());
    setCompletedSubagents([]);
    setTeamState(null);
    setIsStreaming(true);

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
            // Keep last 4 lines — less data = smaller re-render delta
            const lines = (prev + "\n" + event.line).split("\n");
            toolCalls[idx].result = lines.slice(-4).join("\n").trim();
            setActiveTools([...toolCalls]);
          }
          break;
        }

        case "team_start":
          teamName = event.name;
          teamTotal = event.taskCount;
          teamCompleted = 0;
          teammateStatus.clear();
          setTeamState({ name: teamName, tasksCompleted: 0, tasksTotal: teamTotal, teammates: new Map(teammateStatus) });
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
          setTeamState({ name: teamName, tasksCompleted: teamCompleted, tasksTotal: teamTotal, teammates: new Map(teammateStatus) });
          break;

        case "team_progress":
          teammateStatus.set(event.teammateId, { name: event.teammateName || event.teammateId, status: event.message.slice(0, 50) });
          setTeamState({ name: teamName, tasksCompleted: teamCompleted, tasksTotal: teamTotal, teammates: new Map(teammateStatus) });
          break;

        case "team_done":
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
          // Commit completed tool to the permanent message feed
          setMessages(prev => [...prev, {
            role: "assistant" as const,
            text: "",
            toolCalls: [completedTool],
          }]);
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
      {/* Header */}
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

      {/* All messages */}
      {messages.map((msg, i) => (
        <CompletedMessage key={i} msg={msg} index={i} toolsExpanded={toolsExpanded} />
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
              <Text color="#6E6E73">  {randomVerb()}</Text>
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
