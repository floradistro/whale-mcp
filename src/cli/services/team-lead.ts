/**
 * Team Lead — Coordinator for Agent Teams
 *
 * Following Anthropic's official patterns:
 * - Spawns and manages teammates
 * - Creates and assigns tasks
 * - Monitors progress
 * - Synthesizes results
 */

import { Worker } from "worker_threads";
import { EventEmitter } from "events";
import {
  TeamState,
  TeamTask,
  TeammateInfo,
  createTeam,
  loadTeam,
  saveTeam,
  addTeammate,
  addTask,
  getTeamProgress,
  setTeamStatus,
  sendMessage,
  getUnreadMessages,
  markMessagesRead,
  failTask,
  updateTeammate,
} from "./team-state.js";
import { spawnTeammate, TeammateMessage } from "./teammate.js";
import { logSpan, generateTraceId, generateSpanId, createTurnContext, getConversationId } from "./telemetry.js";
import { resolveConfig } from "./config-store.js";
import { getGlobalEmitter } from "./agent-events.js";
import { getModelShortName } from "./agent-loop.js";

// ============================================================================
// TYPES
// ============================================================================

export interface TeamConfig {
  name: string;
  teammateCount: number;
  model?: "sonnet" | "opus" | "haiku";
  tasks: Array<{
    description: string;
    files?: string[];
    dependencies?: string[];  // Task descriptions (matched to IDs after creation)
  }>;
  // Optional teammate names/roles - if not provided, names are generated from tasks
  teammateNames?: string[];
}

export interface TeamResult {
  success: boolean;
  teamId: string;
  summary: string;
  taskResults: Array<{
    description: string;
    result: string;
    status: "completed" | "failed";
  }>;
  tokensUsed: { input: number; output: number };
  durationMs: number;
}

// ============================================================================
// TEAM LEAD CLASS
// ============================================================================

const TEAM_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min total
const WORKER_STALL_MS = 2 * 60 * 1000;   // 2 min no messages

export class TeamLead extends EventEmitter {
  private teamId: string | null = null;
  private workers: Map<string, Worker> = new Map();
  private lastMessageTime: Map<string, number> = new Map();
  private teamTimer: ReturnType<typeof setTimeout> | null = null;
  private stallInterval: ReturnType<typeof setInterval> | null = null;
  private resolveTeam: ((result: TeamResult) => void) | null = null;
  private traceId: string;
  private spanId: string;
  private startTime: number = 0;

  constructor() {
    super();
    this.traceId = generateTraceId();
    this.spanId = generateSpanId();
  }

  /**
   * Generate meaningful teammate names from task descriptions
   * Extracts key action words to create role-based names
   */
  private generateTeammateNames(tasks: TeamConfig["tasks"], count: number): string[] {
    const roles = [
      "Researcher", "Analyst", "Writer", "Reviewer",
      "Coordinator", "Specialist", "Explorer", "Synthesizer"
    ];

    // Extract keywords from task descriptions
    const names: string[] = [];
    const usedRoles = new Set<string>();

    for (let i = 0; i < count; i++) {
      if (i < tasks.length) {
        const desc = tasks[i].description.toLowerCase();

        // Match task keywords to roles
        let role: string;
        if (desc.includes("research") || desc.includes("search") || desc.includes("find")) {
          role = "Researcher";
        } else if (desc.includes("analyze") || desc.includes("analysis") || desc.includes("review")) {
          role = "Analyst";
        } else if (desc.includes("write") || desc.includes("create") || desc.includes("draft")) {
          role = "Writer";
        } else if (desc.includes("compile") || desc.includes("combine") || desc.includes("synthesize")) {
          role = "Synthesizer";
        } else if (desc.includes("explore") || desc.includes("investigate")) {
          role = "Explorer";
        } else {
          // Use a generic role
          role = roles[i % roles.length];
        }

        // Avoid duplicate names by adding number if needed
        if (usedRoles.has(role)) {
          let suffix = 2;
          while (usedRoles.has(`${role} ${suffix}`)) suffix++;
          role = `${role} ${suffix}`;
        }
        usedRoles.add(role);
        names.push(role);
      } else {
        // More teammates than tasks - use generic names
        names.push(roles[i % roles.length]);
      }
    }

    return names;
  }

  // ============================================================================
  // TEAM CREATION
  // ============================================================================

