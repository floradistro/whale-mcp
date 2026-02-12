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
 *   - tasks:           action-based CRUD task tracking (replaces todo_write)
 *
 * Original tools (search_files, search_content, list_directory) kept for compat.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { execSync, spawn } from "child_process";
import { homedir } from "os";
import {
  runSubagent,
  runSubagentBackground,
  type SubagentType,
  type ParentTraceContext,
} from "./subagent.js";
import {
  createTurnContext,
  getTurnNumber,
} from "./telemetry.js";
import {
  runAgentTeam,
  TeamLead,
  type TeamConfig,
} from "./team-lead.js";
import { isRgAvailable, rgGrep, rgGlob } from "./ripgrep.js";
import { spawnBackground, readProcessOutput, killProcess, listProcesses, readAgentOutput, stopBackgroundAgent, listBackgroundAgents } from "./background-processes.js";
import { getGlobalEmitter } from "./agent-events.js";
import { getValidToken, SUPABASE_URL, createAuthenticatedClient } from "./auth-service.js";
import { resolveConfig } from "./config-store.js";
import { executeLSP, notifyFileChanged } from "./lsp-manager.js";
import { sandboxCommand, cleanupSandbox } from "./sandbox.js";
import { backupFile } from "./file-history.js";
import { debugLog } from "./debug-log.js";
// Lazy import to avoid circular dependency — agent-loop imports local-tools
let _agentLoopExports: {
  setPermissionMode: (mode: "default" | "plan" | "yolo") => { success: boolean; message: string };
  getPermissionMode: () => "default" | "plan" | "yolo";
  getModel: () => string;
  setModel: (name: string) => { success: boolean; model: string };
} | null = null;
async function getAgentLoop() {
  if (!_agentLoopExports) {
    const mod = await import("./agent-loop.js");
    _agentLoopExports = {
      setPermissionMode: mod.setPermissionMode,
      getPermissionMode: mod.getPermissionMode,
      getModel: mod.getModel,
      setModel: mod.setModel,
    };
  }
  return _agentLoopExports;
}

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

// Task state — replaces old todoState with ID-based tasks supporting dependencies
interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  blocks: string[];    // task IDs this task blocks
  blockedBy: string[]; // task IDs that must complete before this one
  createdAt: string;
}

