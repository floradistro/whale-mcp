/**
 * MarkdownText — renders markdown as ANSI-styled terminal output
 */

import React, { useMemo } from "react";
import { Text } from "ink";
import { renderMarkdown } from "../shared/markdown.js";

interface MarkdownTextProps {
  text: string;
  streaming?: boolean;
}

/**
 * During streaming, an odd number of ``` fences means a code block is unclosed.
 * Append a closing fence so marked renders it properly mid-stream.
 */
function closeIncompleteFences(text: string): string {
  const fenceCount = (text.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) {
    return text + "\n```";
  }
  return text;
}

export function MarkdownText({ text, streaming = false }: MarkdownTextProps) {
  const rendered = useMemo(() => {
    if (!text) return "";
    try {
      const safeText = streaming ? closeIncompleteFences(text) : text;
      return renderMarkdown(safeText);
    } catch {
      return text;
    }
  }, [text, streaming]);

  return <Text>{rendered}</Text>;
}
