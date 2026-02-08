/**
 * Local Tools — file operations, search, shell execution, notebooks, web
 *
 * Enhanced with Claude Code tool parity:
 *   - read_file:      + offset, limit (line-based pagination)
 *   - edit_file:       + replace_all
 *   - run_command:     + configurable timeout, description
 *   - glob:            proper glob file search (new)
 *   - grep:            regex search with context, output modes (new)
 *   - notebook_edit:   Jupyter notebook cell editing (new)
 *   - web_fetch:       fetch URL content as markdown (new)
 *   - todo_write:      session todo list (new)
 *
 * Original tools (search_files, search_content, list_directory) kept for compat.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
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
// IN-MEMORY STATE (persists across turns within a session)
// ============================================================================

let todoState: Array<{ id: string; content: string; status: string; activeForm?: string }> = [];

// ============================================================================
// TOOL NAMES
// ============================================================================

export const LOCAL_TOOL_NAMES = new Set([
  // Original
  "read_file",
  "write_file",
  "edit_file",
  "list_directory",
  "search_files",
  "search_content",
  "run_command",
  // New (Claude Code parity)
  "glob",
  "grep",
  "notebook_edit",
  "web_fetch",
  "todo_write",
]);

export function isLocalTool(name: string): boolean {
  return LOCAL_TOOL_NAMES.has(name);
}

// ============================================================================
// TOOL DEFINITIONS (for Anthropic API)
// ============================================================================

export const LOCAL_TOOL_DEFINITIONS: LocalToolDefinition[] = [
  // ------------------------------------------------------------------
  // ENHANCED ORIGINALS
  // ------------------------------------------------------------------
  {
    name: "read_file",
    description: "Read file contents. Supports line-based pagination for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        offset: { type: "number", description: "Line number to start reading from (1-based). Omit to read from start." },
        limit: { type: "number", description: "Max number of lines to read. Omit to read all." },
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
    description: "Edit a file by replacing an exact string match. Supports replacing all occurrences.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        old_string: { type: "string", description: "Exact text to find in the file" },
        new_string: { type: "string", description: "Text to replace old_string with" },
        replace_all: { type: "boolean", description: "Replace ALL occurrences (default false — replaces first only)" },
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
    description: "Search for files matching a name pattern using find",
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
    description: "Search for text content in files (grep-like). For advanced search, use the 'grep' tool.",
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
    description: "Execute a shell command with configurable timeout and safety checks",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        working_directory: { type: "string", description: "Working directory for the command" },
        timeout: { type: "number", description: "Timeout in milliseconds (default 30000, max 300000)" },
        description: { type: "string", description: "Short description of what this command does" },
      },
      required: ["command"],
    },
  },

  // ------------------------------------------------------------------
  // NEW: GLOB — pattern-based file finder
  // ------------------------------------------------------------------
  {
    name: "glob",
    description: "Fast file pattern matching. Use glob patterns like '**/*.ts' or 'src/**/*.tsx'. Returns matching file paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.tsx', '*.json')" },
        path: { type: "string", description: "Base directory to search in (defaults to cwd)" },
      },
      required: ["pattern"],
    },
  },

  // ------------------------------------------------------------------
  // NEW: GREP — advanced content search
  // ------------------------------------------------------------------
  {
    name: "grep",
    description: "Search file contents with regex, context lines, and multiple output modes. More powerful than search_content.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search in (defaults to cwd)" },
        glob: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts', '*.{ts,tsx}')" },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output mode: 'content' shows matching lines, 'files_with_matches' shows file paths (default), 'count' shows match counts",
        },
        context: { type: "number", description: "Lines of context before and after each match" },
        before: { type: "number", description: "Lines to show before each match (-B)" },
        after: { type: "number", description: "Lines to show after each match (-A)" },
        case_insensitive: { type: "boolean", description: "Case insensitive search (default false)" },
        type: { type: "string", description: "File type shorthand: js, ts, py, go, rust, java, etc." },
        head_limit: { type: "number", description: "Max results to return (default 200)" },
      },
      required: ["pattern"],
    },
  },

  // ------------------------------------------------------------------
  // NEW: NOTEBOOK_EDIT — Jupyter notebook cell editing
  // ------------------------------------------------------------------
  {
    name: "notebook_edit",
    description: "Edit Jupyter notebook (.ipynb) cells: replace, insert, or delete cells.",
    input_schema: {
      type: "object",
      properties: {
        notebook_path: { type: "string", description: "Path to the .ipynb file" },
        cell_id: { type: "string", description: "Cell ID or 0-based index. For insert, new cell goes after this." },
        new_source: { type: "string", description: "New source code/markdown for the cell" },
        cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type (required for insert)" },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Edit mode (default: replace)" },
      },
      required: ["notebook_path", "new_source"],
    },
  },

  // ------------------------------------------------------------------
  // NEW: WEB_FETCH — fetch URL content
  // ------------------------------------------------------------------
  {
    name: "web_fetch",
    description: "Fetch content from a URL and return as cleaned text/markdown. Strips HTML, scripts, styles.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        prompt: { type: "string", description: "What to extract from the page (used for context)" },
      },
      required: ["url"],
    },
  },

  // ------------------------------------------------------------------
  // NEW: TODO_WRITE — session task tracking
  // ------------------------------------------------------------------
  {
    name: "todo_write",
    description: "Manage a todo list for the current session. Track tasks with status.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Full todo list (replaces existing). Each item: {content, status, activeForm?}",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Task description" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task status" },
              activeForm: { type: "string", description: "Present-tense form shown while in progress" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
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
// EXECUTOR (async to support web_fetch)
// ============================================================================

export async function executeLocalTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (name) {
      // Enhanced originals
      case "read_file":       return readFile(input);
      case "write_file":      return writeFile(input);
      case "edit_file":       return editFile(input);
      case "list_directory":  return listDirectory(input);
      case "search_files":    return searchFiles(input);
      case "search_content":  return searchContent(input);
      case "run_command":     return runCommand(input);
      // New tools
      case "glob":            return globSearch(input);
      case "grep":            return grepSearch(input);
      case "notebook_edit":   return notebookEdit(input);
      case "web_fetch":       return await webFetch(input);
      case "todo_write":      return todoWrite(input);
      default:                return { success: false, output: `Unknown local tool: ${name}` };
    }
  } catch (err) {
    return { success: false, output: `Error: ${err}` };
  }
}