let taskState: TaskItem[] = [];
let taskCounter = 0;
let todoSessionId: string | null = null;
const TODOS_DIR = join(homedir(), ".swagmanager", "todos");

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
  "tasks", // Replaces todo_write — action-based CRUD with IDs, deps
  "multi_edit", // Multi-edit tool
  "task", // Subagent tool
  "team_create", // Agent team tool
  // Background process tools
  "bash_output",
  "kill_shell",
  "list_shells",
  // Background task tools (shells + agents)
  "task_output",
  "task_stop",
  // Web search
  "web_search",
  // Claude Code parity — consolidated tools
  "config", // Settings + plan mode
  "ask_user", // Structured questions
  // Code intelligence
  "lsp",
  // Skills
  "skill",
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
    description: "Read file contents. Supports line-based pagination for large files. Reads images (png/jpg/gif/webp) as visual content. Extracts text from PDFs. For multiple files, emit all read_file calls in one response — they execute in parallel.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
        offset: { type: "number", description: "Line number to start reading from (1-based). Omit to read from start." },
        limit: { type: "number", description: "Max number of lines to read. Omit to read all." },
        pages: { type: "string", description: "Page range for PDFs (e.g. '1-5', '3', '10-20'). Only for .pdf files." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it and parent directories if needed. For multiple independent files, emit all write_file calls in one response.",
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
    description: "Execute a shell command. Output streams live. Use run_in_background:true for dev servers/watchers — after starting, use bash_output to verify. On macOS use python3 not python.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        working_directory: { type: "string", description: "Working directory for the command" },
        timeout: { type: "number", description: "Timeout in milliseconds (default 30000, max 300000)" },
        description: { type: "string", description: "Short description of what this command does" },
        run_in_background: { type: "boolean", description: "Run in background (for dev servers, watchers). Returns process ID immediately." },
        dangerouslyDisableSandbox: { type: "boolean", description: "Disable OS-level sandbox for this command (default: sandboxed)" },
      },
      required: ["command"],
    },
  },

  // ------------------------------------------------------------------
  // NEW: GLOB — pattern-based file finder
  // ------------------------------------------------------------------
  {
    name: "glob",
    description: "Fast file pattern matching. Use glob patterns like '**/*.ts' or 'src/**/*.tsx'. Returns matching file paths. For multiple patterns, emit all glob calls in one response.",
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
    description: "Search file contents with regex, context lines, and multiple output modes. More powerful than search_content. For multiple patterns, emit all grep calls in one response.",
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
        offset: { type: "number", description: "Skip first N entries before applying head_limit (default 0)" },
        multiline: { type: "boolean", description: "Enable multiline mode where . matches newlines (requires rg)" },
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
  // NEW: WEB_SEARCH — search the web via Exa API
  // ------------------------------------------------------------------
  {
    name: "web_search",
    description: "Search the web for current information. Returns titles, URLs, and snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains" },
        blocked_domains: { type: "array", items: { type: "string" }, description: "Exclude results from these domains" },
      },
      required: ["query"],
    },
  },

  // ------------------------------------------------------------------
  // TASKS — action-based CRUD for structured task tracking
  // ------------------------------------------------------------------
  {
    name: "tasks",
    description: "Track tasks for the current session. Actions: create (returns ID), update (status/deps), list (summary), get (full details). Supports dependencies via blocks/blockedBy.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "list", "get"],
          description: "Action to perform",
        },
        // For create:
        subject: { type: "string", description: "Brief title in imperative form (create)" },
        description: { type: "string", description: "Detailed description (create/update)" },
        activeForm: { type: "string", description: "Present continuous spinner text (create/update)" },
        metadata: { type: "object", description: "Arbitrary metadata (create/update)" },
        // For update/get:
        taskId: { type: "string", description: "Task ID (update/get)" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"], description: "New status (update)" },
        subject_update: { type: "string", description: "New subject (update)" },
        addBlocks: { type: "array", items: { type: "string" }, description: "Task IDs this task blocks (update)" },
        addBlockedBy: { type: "array", items: { type: "string" }, description: "Task IDs that block this task (update)" },
        owner: { type: "string", description: "Task owner (update)" },
      },
      required: ["action"],
    },
  },
  // ------------------------------------------------------------------
  // NEW: MULTI_EDIT — multiple edits to one file in a single call
  // ------------------------------------------------------------------
  {
    name: "multi_edit",
    description: "Apply multiple edits to one file in a single call. Edits applied sequentially. Fails if any old_string not found.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or relative path to the file" },
        edits: {
          type: "array",
          description: "Array of edits to apply sequentially",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Exact text to find" },
              new_string: { type: "string", description: "Text to replace with" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
    },
  },
  // ------------------------------------------------------------------
  // TASK — subagent for discrete tasks
  // ------------------------------------------------------------------
  {
    name: "task",
    description: "Launch a subagent that runs in isolated context and returns a summary when done. Use for discrete tasks completable in 2-6 turns. Use run_in_background for long tasks.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Specific task with clear completion criteria" },
        subagent_type: {
          type: "string",
          enum: ["explore", "plan", "general-purpose", "research"],
          description: "Agent type: explore=find, plan=design, general-purpose=do, research=lookup",
        },
        model: {
          type: "string",
          enum: ["sonnet", "opus", "haiku"],
          description: "Haiku for quick tasks, Sonnet (default) for most, Opus for complex",
        },
        run_in_background: {
          type: "boolean",
          description: "Run agent in background. Returns output_file path to check progress via task_output.",
        },
        max_turns: {
          type: "number",
          description: "Max agentic turns (1-50). Default 8.",
        },
        name: {
          type: "string",
          description: "Display name for the agent.",
        },
        description: {
          type: "string",
          description: "Short 3-5 word description of the task.",
        },
        team_name: {
          type: "string",
          description: "Team name for spawning. Uses current team context if omitted.",
        },
        mode: {
          type: "string",
          enum: ["default", "plan", "yolo"],
          description: "Permission mode for spawned agent (default inherits parent).",
        },
      },
      required: ["prompt", "subagent_type"],
    },
  },
  // ------------------------------------------------------------------
  // TEAM — parallel agent team for large tasks
  // ------------------------------------------------------------------
  {
    name: "team_create",
    description: "Create and run an Agent Team — multiple Claude instances working in parallel. Each teammate runs in separate context, claims tasks from a shared list, and has full tool access. Size tasks for 5-6 items per teammate. Include file lists to prevent conflicts.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Team name (e.g., 'Feature Implementation Team')",
        },
        teammate_count: {
          type: "number",
          description: "Number of teammates to spawn (2-5 recommended)",
        },
        model: {
          type: "string",
          enum: ["sonnet", "opus", "haiku"],
          description: "Model for all teammates (default: sonnet)",
        },
        tasks: {
          type: "array",
          description: "Tasks for the team to complete",
          items: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Clear task description with completion criteria",
              },
              files: {
                type: "array",
                items: { type: "string" },
                description: "Files this task will modify (for conflict prevention)",
              },
              dependencies: {
                type: "array",
                items: { type: "string" },
                description: "Task descriptions that must complete first",
              },
            },
            required: ["description"],
          },
        },
      },
      required: ["name", "teammate_count", "tasks"],
    },
  },

  // ------------------------------------------------------------------
  // BACKGROUND PROCESS TOOLS
  // ------------------------------------------------------------------
  {
    name: "bash_output",
    description: "Read output from a running or completed background shell process. Returns only NEW output since the last read.",
    input_schema: {
      type: "object",
      properties: {
        bash_id: { type: "string", description: "The process ID returned when starting the background process" },
        filter: { type: "string", description: "Optional regex to filter output lines" },
      },
      required: ["bash_id"],
    },
  },
  {
    name: "kill_shell",
    description: "Terminate a running background shell process",
    input_schema: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "The process ID to kill" },
      },
      required: ["shell_id"],
    },
  },
  {
    name: "list_shells",
    description: "List all background shell processes (running and recent completed)",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  // ------------------------------------------------------------------
  // TASK OUTPUT / TASK STOP — unified background task management
  // ------------------------------------------------------------------
  {
    name: "task_output",
    description: "Get output from a background task (shell or agent). Returns status and output content.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task/agent ID (e.g. shell-xxx or agent-xxx)" },
        block: { type: "boolean", description: "Wait for completion (default: true)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 30000)" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_stop",
    description: "Stop a running background task (shell or agent) by ID.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID to stop" },
      },
      required: ["task_id"],
    },
  },

  // ------------------------------------------------------------------
  // CONFIG — runtime settings + mode control (consolidated)
  // ------------------------------------------------------------------
  {
    name: "config",
    description: "Read or write CLI settings. Omit value to read. Keys: model (sonnet/opus/haiku), mode (default/plan/yolo — plan restricts to read-only tools), memory. Use mode=plan before non-trivial tasks to explore first, mode=default to resume full access.",
    input_schema: {
      type: "object",
      properties: {
        setting: { type: "string", description: "Setting key: 'model', 'mode', 'memory'" },
        value: { type: "string", description: "New value. Omit to read current value." },
      },
      required: ["setting"],
    },
  },

  // ------------------------------------------------------------------
  // LSP — Language Server Protocol code intelligence
  // ------------------------------------------------------------------
  {
    name: "lsp",
    description: "Code intelligence via Language Server Protocol. Supports: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. Requires a language server installed for the file type.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "goToDefinition",
            "findReferences",
            "hover",
            "documentSymbol",
            "workspaceSymbol",
            "goToImplementation",
            "prepareCallHierarchy",
            "incomingCalls",
            "outgoingCalls",
          ],
          description: "LSP operation to perform",
        },
        filePath: { type: "string", description: "Absolute or relative path to the file" },
        line: { type: "number", description: "Line number (1-based, as shown in editors)" },
        character: { type: "number", description: "Character offset (1-based, as shown in editors)" },
        query: { type: "string", description: "Search query for workspaceSymbol operation (optional, defaults to all symbols)" },
      },
      required: ["operation", "filePath", "line", "character"],
    },
  },

  // ------------------------------------------------------------------
  // ASK_USER — structured multi-choice question
  // ------------------------------------------------------------------
  {
    name: "ask_user",
    description: "Ask the user a structured question with predefined options. Use to gather preferences, clarify requirements, or get decisions during execution. The user can always type a custom answer.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
        options: {
          type: "array",
          description: "2-4 options for the user to choose from",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short option label (1-5 words)" },
              description: { type: "string", description: "Explanation of what this option means" },
            },
            required: ["label", "description"],
          },
        },
      },
      required: ["question", "options"],
    },
  },

  // ------------------------------------------------------------------
  // SKILL — invoke named skills (model-callable)
  // ------------------------------------------------------------------
  {
    name: "skill",
    description: "Invoke a named skill. Skills provide specialized workflows like committing code, reviewing PRs, etc. Built-in skills: commit, review, review-pr. Custom skills from .whale/commands/ and ~/.swagmanager/commands/.",
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name (e.g., 'commit', 'review-pr')" },
        args: { type: "string", description: "Optional arguments for the skill" },
      },
      required: ["skill"],
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
      case "read_file":       return await readFile(input);
      case "write_file":      return writeFile(input);
      case "edit_file":       return editFile(input);
      case "list_directory":  return listDirectory(input);
      case "search_files":    return searchFiles(input);
      case "search_content":  return searchContent(input);
      case "run_command":     return await runCommand(input);
      // Background process tools
      case "bash_output":     return bashOutput(input);
      case "kill_shell":      return killShell(input);
      case "list_shells":     return listShells();
      // New tools
      case "glob":            return globSearch(input);
      case "grep":            return grepSearch(input);
      case "notebook_edit":   return notebookEdit(input);
      case "web_fetch":       return await webFetch(input);
      case "web_search":      return await webSearch(input);
      case "tasks":           return tasksTool(input);
      case "multi_edit":      return multiEdit(input);
      case "task":            return await taskTool(input);
      case "team_create":     return await teamCreateTool(input);
      case "task_output":     return await taskOutput(input);
      case "task_stop":       return taskStop(input);
      // Claude Code parity (consolidated)
      case "config":          return await configTool(input);
      case "ask_user":        return askUser(input);
      case "lsp":             return await lspTool(input);
      case "skill":           return skillTool(input);
      default:                return { success: false, output: `Unknown local tool: ${name}` };
    }
  } catch (err) {
    return { success: false, output: `Error: ${err}` };
  }
}

// ============================================================================
// ORIGINAL TOOLS (enhanced)
// ============================================================================

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp",
};

