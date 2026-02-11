/**
 * MessageList — types and CompletedMessage component
 *
 * CompletedMessage is React.memo'd to prevent re-renders during streaming.
 * Telemetry footer: tokens, cost estimate, tool count.
 * Minimal Box usage — Text-first for reliable rendering.
 */

import React from "react";
import { Box, Text } from "ink";
import { ToolIndicator } from "./ToolIndicator.js";
import { MarkdownText } from "./MarkdownText.js";
import { CompletedSubagentTree, type CompletedSubagentInfo } from "./SubagentPanel.js";
import { colors, symbols } from "../shared/Theme.js";

// ============================================================================
// TYPES
// ============================================================================

export interface ToolCall {
  name: string;
  status: "running" | "success" | "error";
  result?: string;
  input?: Record<string, unknown>;
  durationMs?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ToolCall[];
  completedSubagents?: CompletedSubagentInfo[];
  usage?: { input_tokens: number; output_tokens: number };
}

// ============================================================================
// HELPERS
// ============================================================================

function estimateCost(input: number, output: number): string {
  const cost = (input * 3 + output * 15) / 1_000_000;
  if (cost < 0.001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function totalToolDuration(toolCalls: ToolCall[]): number {
  return toolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

// ============================================================================
// COMPLETED MESSAGE — memoized, never re-renders during streaming
// ============================================================================

export const CompletedMessage = React.memo(function CompletedMessage({ msg, index, toolsExpanded }: {
  msg: ChatMessage;
  index: number;
  toolsExpanded: boolean;
}) {
  const contentWidth = Math.max(20, (process.stdout.columns || 80) - 2);

  return (
    <Box flexDirection="column">
      {/* Turn separator before user messages (except first) */}
      {msg.role === "user" && index > 0 && (
        <>
          <Text>{" "}</Text>
          <Text color={colors.separator}>{"─".repeat(contentWidth)}</Text>
        </>
      )}
      {msg.role === "user" ? (
        <Text>
          <Text color={colors.brand} bold>{symbols.user} </Text>
          <Text color={colors.user}>{msg.text}</Text>
        </Text>
      ) : (
        <Box flexDirection="column">
          {/* Tool calls */}
          {msg.toolCalls && msg.toolCalls.length > 0 && (
            <Box flexDirection="column" marginLeft={2}>
              {msg.toolCalls.map((tc, j) => (
                <ToolIndicator
                  key={j}
                  id={`done-${index}-${j}`}
                  name={tc.name}
                  status={tc.status}
                  result={tc.result}
                  input={tc.input}
                  durationMs={tc.durationMs}
                  expanded={toolsExpanded}
                />
              ))}
            </Box>
          )}

          {/* Completed subagent summary tree */}
          {msg.completedSubagents && msg.completedSubagents.length > 0 && (
            <CompletedSubagentTree agents={msg.completedSubagents} />
          )}

          {/* Response text */}
          {msg.text && (
            <Box marginLeft={2}>
              <MarkdownText text={msg.text} />
            </Box>
          )}

          {/* Telemetry footer */}
          {msg.usage && (
            <Text>
              {"  "}
              <Text dimColor>
                {formatTokens(msg.usage.input_tokens)}
                <Text color="#5E5CE6">↑</Text>
                {" "}{formatTokens(msg.usage.output_tokens)}
                <Text color="#BF5AF2">↓</Text>
              </Text>
              <Text dimColor>  {estimateCost(msg.usage.input_tokens, msg.usage.output_tokens)}</Text>
              {msg.toolCalls && msg.toolCalls.length > 0 ? (
                <Text dimColor>
                  {"  "}{msg.toolCalls.length} tool{msg.toolCalls.length !== 1 ? "s" : ""}
                  {"  "}{formatMs(totalToolDuration(msg.toolCalls))}
                </Text>
              ) : null}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
});
