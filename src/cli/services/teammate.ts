/**
 * Teammate — Independent agent instance in a Team
 *
 * Following Anthropic's official patterns:
 * - Runs in separate context window (worker thread)
 * - Works on tasks from shared task list
 * - Can message other teammates directly
 * - Full tool access (not restricted like subagents)
 */

import Anthropic from "@anthropic-ai/sdk";
import { Worker, parentPort, workerData, isMainThread } from "worker_threads";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  TeamState,
  TeamTask,
  TeammateInfo,
  loadTeam,
  claimTask,
  completeTask,
  failTask,
  getAvailableTasks,
  sendMessage,
  getUnreadMessages,
  markMessagesRead,
  updateTeammate,
} from "./team-state.js";
import { LoopDetector } from "./loop-detector.js";
import {
  LOCAL_TOOL_DEFINITIONS,
  executeLocalTool,
  isLocalTool,
} from "./local-tools.js";
import {
  isServerTool,
  loadServerToolDefinitions,
  executeServerTool,
} from "./server-tools.js";
import { loadConfig } from "./config-store.js";
import { getValidToken, SUPABASE_URL } from "./auth-service.js";
import { logSpan, generateSpanId, generateTraceId, createTurnContext, getConversationId, initializeTelemetryClient } from "./telemetry.js";

// ============================================================================
// TYPES
// ============================================================================

export interface TeammateWorkerData {
  teamId: string;
  teammateId: string;
  teammateName: string;
  model: string;
  cwd: string;
  parentConversationId: string;  // Link to parent trace for hierarchy
  teamName: string;              // For display in telemetry
  authToken?: string;            // User's access token for telemetry
}