  async createTeam(config: TeamConfig): Promise<string> {
    this.startTime = Date.now();
    const cwd = process.cwd();

    // Create team
    const team = createTeam(config.name, "lead");
    this.teamId = team.id;

    this.emit("team_created", { teamId: team.id, name: config.name });

    // Emit to global emitter for UI
    const emitter = getGlobalEmitter();
    emitter.emitTeamStart(team.id, config.name, config.teammateCount, config.tasks.length);

    // Log team creation
    logSpan({
      action: "team.create",
      durationMs: 0,
      context: {
        traceId: this.traceId,
        spanId: this.spanId,
        conversationId: getConversationId(),
        source: "claude_code",
        serviceName: "whale-cli",
        serviceVersion: "2.1.0",
      },
      storeId: resolveConfig().storeId || undefined,
      details: {
        // Team identification (for blackops detection)
        is_team: true,
        is_team_coordinator: true,
        team_id: team.id,
        team_name: config.name,
        teammate_count: config.teammateCount,
        task_count: config.tasks.length,
        model: config.model || getModelShortName(),
        // Display metadata
        display_name: `Team: ${config.name}`,
        display_icon: "person.3.fill",
        display_color: "#10B981",
      },
    });

    // Create tasks
    const taskIdMap = new Map<string, string>(); // description -> id
    for (const taskConfig of config.tasks) {
      const task = await addTask(team.id, {
        description: taskConfig.description,
        files: taskConfig.files,
      });

      if (task) {
        taskIdMap.set(taskConfig.description, task.id);
        this.emit("task_created", { taskId: task.id, description: taskConfig.description });
      }
    }

    // Set up dependencies (now that we have IDs)
    const freshTeam = loadTeam(team.id)!;
    for (const taskConfig of config.tasks) {
      if (taskConfig.dependencies?.length) {
        const task = freshTeam.tasks.find(t => t.description === taskConfig.description);
        if (task) {
          task.dependencies = taskConfig.dependencies
            .map(dep => taskIdMap.get(dep))
            .filter(Boolean) as string[];
        }
      }
    }
    saveTeam(freshTeam);

    // Create teammates with meaningful names
    const model = config.model || getModelShortName();

    // Generate teammate names from tasks if not provided
    const teammateNames = config.teammateNames || this.generateTeammateNames(config.tasks, config.teammateCount);

    for (let i = 0; i < config.teammateCount; i++) {
      const name = teammateNames[i] || `Agent ${i + 1}`;
      const id = `teammate-${i + 1}-${Date.now()}`;

      await addTeammate(team.id, {
        id,
        name,
        model,
        status: "idle",
      });

      this.emit("teammate_created", { teammateId: id, name });
    }

    return team.id;
  }

  // ============================================================================
  // TEAM EXECUTION
  // ============================================================================

  async runTeam(): Promise<TeamResult> {
    if (!this.teamId) {
      throw new Error("No team created. Call createTeam first.");
    }

    const team = loadTeam(this.teamId)!;
    const cwd = process.cwd();

    this.emit("team_started", { teamId: this.teamId, teammateCount: team.teammates.length });

    // Spawn worker threads for each teammate
    const parentConversationId = getConversationId();
    for (const teammate of team.teammates) {
      const worker = await spawnTeammate(
        this.teamId,
        teammate.id,
        teammate.name,
        teammate.model,
        cwd,
        parentConversationId,
        team.name
      );

      this.lastMessageTime.set(teammate.id, Date.now());

      // Handle messages from worker
      worker.on("message", (msg: TeammateMessage) => {
        this.lastMessageTime.set(msg.teammateId, Date.now());
        this.handleTeammateMessage(msg);
      });

      worker.on("error", (err) => {
        this.emit("teammate_error", { teammateId: teammate.id, error: err.message });
        // Fail any in-progress task when worker crashes
        this.handleTeammateFailure(teammate.id, err.message);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          this.emit("teammate_exit", { teammateId: teammate.id, code });
          // Fail any in-progress task on non-zero exit
          this.handleTeammateFailure(teammate.id, `Worker exited with code ${code}`);
        }
        this.workers.delete(teammate.id);
        this.checkCompletion();
      });

      this.workers.set(teammate.id, worker);
    }

