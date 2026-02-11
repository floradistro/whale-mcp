/**
 * MarkdownText — renders markdown as ANSI-styled terminal output
 */

import React, { useMemo } from "react";
import { Text } from "ink";
import { renderMarkdown } from "../shared/markdown.js";

interface MarkdownTextProps {
  text: string;
}

export function MarkdownText({ text }: MarkdownTextProps) {
  const rendered = useMemo(() => {
    if (!text) return "";
    try {
      return renderMarkdown(text, true);
    } catch {
      return text;
    }
  }, [text]);

  return <Text>{rendered}</Text>;
}