export interface TeammateMessage {
  type: "progress" | "task_started" | "task_completed" | "message_sent" | "done" | "error";
  teammateId: string;
  taskId?: string;
  content: string;
  tokensUsed?: { input: number; output: number };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MODEL_MAP: Record<string, string> = {
  sonnet: "claude-sonnet-4-20250514",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

const PROXY_URL = `${SUPABASE_URL}/functions/v1/agent-proxy`;
const MAX_TURNS_PER_TASK = 12;  // More turns than subagent since tasks are larger
const MAX_OUTPUT_TOKENS = 16384;

// ============================================================================
// TEAMMATE SYSTEM PROMPT
// ============================================================================

function buildTeammatePrompt(
  teammateName: string,
  team: TeamState,
  currentTask: TeamTask | null,
  cwd: string
): string {
  const taskList = team.tasks.map(t => {
    const status = t.status === "in_progress" && t.assignedTo
      ? `in_progress (${team.teammates.find(tm => tm.id === t.assignedTo)?.name || "unknown"})`
      : t.status;
    return `- [${status}] ${t.description}${t.id === currentTask?.id ? " (YOUR TASK)" : ""}`;
  }).join("\n");

  const teammates = team.teammates.map(t =>
    `- ${t.name} (${t.id}): ${t.status}${t.currentTask ? ` - working on task` : ""}`
  ).join("\n");

  return `You are ${teammateName}, a teammate in the "${team.name}" team.

## Working Directory
${cwd}

## Your Current Task
${currentTask ? `
**Task ID**: ${currentTask.id}
**Description**: ${currentTask.description}
${currentTask.files?.length ? `**Files to modify**: ${currentTask.files.join(", ")}` : ""}
${currentTask.dependencies?.length ? `**Dependencies**: ${currentTask.dependencies.join(", ")} (all completed)` : ""}
` : "No task assigned yet. Use team_claim_task to claim an available task."}

## Team Task List
${taskList}

## Teammates
${teammates}

## Team Communication Tools
You have special tools to communicate with your team:
- **team_message**: Send a message to another teammate or the team lead
- **team_broadcast**: Send a message to all teammates
- **team_claim_task**: Claim an available task to work on
- **team_complete_task**: Mark your current task as complete with results
- **team_check_messages**: Check for messages from teammates

## Guidelines
1. Focus on YOUR assigned task - don't work on others' tasks
2. Communicate blockers or discoveries that affect other tasks
3. When done, use team_complete_task with a clear summary
4. Check messages periodically for updates from teammates
5. Avoid modifying files assigned to other teammates' tasks

## Self-Monitoring
If a tool fails, use audit_trail (action="errors") to check patterns before retrying.
Use audit_trail (action="tool_stats") to see your tool success rates.
If a tool fails repeatedly, try a different approach instead of retrying the same call.

## Output
Be concise. Report progress and results clearly. Use tools to do the work.`;
}

// ============================================================================
// TEAM-SPECIFIC TOOLS
// ============================================================================

const TEAM_TOOLS: Anthropic.Tool[] = [
  {
    name: "team_message",
    description: "Send a message to a specific teammate or the team lead",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Teammate ID or 'lead' for team lead",
        },
        message: {
          type: "string",
          description: "Message content",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "team_broadcast",
    description: "Send a message to all teammates",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message to broadcast",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "team_claim_task",
    description: "Claim an available task to work on",
    input_schema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "ID of the task to claim",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "team_complete_task",
    description: "Mark your current task as complete",
    input_schema: {
      type: "object",
      properties: {
        result: {
          type: "string",
          description: "Summary of what was accomplished",
        },
      },
      required: ["result"],
    },
  },
  {
    name: "team_check_messages",
    description: "Check for unread messages from teammates",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// ============================================================================
// TOOL EXECUTION
// ============================================================================

async function executeTeamTool(
  toolName: string,
  input: Record<string, unknown>,
  teamId: string,
  teammateId: string,
  currentTaskId: string | null
): Promise<{ success: boolean; output: string }> {
  switch (toolName) {
    case "team_message": {
      const to = input.to as string;
      const message = input.message as string;
      const result = await sendMessage(teamId, teammateId, to, message);
      return result
        ? { success: true, output: `Message sent to ${to}` }
        : { success: false, output: "Failed to send message" };
    }

    case "team_broadcast": {
      const message = input.message as string;
      const result = await sendMessage(teamId, teammateId, "all", message);
      return result
        ? { success: true, output: "Message broadcast to all teammates" }
        : { success: false, output: "Failed to broadcast message" };
    }

    case "team_claim_task": {
      const taskId = input.task_id as string;
      const task = await claimTask(teamId, taskId, teammateId);
      return task
        ? { success: true, output: `Claimed task: ${task.description}` }
        : { success: false, output: "Failed to claim task (may be unavailable or have unmet dependencies)" };
    }

    case "team_complete_task": {
      if (!currentTaskId) {
        return { success: false, output: "No task currently assigned" };
      }
      const result = input.result as string;
      const success = await completeTask(teamId, currentTaskId, result);
      return success
        ? { success: true, output: `Task completed: ${result}` }
        : { success: false, output: "Failed to complete task" };
    }

    case "team_check_messages": {
      const messages = await getUnreadMessages(teamId, teammateId);
      if (messages.length === 0) {
        return { success: true, output: "No unread messages" };
      }
      const msgList = messages.map(m => `From ${m.from}: ${m.content}`).join("\n");
      await markMessagesRead(teamId, messages.map(m => m.id));
      return { success: true, output: `${messages.length} messages:\n${msgList}` };
    }

    default:
      return { success: false, output: `Unknown team tool: ${toolName}` };
  }
}

// ============================================================================
// API CLIENT
// ============================================================================

async function callAPI(
  modelId: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[]
): Promise<{
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}> {
  // Try proxy first
  const token = await getValidToken();
  if (token) {
    try {
      const response = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages,
          system: systemPrompt,
          tools,
          model: modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
        }),
      });

      if (response.ok && response.body) {
        return processStream(response.body);
      }

      if (response.status !== 404) {
        throw new Error(`Proxy error: ${response.status}`);
      }
    } catch (err: any) {
      if (!err.message?.includes("404")) throw err;
    }
  }

  // Fallback to direct
  const apiKey = process.env.ANTHROPIC_API_KEY || loadConfig().anthropic_api_key;
  if (!apiKey) throw new Error("No API key available");

  const client = new Anthropic({ apiKey });
  let text = "";
  const toolBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";

  // Beta API with tool result clearing — prevents old tool results from filling context
  const stream = client.beta.messages.stream({
    model: modelId,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    tools: tools as any,
    messages: messages as any,
    betas: ["context-management-2025-06-27"],
    context_management: {
      edits: [
        {
          type: "clear_tool_uses_20250919" as const,
          trigger: { type: "input_tokens" as const, value: 80_000 },
          keep: { type: "tool_uses" as const, value: 3 },
        },
      ],
    },
  });

