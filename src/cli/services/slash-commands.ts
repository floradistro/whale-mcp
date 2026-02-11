/**
 * Custom Slash Commands — user-defined commands from .whale/commands/
 *
 * Commands are markdown files that expand into prompts:
 *
 *   .whale/commands/review-pr.md:
 *     Review PR #$1 focusing on security and performance.
 *
 *   Usage: /review-pr 123
 *   Expands to: "Review PR #123 focusing on security and performance."
 *
 * Supports:
 * - $1, $2, etc. for positional arguments
 * - $ARGS for all arguments
 * - Frontmatter for metadata (description, etc.)
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ============================================================================
// TYPES
// ============================================================================

export interface SlashCommand {
  name: string;
  description?: string;
  template: string;
  path: string;
  source: "global" | "local";
}

export interface ParsedCommand {
  command: string;
  args: string[];
}

// ============================================================================
// PATHS
// ============================================================================

const GLOBAL_COMMANDS_DIR = join(homedir(), ".swagmanager", "commands");
const LOCAL_COMMANDS_DIR = ".whale/commands";

// ============================================================================
// COMMAND LOADING
// ============================================================================

function parseCommandFile(content: string): { description?: string; template: string } {
  // Check for YAML frontmatter
  if (content.startsWith("---")) {
    const endIndex = content.indexOf("---", 3);
    if (endIndex !== -1) {
      const frontmatter = content.slice(3, endIndex).trim();
      const template = content.slice(endIndex + 3).trim();

      // Simple YAML parsing for description
      const descMatch = frontmatter.match(/description:\s*(.+)/i);
      const description = descMatch?.[1]?.trim();

      return { description, template };
    }
  }

  return { template: content.trim() };
}

function loadCommandsFromDir(dir: string, source: "global" | "local"): SlashCommand[] {
  if (!existsSync(dir)) return [];

  const commands: SlashCommand[] = [];

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

    for (const file of files) {
      const name = basename(file, ".md");
      const path = join(dir, file);

      try {
        const content = readFileSync(path, "utf-8");
        const { description, template } = parseCommandFile(content);

        commands.push({
          name,
          description,
          template,
          path,
          source,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip inaccessible */ }

  return commands;
}

