/**
 * Background Process Management — Claude Code-style async shell execution
 *
 * Enables running long-running processes (dev servers, watchers, builds)
 * without blocking the agent loop.
 *
 * Tools:
 * - run_command with run_in_background: true
 * - bash_output: Read output from running/completed process
 * - kill_shell: Terminate a background process
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

// ============================================================================
// TYPES
// ============================================================================

export interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: Date;
  status: "running" | "completed" | "failed" | "killed";
  exitCode?: number;
  outputBuffer: string[];
  errorBuffer: string[];
  process: ChildProcess | null;
  lastReadIndex: number; // Track what's been read
}

export interface ProcessOutput {
  id: string;
  status: BackgroundProcess["status"];
  newOutput: string;
  newErrors: string;
  exitCode?: number;
}

// ============================================================================
// PROCESS REGISTRY — in-memory store of running/completed processes
// ============================================================================

const processes = new Map<string, BackgroundProcess>();
const MAX_BUFFER_LINES = 10000;
const MAX_PROCESSES = 20;

// ============================================================================
// HELPERS
// ============================================================================

function generateProcessId(): string {
  return `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function cleanOldProcesses(): void {
  // Remove oldest completed/failed processes if we're at capacity
  const procs = Array.from(processes.values());
  const completed = procs
    .filter((p) => p.status !== "running")
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  while (processes.size >= MAX_PROCESSES && completed.length > 0) {
    const oldest = completed.shift()!;
    processes.delete(oldest.id);
  }
}

// ============================================================================
// SPAWN BACKGROUND PROCESS
// ============================================================================

export async function spawnBackground(
  command: string,
  options: {
    cwd?: string;
    timeout?: number; // Max runtime in ms (default: 10 minutes)
    description?: string;
  } = {}
): Promise<{ id: string; message: string; status: "running" | "failed" }> {
  cleanOldProcesses();

  const id = generateProcessId();
  const cwd = options.cwd || process.cwd();
  const timeout = options.timeout || 600_000; // 10 minutes default

  const proc: BackgroundProcess = {
    id,
    command,
    cwd,
    startedAt: new Date(),
    status: "running",
    outputBuffer: [],
    errorBuffer: [],
    process: null,
    lastReadIndex: 0,
  };

  // Spawn with shell
  let child: ChildProcess;
  try {
    child = spawn(command, [], {
      shell: true,
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: any) {
    return { id, message: `Failed to spawn: ${err.message}`, status: "failed" };
  }

  proc.process = child;

  // Capture stdout
  child.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        proc.outputBuffer.push(line);
        if (proc.outputBuffer.length > MAX_BUFFER_LINES) {
          proc.outputBuffer.splice(0, proc.outputBuffer.length - MAX_BUFFER_LINES);
        }
      }
    }
  });

  // Capture stderr
  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) {
        proc.errorBuffer.push(line);
        if (proc.errorBuffer.length > MAX_BUFFER_LINES) {
          proc.errorBuffer.splice(0, proc.errorBuffer.length - MAX_BUFFER_LINES);
        }
      }
    }
  });

  // Handle exit
  child.on("exit", (code) => {
    proc.status = code === 0 ? "completed" : "failed";
    proc.exitCode = code ?? undefined;
    proc.process = null;
  });

  child.on("error", (err) => {
    proc.status = "failed";
    proc.errorBuffer.push(`Process error: ${err.message}`);
    proc.process = null;
  });

  // Timeout kill
  setTimeout(() => {
    if (proc.status === "running" && proc.process) {
      proc.process.kill("SIGTERM");
      proc.status = "killed";
      proc.errorBuffer.push(`Process killed after ${timeout}ms timeout`);
    }
  }, timeout);

  processes.set(id, proc);

  // ── Validation wait — give process 1.5s to start or fail ──
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Build result with validation
  const lines: string[] = [];
  if (proc.status === "failed") {
    lines.push(`✕ Process failed immediately`);
    lines.push(`  Command: ${command}`);
    if (proc.errorBuffer.length > 0) lines.push(`  Error: ${proc.errorBuffer.join("\n  ")}`);
    if (proc.exitCode !== undefined) lines.push(`  Exit code: ${proc.exitCode}`);
    return { id, message: lines.join("\n"), status: "failed" };
  }

  lines.push(`✓ Background process running`);
  lines.push(`  PID: ${child.pid || "?"}`);
  lines.push(`  ID: ${id}`);
  lines.push(`  Command: ${command}`);
  if (proc.outputBuffer.length > 0) {
    lines.push(`  Initial output (${proc.outputBuffer.length} lines):`);
    for (const l of proc.outputBuffer.slice(0, 8)) {
      lines.push(`    ${l}`);
    }
    if (proc.outputBuffer.length > 8) lines.push(`    ... +${proc.outputBuffer.length - 8} more lines`);
  }
  if (proc.errorBuffer.length > 0) {
    lines.push(`  Stderr (${proc.errorBuffer.length} lines):`);
    for (const l of proc.errorBuffer.slice(0, 4)) {
      lines.push(`    ${l}`);
    }
  }
  lines.push(`  Use bash_output("${id}") to check output, kill_shell("${id}") to stop.`);

  return { id, message: lines.join("\n"), status: "running" };
}

// ============================================================================
// READ OUTPUT
// ============================================================================

export function readProcessOutput(
  id: string,
  options: {
    filter?: string; // Regex to filter lines
  } = {}
): ProcessOutput | { error: string } {
  const proc = processes.get(id);
  if (!proc) {
    // Try partial match
    const match = Array.from(processes.keys()).find(k => k.includes(id));
    if (match) return readProcessOutput(match, options);
    return { error: `Process not found: ${id}. Use list_shells to see available processes.` };
  }

  // Get new output since last read
  const newStdout = proc.outputBuffer.slice(proc.lastReadIndex);
  const newStderr = proc.errorBuffer.slice(proc.lastReadIndex);

  // Update read index
  proc.lastReadIndex = proc.outputBuffer.length;

  // Apply filter if provided
  let filteredOutput = newStdout;
  let filteredErrors = newStderr;

  if (options.filter) {
    try {
      const regex = new RegExp(options.filter, "i");
      filteredOutput = newStdout.filter((line) => regex.test(line));
      filteredErrors = newStderr.filter((line) => regex.test(line));
    } catch {
      // Invalid regex, return unfiltered
    }
  }

  return {
    id,
    status: proc.status,
    newOutput: filteredOutput.join("\n"),
    newErrors: filteredErrors.join("\n"),
    exitCode: proc.exitCode,
  };
}

// ============================================================================
// KILL PROCESS
// ============================================================================

export function killProcess(id: string): { success: boolean; message: string } {
  const proc = processes.get(id);
  if (!proc) {
    return { success: false, message: `Process not found: ${id}` };
  }

  if (proc.status !== "running") {
    return { success: false, message: `Process already ${proc.status}` };
  }

  if (proc.process) {
    proc.process.kill("SIGTERM");

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (proc.process) {
        proc.process.kill("SIGKILL");
      }
    }, 5000);
  }

  proc.status = "killed";

  return { success: true, message: `Process ${id} killed` };
}

// ============================================================================
// LIST PROCESSES
// ============================================================================

export function listProcesses(): Array<{
  id: string;
  pid: number | undefined;
  command: string;
  status: BackgroundProcess["status"];
  startedAt: string;
  runtime: string;
  outputLines: number;
  errorLines: number;
}> {
  const now = Date.now();
  return Array.from(processes.values()).map((p) => {
    const runtimeMs = now - p.startedAt.getTime();
    const runtimeSec = Math.floor(runtimeMs / 1000);
    const runtime =
      runtimeSec < 60
        ? `${runtimeSec}s`
        : runtimeSec < 3600
          ? `${Math.floor(runtimeSec / 60)}m ${runtimeSec % 60}s`
          : `${Math.floor(runtimeSec / 3600)}h ${Math.floor((runtimeSec % 3600) / 60)}m`;

    return {
      id: p.id,
      pid: p.process?.pid,
      command: p.command.length > 50 ? p.command.slice(0, 47) + "..." : p.command,
      status: p.status,
      startedAt: p.startedAt.toISOString(),
      runtime,
      outputLines: p.outputBuffer.length,
      errorLines: p.errorBuffer.length,
    };
  });
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const BACKGROUND_TOOL_DEFINITIONS = [
  {
    name: "bash_output",
    description: "Read output from a running or completed background shell process. Returns only NEW output since the last read.",
    input_schema: {
      type: "object",
      properties: {
        bash_id: {
          type: "string",
          description: "The process ID returned when starting the background process",
        },
        filter: {
          type: "string",
          description: "Optional regex to filter output lines (only matching lines returned)",
        },
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
        shell_id: {
          type: "string",
          description: "The process ID to kill",
        },
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
];