async function readFile(input: Record<string, unknown>): Promise<ToolResult> {
  const path = resolvePath(input.path as string);
  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };

  const ext = path.split(".").pop()?.toLowerCase() || "";

  // Image files → base64 with marker for agent-loop to convert to image content block
  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const buffer = readFileSync(path);
      const base64 = buffer.toString("base64");
      const mediaType = IMAGE_MEDIA_TYPES[ext] || "image/png";
      return { success: true, output: `__IMAGE__${mediaType}__${base64}` };
    } catch (err) {
      return { success: false, output: `Failed to read image: ${err}` };
    }
  }

  // PDF files → extract text
  if (ext === "pdf") {
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const buffer = readFileSync(path);
      const data = await pdfParse(buffer);

      let text = data.text || "";
      const totalPages = data.numpages || 0;
      const pagesParam = input.pages as string | undefined;

      // Apply page range filter if specified
      if (pagesParam && text) {
        const pageTexts = text.split(/\f/); // Form feed splits pages in most PDFs
        const { start, end } = parsePageRange(pagesParam, pageTexts.length);
        text = pageTexts.slice(start, end).join("\n\n---\n\n");
      }

      if (text.length > 100_000) {
        text = text.slice(0, 100_000) + `\n\n... (truncated)`;
      }

      return {
        success: true,
        output: `PDF: ${path} (${totalPages} pages)\n\n${text}`,
      };
    } catch (err) {
      return { success: false, output: `Failed to parse PDF: ${err}` };
    }
  }

  // Text files — existing behavior
  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  const offset = (input.offset as number) || 1; // 1-based
  const limit = input.limit as number | undefined;

  if (offset > 1 || limit) {
    const startIdx = Math.max(0, offset - 1);
    const endIdx = limit ? startIdx + limit : lines.length;
    const slice = lines.slice(startIdx, endIdx);

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

  if (content.length > 100_000) {
    return { success: true, output: content.slice(0, 100_000) + `\n\n... (truncated, ${content.length} total chars)` };
  }
  return { success: true, output: content };
}

function parsePageRange(range: string, totalPages: number): { start: number; end: number } {
  const parts = range.split("-");
  const start = Math.max(0, parseInt(parts[0], 10) - 1);
  const end = parts.length > 1 ? Math.min(totalPages, parseInt(parts[1], 10)) : start + 1;
  return { start, end };
}

/** Compute a unified diff between old and new file lines using prefix/suffix matching */
function computeWriteDiff(oldLines: string[], newLines: string[]): string[] {
  const CTX = 3;
  const MAX_PER_SIDE = 60;

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length &&
         oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (not overlapping prefix)
  let suffixLen = 0;
  while (suffixLen < (oldLines.length - prefixLen) &&
         suffixLen < (newLines.length - prefixLen) &&
         oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]) {
    suffixLen++;
  }

  // If identical
  if (prefixLen + suffixLen >= oldLines.length && prefixLen + suffixLen >= newLines.length) {
    return []; // no changes
  }

  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);

  // If most of the file changed, show a compact summary
  if (oldMiddle.length > MAX_PER_SIDE * 2 && newMiddle.length > MAX_PER_SIDE * 2) {
    const showOld = oldMiddle.slice(0, MAX_PER_SIDE);
    const showNew = newMiddle.slice(0, MAX_PER_SIDE);
    const ctxStart = Math.max(0, prefixLen - CTX);
    const ctxBefore = oldLines.slice(ctxStart, prefixLen);
    const parts: string[] = [`@@ -${ctxStart + 1},${ctxBefore.length + showOld.length} +${ctxStart + 1},${ctxBefore.length + showNew.length} @@`];
    for (const l of ctxBefore) parts.push(` ${l}`);
    for (const l of showOld) parts.push(`-${l}`);
    parts.push(`-... (${oldMiddle.length - MAX_PER_SIDE} more lines removed)`);
    for (const l of showNew) parts.push(`+${l}`);
    parts.push(`+... (${newMiddle.length - MAX_PER_SIDE} more lines added)`);
    return parts;
  }

  // Build single hunk with context
  const ctxStart = Math.max(0, prefixLen - CTX);
  const ctxBefore = oldLines.slice(ctxStart, prefixLen);
  const suffixStart = oldLines.length - suffixLen;
  const newSuffixStart = newLines.length - suffixLen;
  const ctxAfter = newLines.slice(newSuffixStart, Math.min(newSuffixStart + CTX, newLines.length));

  const hunkOldLen = ctxBefore.length + oldMiddle.length + ctxAfter.length;
  const hunkNewLen = ctxBefore.length + newMiddle.length + ctxAfter.length;

  const parts: string[] = [`@@ -${ctxStart + 1},${hunkOldLen} +${ctxStart + 1},${hunkNewLen} @@`];
  for (const l of ctxBefore) parts.push(` ${l}`);
  for (const l of oldMiddle.slice(0, MAX_PER_SIDE)) parts.push(`-${l}`);
  if (oldMiddle.length > MAX_PER_SIDE) parts.push(`-... (${oldMiddle.length - MAX_PER_SIDE} more lines removed)`);
  for (const l of newMiddle.slice(0, MAX_PER_SIDE)) parts.push(`+${l}`);
  if (newMiddle.length > MAX_PER_SIDE) parts.push(`+... (${newMiddle.length - MAX_PER_SIDE} more lines added)`);
  for (const l of ctxAfter) parts.push(` ${l}`);

  return parts;
}

function writeFile(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  const content = input.content as string;
  const existed = existsSync(path);
  const oldContent = existed ? readFileSync(path, "utf-8") : null;
  backupFile(path); // Save backup before modification
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf-8");
  debugLog("tools", `write_file: ${path} (${content.length} chars)`);
  notifyFileChanged(path);

  const newLines = content.split("\n");

  if (!existed || !oldContent) {
    // New file — show as all-added unified diff
    const previewMax = 30;
    const preview = newLines.slice(0, previewMax).map(l => `+${l}`);
    if (newLines.length > previewMax) preview.push(`+... (+${newLines.length - previewMax} more lines)`);
    return {
      success: true,
      output: `Created: ${path} (${newLines.length} lines, ${content.length} chars)\n@@ -0,0 +1,${Math.min(newLines.length, previewMax)} @@\n${preview.join("\n")}`,
    };
  }

  // Overwrite — compute diff between old and new content
  const oldLines = oldContent.split("\n");
  const diff = computeWriteDiff(oldLines, newLines);

  // Count changes
  let added = 0, removed = 0;
  for (const line of diff) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }

  const summary = `Added ${added} lines, removed ${removed} lines`;
  return {
    success: true,
    output: `Updated: ${path} (${summary})\n${diff.join("\n")}`,
  };
}

