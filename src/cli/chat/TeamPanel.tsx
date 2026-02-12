/**
 * TeamPanel — Claude Code-style tree rendering for team execution
 *
 * Uses ├──, └──, │ tree chars. Text-first rendering.
 * Shows green ● header with task progress and per-teammate status.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface TeamInfo {
  name: string;
  tasksCompleted: number;
  tasksTotal: number;
  teammates: Map<string, { name: string; status: string }>;
}

interface TeamPanelProps {
  team: TeamInfo;
}

// Custom comparator — prevent re-render when Map contents haven't actually changed
function teamPropsEqual(prev: TeamPanelProps, next: TeamPanelProps): boolean {
  if (prev.team.name !== next.team.name) return false;
  if (prev.team.tasksCompleted !== next.team.tasksCompleted) return false;
  if (prev.team.tasksTotal !== next.team.tasksTotal) return false;
  if (prev.team.teammates.size !== next.team.teammates.size) return false;

  for (const [id, mate] of prev.team.teammates) {
    const nextMate = next.team.teammates.get(id);
    if (!nextMate) return false;
    if (mate.name !== nextMate.name || mate.status !== nextMate.status) return false;
  }
  return true;
}

export const TeamPanel = React.memo(function TeamPanel({ team }: TeamPanelProps) {
  const teammates = Array.from(team.teammates.entries());

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color="#30D158">●</Text>
        <Text color="#E5E5EA" bold> Team: {team.name}</Text>
        <Text color="#6E6E73"> · {team.tasksCompleted}/{team.tasksTotal} tasks</Text>
      </Text>

      {teammates.map(([id, mate], i) => {
        const isLast = i === teammates.length - 1;
        const branch = isLast ? "└── " : "├── ";
        const isDone = mate.status === "done";
        const isFailed = mate.status === "failed";
        const isWorking = !isDone && !isFailed;
        const color = isDone ? "#30D158" : isFailed ? "#FF453A" : undefined;

        return (
          <Text key={id}>
            <Text color="#6E6E73">{branch}</Text>
            {isWorking ? (
              <Text color="#0A84FF"><Spinner type="dots" /></Text>
            ) : isDone ? (
              <Text color="#30D158">✓</Text>
            ) : (
              <Text color="#FF453A">✕</Text>
            )}
            <Text color={color || "#86868B"}> {mate.name || mate.status}</Text>
            {mate.name && mate.status !== mate.name && mate.status !== "done" && mate.status !== "failed" ? (
              <Text color="#6E6E73"> — {mate.status}</Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}, teamPropsEqual);
