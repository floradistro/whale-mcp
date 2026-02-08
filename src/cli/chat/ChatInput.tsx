/**
 * ChatInput — input with slash command popup menu
 *
 * When the input value is exactly "/", the text input is hidden
 * and replaced with a SelectInput menu. Arrow keys + Enter to pick.
 * Esc or backspace closes the menu.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { colors, symbols } from "../shared/Theme.js";

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help",   description: "Show available commands" },
  { name: "/tools",  description: "List all tools (local + server)" },
  { name: "/mcp",    description: "MCP server connection status" },
  { name: "/status", description: "Show status" },
  { name: "/clear",  description: "Clear conversation" },
  { name: "/exit",   description: "Exit whale" },
];

interface ChatInputProps {
  onSubmit: (message: string) => void;
  onCommand: (command: string) => void;
  disabled: boolean;
  agentName?: string;
}

export function ChatInput({ onSubmit, onCommand, disabled, agentName }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [menuMode, setMenuMode] = useState(false);

  // Watch for "/" typed into the text input
  const handleChange = (newValue: string) => {
    if (newValue === "/") {
      // Switch to menu mode
      setMenuMode(true);
      setValue("");
      return;
    }
    setValue(newValue);
  };

  // Close menu on Esc or backspace when in menu mode
  useInput((input, key) => {
    if (!menuMode || disabled) return;
    if (key.escape || key.delete || key.backspace) {
      setMenuMode(false);
    }
  }, { isActive: menuMode });

  const handleMenuSelect = (item: { label: string; value: string }) => {
    setMenuMode(false);
    setValue("");
    onCommand(item.value);
  };

  const handleSubmit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  if (disabled) {
    return (
      <Box>
        <Text color={colors.brand}><Spinner type="dots" /></Text>
        <Text color={colors.muted}> thinking...</Text>
      </Box>
    );
  }

  // Menu mode: show selectable command list
  if (menuMode) {
    const items = SLASH_COMMANDS.map((c) => ({
      label: c.name,
      value: c.name,
    }));

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color={colors.dim}>Select a command:</Text>
        </Box>
        <SelectInput
          items={items}
          onSelect={handleMenuSelect}
          indicatorComponent={({ isSelected }) => (
            <Text color={isSelected ? colors.brand : colors.dim}>
              {isSelected ? symbols.arrowRight : " "}{" "}
            </Text>
          )}
          itemComponent={({ isSelected, label }) => {
            const cmd = SLASH_COMMANDS.find((c) => c.name === label);
            return (
              <Box>
                <Text color={isSelected ? colors.brand : colors.text} bold={isSelected}>
                  {label}
                </Text>
                <Text color={colors.dim}>  {cmd?.description}</Text>
              </Box>
            );
          }}
        />
        <Box marginTop={1}>
          <Text color={colors.subtle}>esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // Normal input mode
  return (
    <Box>
      <Text color={colors.brand} bold>{symbols.user} </Text>
      <TextInput
        value={value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        placeholder={agentName ? `Message ${agentName}, or type /` : "Type a message, or /"}
      />
    </Box>
  );
}