function editFile(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.path as string);
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  const replaceAll = (input.replace_all as boolean) ?? false;

  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };
  backupFile(path); // Save backup before modification
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
    notifyFileChanged(path);
    return { success: true, output: `File edited: ${path} (${count} replacements)` };
  }

  // Single replacement (original behavior)
  const idx = content.indexOf(oldString);
  const newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  writeFileSync(path, newContent, "utf-8");
  notifyFileChanged(path);

  // Generate unified diff with context and line numbers
  const allOldLines = content.split("\n");
  const allNewLines = newContent.split("\n");
  const beforeEdit = content.slice(0, idx);
  const startLine = beforeEdit.split("\n").length; // 1-based
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const CTX = 3;
  const MAX_LINES = 20;
  const ctxStart = Math.max(1, startLine - CTX);
  const ctxBeforeLines = allOldLines.slice(ctxStart - 1, startLine - 1);
  const newEndLine = startLine + newLines.length - 1;
  const ctxAfterLines = allNewLines.slice(newEndLine, Math.min(newEndLine + CTX, allNewLines.length));

  const showOld = oldLines.slice(0, MAX_LINES);
  const showNew = newLines.slice(0, MAX_LINES);
  const hunkOldLen = ctxBeforeLines.length + showOld.length + ctxAfterLines.length;
  const hunkNewLen = ctxBeforeLines.length + showNew.length + ctxAfterLines.length;

  const diffParts: string[] = [];
  diffParts.push(`@@ -${ctxStart},${hunkOldLen} +${ctxStart},${hunkNewLen} @@`);
  for (const l of ctxBeforeLines) diffParts.push(` ${l}`);
  for (const l of showOld) diffParts.push(`-${l}`);
  if (oldLines.length > MAX_LINES) diffParts.push(`-... (${oldLines.length - MAX_LINES} more lines)`);
  for (const l of showNew) diffParts.push(`+${l}`);
  if (newLines.length > MAX_LINES) diffParts.push(`+... (${newLines.length - MAX_LINES} more lines)`);
  for (const l of ctxAfterLines) diffParts.push(` ${l}`);

  return { success: true, output: `File edited: ${path}\n${diffParts.join("\n")}` };
}

function multiEdit(input: Record<string, unknown>): ToolResult {
  const path = resolvePath(input.file_path as string);
  const edits = input.edits as Array<{ old_string: string; new_string: string }>;

  if (!existsSync(path)) return { success: false, output: `File not found: ${path}` };
  if (!Array.isArray(edits) || edits.length === 0) return { success: false, output: "edits array is required and must not be empty" };

  backupFile(path); // Save backup before modification
  let content = readFileSync(path, "utf-8");
  const diffParts: string[] = [];
  const CTX = 2;
  const MAX_LINES = 10;

  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string } = edits[i];
    const idx = content.indexOf(old_string);
    if (idx === -1) {
      return {
        success: false,
        output: `Edit ${i + 1}/${edits.length} failed: old_string not found (${i} edits applied successfully before failure)`,
      };
    }

    // Compute line numbers before applying edit
    const allOldLines = content.split("\n");
    const beforeEdit = content.slice(0, idx);
    const startLine = beforeEdit.split("\n").length;
    const oldLines = old_string.split("\n");
    const newLines = new_string.split("\n");

    const newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
    const allNewLines = newContent.split("\n");

    const ctxStart = Math.max(1, startLine - CTX);
    const ctxBeforeLines = allOldLines.slice(ctxStart - 1, startLine - 1);
    const newEndLine = startLine + newLines.length - 1;
    const ctxAfterLines = allNewLines.slice(newEndLine, Math.min(newEndLine + CTX, allNewLines.length));

    const showOld = oldLines.slice(0, MAX_LINES);
    const showNew = newLines.slice(0, MAX_LINES);
    const hunkOldLen = ctxBeforeLines.length + showOld.length + ctxAfterLines.length;
    const hunkNewLen = ctxBeforeLines.length + showNew.length + ctxAfterLines.length;

    diffParts.push(`@@ -${ctxStart},${hunkOldLen} +${ctxStart},${hunkNewLen} @@`);
    for (const l of ctxBeforeLines) diffParts.push(` ${l}`);
    for (const l of showOld) diffParts.push(`-${l}`);
    if (oldLines.length > MAX_LINES) diffParts.push(`-... (${oldLines.length - MAX_LINES} more)`);
    for (const l of showNew) diffParts.push(`+${l}`);
    if (newLines.length > MAX_LINES) diffParts.push(`+... (${newLines.length - MAX_LINES} more)`);
    for (const l of ctxAfterLines) diffParts.push(` ${l}`);

    content = newContent;
  }

  writeFileSync(path, content, "utf-8");
  notifyFileChanged(path);
  return {
    success: true,
    output: `Applied ${edits.length} edits to ${path}\n${diffParts.join("\n")}`,
  };
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

async function runCommand(input: Record<string, unknown>): Promise<ToolResult> {
  let command = input.command as string;
  const cwd = input.working_directory ? resolvePath(input.working_directory as string) : undefined;
  const timeout = Math.min((input.timeout as number) || 30000, 300000);
  const background = input.run_in_background as boolean;
  const disableSandbox = input.dangerouslyDisableSandbox as boolean;
  const description = input.description as string | undefined;

  debugLog("tools", `run_command: ${description || command.slice(0, 80)}`, { cwd, timeout, background, sandbox: !disableSandbox });

  const dangerous = ["rm -rf /", "rm -rf ~", "mkfs", "dd if=", "> /dev/sd"];
  if (dangerous.some((d) => command.includes(d))) {
    return { success: false, output: "Command blocked for safety" };
  }

  // Apply sandbox wrapping (macOS only, unless explicitly disabled)
  let sandboxProfilePath: string | null = null;
  if (!disableSandbox && !background) {
    const effectiveCwd = cwd || process.cwd();
    const sandboxResult = sandboxCommand(command, effectiveCwd);
    command = sandboxResult.wrapped;
    sandboxProfilePath = sandboxResult.profilePath;
  }

  // Background mode — spawn detached, validate, return with status
  if (background) {
    const result = await spawnBackground(command, { cwd, timeout: 600_000, description: input.description as string });
    return { success: result.status === "running", output: result.message };
  }

  // Foreground async — spawn + stream output via events
  return new Promise<ToolResult>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let killed = false;

    const child = spawn(command, [], {
      shell: true,
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const emitter = getGlobalEmitter();

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout.push(text);
      // Emit live output for UI streaming
      for (const line of text.split("\n")) {
        if (line.trim()) emitter.emitToolOutput("run_command", line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr.push(text);
      for (const line of text.split("\n")) {
        if (line.trim()) emitter.emitToolOutput("run_command", line);
      }
    });

    // Timeout kill
    const timer = setTimeout(() => {
      if (!killed) {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000);
      }
    }, timeout);

    child.on("exit", (code) => {
      clearTimeout(timer);
      cleanupSandbox(sandboxProfilePath);
      const output = stdout.join("") + (stderr.length > 0 ? "\n" + stderr.join("") : "");
      if (killed) {
        resolve({ success: false, output: `Command timed out after ${timeout}ms.\n${output}`.slice(0, 5000) });
      } else if (code === 0) {
        resolve({ success: true, output: output || "(no output)" });
      } else {
        resolve({ success: false, output: `Exit code ${code ?? "?"}:\n${output}`.slice(0, 5000) });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      cleanupSandbox(sandboxProfilePath);
      resolve({ success: false, output: `Spawn error: ${err.message}` });
    });
  });
}

// Background tool handlers
function bashOutput(input: Record<string, unknown>): ToolResult {
  const id = input.bash_id as string;
  const filter = input.filter as string | undefined;
  const result = readProcessOutput(id, { filter });
  if ("error" in result) return { success: false, output: result.error };

  const statusIcon = result.status === "running" ? "●" : result.status === "completed" ? "✓" : "✕";
  const statusColor = result.status === "running" ? "running" : result.status === "completed" ? "completed" : "failed";
  const lines: string[] = [];
  lines.push(`${statusIcon} Process ${id} — ${statusColor}`);
  if (result.exitCode !== undefined) lines.push(`  Exit code: ${result.exitCode}`);
  if (result.newOutput) {
    lines.push(`  Output:`);
    lines.push(result.newOutput);
  }
  if (result.newErrors) {
    lines.push(`  Errors:`);
    lines.push(result.newErrors);
  }
  if (!result.newOutput && !result.newErrors) lines.push("  (no new output since last check)");
  return { success: true, output: lines.join("\n") };
}

