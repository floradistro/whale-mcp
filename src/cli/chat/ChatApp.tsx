/**
 * ChatApp — whale code CLI
 *
 * Clean, Apple-polished chat interface.
 * Minimal header, generous spacing, subtle status.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { execSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop, canUseAgent, getServerToolCount, getServerStatus } from "../services/agent-loop.js";
import { getAllServerToolDefinitions, resetServerToolClient } from "../services/server-tools.js";
import { LOCAL_TOOL_DEFINITIONS } from "../services/local-tools.js";
import { MessageList, type ChatMessage, type ToolCall } from "./MessageList.js";
import { ChatInput, SLASH_COMMANDS } from "./ChatInput.js";
import { StoreSelector } from "./StoreSelector.js";
import { colors, symbols, boxLine } from "../shared/Theme.js";
import { loadConfig } from "../services/config-store.js";
import { getStoresForUser, getValidToken, selectStore, type StoreInfo } from "../services/auth-service.js";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PKG_NAME = "swagmanager-mcp";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_VERSION: string = createRequire(import.meta.url)(join(__dirname, "..", "..", "..", "package.json")).version;

export function ChatApp() {
  const { exit } = useApp();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolCall[]>([]);
  const [userLabel, setUserLabel] = useState("");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [serverToolsAvailable, setServerToolsAvailable] = useState(0);
  const [storeSelectMode, setStoreSelectMode] = useState(false);
  const [storeList, setStoreList] = useState<StoreInfo[]>([]);
  const conversationRef = useRef<Anthropic.MessageParam[]>([]);
  const abortRef = useRef<AbortController | null>(null);

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
  const handleCommand = useCallback((command: string) => {
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
        conversationRef.current = [];
        break;

      case "/exit":
        if (abortRef.current) abortRef.current.abort();
        exit();
        break;

      case "/status": {
        const config = loadConfig();
        const toolsLine = serverToolsAvailable > 0
          ? `  tools     7 local + ${serverToolsAvailable} server`
          : `  tools     7 local`;
        setMessages((prev) => [...prev, {
          role: "assistant",
          text: [
            `  version   v${PKG_VERSION}`,
            `  user      ${config.email || "—"}`,
            `  store     ${config.store_name || "—"}`,
            `  model     claude-sonnet-4`,
            toolsLine,
            `  expand    ${toolsExpanded ? "on" : "off"}  (^E)`,
          ].join("\n"),
        }]);
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

      case "/tools": {
        const lines: string[] = [];
        lines.push("  Local (7)");
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
    // Re-check server tools with new store
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
    setStreamingText(""); setActiveTools([]); setIsStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;
    let accumulatedText = "";
    const toolCalls: ToolCall[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;

    await runAgentLoop({
      message: userMessage,
      conversationHistory: conversationRef.current,
      abortSignal: abort.signal,
      callbacks: {
        onText: (text) => {
          accumulatedText += text;
          setStreamingText(accumulatedText);
        },
        onToolStart: (name) => {
          toolCalls.push({ name, status: "running" });
          setActiveTools([...toolCalls]);
        },
        onToolResult: (name, success, result, input, durationMs) => {
          const tc = toolCalls.find((t) => t.name === name && t.status === "running");
          if (tc) {
            tc.status = success ? "success" : "error";
            tc.result = typeof result === "string" ? result : JSON.stringify(result);
            tc.input = input;
            tc.durationMs = durationMs;
            setActiveTools([...toolCalls]);
          }
          accumulatedText = "";
          setStreamingText("");
        },
        onUsage: (input_tokens, output_tokens) => {
          usage = { input_tokens, output_tokens };
        },
        onDone: (finalMessages) => {
          setMessages((prev) => [...prev, {
            role: "assistant" as const,
            text: accumulatedText,
            toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
            usage,
          }]);
          setStreamingText("");
          setActiveTools([]);
          setIsStreaming(false);
          abortRef.current = null;
          conversationRef.current = finalMessages;
        },
        onError: (err) => {
          if (err !== "Cancelled") {
            setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${err}` }]);
          }
          setStreamingText("");
          setActiveTools([]);
          setIsStreaming(false);
          abortRef.current = null;
        },
      },
    });
  }, [isStreaming]);

  // ── Render ──
  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={colors.brand} bold>◆ whale code</Text>
        <Box height={1} />
        <Text color={colors.error}>{error}</Text>
      </Box>
    );
  }

  if (!ready) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={colors.tertiary}>loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header — minimal, Apple-clean */}
      <Box>
        <Text color={colors.brand} bold>◆ whale code</Text>
        {userLabel && <Text color={colors.dim}>  {userLabel}</Text>}
        {serverToolsAvailable > 0 && (
          <Text color={colors.tertiary}>  {symbols.dot} {serverToolsAvailable} server tools</Text>
        )}
      </Box>
      <Text color={colors.separator}>{boxLine(56)}</Text>

      <MessageList
        messages={messages}
        streamingText={streamingText}
        isStreaming={isStreaming}
        activeTools={activeTools}
        toolsExpanded={toolsExpanded}
      />

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
