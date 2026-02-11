/**
 * SubagentPanel — Claude Code-style tree rendering for subagents
 *
 * Running agents show spinner + nested tool tree.
 * Completed agents show green dot + stats summary.
 * Uses ├──, └──, │ tree characters matching Claude Code's style.
 * Text-first rendering — minimal Box usage for reliable terminal output.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { shortenPath, getDisplayName } from "./ToolIndicator.js";

// ============================================================================
// TYPES
// ============================================================================

export interface SubagentInnerTool {
  name: string;
  status: "running" | "success" | "error";
  input?: Record<string, unknown>;
  durationMs?: number;
}

export interface SubagentActivityState {
  type: string;
  model: string;
  description: string;
  turn: number;
  message: string;
  tools: SubagentInnerTool[];
  startTime: number;
}

export interface CompletedSubagentInfo {
  id: string;
  type: string;
  description: string;
  toolCount: number;
  tokens: { input: number; output: number };
  durationMs: number;
  success: boolean;
}

interface SubagentPanelProps {
  running: Map<string, SubagentActivityState>;
  completed: CompletedSubagentInfo[];
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function toolContext(name: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  if (name === "read_file" || name === "write_file" || name === "edit_file" || name === "list_directory") {
    return input.path ? shortenPath(String(input.path)) : "";
  }
  if (name === "glob") return input.pattern ? String(input.pattern) : "";
  if (name === "grep") {
    const parts = [input.pattern, input.path ? shortenPath(String(input.path)) : null].filter(Boolean);
    return parts.join(" in ");
  }
  if (name === "search_files" || name === "search_content") {
    return [input.pattern || input.query, input.path ? shortenPath(String(input.path)) : null].filter(Boolean).join(" in ");
  }
  if (name === "run_command") {
    const cmd = String(input.command || "");
    return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
  }
  if (name === "web_fetch") return input.url ? String(input.url).slice(0, 40) : "";
  return "";
}

const AGENT_TYPE_LABELS: Record<string, string> = {
  explore: "Explore",
  plan: "Plan",
  "general-purpose": "Agent",
  research: "Research",
};

const MAX_VISIBLE_TOOLS = 6;

// ============================================================================
// RUNNING AGENT TREE
// ============================================================================

function RunningAgentTree({ agent, isLast, isOnly }: {
  agent: SubagentActivityState;
  isLast: boolean;
  isOnly: boolean;
}) {
  const label = AGENT_TYPE_LABELS[agent.type] || agent.type;
  const desc = agent.description || "";

  const running = agent.tools.filter(t => t.status === "running");
  const completed = agent.tools.filter(t => t.status !== "running");
  const maxCompleted = MAX_VISIBLE_TOOLS - running.length;
  const hiddenCount = Math.max(0, completed.length - maxCompleted);
  const visibleCompleted = completed.slice(hiddenCount);
  const visibleTools = [...visibleCompleted, ...running];

  const isThinking = agent.tools.length === 0 || (agent.tools.every(t => t.status !== "running") && agent.message.includes("calling API"));

  const childPrefix = isOnly ? "    " : (isLast ? "    " : "│   ");

  return (
    <Box flexDirection="column">
      {/* Agent header */}
      <Text>
        {!isOnly ? <Text dimColor>{isLast ? "└── " : "├── "}</Text> : null}
        <Text color="#0A84FF"><Spinner type="dots" /></Text>
        <Text color="#E5E5EA" bold> {label}</Text>
        {desc ? <Text dimColor> {desc}</Text> : null}
        {agent.turn > 0 ? <Text dimColor> · Turn {agent.turn}</Text> : null}
      </Text>

      {hiddenCount > 0 && (
        <Text dimColor>{childPrefix}│   ... +{hiddenCount} earlier</Text>
      )}

      {visibleTools.map((tool, i) => {
        const isLastTool = i === visibleTools.length - 1 && !isThinking;
        const toolBranch = isLastTool ? "└── " : "├── ";
        const ctx = toolContext(tool.name, tool.input);

        return (
          <Text key={`${tool.name}-${i}`}>
            <Text dimColor>{childPrefix}{toolBranch}</Text>
            {tool.status === "running" ? (
              <Text color="#0A84FF"><Spinner type="dots" /></Text>
            ) : tool.status === "success" ? (
              <Text color="#30D158">✓</Text>
            ) : (
              <Text color="#FF453A">✕</Text>
            )}
            <Text bold> {getDisplayName(tool.name)}</Text>
            {ctx ? <Text dimColor>  {ctx}</Text> : null}
          </Text>
        );
      })}

      {isThinking && (
        <Text>
          <Text dimColor>{childPrefix}└── </Text>
          <Text color="#0A84FF"><Spinner type="dots" /></Text>
          <Text dimColor> thinking...</Text>
        </Text>
      )}
    </Box>
  );
}

// ============================================================================
// COMPLETED SUMMARY TREE
// ============================================================================

export function CompletedSubagentTree({ agents }: { agents: CompletedSubagentInfo[] }) {
  if (agents.length === 0) return null;

  const typeCounts = new Map<string, number>();
  for (const a of agents) {
    const label = AGENT_TYPE_LABELS[a.type] || a.type;
    typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
  }
  const typeStr = Array.from(typeCounts.entries())
    .map(([label, count]) => `${count} ${label} agent${count > 1 ? "s" : ""}`)
    .join(", ");

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color="#30D158">●</Text>
        <Text color="#E5E5EA" bold> {typeStr} finished</Text>
      </Text>

      {agents.map((agent, i) => {
        const isLast = i === agents.length - 1;
        const branch = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";
        const label = AGENT_TYPE_LABELS[agent.type] || agent.type;
        const totalTokens = agent.tokens.input + agent.tokens.output;

        return (
          <React.Fragment key={agent.id}>
            <Text>
              <Text dimColor>{branch}</Text>
              <Text color="#E5E5EA">{label} {agent.description}</Text>
              <Text dimColor> · {agent.toolCount} tool use{agent.toolCount !== 1 ? "s" : ""} · {formatTokens(totalTokens)} tokens</Text>
            </Text>
            <Text>
              <Text dimColor>{childPrefix}</Text>
              {agent.success ? (
                <Text color="#30D158">Done</Text>
              ) : (
                <Text color="#FF453A">Failed</Text>
              )}
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}

// ============================================================================
// MAIN PANEL
// ============================================================================

export const SubagentPanel = React.memo(function SubagentPanel({ running, completed }: SubagentPanelProps) {
  const hasRunning = running.size > 0;
  const hasCompleted = completed.length > 0;

  if (!hasRunning && !hasCompleted) return null;

  const runningEntries = Array.from(running.entries());
  const isOnlyOne = runningEntries.length === 1 && !hasCompleted;

  return (
    <Box flexDirection="column">
      {hasRunning && runningEntries.map(([id, agent], i) => (
        <RunningAgentTree
          key={id}
          agent={agent}
          isLast={i === runningEntries.length - 1}
          isOnly={isOnlyOne}
        />
      ))}

      {hasCompleted && <CompletedSubagentTree agents={completed} />}
    </Box>
  );
});