function killShell(input: Record<string, unknown>): ToolResult {
  const id = (input.shell_id || input.bash_id) as string;
  const result = killProcess(id);
  return { success: result.success, output: result.message };
}

function listShells(): ToolResult {
  const procs = listProcesses();
  if (procs.length === 0) return { success: true, output: "No background processes." };
  const lines: string[] = [`${procs.length} background process${procs.length !== 1 ? "es" : ""}:`, ""];
  for (const p of procs) {
    const icon = p.status === "running" ? "●" : p.status === "completed" ? "✓" : "✕";
    lines.push(`  ${icon} ${p.id}  ${p.status}  ${p.runtime}`);
    lines.push(`    ${p.command}`);
    if (p.pid) lines.push(`    PID: ${p.pid}`);
    lines.push(`    stdout: ${p.outputLines} lines  stderr: ${p.errorLines} lines`);
    lines.push("");
  }
  return { success: true, output: lines.join("\n") };
}

// ============================================================================
// NEW TOOLS
// ============================================================================

// --- GLOB -------------------------------------------------------------------

function globSearch(input: Record<string, unknown>): ToolResult {
  const pattern = input.pattern as string;
  const basePath = resolvePath((input.path as string) || process.cwd());

  if (!existsSync(basePath)) return { success: false, output: `Directory not found: ${basePath}` };

  // Try ripgrep first for speed
  if (isRgAvailable()) {
    try {
      const result = rgGlob({ pattern, path: basePath, headLimit: 200 });
      if (result === null) return { success: true, output: "No files found" };
      const files = result.split("\n").filter(Boolean);
      return { success: true, output: `${files.length} files:\n${result}` };
    } catch {
      // Fall through to find
    }
  }

  // Fallback: system find
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
  const offset = (input.offset as number) || 0;
  const multiline = input.multiline as boolean | undefined;

  // Try ripgrep first
  if (isRgAvailable()) {
    try {
      const result = rgGrep({
        pattern,
        path,
        outputMode: outputMode as "content" | "files_with_matches" | "count",
        glob: globFilter,
        type: fileType,
        caseInsensitive: caseInsensitive || false,
        multiline: multiline || false,
        context: contextLines,
        before: beforeLines,
        after: afterLines,
        headLimit,
      });

      if (result === null) return { success: true, output: "No matches found" };

      // For count mode, filter zero-count files
      if (outputMode === "count") {
        const lines = result.split("\n").filter((l) => !l.endsWith(":0"));
        const sliced = offset > 0 ? lines.slice(offset) : lines;
        return { success: true, output: sliced.join("\n") || "No matches found" };
      }

      // Apply offset (skip first N entries)
      if (offset > 0) {
        const lines = result.split("\n");
        const sliced = lines.slice(offset);
        return { success: true, output: sliced.join("\n") || "No matches found" };
      }

      return { success: true, output: result };
    } catch {
      // Fall through to system grep
    }
  }

  // Multiline requires rg — can't do with system grep
  if (multiline) {
    return { success: false, output: "Multiline search requires ripgrep (rg). Install: brew install ripgrep" };
  }

  // Fallback: system grep
  const parts: string[] = ["grep", "-r"];

  if (caseInsensitive) parts.push("-i");

  switch (outputMode) {
    case "files_with_matches": parts.push("-l"); break;
    case "count": parts.push("-c"); break;
    case "content": parts.push("-n"); break;
  }

  if (outputMode === "content") {
    if (contextLines) parts.push(`-C ${contextLines}`);
    if (beforeLines) parts.push(`-B ${beforeLines}`);
    if (afterLines) parts.push(`-A ${afterLines}`);
  }

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

  parts.push("--exclude-dir='node_modules'", "--exclude-dir='.git'", "--exclude-dir='dist'");

  const escaped = pattern.replace(/'/g, "'\\''");
  parts.push(`'${escaped}'`, `'${path}'`);

  const cmd = `${parts.join(" ")} 2>/dev/null | head -${headLimit}`;

  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
    const result = output.trim();
    if (!result) return { success: true, output: "No matches found" };

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

/** Remove all instances of a tag and its content, handling nesting (innermost first) */
function removeNestedTag(html: string, tag: string): string {
  const pattern = new RegExp(
    `<${tag}[^>]*>(?:(?!<${tag}[\\s>/])[\\s\\S])*?<\\/${tag}>`, "gi"
  );
  let result = html;
  let prev = "";
  let safety = 0;
  while (result !== prev && safety++ < 50) {
    prev = result;
    result = result.replace(pattern, "");
  }
  result = result.replace(new RegExp(`<${tag}[^>]*>`, "gi"), "");
  return result;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));
}

/** Enhanced HTML → readable text/markdown converter */
function htmlToText(html: string): string {
  let c = html;

  // 1. Extract main content area (skips nav, sidebar, footer automatically)
  const mainMatch = c.match(/<main[^>]*>([\s\S]*)<\/main>/i)
    || c.match(/<article[^>]*>([\s\S]*)<\/article>/i);
  if (mainMatch) {
    c = mainMatch[1];
  } else {
    const bodyMatch = c.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) c = bodyMatch[1];
  }

  // 2. Remove non-content elements (nesting-aware)
  for (const tag of [
    "script", "style", "nav", "footer", "aside", "header",
    "form", "svg", "iframe", "select", "button", "noscript",
  ]) {
    c = removeNestedTag(c, tag);
  }

  // 3. Remove HTML comments
  c = c.replace(/<!--[\s\S]*?-->/g, "");

  // 4. Convert semantic elements → markdown

  // Code blocks first (preserve contents)
  c = c.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) =>
    "\n```\n" + stripTags(inner).trim() + "\n```\n"
  );
  c = c.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Headings
  c = c.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) =>
    "\n" + "#".repeat(parseInt(level)) + " " + stripTags(text).trim() + "\n\n"
  );

  // Links — skip empty, anchor-only, and javascript: hrefs
  c = c.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const linkText = stripTags(text).trim();
    if (!linkText) return "";
    if (href.startsWith("#") || href.startsWith("javascript:")) return linkText;
    return `[${linkText}](${href})`;
  });

  // Tables → pipe-delimited markdown
  c = c.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent) => {
    const rows: string[] = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    let isFirstRow = true;
    while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
      const cells: string[] = [];
      const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        cells.push(stripTags(cellMatch[1]).trim());
      }
      if (cells.length > 0) {
        rows.push("| " + cells.join(" | ") + " |");
        if (isFirstRow) {
          rows.push("| " + cells.map(() => "---").join(" | ") + " |");
          isFirstRow = false;
        }
      }
    }
    return "\n" + rows.join("\n") + "\n";
  });

  // List items
  c = c.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) =>
    "- " + stripTags(text).trim() + "\n"
  );

  // Bold, italic
  c = c.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  c = c.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");

  // Images → alt text
  c = c.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "[$1]");
  c = c.replace(/<img[^>]*>/gi, "");

  // Horizontal rules
  c = c.replace(/<hr\s*\/?>/gi, "\n---\n");

  // 5. Block elements → newlines (replace tags independently, NOT as pairs)
  c = c.replace(/<\/(?:p|div|section|article|main|blockquote|dd|dt|figcaption|figure|details|summary)>/gi, "\n\n");
  c = c.replace(/<(?:p|div|section|article|main|blockquote|dd|dt|figcaption|figure|details|summary)[^>]*>/gi, "");
  c = c.replace(/<br\s*\/?>/gi, "\n");
  c = c.replace(/<\/(?:li|tr|thead|tbody|tfoot|ul|ol|dl)>/gi, "\n");

  // 6. Strip all remaining tags
  c = c.replace(/<[^>]+>/g, "");

  // 7. Decode HTML entities
  c = decodeEntities(c);

  // 8. Clean whitespace
  c = c
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return c;
}

