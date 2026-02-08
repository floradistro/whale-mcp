/**
 * StreamingText — smooth cursor animation while streaming
 *
 * Thin blinking line cursor (like macOS text fields),
 * not the heavy block cursor.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { colors } from "../shared/Theme.js";
import { MarkdownText } from "./MarkdownText.js";

interface StreamingTextProps {
  text: string;
  isStreaming: boolean;
}

export function StreamingText({ text, isStreaming }: StreamingTextProps) {
  const [cursorPhase, setCursorPhase] = useState(0);

  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => setCursorPhase((p) => (p + 1) % 4), 200);
    return () => clearInterval(timer);
  }, [isStreaming]);

  // Smooth fade cursor: ▎ → ▏ → (space) → ▏ → ▎
  const cursorChars = ["▍", "▎", "▏", " "];
  const cursor = cursorChars[cursorPhase];

  return (
    <Box flexDirection="column">
      <MarkdownText text={text} streaming={isStreaming} />
      {isStreaming && (
        <Text color={colors.brand}>{cursor}</Text>
      )}
    </Box>
  );
}
