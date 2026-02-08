/**
 * ToolIndicator — polished tool call rendering
 *
 * Every result gets syntax highlighting via MarkdownText.
 * Financial-aware: green for gains, red for deductions/negatives.
 * Params: purple keys, typed values (blue dates, green money, red negatives).
 * Duration badge, tool type glyph.
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

const AUTO_EXPAND_THRESHOLD = 12;
const PREVIEW_LINES = 6;

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

/** Compact one-line context */
function formatContext(name: string, input?: Record<string, unknown>): string {
  if (!input) return "";

  if (name === "read_file" || name === "write_file" || name === "edit_file" || name === "list_directory") {
    return input.path ? String(input.path) : "";
  }
  if (name === "run_command") {
    const cmd = String(input.command || "");
    return cmd.length > 50 ? cmd.slice(0, 47) + "…" : cmd;
  }
  if (name === "search_files") {
    return [input.pattern, input.path].filter(Boolean).join(" in ");
  }
  if (name === "search_content") {
    const q = String(input.query || "");
    const p = input.path ? ` in ${input.path}` : "";
    return q.length > 30 ? q.slice(0, 27) + "…" + p : q + p;
  }

  // Server tools → action + key param
  if (input.action) {
    const parts: string[] = [String(input.action)];
    if (input.query) parts.push(String(input.query).slice(0, 25));
    else if (input.name) parts.push(String(input.name));
    else if (input.period) parts.push(String(input.period));
    else if (input.product_id) parts.push(String(input.product_id).slice(0, 12));
    else if (input.location_id) parts.push(String(input.location_id).slice(0, 12));
    else if (input.customer_id) parts.push(String(input.customer_id).slice(0, 12));
    else if (input.order_id) parts.push(String(input.order_id).slice(0, 12));
    return parts.join(" ");
  }
  return "";
}

const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", rb: "ruby",
  swift: "swift", kt: "kotlin", java: "java", c: "c", cpp: "cpp",
  css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", md: "markdown", sh: "bash", zsh: "bash",
  sql: "sql", xml: "xml",
};

function detectLang(toolName: string, input?: Record<string, unknown>): string {
  if (toolName === "read_file" && input?.path) {
    const ext = String(input.path).split(".").pop()?.toLowerCase() || "";
    return LANG_MAP[ext] || "";
  }
  if (toolName === "run_command" || toolName === "list_directory") return "bash";
  if (!isLocalTool(toolName)) return "json";
  return "";
}

