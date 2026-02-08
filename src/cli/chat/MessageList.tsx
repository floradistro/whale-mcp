/**
 * MessageList — polished conversation layout
 *
 * Generous spacing, subtle separators.
 * Tool calls render with full syntax highlighting.
 * Telemetry footer: tokens, cost estimate, tool count.
 */

import React from "react";
import { Box, Text } from "ink";
import { StreamingText } from "./StreamingText.js";
import { ToolIndicator } from "./ToolIndicator.js";
import { MarkdownText } from "./MarkdownText.js";
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
  usage?: { input_tokens: number; output_tokens: number };
}

interface MessageListProps {
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
  activeTools: ToolCall[];
  toolsExpanded: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Estimate cost: Sonnet 4 pricing — $3/MTok in, $15/MTok out */
function estimateCost(input: number, output: number): string {
  const cost = (input * 3 + output * 15) / 1_000_000;
  if (cost < 0.001) return "<$0.001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

/** Format token count: 1234 → 1.2k, 12345 → 12.3k */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Total duration across tool calls */
function totalToolDuration(toolCalls: ToolCall[]): number {
  return toolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function MessageList({ messages, streamingText, isStreaming, activeTools, toolsExpanded }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {msg.role === "user" ? (
            <Box>
              <Text color={colors.brand} bold>{symbols.user} </Text>
              <Text color={colors.user}>{msg.text}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {/* Tool calls */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <Box flexDirection="column" marginLeft={2} marginBottom={msg.text ? 1 : 0}>
                  {msg.toolCalls.map((tc, j) => (
                    <ToolIndicator
                      key={j}
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

              {/* Response text */}
              {msg.text && (
                <Box marginLeft={2}>
                  <MarkdownText text={msg.text} />
                </Box>
              )}

              {/* Telemetry footer */}
              {msg.usage && (
                <Box marginLeft={2} marginTop={0}>
                  <Text color="#48484A">
                    {formatTokens(msg.usage.input_tokens)}
                    <Text color="#5E5CE6">↑</Text>
                    {" "}{formatTokens(msg.usage.output_tokens)}
                    <Text color="#BF5AF2">↓</Text>
                  </Text>
                  <Text color="#38383A">  {estimateCost(msg.usage.input_tokens, msg.usage.output_tokens)}</Text>
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <Text color="#38383A">
                      {"  "}{msg.toolCalls.length} tool{msg.toolCalls.length !== 1 ? "s" : ""}
                      {"  "}{formatMs(totalToolDuration(msg.toolCalls))}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}
        </Box>
      ))}

      {/* Active streaming */}
      {(isStreaming || streamingText || activeTools.length > 0) && (
        <Box flexDirection="column" marginBottom={1}>
          {activeTools.length > 0 && (
            <Box flexDirection="column" marginLeft={2} marginBottom={streamingText ? 1 : 0}>
              {activeTools.map((tc, i) => (
                <ToolIndicator
                  key={i}
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
          {streamingText && (
            <Box marginLeft={2}>
              <StreamingText text={streamingText} isStreaming={isStreaming} />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