// --- WEB_SEARCH -------------------------------------------------------------

// Cache the Exa API key within a session
let cachedExaKey: string | null = null;

async function getExaApiKey(): Promise<string | null> {
  if (cachedExaKey) return cachedExaKey;

  try {
    const config = resolveConfig();

    // Tier 1: Service role key (MCP server mode)
    if (config.supabaseUrl && config.supabaseKey) {
      const { createClient } = await import("@supabase/supabase-js");
      const client = createClient(config.supabaseUrl, config.supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await client.from("platform_secrets").select("value").eq("key", "exa_api_key").single();
      if (data?.value) { cachedExaKey = data.value; return cachedExaKey; }
    }

    // Tier 2: User JWT
    const token = await getValidToken();
    if (token) {
      const client = createAuthenticatedClient(token);
      const { data } = await client.from("platform_secrets").select("value").eq("key", "exa_api_key").single();
      if (data?.value) { cachedExaKey = data.value; return cachedExaKey; }
    }
  } catch { /* swallow */ }

  return null;
}

async function webSearch(input: Record<string, unknown>): Promise<ToolResult> {
  const query = input.query as string;
  if (!query) return { success: false, output: "query is required" };
  const allowedDomains = input.allowed_domains as string[] | undefined;
  const blockedDomains = input.blocked_domains as string[] | undefined;

  const apiKey = await getExaApiKey();
  if (!apiKey) {
    return { success: false, output: "Exa API key not configured. Add 'exa_api_key' to platform_secrets table." };
  }

  try {
    const searchBody: Record<string, unknown> = {
      query,
      numResults: 10,
      type: "auto",
      contents: { text: { maxCharacters: 1200, includeHtmlTags: false } },
    };
    if (allowedDomains?.length) searchBody.includeDomains = allowedDomains;
    if (blockedDomains?.length) searchBody.excludeDomains = blockedDomains;

    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(searchBody),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errBody = await response.text();
      return { success: false, output: `Exa API error (${response.status}): ${errBody}` };
    }

    const data = await response.json();
    const results = (data.results || []).map((r: any, i: number) => {
      const parts = [
        `${i + 1}. **${r.title || "Untitled"}**`,
        `   ${r.url}`,
      ];
      if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`);
      if (r.text) parts.push(`   ${r.text.slice(0, 500)}`);
      return parts.join("\n");
    });

    return {
      success: true,
      output: `Found ${results.length} results for "${query}":\n\n${results.join("\n\n")}`,
    };
  } catch (err: any) {
    if (err.name === "TimeoutError" || err.message?.includes("timeout")) {
      return { success: false, output: "Exa search timed out (15s)" };
    }
    return { success: false, output: `Web search error: ${err.message || err}` };
  }
}

// --- TODO_WRITE -------------------------------------------------------------

// ============================================================================
// TASKS TOOL — consolidated CRUD replacing todo_write
// ============================================================================

function tasksTool(input: Record<string, unknown>): ToolResult {
  const action = input.action as string;
  if (!action) return { success: false, output: "action is required (create/update/list/get)" };

  switch (action) {
    case "create": {
      const subject = input.subject as string;
      const description = input.description as string;
      if (!subject || !description) return { success: false, output: "subject and description required for create" };

      taskCounter++;
      const task: TaskItem = {
        id: String(taskCounter),
        subject,
        description,
        status: "pending",
        activeForm: input.activeForm as string | undefined,
        owner: input.owner as string | undefined,
        metadata: input.metadata as Record<string, unknown> | undefined,
        blocks: [],
        blockedBy: [],
        createdAt: new Date().toISOString(),
      };
      taskState.push(task);
      persistTasks();

      return { success: true, output: `Created task #${task.id}: ${subject}` };
    }

    case "update": {
      const taskId = input.taskId as string;
      if (!taskId) return { success: false, output: "taskId required for update" };

      const task = taskState.find((t) => t.id === taskId);
      if (!task) return { success: false, output: `Task #${taskId} not found` };

      const newStatus = input.status as string | undefined;

      // Handle deletion
      if (newStatus === "deleted") {
        // Remove from other tasks' blocks/blockedBy
        for (const t of taskState) {
          t.blocks = t.blocks.filter((id) => id !== taskId);
          t.blockedBy = t.blockedBy.filter((id) => id !== taskId);
        }
        taskState = taskState.filter((t) => t.id !== taskId);
        persistTasks();
        return { success: true, output: `Deleted task #${taskId}` };
      }

      if (newStatus && ["pending", "in_progress", "completed"].includes(newStatus)) {
        task.status = newStatus as TaskItem["status"];
      }
      if (input.subject_update) task.subject = input.subject_update as string;
      if (input.description !== undefined) task.description = input.description as string;
      if (input.activeForm !== undefined) task.activeForm = input.activeForm as string;
      if (input.owner !== undefined) task.owner = input.owner as string;
      if (input.metadata) {
        task.metadata = { ...(task.metadata || {}), ...(input.metadata as Record<string, unknown>) };
        // Remove null keys
        for (const [k, v] of Object.entries(task.metadata!)) {
          if (v === null) delete task.metadata![k];
        }
      }

      // Dependency management
      const addBlocks = input.addBlocks as string[] | undefined;
      const addBlockedBy = input.addBlockedBy as string[] | undefined;
      if (addBlocks) {
        for (const id of addBlocks) {
          if (!task.blocks.includes(id)) task.blocks.push(id);
          const target = taskState.find((t) => t.id === id);
          if (target && !target.blockedBy.includes(taskId)) target.blockedBy.push(taskId);
        }
      }
      if (addBlockedBy) {
        for (const id of addBlockedBy) {
          if (!task.blockedBy.includes(id)) task.blockedBy.push(id);
          const target = taskState.find((t) => t.id === id);
          if (target && !target.blocks.includes(taskId)) target.blocks.push(taskId);
        }
      }

      persistTasks();
      return { success: true, output: `Updated task #${taskId}: ${task.subject} [${task.status}]` };
    }

    case "list": {
      if (taskState.length === 0) return { success: true, output: "No tasks." };

      const icon: Record<string, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
      const lines = taskState.map((t) => {
        let line = `#${t.id}. ${icon[t.status] || "[ ]"} ${t.subject}`;
        if (t.owner) line += ` (${t.owner})`;
        // Show only open blockers
        const openBlockers = t.blockedBy.filter((id) => {
          const blocker = taskState.find((b) => b.id === id);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) line += ` ← blocked by #${openBlockers.join(", #")}`;
        return line;
      });

      const counts = {
        pending: taskState.filter((t) => t.status === "pending").length,
        in_progress: taskState.filter((t) => t.status === "in_progress").length,
        completed: taskState.filter((t) => t.status === "completed").length,
      };

      return {
        success: true,
        output: `Tasks (${taskState.length}: ${counts.completed} done, ${counts.in_progress} active, ${counts.pending} pending):\n${lines.join("\n")}`,
      };
    }

    case "get": {
      const taskId = input.taskId as string;
      if (!taskId) return { success: false, output: "taskId required for get" };

      const task = taskState.find((t) => t.id === taskId);
      if (!task) return { success: false, output: `Task #${taskId} not found` };

      const details = [
        `# Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
        task.owner ? `Owner: ${task.owner}` : null,
        task.activeForm ? `Active form: ${task.activeForm}` : null,
        `Created: ${task.createdAt}`,
        task.blocks.length ? `Blocks: #${task.blocks.join(", #")}` : null,
        task.blockedBy.length ? `Blocked by: #${task.blockedBy.join(", #")}` : null,
        task.metadata ? `Metadata: ${JSON.stringify(task.metadata)}` : null,
        "",
        task.description,
      ].filter(Boolean).join("\n");

      return { success: true, output: details };
    }

    default:
      return { success: false, output: `Unknown action: ${action}. Use create/update/list/get.` };
  }
}

/** Persist tasks to disk (fire-and-forget) */
function persistTasks(): void {
  if (!todoSessionId) return;
  try {
    if (!existsSync(TODOS_DIR)) mkdirSync(TODOS_DIR, { recursive: true });
    writeFileSync(
      join(TODOS_DIR, `${todoSessionId}.json`),
      JSON.stringify({ tasks: taskState, counter: taskCounter }, null, 2),
      "utf-8"
    );
  } catch { /* best effort */ }
}

/** Load tasks from disk for a session */
export function loadTodos(sessionId: string): void {
  const path = join(TODOS_DIR, `${sessionId}.json`);
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Support both old format (array) and new format ({tasks, counter})
    if (Array.isArray(raw)) {
      // Migrate old todo format
      taskState = raw.map((t: any, i: number) => ({
        id: t.id || String(i + 1),
        subject: t.content || t.subject || "Untitled",
        description: t.content || t.description || "",
        status: t.status || "pending",
        activeForm: t.activeForm,
        blocks: t.blocks || [],
        blockedBy: t.blockedBy || [],
        createdAt: t.createdAt || new Date().toISOString(),
      }));
      taskCounter = taskState.length;
    } else if (raw.tasks) {
      taskState = raw.tasks;
      taskCounter = raw.counter || taskState.length;
    }
    todoSessionId = sessionId;
  } catch { /* skip corrupted */ }
}

/** Link tasks to a session for persistence */
export function setTodoSessionId(id: string): void {
  todoSessionId = id;
}

/** Get current task state (for UI display) */
export function getTodoState(): typeof taskState {
  return taskState;
}

// ============================================================================
// CONFIG TOOL — runtime settings + plan mode (consolidated)
// ============================================================================

async function configTool(input: Record<string, unknown>): Promise<ToolResult> {
  const setting = input.setting as string;
  const value = input.value as string | undefined;
  const agentLoop = await getAgentLoop();

  switch (setting) {
    case "model": {
      if (!value) return { success: true, output: `Current model: ${agentLoop.getModel()}` };
      const result = agentLoop.setModel(value);
      return { success: result.success, output: `Model set to: ${result.model}` };
    }

    case "mode":
    case "permission_mode": {
      if (!value) return { success: true, output: `Current mode: ${agentLoop.getPermissionMode()}` };
      if (!["default", "plan", "yolo"].includes(value)) {
        return { success: false, output: `Invalid mode: ${value}. Use: default, plan, yolo` };
      }
      const result = agentLoop.setPermissionMode(value as "default" | "plan" | "yolo");
      return { success: result.success, output: result.message };
    }

    case "memory": {
      if (!value) {
        const memPath = join(homedir(), ".swagmanager", "memory", "MEMORY.md");
        if (!existsSync(memPath)) return { success: true, output: "No memory file found." };
        const content = readFileSync(memPath, "utf-8");
        return { success: true, output: `Memory (${content.length} chars):\n${content.slice(0, 2000)}` };
      }
      return { success: false, output: "Use read_file/write_file to edit memory directly." };
    }

    default:
      return { success: false, output: `Unknown setting: ${setting}. Available: model, mode, memory` };
  }
}

// ============================================================================
// ASK_USER TOOL — structured questions via event emitter
// ============================================================================

function askUser(input: Record<string, unknown>): ToolResult {
  const question = input.question as string;
  const options = input.options as Array<{ label: string; description: string }>;

  if (!question) return { success: false, output: "question is required" };
  if (!options || options.length < 2) return { success: false, output: "at least 2 options required" };

  // Emit the question via the global event emitter for the UI to render
  const emitter = getGlobalEmitter();
  if (emitter) {
    emitter.emit("ask_user", { question, options });
  }

  // Format question as text for the model to see in the response
  // The actual interactive selection happens in the UI layer
  const optionLines = options.map((o, i) => `  ${i + 1}. **${o.label}** — ${o.description}`).join("\n");
  return {
    success: true,
    output: `Question presented to user:\n${question}\n\nOptions:\n${optionLines}\n\n(Waiting for user response...)`,
  };
}

// ============================================================================
// LSP TOOL — code intelligence
// ============================================================================

async function lspTool(input: Record<string, unknown>): Promise<ToolResult> {
  const operation = input.operation as string;
  if (!operation) return { success: false, output: "operation is required" };
  return await executeLSP(operation, input);
}

// ============================================================================
// SKILL TOOL — invoke named skills
// ============================================================================

function skillTool(input: Record<string, unknown>): ToolResult {
  const skillName = input.skill as string;
  if (!skillName) return { success: false, output: "skill name is required" };

  const args = ((input.args as string) || "").split(/\s+/).filter(Boolean);

  // Resolution order:
  // 1. .whale/commands/{skill}.md (project-local)
  // 2. ~/.swagmanager/commands/{skill}.md (user global)
  // 3. Built-in skills bundled with package

  const localPath = join(process.cwd(), ".whale", "commands", `${skillName}.md`);
  const globalPath = join(homedir(), ".swagmanager", "commands", `${skillName}.md`);
  // Built-in skills: check both dist/ and src/ locations
  const thisFileDir = dirname(new URL(import.meta.url).pathname);
  const builtinPaths = [
    join(thisFileDir, "builtin-skills", `${skillName}.md`),           // dist/cli/services/builtin-skills/
    join(thisFileDir, "..", "..", "..", "src", "cli", "services", "builtin-skills", `${skillName}.md`), // src/ from dist/
  ];

  let template: string | null = null;
  let source = "";

  // Check local → global → builtin (multiple paths)
  const candidates: Array<[string, string]> = [
    [localPath, "local"],
    [globalPath, "global"],
    ...builtinPaths.map(p => [p, "builtin"] as [string, string]),
  ];
  for (const [path, src] of candidates) {
    if (existsSync(path)) {
      try {
        let content = readFileSync(path, "utf-8");
        // Strip frontmatter
        if (content.startsWith("---")) {
          const endIdx = content.indexOf("---", 3);
          if (endIdx !== -1) {
            content = content.slice(endIdx + 3).trim();
          }
        }
        template = content;
        source = src;
        break;
      } catch { /* skip */ }
    }
  }

  if (!template) {
    return {
      success: false,
      output: `Skill not found: ${skillName}. Available locations:\n  .whale/commands/${skillName}.md\n  ~/.swagmanager/commands/${skillName}.md\n\nBuilt-in skills: commit, review, review-pr`,
    };
  }

  // Expand arguments ($1, $2, $ARGS)
  let expanded = template;
  for (let i = 0; i < args.length; i++) {
    expanded = expanded.replace(new RegExp(`\\$${i + 1}`, "g"), args[i]);
  }
  expanded = expanded.replace(/\$ARGS/g, args.join(" "));
  expanded = expanded.replace(/\$\d+/g, ""); // Clean up unused

  return {
    success: true,
    output: `[Skill: ${skillName} (${source})]\n\n${expanded.trim()}`,
  };
}

// ============================================================================
// TASK TOOL — subagent execution
// ============================================================================

/** Create parent trace context for subagent hierarchy (inherits current turn number) */
function getParentTraceContext(): ParentTraceContext {
  const ctx = createTurnContext();
  return {
    traceId: ctx.traceId!,
    spanId: ctx.spanId!,
    conversationId: ctx.conversationId,
    turnNumber: getTurnNumber(), // Get current turn number directly
    userId: ctx.userId,
    userEmail: ctx.userEmail,
  };
}

async function taskTool(input: Record<string, unknown>): Promise<ToolResult> {
  const prompt = input.prompt as string;
  const subagent_type = input.subagent_type as SubagentType;
  const model = (input.model as "sonnet" | "opus" | "haiku") || "haiku";
  const runInBackground = input.run_in_background as boolean | undefined;
  const maxTurns = input.max_turns as number | undefined;
  const agentName = input.name as string | undefined;
  const teamName = input.team_name as string | undefined;
  const mode = input.mode as string | undefined;

  if (!prompt) return { success: false, output: "prompt is required" };
  if (!subagent_type) return { success: false, output: "subagent_type is required" };

  // Apply permission mode for subagent if specified
  if (mode) {
    const agentLoop = await getAgentLoop();
    const parentMode = agentLoop.getPermissionMode();
    agentLoop.setPermissionMode(mode as "default" | "plan" | "yolo");
    // Note: mode resets are handled by subagent isolation
  }

  debugLog("tools", `task: ${agentName || subagent_type}`, { model, maxTurns, teamName, mode });

  try {
    // Background mode: start agent, return output file path immediately
    if (runInBackground) {
      const { agentId, outputFile } = await runSubagentBackground({
        prompt,
        subagent_type,
        model,
        max_turns: maxTurns,
        name: agentName,
        run_in_background: true,
        parentTraceContext: getParentTraceContext(),
      });

      return {
        success: true,
        output: `Background agent started.\n  agent_id: ${agentId}\n  output_file: ${outputFile}\n\nUse task_output with task_id="${agentId}" to check progress.`,
      };
    }

    // Foreground mode: run agent synchronously
    const result = await runSubagent({
      prompt,
      subagent_type,
      model,
      max_turns: maxTurns,
      name: agentName,
      parentTraceContext: getParentTraceContext(),
    });

    return {
      success: result.success,
      output: result.output,
    };
  } catch (err: any) {
    return {
      success: false,
      output: `Task failed: ${err.message || err}`,
    };
  }
}

// ============================================================================
// TASK OUTPUT / TASK STOP — unified background task management
// ============================================================================

async function taskOutput(input: Record<string, unknown>): Promise<ToolResult> {
  const taskId = input.task_id as string;
  const block = (input.block as boolean) ?? true;
  const timeout = Math.min((input.timeout as number) || 30000, 120000);

  if (!taskId) return { success: false, output: "task_id is required" };

  // Check if it's a background agent (agent-xxx prefix)
  if (taskId.startsWith("agent-")) {
    const agentResult = readAgentOutput(taskId);
    if (!agentResult) return { success: false, output: `Agent not found: ${taskId}. Use list_shells to see available tasks.` };

    // If blocking and still running, poll until done or timeout
    if (block && agentResult.status === "running") {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 1000));
        const updated = readAgentOutput(taskId);
        if (updated && updated.status !== "running") {
          return { success: true, output: `[${updated.status}]\n${updated.output}` };
        }
      }
      const final = readAgentOutput(taskId);
      return { success: true, output: `[${final?.status || "running"} — timed out waiting]\n${final?.output || ""}` };
    }

    return { success: true, output: `[${agentResult.status}]\n${agentResult.output}` };
  }

  // Fall back to shell process output (bash_output behavior)
  const result = readProcessOutput(taskId, {});
  if ("error" in result) return { success: false, output: result.error };

  const statusIcon = result.status === "running" ? "●" : result.status === "completed" ? "✓" : "✕";
  const lines: string[] = [];
  lines.push(`${statusIcon} Task ${taskId} — ${result.status}`);
  if (result.exitCode !== undefined) lines.push(`  Exit code: ${result.exitCode}`);
  if (result.newOutput) { lines.push(`  Output:`); lines.push(result.newOutput); }
  if (result.newErrors) { lines.push(`  Errors:`); lines.push(result.newErrors); }
  if (!result.newOutput && !result.newErrors) lines.push("  (no new output since last check)");
  return { success: true, output: lines.join("\n") };
}