// ============================================================================
// ORIGINAL TOOLS (enhanced)
// ============================================================================

function readFile(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  const offset = (input.offset as number) || 1; // 1-based
  const limit = input.limit as number | undefined;

  if (offset > 1 || limit) {
    const startIdx = Math.max(0, offset - 1);
    const endIdx = limit ? startIdx + limit : lines.length;
    const slice = lines.slice(startIdx, endIdx);

    // Format with line numbers like `cat -n`
    const numbered = slice.map((line, i) => {
      const lineNum = startIdx + i + 1;
      return `${String(lineNum).padStart(6)}  ${line}`;
    });

    let output = numbered.join("\n");
    if (endIdx < lines.length) {
      output += `\n\n... (showing lines ${startIdx + 1}-${Math.min(endIdx, lines.length)} of ${lines.length})`;
    }
    return { success: true, output };
  }

  // Full file read with truncation
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
  const replaceAll = (input.replace_all as boolean) ?? false;

  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };
  let content = readFileSync(path, "utf-8");
  if (!content.includes(oldString)) return { success: false, output: "old_string not found in file" };

  if (replaceAll) {
    let count = 0;
    while (content.includes(oldString)) {
      content = content.replace(oldString, newString);
      count++;
      if (count > 10000) break; // safety
    }
    writeFileSync(path, content, "utf-8");
    return { success: true, output: `File edited: ${path} (${count} replacements)` };
  }

  // Single replacement (original behavior)
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
  const timeout = Math.min((input.timeout as number) || 30000, 300000);

  const dangerous = ["rm -rf /", "rm -rf ~", "mkfs", "dd if=", "> /dev/sd"];
  if (dangerous.some((d) => command.includes(d))) {
    return { success: false, output: "Command blocked for safety" };
  }

  try {
    const output = execSync(command, {
      encoding: "utf-8", timeout, cwd, maxBuffer: 1024 * 1024,
    });
    return { success: true, output: output || "(no output)" };
  } catch (err: any) {
    const stderr = err.stderr || err.stdout || String(err);
    return { success: false, output: `Exit code ${err.status || "?"}: ${stderr}`.slice(0, 5000) };
  }
}

// ============================================================================
// NEW TOOLS
// ============================================================================

// --- GLOB -------------------------------------------------------------------

