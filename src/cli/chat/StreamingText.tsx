/**
 * StreamingText — renders streaming markdown text
 *
 * Wrapped in React.memo to prevent re-renders when parent state
 * (subagent updates, tool updates) changes but text hasn't.
 */

import React from "react";
import { MarkdownText } from "./MarkdownText.js";

interface StreamingTextProps {
  text: string;
}

export const StreamingText = React.memo(function StreamingText({ text }: StreamingTextProps) {
  return <MarkdownText text={text} />;
});