function taskStop(input: Record<string, unknown>): ToolResult {
  const taskId = input.task_id as string;
  if (!taskId) return { success: false, output: "task_id is required" };

  // Check if it's a background agent
  if (taskId.startsWith("agent-")) {
    const result = stopBackgroundAgent(taskId);
    return { success: result.success, output: result.message };
  }

  // Fall back to shell kill
  const result = killProcess(taskId);
  return { success: result.success, output: result.message };
}

// ============================================================================
// TEAM CREATE TOOL
// ============================================================================

async function teamCreateTool(input: Record<string, unknown>): Promise<ToolResult> {
  const name = input.name as string;
  const teammateCount = input.teammate_count as number;
  const model = (input.model as "sonnet" | "opus" | "haiku") || "sonnet";
  const tasksInput = input.tasks as Array<{
    description: string;
    files?: string[];
    dependencies?: string[];
  }>;

  if (!name) return { success: false, output: "name is required" };
  if (!teammateCount || teammateCount < 1) {
    return { success: false, output: "teammate_count must be at least 1" };
  }
  if (!tasksInput || tasksInput.length === 0) {
    return { success: false, output: "tasks array is required and must not be empty" };
  }

  // Validate task count vs teammate count
  if (tasksInput.length < teammateCount) {
    return {
      success: false,
      output: `Not enough tasks (${tasksInput.length}) for ${teammateCount} teammates. Add more tasks or reduce teammates.`,
    };
  }

  const config: TeamConfig = {
    name,
    teammateCount,
    model,
    tasks: tasksInput,
  };

  try {
    const result = await runAgentTeam(config);

    // Build summary output
    const lines: string[] = [
      `## Team: ${name}`,
      `Status: ${result.success ? "SUCCESS" : "PARTIAL"}`,
      `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
      `Tokens: ${result.tokensUsed.input} in, ${result.tokensUsed.output} out`,
      "",
      "### Task Results",
    ];

    for (const task of result.taskResults) {
      const icon = task.status === "completed" ? "[done]" : "[fail]";
      lines.push(`${icon} ${task.description}`);
      if (task.result) {
        lines.push(`    ${task.result.slice(0, 200)}${task.result.length > 200 ? "..." : ""}`);
      }
    }

    return {
      success: result.success,
      output: lines.join("\n"),
    };
  } catch (err: any) {
    return {
      success: false,
      output: `Team failed: ${err.message || err}`,
    };
  }
}
