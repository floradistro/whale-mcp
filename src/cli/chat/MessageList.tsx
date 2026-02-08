/**
 * MessageList — clean conversation layout
 *
 * Apple-inspired spacing: generous whitespace, subtle separators.
 * User messages are clean, assistant responses indented.
 * Tool calls render inline with elegant minimal chrome.
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

              {/* Token usage — very subtle */}
              {msg.usage && (
                <Box marginLeft={2} marginTop={0}>
                  <Text color={colors.quaternary}>
                    {msg.usage.input_tokens.toLocaleString()}↑ {msg.usage.output_tokens.toLocaleString()}↓
                  </Text>
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
