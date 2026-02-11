/**
 * Agent Event System — decoupled event-driven architecture for smooth UI
 *
 * The agent loop emits typed events; the UI subscribes and renders.
 * This prevents tight coupling and enables proper batching.
 */

import { EventEmitter } from "events";
import type Anthropic from "@anthropic-ai/sdk";

// ============================================================================
// EVENT TYPES
// ============================================================================

export interface AgentTextEvent {
  type: "text";
  text: string;
  accumulated: string;
}

export interface AgentToolStartEvent {
  type: "tool_start";
  id: string;
  name: string;
}

export interface AgentToolEndEvent {
  type: "tool_end";
  id: string;
  name: string;
  success: boolean;
  result?: string;
  input?: Record<string, unknown>;
  durationMs: number;
}

export interface AgentUsageEvent {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
}

export interface AgentDoneEvent {
  type: "done";
  text: string;
  messages: Anthropic.MessageParam[];
}

export interface AgentErrorEvent {
  type: "error";
  error: string;
}

export interface AgentCompactEvent {
  type: "compact";
  before: number;
  after: number;
  tokensSaved: number;
}

export interface ToolOutputEvent {
  type: "tool_output";
  toolName: string;
  line: string;
}

export interface SubagentStartEvent {
  type: "subagent_start";
  id: string;
  agentType: string;
  model: string;
  description: string;
}

export interface SubagentProgressEvent {
  type: "subagent_progress";
  id: string;
  agentType: string;
  message: string;
  turn?: number;
  toolName?: string;
}

export interface SubagentDoneEvent {
  type: "subagent_done";
  id: string;
  agentType: string;
  success: boolean;
  output: string;
  tokens: { input: number; output: number };
  tools: string[];
  durationMs: number;
}

export interface SubagentToolStartEvent {
  type: "subagent_tool_start";
  agentId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}

export interface SubagentToolEndEvent {
  type: "subagent_tool_end";
  agentId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
}

// ============================================================================
// TEAM EVENTS
// ============================================================================

export interface TeamStartEvent {
  type: "team_start";
  teamId: string;
  name: string;
  teammateCount: number;
  taskCount: number;
}

export interface TeamProgressEvent {
  type: "team_progress";
  teamId: string;
  teammateId: string;
  teammateName: string;
  message: string;
  taskId?: string;
}

export interface TeamTaskEvent {
  type: "team_task";
  teamId: string;
  teammateId: string;
  taskId: string;
  taskDescription: string;
  status: "started" | "completed" | "failed";
  result?: string;
}

export interface TeamDoneEvent {
  type: "team_done";
  teamId: string;
  success: boolean;
  summary: string;
  tasksCompleted: number;
  tasksTotal: number;
  tokens: { input: number; output: number };
  durationMs: number;
}

export type AgentEvent =
  | AgentTextEvent
  | AgentToolStartEvent
  | AgentToolEndEvent
  | AgentUsageEvent
  | AgentDoneEvent
  | AgentErrorEvent
  | AgentCompactEvent
  | ToolOutputEvent
  | SubagentStartEvent
  | SubagentProgressEvent
  | SubagentDoneEvent
  | SubagentToolStartEvent
  | SubagentToolEndEvent
  | TeamStartEvent
  | TeamProgressEvent
  | TeamTaskEvent
  | TeamDoneEvent;

// ============================================================================
// TYPED EVENT EMITTER
// ============================================================================

export class AgentEventEmitter extends EventEmitter {
  /**
   * Emit text immediately — UI-side handles batching via single flush timer
   */
  emitText(text: string): void {
    this.emit("event", {
      type: "text",
      text,
      accumulated: "", // Set by consumer
    } as AgentTextEvent);
  }

  /**
   * No-op — kept for interface compat
   */
  flushText(): void {}

  emitToolStart(id: string, name: string): void {
    this.flushText(); // Flush pending text before tool
    this.emit("event", { type: "tool_start", id, name } as AgentToolStartEvent);
  }

  emitToolEnd(
    id: string,
    name: string,
    success: boolean,
    result: string | undefined,
    input: Record<string, unknown> | undefined,
    durationMs: number
  ): void {
    this.emit("event", {
      type: "tool_end",
      id,
      name,
      success,
      result,
      input,
      durationMs,
    } as AgentToolEndEvent);
  }