    // Wait for all workers to complete — with timeout and stall detection
    return new Promise((resolve) => {
      this.resolveTeam = resolve;

      const cleanup = () => {
        if (this.teamTimer) { clearTimeout(this.teamTimer); this.teamTimer = null; }
        if (this.stallInterval) { clearInterval(this.stallInterval); this.stallInterval = null; }
      };

      const forceComplete = (reason: string) => {
        cleanup();
        this.resolveTeam = null; // Prevent double-resolve from checkCompletion
        // Terminate all remaining workers
        for (const [id, worker] of this.workers) {
          this.emit("teammate_timeout", { teammateId: id, reason });
          this.handleTeammateFailure(id, `Terminated: ${reason}`);
          worker.terminate();
        }
        this.workers.clear();
        if (this.teamId) setTeamStatus(this.teamId, "completed");
        resolve(this.buildResult());
      };

      // Global team timeout
      this.teamTimer = setTimeout(() => {
        if (this.workers.size > 0) {
          forceComplete(`Team timeout after ${TEAM_TIMEOUT_MS / 1000}s`);
        }
      }, TEAM_TIMEOUT_MS);

      // Stall detection — check every 15s for stalled workers
      this.stallInterval = setInterval(() => {
        if (this.workers.size === 0) {
          cleanup();
          return;
        }

        const now = Date.now();
        for (const [id, worker] of this.workers) {
          const lastMsg = this.lastMessageTime.get(id) || 0;
          if (now - lastMsg > WORKER_STALL_MS) {
            this.emit("teammate_timeout", { teammateId: id, reason: "stall" });
            this.handleTeammateFailure(id, `Worker stalled (no messages for ${WORKER_STALL_MS / 1000}s)`);
            worker.terminate();
            this.workers.delete(id);
          }
        }
      }, 15_000);
    });
  }

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================

  private handleTeammateMessage(msg: TeammateMessage): void {
    const emitter = getGlobalEmitter();
    const team = this.teamId ? loadTeam(this.teamId) : null;
    const teammate = team?.teammates.find(t => t.id === msg.teammateId);
    const teammateName = teammate?.name || msg.teammateId;

    switch (msg.type) {
      case "progress":
        this.emit("teammate_progress", {
          teammateId: msg.teammateId,
          taskId: msg.taskId,
          content: msg.content,
        });
        // Emit to global emitter for UI
        if (this.teamId) {
          emitter.emitTeamProgress(this.teamId, msg.teammateId, teammateName, msg.content, msg.taskId);
        }
        break;

      case "task_started":
        this.emit("task_started", {
          teammateId: msg.teammateId,
          taskId: msg.taskId,
          content: msg.content,
        });
        // Emit to global emitter for UI
        if (this.teamId && msg.taskId) {
          emitter.emitTeamTask(this.teamId, msg.teammateId, msg.taskId, msg.content, "started");
        }
        break;

      case "task_completed":
        this.emit("task_completed", {
          teammateId: msg.teammateId,
          taskId: msg.taskId,
          content: msg.content,
        });
        // Emit to global emitter for UI
        if (this.teamId && msg.taskId) {
          emitter.emitTeamTask(this.teamId, msg.teammateId, msg.taskId, msg.content, "completed", msg.content);
        }
        break;

      case "message_sent":
        this.emit("message_sent", {
          teammateId: msg.teammateId,
          content: msg.content,
        });
        break;

      case "done":
        this.emit("teammate_done", {
          teammateId: msg.teammateId,
          content: msg.content,
          tokensUsed: msg.tokensUsed,
        });
        break;

      case "error":
        this.emit("teammate_error", {
          teammateId: msg.teammateId,
          content: msg.content,
        });
        // Fail any in-progress task when teammate reports error
        this.handleTeammateFailure(msg.teammateId, msg.content);
        break;
    }
  }

  // ============================================================================
  // FAILURE HANDLING
  // ============================================================================

  private async handleTeammateFailure(teammateId: string, errorMessage: string): Promise<void> {
    if (!this.teamId) return;

    const team = loadTeam(this.teamId);
    if (!team) return;

    const teammate = team.teammates.find(t => t.id === teammateId);
    if (!teammate) return;

    // Find and fail the task this teammate was working on
    const inProgressTask = team.tasks.find(
      t => t.status === "in_progress" && t.assignedTo === teammateId
    );

    if (inProgressTask) {
      await failTask(this.teamId, inProgressTask.id, errorMessage);
      this.emit("task_failed", {
        teammateId,
        taskId: inProgressTask.id,
        error: errorMessage,
      });

      // Emit to global emitter for UI
      const emitter = getGlobalEmitter();
      emitter.emitTeamTask(
        this.teamId,
        teammateId,
        inProgressTask.id,
        inProgressTask.description,
        "failed",
        errorMessage
      );
    }

    // Update teammate status (use "done" since "error" isn't a valid status)
    await updateTeammate(this.teamId, teammateId, {
      status: "done",
      currentTask: undefined,
    });
  }

  // ============================================================================
  // COMPLETION
  // ============================================================================

  private checkCompletion(): void {
    if (this.workers.size === 0 && this.teamId) {
      // Clean up timers
      if (this.teamTimer) { clearTimeout(this.teamTimer); this.teamTimer = null; }
      if (this.stallInterval) { clearInterval(this.stallInterval); this.stallInterval = null; }
      setTeamStatus(this.teamId, "completed");
      this.emit("team_completed", { teamId: this.teamId });
      // Resolve the runTeam() promise
      if (this.resolveTeam) {
        this.resolveTeam(this.buildResult());
        this.resolveTeam = null;
      }
    }
  }

  private buildResult(): TeamResult {
    if (!this.teamId) {
      return {
        success: false,
        teamId: "",
        summary: "No team created",
        taskResults: [],
        tokensUsed: { input: 0, output: 0 },
        durationMs: Date.now() - this.startTime,
      };
    }

    const team = loadTeam(this.teamId)!;
    const progress = getTeamProgress(team);

    // Calculate total tokens
    let totalIn = 0;
    let totalOut = 0;
    for (const teammate of team.teammates) {
      totalIn += teammate.tokensUsed.input;
      totalOut += teammate.tokensUsed.output;
    }

    // Build task results
    const taskResults = team.tasks.map(t => ({
      description: t.description,
      result: t.result || t.error || "Not completed",
      status: t.status === "completed" ? "completed" as const : "failed" as const,
    }));

    const durationMs = Date.now() - this.startTime;
    const success = progress.blocked === 0 && progress.completed === progress.total;

    // Log team completion
    logSpan({
      action: "team.complete",
      durationMs,
      context: {
        traceId: this.traceId,
        spanId: generateSpanId(),
        parentSpanId: this.spanId,
        source: "claude_code",
        serviceName: "whale-cli",
        serviceVersion: "2.1.0",
        inputTokens: totalIn,
        outputTokens: totalOut,
      },
      storeId: resolveConfig().storeId || undefined,
      details: {
        // Team identification (for blackops detection)
        is_team: true,
        is_team_coordinator: true,
        team_id: this.teamId,
        team_name: team.name,
        // Metrics
        tasks_total: progress.total,
        tasks_completed: progress.completed,
        tasks_failed: progress.blocked,
        teammates: team.teammates.length,
        percent_complete: progress.percentComplete,
        // Display metadata
        display_name: `Team Complete: ${team.name}`,
        display_icon: "checkmark.circle.fill",
        display_color: success ? "#10B981" : "#EF4444",
      },
    });

    // Emit team done to global emitter for UI
    const emitter = getGlobalEmitter();
    emitter.emitTeamDone(
      this.teamId,
      success,
      `${progress.completed}/${progress.total} tasks completed`,
      progress.completed,
      progress.total,
      { input: totalIn, output: totalOut },
      durationMs
    );

    return {
      success,
      teamId: this.teamId,
      summary: `${progress.completed}/${progress.total} tasks completed (${progress.percentComplete}%)`,
      taskResults,
      tokensUsed: { input: totalIn, output: totalOut },
      durationMs,
    };
  }

  // ============================================================================
  // CONTROL METHODS
  // ============================================================================

  async sendToTeammate(teammateId: string, message: string): Promise<boolean> {
    if (!this.teamId) return false;
    const result = await sendMessage(this.teamId, "lead", teammateId, message);
    return !!result;
  }

  async broadcast(message: string): Promise<boolean> {
    if (!this.teamId) return false;
    const result = await sendMessage(this.teamId, "lead", "all", message);
    return !!result;
  }

  async getMessages(): Promise<Array<{ from: string; content: string }>> {
    if (!this.teamId) return [];
    const messages = await getUnreadMessages(this.teamId, "lead");
    if (messages.length > 0) {
      await markMessagesRead(this.teamId, messages.map(m => m.id));
    }
    return messages.map(m => ({ from: m.from, content: m.content }));
  }

  getProgress(): { total: number; completed: number; percentComplete: number } | null {
    if (!this.teamId) return null;
    const team = loadTeam(this.teamId);
    if (!team) return null;
    return getTeamProgress(team);
  }

  stop(): void {
    // Terminate all workers
    for (const [id, worker] of this.workers) {
      worker.terminate();
      this.emit("teammate_stopped", { teammateId: id });
    }
    this.workers.clear();

    if (this.teamId) {
      setTeamStatus(this.teamId, "failed");
    }
  }
}

// ============================================================================
// CONVENIENCE FUNCTION
// ============================================================================

export async function runAgentTeam(config: TeamConfig): Promise<TeamResult> {
  const lead = new TeamLead();
  // Events are handled via global emitter -> ChatApp UI
  // No stderr writes here to avoid interfering with Ink rendering
  await lead.createTeam(config);
  return lead.runTeam();
}