function globSearch(input: Record<string, unknown>): ToolResult {
  const pattern = input.pattern as string;
  const basePath = resolvePath((input.path as string) || process.cwd());

  if (!existsSync(basePath)) return { success: false, output: `Directory not found: ${basePath}` };

  // Parse glob pattern into a directory prefix + name pattern
  // Examples:
  //   "**/*.ts"              → dir=basePath, name="*.ts"
  //   "src/**/*.tsx"         → dir=basePath/src, name="*.tsx"
  //   "*.json"               → dir=basePath, name="*.json"
  //   "src/components/*.tsx"  → dir=basePath/src/components, name="*.tsx"

  let searchDir = basePath;
  let namePattern = pattern;

  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash >= 0) {
    const dirPart = pattern.slice(0, lastSlash).replace(/\*\*\/?/g, "").replace(/\/+$/, "");
    namePattern = pattern.slice(lastSlash + 1);
    if (dirPart && !dirPart.includes("*")) {
      searchDir = join(basePath, dirPart);
    }
  }

  // Handle brace expansion: *.{ts,tsx} → -name '*.ts' -o -name '*.tsx'
  let findCmd: string;
  const braceMatch = namePattern.match(/\{([^}]+)\}/);

  if (braceMatch) {
    const extensions = braceMatch[1].split(",").map((e) => e.trim());
    const conditions = extensions
      .map((ext) => {
        const expanded = namePattern.replace(`{${braceMatch[1]}}`, ext);
        return `-name '${expanded}'`;
      })
      .join(" -o ");
    findCmd = `find "${searchDir}" \\( ${conditions} \\) -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' 2>/dev/null | sort | head -200`;
  } else {
    findCmd = `find "${searchDir}" -name '${namePattern}' -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' 2>/dev/null | sort | head -200`;
  }

  try {
    const output = execSync(findCmd, { encoding: "utf-8", timeout: 10000 });
    const files = output.trim().split("\n").filter(Boolean);
    if (files.length === 0) return { success: true, output: "No files found" };
    return { success: true, output: `${files.length} files:\n${files.join("\n")}` };
  } catch {
    return { success: true, output: "No files found" };
  }
}

// --- GREP -------------------------------------------------------------------

function grepSearch(input: Record<string, unknown>): ToolResult {
  const pattern = input.pattern as string;
  const path = resolvePath((input.path as string) || process.cwd());
  const globFilter = input.glob as string | undefined;
  const outputMode = (input.output_mode as string) || "files_with_matches";
  const contextLines = input.context as number | undefined;
  const beforeLines = input.before as number | undefined;
  const afterLines = input.after as number | undefined;
  const caseInsensitive = input.case_insensitive as boolean | undefined;
  const fileType = input.type as string | undefined;
  const headLimit = (input.head_limit as number) || 200;

  // Build grep command
  const parts: string[] = ["grep", "-r"];

  // Case sensitivity
  if (caseInsensitive) parts.push("-i");

  // Output mode
  switch (outputMode) {
    case "files_with_matches":
      parts.push("-l");
      break;
    case "count":
      parts.push("-c");
      break;
    case "content":
      parts.push("-n"); // always show line numbers for content
      break;
  }

  // Context (only meaningful for content mode)
  if (outputMode === "content") {
    if (contextLines) parts.push(`-C ${contextLines}`);
    if (beforeLines) parts.push(`-B ${beforeLines}`);
    if (afterLines) parts.push(`-A ${afterLines}`);
  }

  // File type filter
  const typeMap: Record<string, string> = {
    js: "*.js", ts: "*.ts", tsx: "*.tsx", jsx: "*.jsx",
    py: "*.py", rust: "*.rs", go: "*.go", java: "*.java",
    rb: "*.rb", php: "*.php", css: "*.css", html: "*.html",
    json: "*.json", yaml: "*.yaml", yml: "*.yml", md: "*.md",
    swift: "*.swift", kt: "*.kt", cpp: "*.cpp", c: "*.c", h: "*.h",
    sh: "*.sh", sql: "*.sql", xml: "*.xml", toml: "*.toml",
  };

  if (globFilter) {
    parts.push(`--include='${globFilter}'`);
  } else if (fileType && typeMap[fileType]) {
    parts.push(`--include='${typeMap[fileType]}'`);
  }

  // Exclude common dirs
  parts.push("--exclude-dir='node_modules'", "--exclude-dir='.git'", "--exclude-dir='dist'");

  // Pattern (escape single quotes)
  const escaped = pattern.replace(/'/g, "'\\''");
  parts.push(`'${escaped}'`, `'${path}'`);

  const cmd = `${parts.join(" ")} 2>/dev/null | head -${headLimit}`;

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
    const result = output.trim();
    if (!result) return { success: true, output: "No matches found" };

    // For count mode, filter out zero-count files
    if (outputMode === "count") {
      const lines = result.split("\n").filter((l) => !l.endsWith(":0"));
      return { success: true, output: lines.join("\n") || "No matches found" };
    }

    return { success: true, output: result };
  } catch {
    return { success: true, output: "No matches found" };
  }
}

// --- NOTEBOOK_EDIT ----------------------------------------------------------

