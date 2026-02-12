/**
 * Print Mode — non-interactive headless agent runner
 *
 * Used for:
 *   whale -p "prompt"                     Text output to stdout
 *   whale -p --output-format json "..."   Single JSON result
 *   whale -p --output-format stream-json  NDJSON event stream
 *   echo "..." | whale -p                 Read prompt from stdin
 *
 * Auto-yolo mode (no permission prompts).
 * Exit codes: 0=success, 1=error, 2=budget exceeded, 130=SIGINT
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  runAgentLoop,
  setModel,
  setPermissionMode,
  loadSession,
  findLatestSessionForCwd,
  estimateCostUsd,
  type AgentLoopCallbacks,
  type AgentLoopOptions,
} from "./services/agent-loop.js";

// ============================================================================
// TYPES
// ============================================================================

export interface PrintModeOptions {
  message: string;
  outputFormat: "text" | "json" | "stream-json";
  model?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  continueLastSession?: boolean;
  sessionId?: string;
  noSessionPersistence?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  fallbackModel?: string;
  debug?: boolean;
  verbose?: boolean;
}

// ============================================================================
// PRINT MODE RUNNER
// ============================================================================

export async function runPrintMode(opts: PrintModeOptions): Promise<number> {
  const startTime = Date.now();

  // Apply model
  if (opts.model) setModel(opts.model);

  // Auto-yolo in print mode unless explicit mode specified
  setPermissionMode((opts.permissionMode as "default" | "plan" | "yolo") || "yolo");

  // Load session history if resuming
  let conversationHistory: Anthropic.MessageParam[] = [];
  if (opts.resumeSessionId) {
    const session = loadSession(opts.resumeSessionId);
    if (session) {
      conversationHistory = session.messages;
      if (opts.verbose) {
        process.stderr.write(`Resuming session ${opts.resumeSessionId} (${session.meta.messageCount} messages)\n`);
      }
    } else {
      process.stderr.write(`Session not found: ${opts.resumeSessionId}\n`);
      return 1;
    }
  } else if (opts.continueLastSession) {
    const latest = findLatestSessionForCwd();
    if (latest) {
      const session = loadSession(latest.id);
      if (session) {
        conversationHistory = session.messages;
        if (opts.verbose) {
          process.stderr.write(`Continuing session ${latest.id}\n`);
        }
      }
    }
  }

  // Collect results for JSON output
  const toolsUsed: string[] = [];
  let fullText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let exitCode = 0;

  // SIGINT handling
  const abortController = new AbortController();
  const sigintHandler = () => {
    abortController.abort();
    exitCode = 130;
  };
  process.on("SIGINT", sigintHandler);

  try {
    const callbacks: AgentLoopCallbacks = {
      onText: (text: string) => {
        fullText += text;
        if (opts.outputFormat === "text") {
          process.stdout.write(text);
        } else if (opts.outputFormat === "stream-json") {
          process.stdout.write(JSON.stringify({ type: "text", content: text }) + "\n");
        }
      },

      onToolStart: (name: string, input?: Record<string, unknown>) => {
        if (!toolsUsed.includes(name)) toolsUsed.push(name);
        if (opts.outputFormat === "stream-json") {
          process.stdout.write(JSON.stringify({ type: "tool_start", tool: name, input }) + "\n");
        } else if (opts.verbose) {
          process.stderr.write(`[tool] ${name}\n`);
        }
      },

      onToolResult: (name: string, success: boolean, result: unknown, input?: Record<string, unknown>, durationMs?: number) => {
        if (opts.outputFormat === "stream-json") {
          process.stdout.write(JSON.stringify({
            type: "tool_result",
            tool: name,
            success,
            result: typeof result === "string" ? result.slice(0, 1000) : result,
            duration_ms: durationMs,
          }) + "\n");
        } else if (opts.verbose) {
          const status = success ? "ok" : "err";
          process.stderr.write(`[tool] ${name} ${status} (${durationMs}ms)\n`);
        }
      },

      onUsage: (input_tokens: number, output_tokens: number) => {
        totalInputTokens += input_tokens;
        totalOutputTokens += output_tokens;
        if (opts.outputFormat === "stream-json") {
          process.stdout.write(JSON.stringify({
            type: "usage",
            input_tokens,
            output_tokens,
          }) + "\n");
        }
      },

      onDone: (_finalMessages: Anthropic.MessageParam[]) => {
        // Handled below
      },

      onError: (error: string) => {
        if (error.startsWith("Budget exceeded")) {
          exitCode = 2;
        } else if (error !== "Cancelled") {
          exitCode = 1;
        }

        if (opts.outputFormat === "stream-json") {
          process.stdout.write(JSON.stringify({ type: "error", error }) + "\n");
        } else if (opts.outputFormat === "json") {
          // Will be included in final output
        } else {
          process.stderr.write(`Error: ${error}\n`);
        }
      },

      onAutoCompact: (before: number, after: number, tokensSaved: number) => {
        if (opts.debug) {
          process.stderr.write(`[compact] ${before} → ${after} messages (saved ~${tokensSaved} tokens)\n`);
        }
      },
    };

    const loopOpts: AgentLoopOptions = {
      message: opts.message,
      conversationHistory,
      callbacks,
      abortSignal: abortController.signal,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      effort: (opts.effort || "medium") as "low" | "medium" | "high",
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      fallbackModel: opts.fallbackModel,
    };

    await runAgentLoop(loopOpts);

    // Final output for json/stream-json
    const durationMs = Date.now() - startTime;
    const costUsd = estimateCostUsd(totalInputTokens, totalOutputTokens);

    if (opts.outputFormat === "json") {
      const result = {
        type: "result",
        text: fullText,
        session_id: opts.sessionId || null,
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
        },
        cost_usd: costUsd,
        tools_used: toolsUsed,
        model: undefined as string | undefined,
        duration_ms: durationMs,
      };
      // Get model dynamically
      const { getModel } = await import("./services/agent-loop.js");
      result.model = getModel();
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (opts.outputFormat === "stream-json") {
      process.stdout.write(JSON.stringify({
        type: "done",
        duration_ms: durationMs,
        cost_usd: costUsd,
        tools_used: toolsUsed,
      }) + "\n");
    } else if (opts.outputFormat === "text") {
      // Ensure trailing newline
      if (fullText && !fullText.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
  } finally {
    process.off("SIGINT", sigintHandler);
  }

  return exitCode;
}
