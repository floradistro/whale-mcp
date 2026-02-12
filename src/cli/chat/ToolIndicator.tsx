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
import os from "os";

// ============================================================================
// CONSTANTS
// ============================================================================

const AUTO_EXPAND_THRESHOLD = 12;
const PREVIEW_LINES = 6;

// ============================================================================
// PROPS
// ============================================================================

interface ToolIndicatorProps {
  id: string;
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

/** Shorten an absolute path for display: strip cwd, collapse home, truncate */
export function shortenPath(fullPath: string, maxLen = 40): string {
  let p = fullPath;
  const cwd = process.cwd();
  if (p.startsWith(cwd + "/")) p = p.slice(cwd.length + 1);
  else if (p.startsWith(cwd)) p = p.slice(cwd.length);
  else {
    const home = os.homedir();
    if (p.startsWith(home)) p = "~" + p.slice(home.length);
  }
  if (p.length <= maxLen) return p;
  const parts = p.split("/");
  const file = parts.pop()!;
  if (file.length >= maxLen - 4) return "…/" + file.slice(-(maxLen - 4));
  const parent = parts.pop();
  return parent ? "…/" + parent + "/" + file : "…/" + file;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** Compact one-line context */
function formatContext(name: string, input?: Record<string, unknown>): string {
  if (!input) return "";

  if (name === "read_file" || name === "write_file" || name === "edit_file" || name === "list_directory") {
    return input.path ? shortenPath(String(input.path)) : "";
  }
  if (name === "run_command") {
    const cmd = String(input.command || "");
    return cmd.length > 50 ? cmd.slice(0, 47) + "…" : cmd;
  }
  if (name === "search_files") {
    const parts = [input.pattern, input.path ? shortenPath(String(input.path)) : null].filter(Boolean);
    return parts.join(" in ");
  }
  if (name === "search_content") {
    const q = String(input.query || "");
    const p = input.path ? ` in ${shortenPath(String(input.path))}` : "";
    return q.length > 30 ? q.slice(0, 27) + "…" + p : q + p;
  }

  if (name === "grep") {
    const parts = [input.pattern, input.path ? shortenPath(String(input.path)) : null].filter(Boolean);
    return parts.join(" in ");
  }
  if (name === "glob") {
    const parts = [input.pattern, input.path ? shortenPath(String(input.path)) : null].filter(Boolean);
    return parts.join(" in ");
  }
  if (name === "multi_edit") {
    const edits = input.edits as any[];
    return input.file_path ? `${shortenPath(String(input.file_path))} (${edits?.length || 0} edits)` : "";
  }
  if (name === "task") {
    const type = input.subagent_type || "";
    const model = input.model || "sonnet";
    return `${type} (${model})`;
  }
  if (name === "lsp") {
    const op = input.operation || "";
    const fp = input.filePath ? shortenPath(String(input.filePath)) : "";
    const ln = input.line ? `:${input.line}` : "";
    return `${op} ${fp}${ln}`;
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

// ============================================================================
// TOOL CATEGORIES — unique icon + color per tool type
// ============================================================================

type ToolCategory = "read" | "write" | "edit" | "search" | "command" | "directory" | "web" | "agent" | "todo" | "notebook" | "server" | "lsp" | "interactive";

interface CategoryStyle {
  icon: string;
  color: string;
}

const CATEGORY_STYLES: Record<ToolCategory, CategoryStyle> = {
  read:      { icon: "◇", color: "#64D2FF" },   // cyan
  write:     { icon: "◆", color: "#30D158" },   // green
  edit:      { icon: "±", color: "#FF9F0A" },   // orange
  search:    { icon: "⊕", color: "#BF5AF2" },   // purple
  command:   { icon: "$", color: "#FF375F" },   // pink
  directory: { icon: "▤", color: "#5E5CE6" },   // indigo
  web:       { icon: "◎", color: "#0A84FF" },   // blue
  agent:     { icon: "⊛", color: "#BF5AF2" },   // purple
  todo:      { icon: "☐", color: "#30D158" },   // green
  notebook:  { icon: "◫", color: "#FF9F0A" },   // orange
  server:    { icon: "▹", color: "#FF375F" },   // pink
  lsp:         { icon: "⊞", color: "#64D2FF" },   // cyan
  interactive: { icon: "▹", color: "#5E5CE6" },   // indigo
};

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  multi_edit: "edit",
  search_files: "search",
  search_content: "search",
  glob: "search",
  grep: "search",
  run_command: "command",
  list_directory: "directory",
  web_fetch: "web",
  web_search: "web",
  task: "agent",
  team_create: "agent",
  tasks: "todo",
  config: "command",
  ask_user: "command",
  bash_output: "command",
  kill_shell: "command",
  list_shells: "command",
  notebook_edit: "notebook",
  task_output: "agent",
  task_stop: "agent",
  lsp: "lsp",
  enter_plan_mode: "interactive",
  exit_plan_mode: "interactive",
  ask_user_question: "interactive",
  skill: "command",
};

function getToolCategory(name: string): ToolCategory {
  return TOOL_CATEGORY_MAP[name] || (isLocalTool(name) ? "command" : "server");
}

// Human-readable tool display names (Claude Code parity)
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  multi_edit: "MultiEdit",
  search_files: "Search",
  search_content: "Search",
  glob: "Glob",
  grep: "Grep",
  run_command: "Bash",
  list_directory: "List",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  task: "Task",
  team_create: "Team",
  tasks: "Tasks",
  config: "Config",
  ask_user: "AskUser",
  bash_output: "TaskOutput",
  kill_shell: "TaskStop",
  list_shells: "Tasks",
  notebook_edit: "NotebookEdit",
  task_output: "TaskOutput",
  task_stop: "TaskStop",
  lsp: "LSP",
  enter_plan_mode: "PlanMode",
  exit_plan_mode: "PlanMode",
  ask_user_question: "AskUser",
  skill: "Skill",
};

export function getDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name;
}

/** Shorten absolute paths in search/grep results for readable display */
function formatSearchResult(result: string): string {
  return result.split("\n").map(line => {
    // Match "path:line:col:content" or "path:line:content" (grep/ripgrep output)
    const grepMatch = line.match(/^(\/[^:]+):(\d+(?::\d+)?):(.*)$/);
    if (grepMatch) {
      const [, filePath, lineCol, rest] = grepMatch;
      return `${shortenPath(filePath, 35)}:${lineCol}:${rest}`;
    }
    // Match plain absolute paths (glob results)
    if (line.startsWith("/")) {
      return shortenPath(line.trim(), 60);
    }
    return line;
  }).join("\n");
}

const PLAIN_TEXT_TOOLS = new Set(["enter_plan_mode", "exit_plan_mode", "ask_user_question", "skill"]);

function detectLang(toolName: string, input?: Record<string, unknown>): string {
  if (toolName === "edit_file" || toolName === "multi_edit") return "diff";
  if (toolName === "read_file" && input?.path) {
    const p = String(input.path);
    const base = p.split("/").pop() || "";
    // .env, .env.local, .env.production, etc. → bash (KEY=VALUE syntax)
    if (base.startsWith(".env")) return "bash";
    const ext = base.split(".").pop()?.toLowerCase() || "";
    return LANG_MAP[ext] || "";
  }
  if (toolName === "run_command" || toolName === "list_directory") return "bash";
  // Interactive/plain tools — render as plain text or markdown (not JSON fences)
  if (PLAIN_TEXT_TOOLS.has(toolName)) return "";
  if (!isLocalTool(toolName)) return "json";
  return "";
}

function wrapInFence(content: string, lang: string, subtitle?: string): string {
  if (content.includes("```")) return content;

  // Detect formatted markdown (tables, bold, headings) — render as markdown, not fenced
  const t = content.trim();
  if (t.startsWith("**") || t.startsWith("| ") || t.startsWith("# ")) return content;

  // For server tools, detect JSON
  if (!lang) {
    if ((t.startsWith("{") || t.startsWith("[")) && (t.endsWith("}") || t.endsWith("]"))) {
      lang = "json";
    }
  }
  // Only add :subtitle when lang is non-empty (prevents "```:path" which has no valid lang)
  const fence = (lang && subtitle) ? lang + ":" + subtitle : lang;
  return "```" + fence + "\n" + content + "\n```";
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ToolIndicator = React.memo(function ToolIndicator({ id: _id, name, status, result, input, durationMs, expanded = false }: ToolIndicatorProps) {
  const context = useMemo(() => formatContext(name, input), [name, input]);
  const lineCount = useMemo(() => result ? result.split("\n").length : 0, [result]);
  // Detect lang — writes with diffs get "diff" treatment
  const lang = useMemo(() => {
    const base = detectLang(name, input);
    if (base) return base;
    if (name === "write_file" && result?.includes("\n@@")) return "diff";
    return base;
  }, [name, input, result]);

  // Category-based styling
  const category = getToolCategory(name);
  const catStyle = CATEGORY_STYLES[category];

  // Extract file path for code block subtitle
  const filePath = useMemo(() => {
    if (!input) return undefined;
    const p = input.path || input.file_path;
    return p ? String(p) : undefined;
  }, [input]);

  // Category-specific summary metrics
  const summary = useMemo(() => {
    if (!result || status !== "success") return null;

    if (category === "read") {
      const lc = result.split("\n").length;
      return { type: "read" as const, label: `Read ${lc} line${lc !== 1 ? "s" : ""}` };
    }

    if (category === "write") {
      // Overwrite with diff — show +N -N badge
      const diffMatch = result.match(/Added (\d+) lines?, removed (\d+) lines?/i);
      if (diffMatch) {
        return { type: "edit" as const, added: parseInt(diffMatch[1]), removed: parseInt(diffMatch[2]) };
      }
      const lineMatch = result.match(/\((\d+) lines?, (\d+) chars\)/);
      if (lineMatch) {
        const lines = parseInt(lineMatch[1]);
        const label = `Wrote ${lines} line${lines !== 1 ? "s" : ""}`;
        return { type: "write" as const, label };
      }
      const charMatch = result.match(/\((\d+) chars\)/);
      if (charMatch) {
        const chars = parseInt(charMatch[1]);
        const label = chars >= 1000 ? `Wrote ${(chars / 1000).toFixed(1)}K chars` : `Wrote ${chars} chars`;
        return { type: "write" as const, label };
      }
      return { type: "write" as const, label: "Written" };
    }

    if (category === "edit") {
      let added = 0, removed = 0;
      for (const line of result.split("\n")) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
      if (added > 0 || removed > 0) return { type: "edit" as const, added, removed };
    }

    if (category === "search") {
      const lines = result.split("\n").filter(l => l.trim());
      const files = new Set(lines.map(l => l.split(":")[0]).filter(f => f.includes("/") || f.includes(".")));
      if (lines.length > 0) return { type: "search" as const, matches: lines.length, files: files.size };
    }

    if (category === "command") {
      const lines = result.split("\n").filter(l => l.trim());
      if (lines.length > 0) return { type: "command" as const, label: `${lines.length} line${lines.length !== 1 ? "s" : ""} output` };
    }

    if (category === "directory") {
      const items = result.split("\n").filter(l => l.trim());
      if (items.length > 0) return { type: "directory" as const, label: `${items.length} item${items.length !== 1 ? "s" : ""}` };
    }

    if (category === "web") {
      const chars = result.length;
      const label = chars >= 1000 ? `${(chars / 1000).toFixed(1)}K chars` : `${chars} chars`;
      return { type: "web" as const, label: `fetched ${label}` };
    }

    // Server tools with formatted markdown — extract bold title as summary
    if (category === "server" && result.trim().startsWith("**")) {
      const firstLine = result.trim().split("\n")[0];
      const match = firstLine.match(/^\*\*(.+?)\*\*/);
      if (match) return { type: "server" as const, label: match[1] };
    }

    return null;
  }, [result, status, category]);

  // Live output lines (last 6) for running commands
  const liveLines = useMemo(() => {
    if (status !== "running" || !result) return [];
    return result.split("\n").filter(l => l.trim()).slice(-6);
  }, [status, result]);

  // ── RUNNING ──
  if (status === "running") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={catStyle.color}><Spinner type="dots" /></Text>
          <Text color={catStyle.color}> {catStyle.icon}</Text>
          <Text color={catStyle.color} bold> {getDisplayName(name)}</Text>
          {context ? <Text color="#86868B">  {context}</Text> : null}
        </Box>
        {/* Live streaming output for running commands */}
        {liveLines.length > 0 && (
          <Box flexDirection="column" marginLeft={4}>
            {liveLines.map((line, i) => (
              <Text key={i} color="#6E6E73" wrap="truncate">{line}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  // ── ERROR ──
  if (status === "error") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="#FF453A" bold>✕</Text>
          <Text color={catStyle.color}> {catStyle.icon}</Text>
          <Text color={catStyle.color} bold> {getDisplayName(name)}</Text>
          {context ? <Text color="#86868B">  {context}</Text> : null}
          {durationMs !== undefined && <Text color="#86868B">  {formatDuration(durationMs)}</Text>}
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
  const hasResult = !!(result && result.trim());
  const isShort = lineCount <= AUTO_EXPAND_THRESHOLD;
  // Read/write results stay collapsed (just header line) — Claude Code parity.
  // Edit/search/command results auto-expand if short enough.
  // Writes with diffs auto-expand like edits.
  const hasDiff = lang === "diff";
  const collapseByDefault = category === "read" || (category === "write" && !hasDiff) || category === "directory";
  // Interactive tools (plan mode) always expand to show their content
  const alwaysExpand = category === "interactive";
  const showFull = hasResult && (expanded || alwaysExpand || (isShort && !collapseByDefault));

  return (
    <Box flexDirection="column">
      {/* Header: ✓ ◇ Read  src/foo.ts  120ms  Read 142 lines */}
      <Box>
        <Text color="#30D158">✓</Text>
        <Text color={catStyle.color}> {catStyle.icon}</Text>
        <Text color={catStyle.color} bold> {getDisplayName(name)}</Text>
        {context ? <Text color="#86868B">  {context}</Text> : null}
        {durationMs !== undefined && (
          durationMs > 3000
            ? <Text color="#FF9F0A">  {formatDuration(durationMs)}</Text>
            : <Text color="#86868B">  {formatDuration(durationMs)}</Text>
        )}
        {/* Inline summary badges — edits only (writes use tree line below) */}
        {summary?.type === "edit" && category === "edit" && (
          <>
            <Text color="#30D158">  +{summary.added}</Text>
            <Text color="#FF453A"> -{summary.removed}</Text>
          </>
        )}
        {summary?.type === "search" && (
          <Text color="#86868B">  {summary.matches} match{summary.matches !== 1 ? "es" : ""}{summary.files > 0 ? ` in ${summary.files} file${summary.files !== 1 ? "s" : ""}` : ""}</Text>
        )}
        {(summary?.type === "read" || summary?.type === "write" || summary?.type === "command" || summary?.type === "directory" || summary?.type === "web") && (
          <Text color="#86868B">  {(summary as any).label}</Text>
        )}
        {summary?.type === "server" && (
          <Text color="#64D2FF">  {(summary as any).label}</Text>
        )}
        {!summary && hasResult && !showFull && <Text color="#86868B">  {lineCount} lines</Text>}
      </Box>

      {/* Write diff summary tree line */}
      {category === "write" && hasDiff && summary?.type === "edit" && (
        <Box marginLeft={2}>
          <Text color="#6E6E73">└ Added </Text><Text color="#30D158">{summary.added}</Text>
          <Text color="#6E6E73"> lines, removed </Text><Text color="#FF453A">{summary.removed}</Text>
          <Text color="#6E6E73"> lines</Text>
        </Box>
      )}

      {/* Result — full, syntax highlighted */}
      {showFull && (
        <Box marginLeft={2} flexDirection="column">
          <MarkdownText text={wrapInFence(
            category === "search" ? formatSearchResult(result!) : result!,
            lang,
            filePath
          )} />
        </Box>
      )}

      {/* Preview for long results (edit/search/command only — reads stay fully collapsed) */}
      {hasResult && !showFull && !collapseByDefault && (
        <Box flexDirection="column" marginLeft={2}>
          <MarkdownText text={wrapInFence(
            (category === "search" ? formatSearchResult(result!) : result!).split("\n").slice(0, PREVIEW_LINES).join("\n"),
            lang,
            filePath
          )} />
          <Text color="#6E6E73">  └ +{lineCount - PREVIEW_LINES} lines  ^E</Text>
        </Box>
      )}
    </Box>
  );
}, (prev, next) => {
  // Custom comparator: skip deep-comparing input object reference
  return prev.id === next.id
    && prev.status === next.status
    && prev.expanded === next.expanded
    && prev.result === next.result
    && prev.durationMs === next.durationMs
    && prev.name === next.name;
});

