/**
 * Local Tools — file operations, search, and shell execution
 * Ported from SwagManager/Services/LocalToolService.swift
 *
 * These execute on the user's machine (not on the server).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";
import { homedir } from "os";

// ============================================================================
// TYPES
// ============================================================================

export interface LocalToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
}

// ============================================================================
// TOOL NAMES
// ============================================================================

export const LOCAL_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "search_files",
  "search_content",
  "run_command",
]);

export function isLocalTool(name: string): boolean {
  return LOCAL_TOOL_NAMES.has(name);
}

// ============================================================================
// TOOL DEFINITIONS (for Anthropic API)
// ============================================================================

export const LOCAL_TOOL_DEFINITIONS: LocalToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the specified path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it and parent directories if needed",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing an exact string match with new text",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        old_string: { type: "string", description: "Exact text to find in the file" },
        new_string: { type: "string", description: "Text to replace old_string with" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories at the specified path",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the directory" },
        recursive: { type: "boolean", description: "List recursively (default false, max 200 entries)" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search for files matching a glob pattern using find",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "File name pattern (e.g. *.ts, *.swift)" },
        path: { type: "string", description: "Directory to search in" },
      },
      required: ["pattern", "path"],
    },
  },
  {
    name: "search_content",
    description: "Search for text content in files (grep-like)",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex pattern to search for" },
        path: { type: "string", description: "Directory to search in" },
        file_pattern: { type: "string", description: "Optional file glob filter (e.g. *.ts)" },
      },
      required: ["query", "path"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command and return stdout/stderr",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        working_directory: { type: "string", description: "Working directory for the command" },
      },
      required: ["command"],
    },
  },
];

// ============================================================================
// PATH HELPERS
// ============================================================================

function resolvePath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// ============================================================================
// EXECUTOR
// ============================================================================

export function executeLocalTool(
  name: string,
  input: Record<string, unknown>
): ToolResult {
  try {
    switch (name) {
      case "read_file": return readFile(input);
      case "write_file": return writeFile(input);
      case "edit_file": return editFile(input);
      case "list_directory": return listDirectory(input);
      case "search_files": return searchFiles(input);
      case "search_content": return searchContent(input);
      case "run_command": return runCommand(input);
      default: return { success: false, output: `Unknown local tool: ${name}` };
    }
  } catch (err) {
    return { success: false, output: `Error: ${err}` };
  }
}

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

function readFile(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };
  const content = readFileSync(path, "utf-8");
  if (content.length > 100_000) {
    return { success: true, output: content.slice(0, 100_000) + `\n\n... (truncated, ${content.length} total chars)` };
  }
  return { success: true, output: content };
}

function writeFile(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  const content = input.content as string;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf-8");
  return { success: true, output: `File written: ${path} (${content.length} chars)` };
}

function editFile(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };
  let content = readFileSync(path, "utf-8");
  if (!content.includes(oldString)) return { success: false, output: "old_string not found in file" };
  const idx = content.indexOf(oldString);
  content = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  writeFileSync(path, content, "utf-8");
  return { success: true, output: `File edited: ${path}` };
}

function listDirectory(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  const recursive = input.recursive as boolean ?? false;
  if (!existsSync(path)) return { success: false, output: `Directory not found: ${path}` };

  if (recursive) {
    try {
      const output = execSync(`find "${path}" -maxdepth 4 -not -path '*/.*' 2>/dev/null | head -200`, {
        encoding: "utf-8", timeout: 5000,
      });
      return { success: true, output: output.trim() || "(empty)" };
    } catch {
      return { success: false, output: "Failed to list directory recursively" };
    }
  }

  const entries = readdirSync(path, { withFileTypes: true });
  const lines = entries.map((e) => `${e.isDirectory() ? "[dir]  " : "       "}${e.name}`);
  return { success: true, output: lines.join("\n") || "(empty directory)" };
}

function searchFiles(input: Record<string, unknown>): ToolResult {
  const pattern = input.pattern as string;
  const path = resolvePath(input.path as string);
  try {
    const output = execSync(
      `find "${path}" -name '${pattern}' -type f -not -path '*/.*' 2>/dev/null | head -100`,
      { encoding: "utf-8", timeout: 10000 }
    );
    return { success: true, output: output.trim() || "No files found" };
  } catch {
    return { success: false, output: "Search failed" };
  }
}

function searchContent(input: Record<string, unknown>): ToolResult {
  const query = input.query as string;
  const path = resolvePath(input.path as string);
  const filePattern = input.file_pattern as string | undefined;

  let cmd = `grep -rn '${query.replace(/'/g, "'\\''")}' '${path}'`;
  if (filePattern) cmd += ` --include='${filePattern}'`;
  cmd += " 2>/dev/null | head -50";

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
    return { success: true, output: output.trim() || "No matches found" };
  } catch {
    return { success: true, output: "No matches found" };
  }
}

function runCommand(input: Record<string, unknown>): ToolResult {
  const command = input.command as string;
  const cwd = input.working_directory ? resolvePath(input.working_directory as string) : undefined;

  const dangerous = ["rm -rf /", "rm -rf ~", "mkfs", "dd if=", "> /dev/sd"];
  if (dangerous.some((d) => command.includes(d))) {
    return { success: false, output: "Command blocked for safety" };
  }

  try {
    const output = execSync(command, {
      encoding: "utf-8", timeout: 30000, cwd, maxBuffer: 1024 * 1024,
    });
    return { success: true, output: output || "(no output)" };
  } catch (err: any) {
    const stderr = err.stderr || err.stdout || String(err);
    return { success: false, output: `Exit code ${err.status || "?"}: ${stderr}`.slice(0, 5000) };
  }
}