  for await (const event of stream) {
    switch (event.type) {
      case "message_start":
        inputTokens = (event as any).message?.usage?.input_tokens || 0;
        break;
      case "content_block_start":
        if ((event as any).content_block?.type === "tool_use") {
          toolBlocks.set((event as any).index, {
            id: (event as any).content_block.id,
            name: (event as any).content_block.name,
            inputJson: "",
          });
        }
        break;
      case "content_block_delta":
        if ((event as any).delta?.type === "text_delta") {
          text += (event as any).delta.text || "";
        } else if ((event as any).delta?.type === "input_json_delta") {
          const block = toolBlocks.get((event as any).index);
          if (block) block.inputJson += (event as any).delta.partial_json || "";
        }
        break;
      case "message_delta":
        stopReason = (event as any).delta?.stop_reason || "end_turn";
        outputTokens = (event as any).usage?.output_tokens || 0;
        break;
    }
  }

  const content: Anthropic.ContentBlock[] = [];
  if (text) content.push({ type: "text", text } as Anthropic.TextBlock);
  for (const [, block] of toolBlocks) {
    let input = {};
    try { input = JSON.parse(block.inputJson); } catch {}
    content.push({ type: "tool_use", id: block.id, name: block.name, input } as Anthropic.ToolUseBlock);
  }

  return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason };
}

async function processStream(body: ReadableStream<Uint8Array>): Promise<{
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;

        let event: any;
        try { event = JSON.parse(data); } catch { continue; }

        switch (event.type) {
          case "error":
            // Proxy wraps API errors as SSE error events — throw so caller can handle
            throw new Error(event.error || "Unknown streaming error from proxy");
          case "message_start":
            inputTokens = event.message?.usage?.input_tokens || 0;
            break;
          case "content_block_start":
            if (event.content_block?.type === "tool_use") {
              toolBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: "",
              });
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta") {
              text += event.delta.text || "";
            } else if (event.delta?.type === "input_json_delta") {
              const block = toolBlocks.get(event.index);
              if (block) block.inputJson += event.delta.partial_json || "";
            }
            break;
          case "message_delta":
            stopReason = event.delta?.stop_reason || "end_turn";
            outputTokens = event.usage?.output_tokens || 0;
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const content: Anthropic.ContentBlock[] = [];
  if (text) content.push({ type: "text", text } as Anthropic.TextBlock);
  for (const [, block] of toolBlocks) {
    let input = {};
    try { input = JSON.parse(block.inputJson); } catch {}
    content.push({ type: "tool_use", id: block.id, name: block.name, input } as Anthropic.ToolUseBlock);
  }

  return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason };
}

// ============================================================================
// TEAMMATE WORKER LOOP
// ============================================================================

