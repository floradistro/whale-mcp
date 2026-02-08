/**
 * ToolIndicator — Apple-polished tool call rendering
 *
 * Clean and minimal like Claude Code:
 *   › read_file src/index.ts                              23ms
 *     │ import { createClient } from "@supabase/...
 *     │ ...
 *     │ +140 lines · ^E
 *
 * Design principles:
 * - Whitespace over box-drawing
 * - Single glyph prefixes, no heavy panels
 * - Duration always visible
 * - Input params shown inline or on one line
 * - Result preview with subtle vertical bar
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { MarkdownText } from "./MarkdownText.js";
import { colors, symbols } from "../shared/Theme.js";
import { isLocalTool } from "../services/local-tools.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const AUTO_EXPAND_THRESHOLD = 10;
const PREVIEW_LINES = 4;

// ============================================================================
// PROPS
// ============================================================================

interface ToolIndicatorProps {
  name: string;
  status: "running" | "success" | "error";
  result?: string;
  input?: Record<string, unknown>;
  durationMs?: number;
  expanded?: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Compact one-line summary of what this tool is doing */
function formatContext(name: string, input?: Record<string, unknown>): string {
  if (!input) return "";

  // File tools → path
  if (name === "read_file" || name === "write_file" || name === "edit_file") {
    return input.path ? String(input.path) : "";
  }
  if (name === "list_directory") {
    return input.path ? String(input.path) : "";
  }

  // Shell → command
  if (name === "run_command") {
    const cmd = String(input.command || "");
    return cmd.length > 45 ? cmd.slice(0, 42) + "..." : cmd;
  }

  // Search → query in path
  if (name === "search_files") {
    return [input.pattern, input.path].filter(Boolean).join(" in ");
  }
  if (name === "search_content") {
    const q = String(input.query || "");
    const p = input.path ? ` in ${input.path}` : "";
    return q.length > 30 ? q.slice(0, 27) + "..." + p : q + p;
  }

  // Server tools → action + most relevant param
  if (input.action) {
    const parts: string[] = [String(input.action)];
    if (input.query) parts.push(String(input.query).slice(0, 25));
    else if (input.name) parts.push(String(input.name));
    else if (input.period) parts.push(String(input.period));
    else if (input.product_id) parts.push(String(input.product_id).slice(0, 12));
    else if (input.location_id) parts.push(String(input.location_id).slice(0, 12));
    return parts.join(" ");
  }

  return "";
}

/** Format input as compact key:value lines */
function formatParams(input: Record<string, unknown>): string[] {
  return Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (typeof v === "string") {
        return `${k}: ${v.length > 55 ? v.slice(0, 52) + "..." : v}`;
      }
      if (typeof v === "object") {
        const j = JSON.stringify(v);
        return `${k}: ${j.length > 55 ? j.slice(0, 52) + "..." : j}`;
      }
      return `${k}: ${String(v)}`;
    });
}

function wrapInCodeFence(result: string, toolName: string, input?: Record<string, unknown>): string {
  if (result.includes("```")) return result;

  // Detect language from file extension
  if (toolName === "read_file" && input?.path) {
    const ext = String(input.path).split(".").pop()?.toLowerCase() || "";
    const langMap: Record<string, string> = {
      ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
      py: "python", rs: "rust", go: "go", rb: "ruby",
      swift: "swift", kt: "kotlin", java: "java", c: "c", cpp: "cpp",
      css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
      toml: "toml", md: "markdown", sh: "bash", zsh: "bash",
      sql: "sql", xml: "xml",
    };
    return "```" + (langMap[ext] || "") + "\n" + result + "\n```";
  }

  // Server tool results → try JSON
  if (!isLocalTool(toolName)) {
    const t = result.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && (t.endsWith("}") || t.endsWith("]"))) {
      return "```json\n" + result + "\n```";
    }
  }

  return "```\n" + result + "\n```";
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ToolIndicator({ name, status, result, input, durationMs, expanded = false }: ToolIndicatorProps) {
  const local = isLocalTool(name);
  const context = useMemo(() => formatContext(name, input), [name, input]);
  const lineCount = useMemo(() => result ? result.split("\n").length : 0, [result]);

  const toolColor = local ? colors.localTool : colors.serverTool;
  const typeLabel = local ? "local" : "server";

  // ── RUNNING ──
  if (status === "running") {
    return (
      <Box marginBottom={0}>
        <Text color={colors.brand}><Spinner type="dots" /></Text>
        <Text color={toolColor} bold> {name}</Text>
        {context ? <Text color={colors.dim}>  {context}</Text> : null}
      </Box>
    );
  }

  // ── ERROR ──
  if (status === "error") {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Box>
          <Text color={colors.error} bold>✕</Text>
          <Text color={toolColor} bold> {name}</Text>
          {context ? <Text color={colors.dim}>  {context}</Text> : null}
          {durationMs !== undefined && <Text color={colors.tertiary}>  {formatDuration(durationMs)}</Text>}
        </Box>
        {result && (
          <Box marginLeft={2}>
            <Text color={colors.error}>  {result.split("\n")[0].slice(0, 70)}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // ── SUCCESS ──
  const isShort = lineCount <= AUTO_EXPAND_THRESHOLD;
  const showFull = expanded || isShort;

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* Header */}
      <Box>
        <Text color={colors.success}>✓</Text>
        <Text color={toolColor} bold> {name}</Text>
        {context ? <Text color={colors.dim}>  {context}</Text> : null}
        {durationMs !== undefined && <Text color={colors.tertiary}>  {formatDuration(durationMs)}</Text>}
        {!isShort && !expanded && <Text color={colors.quaternary}>  {lineCount} lines</Text>}
      </Box>

      {/* Input params — compact, only for server tools or when interesting */}
      {input && !local && Object.keys(input).length > 1 && (
        <Box flexDirection="column" marginLeft={2}>
          {formatParams(input).map((line, i) => (
            <Box key={i}>
              <Text color={colors.quaternary}>  {symbols.verticalBar} </Text>
              <Text color={colors.tertiary}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Result body */}
      {result && showFull && (
        <Box marginLeft={2} flexDirection="column">
          <MarkdownText text={wrapInCodeFence(result, name, input)} />
        </Box>
      )}

      {/* Collapsed preview */}
      {result && !showFull && (
        <Box flexDirection="column" marginLeft={2}>
          {result.split("\n").slice(0, PREVIEW_LINES).map((line, i) => (
            <Box key={i}>
              <Text color={colors.quaternary}>  {symbols.verticalBar} </Text>
              <Text color={colors.dim}>{line.slice(0, 72)}</Text>
            </Box>
          ))}
          <Box>
            <Text color={colors.quaternary}>  {symbols.corner} </Text>
            <Text color={colors.tertiary}>+{lineCount - PREVIEW_LINES} lines</Text>
            <Text color={colors.quaternary}>  ^E</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
