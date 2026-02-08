/**
 * AgentSelector — polished agent picker with descriptions
 */

import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { colors, symbols } from "../shared/Theme.js";

interface Agent {
  id: string;
  name: string;
  model: string;
}

interface AgentSelectorProps {
  agents: Agent[];
  onSelect: (agentId: string) => void;
}

export function AgentSelector({ agents, onSelect }: AgentSelectorProps) {
  const items = agents.map((a) => ({
    label: `${a.name}`,
    value: a.id,
  }));

  return (
    <Box flexDirection="column">
      <Text color={colors.muted}>Select an agent:</Text>
      <Box height={1} />
      <SelectInput
        items={items}
        onSelect={(item) => onSelect(item.value)}
        indicatorComponent={({ isSelected }) => (
          <Text color={isSelected ? colors.brand : colors.dim}>
            {isSelected ? symbols.arrowRight : " "}{" "}
          </Text>
        )}
        itemComponent={({ isSelected, label }) => {
          const agent = agents.find((a) => a.name === label);
          return (
            <Box>
              <Text color={isSelected ? colors.brand : colors.text} bold={isSelected}>
                {label}
              </Text>
              {agent && (
                <Text color={colors.dim}> ({agent.model})</Text>
              )}
            </Box>
          );
        }}
      />
    </Box>
  );
}