function notebookEdit(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.notebook_path as string);
  const newSource = (input.new_source as string) || "";
  const cellType = (input.cell_type as string) || "code";
  const editMode = (input.edit_mode as string) || "replace";
  const cellId = input.cell_id as string | undefined;

  if (!existsSync(path)) return { success: false, output: `Notebook not found: ${path}` };

  let notebook: any;
  try {
    notebook = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { success: false, output: `Failed to parse notebook: ${err}` };
  }

  const cells: any[] = notebook.cells || [];

  // Find cell by ID or numeric index
  let cellIndex = -1;
  if (cellId !== undefined) {
    // Try by cell.id first
    cellIndex = cells.findIndex((c) => c.id === cellId);
    if (cellIndex === -1) {
      // Try as numeric index
      const idx = parseInt(cellId, 10);
      if (!isNaN(idx) && idx >= 0 && idx < cells.length) cellIndex = idx;
    }
  }

  // Split source into notebook-format lines (each line ends with \n except last)
  const sourceLines = newSource.split("\n").map((line, i, arr) =>
    i < arr.length - 1 ? line + "\n" : line
  );

  switch (editMode) {
    case "replace": {
      if (cellIndex < 0) return { success: false, output: `Cell not found: ${cellId}` };
      cells[cellIndex].source = sourceLines;
      if (cellType) cells[cellIndex].cell_type = cellType;
      break;
    }

    case "insert": {
      const newCell: any = {
        cell_type: cellType,
        source: sourceLines,
        metadata: {},
      };
      if (cellType === "code") {
        newCell.execution_count = null;
        newCell.outputs = [];
      }
      if (cellIndex >= 0) {
        cells.splice(cellIndex + 1, 0, newCell);
      } else {
        cells.push(newCell);
      }
      break;
    }

    case "delete": {
      if (cellIndex < 0) return { success: false, output: `Cell not found: ${cellId}` };
      cells.splice(cellIndex, 1);
      break;
    }

    default:
      return { success: false, output: `Unknown edit_mode: ${editMode}` };
  }

  notebook.cells = cells;
  writeFileSync(path, JSON.stringify(notebook, null, 1), "utf-8");
  return { success: true, output: `Notebook ${editMode}d cell in ${path} (${cells.length} cells total)` };
}

// --- WEB_FETCH --------------------------------------------------------------

async function webFetch(input: Record<string, unknown>): Promise<ToolResult> {
  const url = input.url as string;
  if (!url) return { success: false, output: "url is required" };

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "WhaleCode/3.0 (CLI Agent)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });

    if (!response.ok) {
      return { success: false, output: `HTTP ${response.status}: ${response.statusText}` };
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    // JSON — return as-is (pretty-printed)
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(body);
        const pretty = JSON.stringify(parsed, null, 2);
        return { success: true, output: pretty.slice(0, 80000) };
      } catch {
        return { success: true, output: body.slice(0, 80000) };
      }
    }

    // Plain text — return as-is
    if (contentType.includes("text/plain")) {
      return { success: true, output: body.slice(0, 80000) };
    }

    // HTML — convert to readable text
    const text = htmlToText(body);
    const truncated = text.length > 50000 ? text.slice(0, 50000) + "\n\n... (truncated)" : text;
    return { success: true, output: `# ${url}\n\n${truncated}` };
  } catch (err: any) {
    return { success: false, output: `Fetch error: ${err.message || err}` };
  }
}

/** Simple HTML → readable text/markdown converter */
function htmlToText(html: string): string {
  return html
    // Remove scripts, styles, head, nav, footer
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
    // Convert headings to markdown
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) =>
      "\n" + "#".repeat(parseInt(level)) + " " + stripTags(content).trim() + "\n\n"
    )
    // Convert links to markdown
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) =>
      `[${stripTags(text).trim()}](${href})`
    )
    // Convert list items
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => "- " + stripTags(content).trim() + "\n")
    // Convert paragraphs and divs
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => stripTags(content).trim() + "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Bold, italic
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    // Code
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

// --- TODO_WRITE -------------------------------------------------------------

function todoWrite(input: Record<string, unknown>): ToolResult {
  const todos = input.todos as Array<{ content: string; status: string; activeForm?: string }>;
  if (!Array.isArray(todos)) return { success: false, output: "todos must be an array" };

  todoState = todos.map((t, i) => ({
    id: String(i + 1),
    content: t.content,
    status: t.status,
    activeForm: t.activeForm,
  }));

  const statusIcon: Record<string, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
  };

  const summary = todoState
    .map((t) => `${statusIcon[t.status] || "[ ]"} ${t.content}`)
    .join("\n");

  const counts = {
    pending: todoState.filter((t) => t.status === "pending").length,
    in_progress: todoState.filter((t) => t.status === "in_progress").length,
    completed: todoState.filter((t) => t.status === "completed").length,
  };

  return {
    success: true,
    output: `Todo list (${todoState.length} items — ${counts.completed} done, ${counts.in_progress} active, ${counts.pending} pending):\n${summary}`,
  };
}

/** Get current todo state (for UI display) */
export function getTodoState(): typeof todoState {
  return todoState;
}
