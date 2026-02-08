/**
 * ChatApp — whale CLI, our Claude Code
 *
 * Auth: Supabase login (JWT) → LLM calls proxy through edge function.
 * Local tools execute on the client. Server tools via direct import.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop, canUseAgent, getServerToolCount, getServerStatus } from "../services/agent-loop.js";
import { getAllServerToolDefinitions } from "../services/server-tools.js";
import { LOCAL_TOOL_DEFINITIONS } from "../services/local-tools.js";
import { MessageList, type ChatMessage, type ToolCall } from "./MessageList.js";
import { ChatInput, SLASH_COMMANDS } from "./ChatInput.js";
import { colors, symbols, boxLine } from "../shared/Theme.js";
import { loadConfig } from "../services/config-store.js";

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
  const conversationRef = useRef<Anthropic.MessageParam[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // ── Init: check auth + probe server tools ──
  useEffect(() => {
    const check = canUseAgent();
    if (!check.ready) {
      setError(check.reason || "Run `whale login` to authenticate.");
    } else {
      const config = loadConfig();
      if (config.email) setUserLabel(config.store_name || config.email);
      setReady(true);

      // Probe server tools in background
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
    // Ctrl+E: toggle tool result expand/collapse
    if (input === "e" && key.ctrl) {
      setToolsExpanded((prev) => !prev);
    }
  });

  // ── Slash commands ──
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
          ? `  tools    7 local + ${serverToolsAvailable} server`
          : `  tools    7 local (server tools unavailable)`;
        setMessages((prev) => [...prev, {
          role: "assistant",
          text: [
            `  user     ${config.email || "—"}`,
            `  store    ${config.store_name || "—"}`,
            `  model    claude-sonnet-4`,
            toolsLine,
            `  expand   ${toolsExpanded ? "on" : "off"} (^E toggle)`,
          ].join("\n"),
        }]);
        break;
      }
      case "/mcp": {
        getServerStatus().then((status) => {
          const lines: string[] = [];
          if (status.connected) {
            lines.push(`  ${symbols.check} MCP Connected`);
            lines.push(`  auth     ${status.authMethod === "service_role" ? "service role key" : "user JWT"}`);
            lines.push(`  store    ${status.storeName || status.storeId || "—"}`);
            lines.push(`  tools    ${status.toolCount} server tools active`);
            lines.push("");
            lines.push("  Server tools:");
            const serverDefs = getAllServerToolDefinitions();
            for (const t of serverDefs) {
              lines.push(`    ☁ ${t.name.padEnd(20)} ${(t.description || "").slice(0, 50)}`);
            }
          } else {
            lines.push(`  ${symbols.cross} MCP Disconnected`);
            lines.push(`  auth     ${status.authMethod}`);
            lines.push("");
            lines.push("  Server tools require a Supabase connection.");
            lines.push("  Run: whale login");
          }
          setMessages((prev) => [...prev, { role: "assistant", text: lines.join("\n") }]);
        });
        break;
      }
      case "/tools": {
        const lines: string[] = [];
        lines.push("  LOCAL TOOLS (7)");
        for (const t of LOCAL_TOOL_DEFINITIONS) {
          lines.push(`    ${symbols.localTool} ${t.name.padEnd(20)} ${t.description.slice(0, 50)}`);
        }
        lines.push("");
        if (serverToolsAvailable > 0) {
          lines.push(`  SERVER TOOLS (${serverToolsAvailable})`);
          const serverDefs = getAllServerToolDefinitions();
          for (const t of serverDefs) {
            lines.push(`    ${symbols.serverTool} ${t.name.padEnd(20)} ${(t.description || "").slice(0, 50)}`);
          }
        } else {
          lines.push("  SERVER TOOLS (unavailable)");
          lines.push("    Run /mcp for connection details");
        }
        setMessages((prev) => [...prev, { role: "assistant", text: lines.join("\n") }]);
        break;
      }
    }
  }, [exit, toolsExpanded, serverToolsAvailable]);

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
        <Box>
          <Text color={colors.brand} bold>{symbols.sparkle} whale</Text>
        </Box>
        <Box height={1} />
        <Text color={colors.error}>{symbols.cross} {error}</Text>
      </Box>
    );
  }

  if (!ready) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={colors.dim}>loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color={colors.brand} bold>{symbols.sparkle} whale</Text>
        {userLabel && <Text color={colors.dim}>  {userLabel}</Text>}
        {serverToolsAvailable > 0 && (
          <Text color={colors.serverTool}>  {symbols.serverTool} {serverToolsAvailable} server tools</Text>
        )}
      </Box>
      <Text color={colors.border}>{boxLine(60)}</Text>

      <MessageList
        messages={messages}
        streamingText={streamingText}
        isStreaming={isStreaming}
        activeTools={activeTools}
        toolsExpanded={toolsExpanded}
      />

      <ChatInput
        onSubmit={handleSend}
        onCommand={handleCommand}
        disabled={isStreaming}
        agentName="whale"
      />
    </Box>
  );
}