export function loadAllCommands(): SlashCommand[] {
  const commands: SlashCommand[] = [];

  // Load global commands first
  commands.push(...loadCommandsFromDir(GLOBAL_COMMANDS_DIR, "global"));

  // Load local commands (override global with same name)
  const localDir = join(process.cwd(), LOCAL_COMMANDS_DIR);
  const localCommands = loadCommandsFromDir(localDir, "local");

  // Merge: local overrides global
  for (const local of localCommands) {
    const existingIndex = commands.findIndex((c) => c.name === local.name);
    if (existingIndex >= 0) {
      commands[existingIndex] = local;
    } else {
      commands.push(local);
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCommand(name: string): SlashCommand | undefined {
  const commands = loadAllCommands();
  return commands.find((c) => c.name === name || c.name === name.replace(/^\//, ""));
}

// ============================================================================
// COMMAND PARSING
// ============================================================================

export function parseCommandInput(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  if (!command) return null;

  return { command, args };
}

// ============================================================================
// COMMAND EXPANSION
// ============================================================================

export function expandCommand(command: SlashCommand, args: string[]): string {
  let expanded = command.template;

  // Replace $1, $2, etc.
  for (let i = 0; i < args.length; i++) {
    expanded = expanded.replace(new RegExp(`\\$${i + 1}`, "g"), args[i]);
  }

  // Replace $ARGS with all arguments
  expanded = expanded.replace(/\$ARGS/g, args.join(" "));

  // Clean up unreplaced placeholders
  expanded = expanded.replace(/\$\d+/g, "");

  return expanded.trim();
}

// ============================================================================
// BUILT-IN COMMANDS
// ============================================================================

export interface BuiltInCommand {
  name: string;
  description: string;
  handler: (args: string[]) => { handled: boolean; message?: string; action?: string };
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: "help",
    description: "Show help and available commands",
    handler: () => ({ handled: true, action: "show_help" }),
  },
  {
    name: "clear",
    description: "Clear conversation history",
    handler: () => ({ handled: true, action: "clear_history" }),
  },
  {
    name: "exit",
    description: "Exit the chat",
    handler: () => ({ handled: true, action: "exit" }),
  },
  {
    name: "quit",
    description: "Exit the chat",
    handler: () => ({ handled: true, action: "exit" }),
  },
  {
    name: "status",
    description: "Show connection and tool status",
    handler: () => ({ handled: true, action: "show_status" }),
  },
  {
    name: "model",
    description: "Switch model (e.g., /model opus)",
    handler: (args) => ({
      handled: true,
      action: "set_model",
      message: args[0] || "sonnet",
    }),
  },
  {
    name: "compact",
    description: "Compress conversation context",
    handler: () => ({ handled: true, action: "compact" }),
  },
  {
    name: "save",
    description: "Save current session",
    handler: () => ({ handled: true, action: "save_session" }),
  },
  {
    name: "load",
    description: "Load a saved session",
    handler: (args) => ({
      handled: true,
      action: "load_session",
      message: args[0],
    }),
  },
  {
    name: "sessions",
    description: "List saved sessions",
    handler: () => ({ handled: true, action: "list_sessions" }),
  },
  {
    name: "hooks",
    description: "Show active hooks",
    handler: () => ({ handled: true, action: "show_hooks" }),
  },
  {
    name: "tasks",
    description: "List background tasks/shells",
    handler: () => ({ handled: true, action: "list_tasks" }),
  },
  {
    name: "agents",
    description: "List available agent types",
    handler: () => ({ handled: true, action: "list_agents" }),
  },
  {
    name: "remember",
    description: "Remember a fact across sessions",
    handler: (args) => ({
      handled: true,
      action: "remember",
      message: args.join(" "),
    }),
  },
  {
    name: "forget",
    description: "Forget a remembered fact",
    handler: (args) => ({
      handled: true,
      action: "forget",
      message: args.join(" "),
    }),
  },
  {
    name: "memory",
    description: "List all remembered facts",
    handler: () => ({ handled: true, action: "list_memory" }),
  },
  {
    name: "mode",
    description: "Switch permission mode (default/plan/yolo)",
    handler: (args) => ({
      handled: true,
      action: "set_mode",
      message: args[0] || "",
    }),
  },
];

export function getBuiltInCommand(name: string): BuiltInCommand | undefined {
  return BUILT_IN_COMMANDS.find((c) => c.name === name);
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export function handleSlashCommand(input: string): {
  handled: boolean;
  expandedPrompt?: string;
  action?: string;
  message?: string;
  error?: string;
} {
  const parsed = parseCommandInput(input);
  if (!parsed) {
    return { handled: false };
  }

  // Check built-in commands first
  const builtIn = getBuiltInCommand(parsed.command);
  if (builtIn) {
    const result = builtIn.handler(parsed.args);
    return {
      handled: result.handled,
      action: result.action,
      message: result.message,
    };
  }

  // Check custom commands
  const custom = getCommand(parsed.command);
  if (custom) {
    const expanded = expandCommand(custom, parsed.args);
    return {
      handled: true,
      expandedPrompt: expanded,
    };
  }

  return {
    handled: false,
    error: `Unknown command: /${parsed.command}. Use /help for available commands.`,
  };
}

// ============================================================================
// HELP GENERATOR
// ============================================================================

export function generateHelpText(): string {
  const lines: string[] = ["## Available Commands", ""];

  // Built-in commands
  lines.push("### Built-in");
  for (const cmd of BUILT_IN_COMMANDS) {
    lines.push(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
  }

  // Custom commands
  const custom = loadAllCommands();
  if (custom.length > 0) {
    lines.push("");
    lines.push("### Custom Commands");
    for (const cmd of custom) {
      const desc = cmd.description || `(from ${cmd.path})`;
      lines.push(`  /${cmd.name.padEnd(12)} ${desc}`);
    }
  }

  return lines.join("\n");
}
