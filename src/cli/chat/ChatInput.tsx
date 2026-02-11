/**
 * ChatInput — Claude Code-style input with full-width divider
 *
 * Full-width ─ divider above prompt. "/" triggers slash command menu.
 * Clean, minimal chrome. Edge-to-edge divider for visual separation.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { colors } from "../shared/Theme.js";

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help",     description: "Show available commands" },
  { name: "/tools",    description: "List all tools" },
  { name: "/model",    description: "Switch model (sonnet/opus/haiku)" },
  { name: "/compact",  description: "Compress conversation context" },
  { name: "/save",     description: "Save session to disk" },
  { name: "/sessions", description: "List saved sessions" },
  { name: "/resume",   description: "Resume a saved session" },
  { name: "/mcp",      description: "Server connection status" },
  { name: "/store",    description: "Switch active store" },
  { name: "/status",   description: "Show session info" },
  { name: "/agents",   description: "List available agent types" },
  { name: "/remember", description: "Remember a fact across sessions" },
  { name: "/forget",   description: "Forget a remembered fact" },
  { name: "/memory",   description: "List all remembered facts" },
  { name: "/mode",     description: "Permission mode (default/plan/yolo)" },
  { name: "/update",   description: "Check for updates & install" },
  { name: "/clear",    description: "Clear conversation" },
  { name: "/exit",     description: "Exit" },
];

interface ChatInputProps {
  onSubmit: (message: string) => void;
  onCommand: (command: string) => void;
  disabled: boolean;
  agentName?: string;
}

function dividerLine(): string {
  const w = (process.stdout.columns || 80) - 2;
  return "─".repeat(Math.max(20, w));
}

export function ChatInput({ onSubmit, onCommand, disabled, agentName }: ChatInputProps) {
  const [value, setValue] = useState("");
  const [menuMode, setMenuMode] = useState(false);

  const handleChange = (newValue: string) => {
    if (newValue === "/") {
      setMenuMode(true);
      setValue("");
      return;
    }
    setValue(newValue);
  };

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

    // Intercept typed slash commands (e.g. "/remember something")
    if (trimmed.startsWith("/")) {
      setValue("");
      onCommand(trimmed);
      return;
    }

    onSubmit(trimmed);
    setValue("");
  };

  const divider = dividerLine();

  // Disabled during streaming — divider + minimal indicator
  if (disabled) {
    return (
      <Box flexDirection="column">
        <Text>{" "}</Text>
        <Text color={colors.separator}>{divider}</Text>
      </Box>
    );
  }

  // Slash command menu
  if (menuMode) {
    const items = SLASH_COMMANDS.map((c) => ({
      label: c.name,
      value: c.name,
    }));

    return (
      <Box flexDirection="column">
        <Text>{" "}</Text>
        <Text color={colors.separator}>{divider}</Text>
        <SelectInput
          items={items}
          onSelect={handleMenuSelect}
          indicatorComponent={({ isSelected }) => (
            <Text color={isSelected ? colors.brand : colors.quaternary}>
              {isSelected ? "›" : " "}{" "}
            </Text>
          )}
          itemComponent={({ isSelected, label }) => {
            const cmd = SLASH_COMMANDS.find((c) => c.name === label);
            return (
              <Text>
                <Text color={isSelected ? colors.brand : colors.secondary} bold={isSelected}>
                  {label}
                </Text>
                <Text color={colors.tertiary}>  {cmd?.description}</Text>
              </Text>
            );
          }}
        />
        <Text color={colors.quaternary}>  esc to dismiss</Text>
      </Box>
    );
  }

  // Normal input — divider + prompt
  return (
    <Box flexDirection="column">
      <Text>{" "}</Text>
      <Text color={colors.separator}>{divider}</Text>
      <Box>
        <Text color="#E5E5EA" bold>{"❯"} </Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={handleSubmit}
          placeholder={`Message ${agentName || "whale"}, or type / for commands`}
        />
      </Box>
    </Box>
  );
}