async function runTeammateLoop(data: TeammateWorkerData): Promise<void> {
  const { teamId, teammateId, teammateName, model, cwd, parentConversationId, teamName, authToken } = data;
  const modelId = MODEL_MAP[model] || MODEL_MAP.opus;  // Inherit parent default
  const startTime = Date.now();

  // Initialize telemetry client with auth token if provided
  if (authToken) {
    initializeTelemetryClient(authToken);
  }

  // Each teammate gets its own conversation_id (separate trace)
  // but links to parent via parent_conversation_id
  const teammateConversationId = getConversationId(); // Worker's own ID

  // Create trace context for this teammate
  const teammateTraceId = generateTraceId();
  const teammateSpanId = generateSpanId();

  // Log teammate start - links to parent for tree hierarchy
  logSpan({
    action: "team.teammate_start",
    durationMs: 0,
    context: {
      traceId: teammateTraceId,
      spanId: teammateSpanId,
      conversationId: teammateConversationId,
      source: "claude_code",
      serviceName: "whale-cli",
      serviceVersion: "2.1.0",
      model: modelId,
    },
    details: {
      is_team: true,
      is_teammate: true,
      team_id: teamId,
      teammate_id: teammateId,
      teammate_name: teammateName,
      team_name: teamName,
      parent_conversation_id: parentConversationId,  // Link to parent trace
      model: model,
      display_name: teammateName,
      display_icon: "person.fill",
      display_color: "#3B82F6",
    },
  });

  // Get all tools (local + server + team)
  const localTools: Anthropic.Tool[] = LOCAL_TOOL_DEFINITIONS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  let serverTools: Anthropic.Tool[] = [];
  try {
    serverTools = await loadServerToolDefinitions();
  } catch {}

  // Deduplicate: local tools take priority over server tools with the same name
  const localNames = new Set(localTools.map(t => t.name));
  const uniqueServerTools = serverTools.filter(t => !localNames.has(t.name));
  const allTools = [...localTools, ...uniqueServerTools, ...TEAM_TOOLS];

  const loopDetector = new LoopDetector();

  let totalIn = 0;
  let totalOut = 0;
  let currentTaskId: string | null = null;
  let messages: Anthropic.MessageParam[] = [];
  let tasksCompleted = 0;

  const report = (msg: TeammateMessage) => {
    if (parentPort) {
      parentPort.postMessage(msg);
    }
  };

  report({ type: "progress", teammateId, content: `${teammateName} started` });

  // Helper to log teammate completion
  const logTeammateComplete = (reason: string) => {
    logSpan({
      action: "team.teammate_done",
      durationMs: Date.now() - startTime,
      context: {
        traceId: teammateTraceId,
        spanId: generateSpanId(),
        parentSpanId: teammateSpanId,
        conversationId: teammateConversationId,
        source: "claude_code",
        serviceName: "whale-cli",
        serviceVersion: "2.1.0",
        model: modelId,
        inputTokens: totalIn,
        outputTokens: totalOut,
      },
      details: {
        is_team: true,
        is_teammate: true,
        team_id: teamId,
        teammate_id: teammateId,
        teammate_name: teammateName,
        team_name: teamName,
        parent_conversation_id: parentConversationId,
        tasks_completed: tasksCompleted,
        completion_reason: reason,
        display_name: `${teammateName} done`,
        display_icon: "checkmark.circle.fill",
        display_color: "#10B981",
      },
    });
  };

  // Main work loop - keep working until no more tasks
  while (true) {
    const team = loadTeam(teamId);
    if (!team || team.status !== "active") {
      logTeammateComplete("team_inactive");
      report({ type: "done", teammateId, content: "Team completed or inactive", tokensUsed: { input: totalIn, output: totalOut } });
      break;
    }

    // Find current task or claim a new one
    const currentTask = currentTaskId
      ? team.tasks.find(t => t.id === currentTaskId)
      : null;

    // If no current task, try to claim one
    if (!currentTask || currentTask.status === "completed") {
      const available = getAvailableTasks(team);
      if (available.length === 0) {
        // No tasks available, check if all done or waiting
        const inProgress = team.tasks.filter(t => t.status === "in_progress").length;
        if (inProgress === 0) {
          logTeammateComplete("all_tasks_done");
          report({ type: "done", teammateId, content: "All tasks completed", tokensUsed: { input: totalIn, output: totalOut } });
          break;
        }
        // Wait and retry
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // Claim first available task
      const claimed = await claimTask(teamId, available[0].id, teammateId);
      if (!claimed) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      currentTaskId = claimed.id;
      await updateTeammate(teamId, teammateId, { status: "working", currentTask: currentTaskId });
      report({ type: "task_started", teammateId, taskId: currentTaskId, content: claimed.description });

      // Start fresh conversation for new task
      messages = [{
        role: "user",
        content: `Your task: ${claimed.description}\n\nBegin working on this task. Use the available tools to complete it, then use team_complete_task when done.`,
      }];
    }

    // Build system prompt with current state
    const freshTeam = loadTeam(teamId)!;
    const freshTask = freshTeam.tasks.find(t => t.id === currentTaskId) || null;
    const systemPrompt = buildTeammatePrompt(teammateName, freshTeam, freshTask, cwd);

    // Agent loop for current task
    let taskExhausted = false;
    let apiError: string | null = null;
    for (let turn = 0; turn < MAX_TURNS_PER_TASK; turn++) {
      const apiStart = Date.now();
      let response: Awaited<ReturnType<typeof callAPI>>;
      try {
        response = await callAPI(modelId, systemPrompt, messages, allTools);
      } catch (err: any) {
        apiError = err.message || String(err);
        report({ type: "progress", teammateId, content: `API error: ${apiError!.slice(0, 80)}` });
        logSpan({
          action: "claude_api_request",
          durationMs: Date.now() - apiStart,
          severity: "error",
          error: apiError || undefined,
          context: {
            traceId: teammateTraceId,
            spanId: generateSpanId(),
            parentSpanId: teammateSpanId,
            conversationId: teammateConversationId,
            source: "claude_code",
            serviceName: "whale-cli",
            serviceVersion: "2.1.0",
            model: modelId,
          },
          details: {
            is_team: true,
            is_teammate: true,
            team_id: teamId,
            teammate_id: teammateId,
            teammate_name: teammateName,
            parent_conversation_id: parentConversationId,
            turn_number: turn + 1,
            task_id: currentTaskId,
          },
        });
        break; // Exit inner loop — force-complete handler below will deal with the task
      }
      const apiDuration = Date.now() - apiStart;
      totalIn += response.usage.input_tokens;
      totalOut += response.usage.output_tokens;

      // Log Claude API request telemetry
      logSpan({
        action: "claude_api_request",
        durationMs: apiDuration,
        context: {
          traceId: teammateTraceId,
          spanId: generateSpanId(),
          parentSpanId: teammateSpanId,
          conversationId: teammateConversationId,
          source: "claude_code",
          serviceName: "whale-cli",
          serviceVersion: "2.1.0",
          model: modelId,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        details: {
          is_team: true,
          is_teammate: true,
          team_id: teamId,
          teammate_id: teammateId,
          teammate_name: teammateName,
          parent_conversation_id: parentConversationId,
          turn_number: turn + 1,
          task_id: currentTaskId,
          stop_reason: response.stop_reason,
          "gen_ai.request.model": modelId,
          "gen_ai.usage.input_tokens": response.usage.input_tokens,
          "gen_ai.usage.output_tokens": response.usage.output_tokens,
        },
      });

      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const toolBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      // Report progress
      if (textBlocks.length) {
        report({ type: "progress", teammateId, taskId: currentTaskId || undefined, content: textBlocks[0].text.slice(0, 200) });
      }

      // No tools = done with this turn
      if (toolBlocks.length === 0) break;

      // Execute tools
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let taskCompleted = false;

      for (const tu of toolBlocks) {
        // Circuit breaker check
        const loopCheck = loopDetector.recordCall(tu.name, tu.input as Record<string, unknown>);
        if (loopCheck.blocked) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: loopCheck.reason }),
          });
          continue;
        }

        const toolStart = Date.now();
        let result: { success: boolean; output: string };
        let toolCategory = "unknown";

        // Check if it's a team tool
        if (TEAM_TOOLS.some(t => t.name === tu.name)) {
          toolCategory = "team";
          result = await executeTeamTool(
            tu.name,
            tu.input as Record<string, unknown>,
            teamId,
            teammateId,
            currentTaskId
          );

          // Check if task was completed
          if (tu.name === "team_complete_task" && result.success) {
            taskCompleted = true;
            tasksCompleted++;
            report({ type: "task_completed", teammateId, taskId: currentTaskId || undefined, content: result.output });

            // Log task completion to telemetry
            logSpan({
              action: "team.task_complete",
              durationMs: 0,
              context: {
                traceId: teammateTraceId,
                spanId: generateSpanId(),
                parentSpanId: teammateSpanId,
                conversationId: teammateConversationId,
                source: "claude_code",
                serviceName: "whale-cli",
                serviceVersion: "2.1.0",
              },
              details: {
                is_team: true,
                is_teammate: true,
                team_id: teamId,
                teammate_id: teammateId,
                teammate_name: teammateName,
                parent_conversation_id: parentConversationId,
                task_id: currentTaskId,
                task_result: result.output.slice(0, 500),
                display_name: "Task completed",
                display_icon: "checkmark.square.fill",
                display_color: "#10B981",
              },
            });
          }
        } else if (isLocalTool(tu.name)) {
          toolCategory = "local";
          result = await executeLocalTool(tu.name, tu.input as Record<string, unknown>);
        } else if (isServerTool(tu.name)) {
          toolCategory = "server";
          result = await executeServerTool(tu.name, tu.input as Record<string, unknown>);
        } else {
          result = { success: false, output: `Unknown tool: ${tu.name}` };
        }

        const toolDuration = Date.now() - toolStart;
        loopDetector.recordResult(tu.name, result.success);

        // Log tool execution telemetry
        logSpan({
          action: `tool.${tu.name}`,
          durationMs: toolDuration,
          severity: result.success ? "info" : "error",
          context: {
            traceId: teammateTraceId,
            spanId: generateSpanId(),
            parentSpanId: teammateSpanId,
            conversationId: teammateConversationId,
            source: "claude_code",
            serviceName: "whale-cli",
            serviceVersion: "2.1.0",
          },
          error: result.success ? undefined : result.output,
          details: {
            is_team: true,
            is_teammate: true,
            team_id: teamId,
            teammate_id: teammateId,
            teammate_name: teammateName,
            parent_conversation_id: parentConversationId,
            tool_category: toolCategory,
            tool_input: JSON.stringify(tu.input).slice(0, 1000),
            tool_result: result.output.slice(0, 1000),
          },
        });

        const MAX_TOOL_RESULT_CHARS = 30_000;
        let contentStr = JSON.stringify(result.success ? result.output : { error: result.output });
        if (contentStr.length > MAX_TOOL_RESULT_CHARS) {
          contentStr = contentStr.slice(0, MAX_TOOL_RESULT_CHARS)
            + `\n\n... (truncated — ${contentStr.length.toLocaleString()} chars total)`;
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: contentStr,
        });
      }

      // Append to messages
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });

      // If task was completed, break out to get next task
      if (taskCompleted) {
        currentTaskId = null;
        await updateTeammate(teamId, teammateId, { status: "idle", currentTask: undefined });
        break;
      }
    }

    // If inner loop ended without completing the task (exhausted turns, API error, or no-tool response)
    if (currentTaskId) {
      const team = loadTeam(teamId);
      const task = team?.tasks.find(t => t.id === currentTaskId);
      if (task && task.status === "in_progress") {
        if (apiError) {
          // API failed — mark task as failed, not completed
          await failTask(teamId, currentTaskId, apiError);
          // Report as progress (not error) — error type causes red flash in UI via handleTeammateFailure double-handling
          report({ type: "progress", teammateId, taskId: currentTaskId, content: `Task failed: ${apiError.slice(0, 80)}` });
        } else if (totalIn === 0 && totalOut === 0) {
          // Zero tokens used means no real work was done — fail the task
          await failTask(teamId, currentTaskId, "No API response received (0 tokens)");
          report({ type: "progress", teammateId, taskId: currentTaskId, content: "Task failed: no API response" });
        } else {
          // Exhausted turns or model stopped — auto-complete with partial result
          const lastText = messages.length > 0 ? messages[messages.length - 1] : null;
          let partialResult = "Task auto-completed after reaching turn limit.";
          if (lastText && typeof lastText === "object" && "content" in lastText) {
            const content = lastText.content;
            if (typeof content === "string") partialResult = content.slice(0, 500);
            else if (Array.isArray(content)) {
              const txt = content.find((b: any) => b.type === "text");
              if (txt && "text" in txt) partialResult = (txt as any).text.slice(0, 500);
            }
          }
          await completeTask(teamId, currentTaskId, partialResult);
          tasksCompleted++;
          report({ type: "task_completed", teammateId, taskId: currentTaskId, content: partialResult });
        }
      }
      currentTaskId = null;
      await updateTeammate(teamId, teammateId, { status: "idle", currentTask: undefined });
    }
  }

  // Final update
  await updateTeammate(teamId, teammateId, {
    status: "done",
    currentTask: undefined,
    tokensUsed: { input: totalIn, output: totalOut },
  });
}

// ============================================================================
// WORKER ENTRY POINT
// ============================================================================

if (!isMainThread && parentPort) {
  const data = workerData as TeammateWorkerData;
  runTeammateLoop(data).catch(err => {
    parentPort!.postMessage({
      type: "error",
      teammateId: data.teammateId,
      content: err.message || String(err),
    });
  });
}

// ============================================================================
// SPAWN TEAMMATE (from main thread)
// ============================================================================

export async function spawnTeammate(
  teamId: string,
  teammateId: string,
  teammateName: string,
  model: string,
  cwd: string,
  parentConversationId: string,
  teamName: string
): Promise<Worker> {
  const __filename = fileURLToPath(import.meta.url);
  const workerPath = __filename.replace(".js", ".js"); // Same file

  // Get auth token to pass to worker for telemetry
  const authToken = await getValidToken();

  const worker = new Worker(workerPath, {
    workerData: {
      teamId,
      teammateId,
      teammateName,
      model,
      cwd,
      parentConversationId,
      teamName,
      authToken: authToken || undefined,
    } as TeammateWorkerData,
  });

  return worker;
}
