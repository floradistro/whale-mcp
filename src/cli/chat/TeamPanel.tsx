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

export const TeamPanel = React.memo(function TeamPanel({ team }: TeamPanelProps) {
  const teammates = Array.from(team.teammates.entries());

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color="#30D158">●</Text>
        <Text color="#E5E5EA" bold> Team: {team.name}</Text>
        <Text color="#48484A"> · {team.tasksCompleted}/{team.tasksTotal} tasks</Text>
      </Text>

      {teammates.map(([id, mate], i) => {
        const isLast = i === teammates.length - 1;
        const branch = isLast ? "└── " : "├── ";
        const isDone = mate.status === "done";
        const isFailed = mate.status === "failed";
        const isWorking = !isDone && !isFailed;
        const color = isDone ? "#30D158" : isFailed ? "#FF453A" : "#8E8E93";

        return (
          <Text key={id}>
            <Text color="#48484A">{branch}</Text>
            {isWorking ? (
              <Text color="#0A84FF"><Spinner type="dots" /></Text>
            ) : isDone ? (
              <Text color="#30D158">✓</Text>
            ) : (
              <Text color="#FF453A">✕</Text>
            )}
            <Text color={color}> {mate.name || mate.status}</Text>
            {mate.name && mate.status !== mate.name ? (
              <Text color="#48484A"> — {mate.status}</Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
});