  emitUsage(inputTokens: number, outputTokens: number): void {
    this.emit("event", { type: "usage", inputTokens, outputTokens } as AgentUsageEvent);
  }

  emitDone(text: string, messages: Anthropic.MessageParam[]): void {
    this.flushText();
    this.emit("event", { type: "done", text, messages } as AgentDoneEvent);
  }

  emitError(error: string): void {
    this.flushText();
    this.emit("event", { type: "error", error } as AgentErrorEvent);
  }

  emitCompact(before: number, after: number, tokensSaved: number): void {
    this.emit("event", { type: "compact", before, after, tokensSaved } as AgentCompactEvent);
  }

  emitToolOutput(toolName: string, line: string): void {
    this.emit("event", { type: "tool_output", toolName, line } as ToolOutputEvent);
  }

  emitSubagentStart(id: string, agentType: string, model: string, description: string): void {
    this.emit("event", { type: "subagent_start", id, agentType, model, description } as SubagentStartEvent);
  }

  emitSubagentProgress(id: string, agentType: string, message: string, turn?: number, toolName?: string): void {
    this.emit("event", {
      type: "subagent_progress",
      id,
      agentType,
      message,
      turn,
      toolName,
    } as SubagentProgressEvent);
  }

  emitSubagentDone(
    id: string,
    agentType: string,
    success: boolean,
    output: string,
    tokens: { input: number; output: number },
    tools: string[],
    durationMs: number
  ): void {
    this.emit("event", {
      type: "subagent_done",
      id,
      agentType,
      success,
      output,
      tokens,
      tools,
      durationMs,
    } as SubagentDoneEvent);
  }

  emitSubagentToolStart(agentId: string, toolName: string, toolInput?: Record<string, unknown>): void {
    this.emit("event", {
      type: "subagent_tool_start",
      agentId,
      toolName,
      toolInput,
    } as SubagentToolStartEvent);
  }

  emitSubagentToolEnd(agentId: string, toolName: string, success: boolean, durationMs: number): void {
    this.emit("event", {
      type: "subagent_tool_end",
      agentId,
      toolName,
      success,
      durationMs,
    } as SubagentToolEndEvent);
  }

  // ── Team Events ──

  emitTeamStart(teamId: string, name: string, teammateCount: number, taskCount: number): void {
    this.emit("event", {
      type: "team_start",
      teamId,
      name,
      teammateCount,
      taskCount,
    } as TeamStartEvent);
  }

  emitTeamProgress(teamId: string, teammateId: string, teammateName: string, message: string, taskId?: string): void {
    this.emit("event", {
      type: "team_progress",
      teamId,
      teammateId,
      teammateName,
      message,
      taskId,
    } as TeamProgressEvent);
  }

  emitTeamTask(
    teamId: string,
    teammateId: string,
    taskId: string,
    taskDescription: string,
    status: "started" | "completed" | "failed",
    result?: string
  ): void {
    this.emit("event", {
      type: "team_task",
      teamId,
      teammateId,
      taskId,
      taskDescription,
      status,
      result,
    } as TeamTaskEvent);
  }

  emitTeamDone(
    teamId: string,
    success: boolean,
    summary: string,
    tasksCompleted: number,
    tasksTotal: number,
    tokens: { input: number; output: number },
    durationMs: number
  ): void {
    this.emit("event", {
      type: "team_done",
      teamId,
      success,
      summary,
      tasksCompleted,
      tasksTotal,
      tokens,
      durationMs,
    } as TeamDoneEvent);
  }

  /**
   * Subscribe to events with typed handler
   */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.on("event", handler);
    return () => this.off("event", handler);
  }

  /**
   * Clean up
   */
  destroy(): void {
    this.removeAllListeners();
  }
}

// ============================================================================
// GLOBAL EMITTER (for subagents to report progress)
// ============================================================================

let globalEmitter: AgentEventEmitter | null = null;

export function getGlobalEmitter(): AgentEventEmitter {
  if (!globalEmitter) {
    globalEmitter = new AgentEventEmitter();
  }
  return globalEmitter;
}

export function setGlobalEmitter(emitter: AgentEventEmitter): void {
  globalEmitter = emitter;
}

export function clearGlobalEmitter(): void {
  if (globalEmitter) {
    globalEmitter.destroy();
    globalEmitter = null;
  }
}