function wrapInFence(content: string, lang: string): string {
  if (content.includes("```")) return content;

  // For server tools, detect JSON
  if (!lang) {
    const t = content.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && (t.endsWith("}") || t.endsWith("]"))) {
      lang = "json";
    }
  }
  return "```" + lang + "\n" + content + "\n```";
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ToolIndicator({ name, status, result, input, durationMs, expanded = false }: ToolIndicatorProps) {
  const local = isLocalTool(name);
  const context = useMemo(() => formatContext(name, input), [name, input]);
  const lineCount = useMemo(() => result ? result.split("\n").length : 0, [result]);
  const lang = useMemo(() => detectLang(name, input), [name, input]);

  // Purple for local tools, pink for server tools
  const toolColor = local ? "#BF5AF2" : "#FF375F";
  const typeGlyph = local ? symbols.local : symbols.server;

  // ── RUNNING ──
  if (status === "running") {
    return (
      <Box marginBottom={0}>
        <Text color="#0A84FF"><Spinner type="dots" /></Text>
        <Text color={toolColor} bold> {name}</Text>
        {context ? <Text color="#86868B">  {context}</Text> : null}
      </Box>
    );
  }

  // ── ERROR ──
  if (status === "error") {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Box>
          <Text color="#FF453A" bold>✕</Text>
          <Text color={toolColor} bold> {name}</Text>
          {context ? <Text color="#86868B">  {context}</Text> : null}
          {durationMs !== undefined && <Text color="#48484A">  {formatDuration(durationMs)}</Text>}
        </Box>
        {result && (
          <Box marginLeft={2}>
            <MarkdownText text={"```\n" + result.split("\n").slice(0, 3).join("\n") + "\n```"} />
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
      {/* Header: ✓ ▸ tool_name  context  420ms */}
      <Box>
        <Text color="#30D158">✓</Text>
        <Text color="#6E6E73"> {typeGlyph}</Text>
        <Text color={toolColor} bold> {name}</Text>
        {context ? <Text color="#86868B">  {context}</Text> : null}
        {durationMs !== undefined && (
          <Text color={durationMs > 3000 ? "#FF9F0A" : "#48484A"}>  {formatDuration(durationMs)}</Text>
        )}
        {!isShort && !expanded && <Text color="#6E6E73">  {lineCount} lines</Text>}
      </Box>

      {/* Input params — purple keys, typed values */}
      {input && !local && Object.keys(input).length > 1 && (
        <Box flexDirection="column" marginLeft={2}>
          {Object.entries(input)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v], i) => (
              <Box key={i}>
                <Text color="#48484A">  │ </Text>
                <Text color="#BF5AF2">{k}</Text>
                <Text color="#6E6E73">: </Text>
                <ParamValue value={v} />
              </Box>
            ))}
        </Box>
      )}

      {/* Result — full, syntax highlighted */}
      {result && showFull && (
        <Box marginLeft={2} flexDirection="column">
          <MarkdownText text={wrapInFence(result, lang)} />
        </Box>
      )}

      {/* Collapsed preview — also syntax highlighted */}
      {result && !showFull && (
        <Box flexDirection="column" marginLeft={2}>
          <MarkdownText text={wrapInFence(result.split("\n").slice(0, PREVIEW_LINES).join("\n"), lang)} />
          <Box>
            <Text color="#48484A">  └ </Text>
            <Text color="#6E6E73">+{lineCount - PREVIEW_LINES} lines</Text>
            <Text color="#48484A">  ^E</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ============================================================================
// PARAM VALUE — financial-aware coloring
// ============================================================================

function ParamValue({ value }: { value: unknown }) {
  if (typeof value === "number") {
    // Negative → red, positive → mint
    if (value < 0) return <Text color="#FF453A">{String(value)}</Text>;
    return <Text color="#66D4CF">{String(value)}</Text>;
  }

  if (typeof value === "boolean") {
    return <Text color={value ? "#30D158" : "#FF453A"}>{String(value)}</Text>;
  }

  if (typeof value === "string") {
    // Negative money → red
    if (/^-\$?[\d,]+\.?\d*$/.test(value)) {
      return <Text color="#FF453A">{value}</Text>;
    }
    // Positive money → green
    if (/^\+?\$[\d,]+\.?\d*$/.test(value)) {
      return <Text color="#30D158">{value}</Text>;
    }
    // Negative percentage → red
    if (/^-\d+\.?\d*%$/.test(value)) {
      return <Text color="#FF453A">{value}</Text>;
    }
    // Positive percentage → cyan
    if (/^\d+\.?\d*%$/.test(value)) {
      return <Text color="#64D2FF">{value}</Text>;
    }
    // Plain numbers → mint
    if (/^-?\d+\.?\d*$/.test(value)) {
      const n = parseFloat(value);
      if (n < 0) return <Text color="#FF453A">{value}</Text>;
      return <Text color="#66D4CF">{value}</Text>;
    }
    // UUIDs → dim, truncated
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(value)) {
      return <Text color="#6E6E73">{value.length > 20 ? value.slice(0, 18) + "…" : value}</Text>;
    }
    // Dates → blue
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return <Text color="#0A84FF">{value}</Text>;
    }
    // Enum actions → indigo
    if (/^[a-z_]+$/.test(value) && value.length < 25) {
      return <Text color="#5E5CE6">{value}</Text>;
    }
    // Status words
    if (/^(active|complete|approved|success|received)/i.test(value)) {
      return <Text color="#30D158">{value}</Text>;
    }
    if (/^(cancelled|failed|error|rejected|expired|overdue)/i.test(value)) {
      return <Text color="#FF453A">{value}</Text>;
    }
    if (/^(pending|draft|processing)/i.test(value)) {
      return <Text color="#FF9F0A">{value}</Text>;
    }

    const display = value.length > 55 ? value.slice(0, 52) + "…" : value;
    return <Text color="#F5F5F7">{display}</Text>;
  }

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      const j = JSON.stringify(value);
      const display = j.length > 55 ? j.slice(0, 52) + "…" : j;
      return <Text color="#6E6E73">{display}</Text>;
    }
    const j = JSON.stringify(value);
    const display = j.length > 55 ? j.slice(0, 52) + "…" : j;
    return <Text color="#6E6E73">{display}</Text>;
  }

  return <Text color="#F5F5F7">{String(value)}</Text>;
}
