/**
 * Team State — Shared state management for Agent Teams
 *
 * Following Anthropic's official patterns:
 * - Shared task list with status tracking
 * - File-based locking to prevent conflicts
 * - Inter-agent message queue
 * - Dependencies between tasks
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================================================
// TYPES
// ============================================================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface TeamTask {
  id: string;
  description: string;
  status: TaskStatus;
  assignedTo?: string;        // Teammate ID
  dependencies?: string[];    // Task IDs that must complete first
  files?: string[];           // Files this task will modify (for conflict detection)
  result?: string;            // Output when completed
  error?: string;             // Error if failed
  createdAt: string;
  updatedAt: string;
}

export interface TeamMessage {
  id: string;
  from: string;               // Teammate ID or "lead"
  to: string;                 // Teammate ID, "lead", or "all" for broadcast
  content: string;
  timestamp: string;
  read: boolean;
}

export interface TeammateInfo {
  id: string;
  name: string;
  model: string;
  status: "idle" | "working" | "waiting" | "done";
  currentTask?: string;       // Task ID
  tokensUsed: { input: number; output: number };
  startedAt: string;
}

export interface TeamState {
  id: string;
  name: string;
  leadId: string;
  teammates: TeammateInfo[];
  tasks: TeamTask[];
  messages: TeamMessage[];
  createdAt: string;
  updatedAt: string;
  status: "active" | "completed" | "failed";
}

// ============================================================================
// STORAGE
// ============================================================================

const TEAMS_DIR = join(homedir(), ".swagmanager", "teams");

function ensureTeamsDir(): void {
  if (!existsSync(TEAMS_DIR)) {
    mkdirSync(TEAMS_DIR, { recursive: true });
  }
}

function getTeamPath(teamId: string): string {
  return join(TEAMS_DIR, `${teamId}.json`);
}

function getLockPath(teamId: string): string {
  return join(TEAMS_DIR, `${teamId}.lock`);
}

// ============================================================================
// FILE LOCKING — Prevents concurrent modifications
// ============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

async function acquireLock(teamId: string): Promise<boolean> {
  const lockPath = getLockPath(teamId);
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Check if lock exists and is stale
      if (existsSync(lockPath)) {
        const lockData = readFileSync(lockPath, "utf-8");
        const lockTime = parseInt(lockData, 10);
        if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
          // Stale lock, remove it
          unlinkSync(lockPath);
        } else {
          // Valid lock, wait and retry
          await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
          continue;
        }
      }

      // Try to create lock
      writeFileSync(lockPath, Date.now().toString(), { flag: "wx" });
      return true;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Lock was created by another process, retry
        await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
        continue;
      }
      throw err;
    }
  }

  return false;
}

function releaseLock(teamId: string): void {
  const lockPath = getLockPath(teamId);
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Ignore errors releasing lock
  }
}

// ============================================================================
// STATE OPERATIONS
// ============================================================================

export function createTeam(name: string, leadId: string): TeamState {
  ensureTeamsDir();

  const team: TeamState = {
    id: `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    leadId,
    teammates: [],
    tasks: [],
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  };

  saveTeam(team);
  return team;
}

export function loadTeam(teamId: string): TeamState | null {
  const path = getTeamPath(teamId);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveTeam(team: TeamState): void {
  ensureTeamsDir();
  team.updatedAt = new Date().toISOString();
  writeFileSync(getTeamPath(team.id), JSON.stringify(team, null, 2));
}

export function listTeams(): TeamState[] {
  ensureTeamsDir();
  const files = existsSync(TEAMS_DIR)
    ? require("fs").readdirSync(TEAMS_DIR).filter((f: string) => f.endsWith(".json") && !f.endsWith(".lock"))
    : [];

  return files.map((f: string) => {
    try {
      return JSON.parse(readFileSync(join(TEAMS_DIR, f), "utf-8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ============================================================================
// TEAMMATE MANAGEMENT
// ============================================================================

export async function addTeammate(
  teamId: string,
  teammate: Omit<TeammateInfo, "tokensUsed" | "startedAt">
): Promise<TeammateInfo | null> {
  if (!await acquireLock(teamId)) {
    return null;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return null;

    const newTeammate: TeammateInfo = {
      ...teammate,
      tokensUsed: { input: 0, output: 0 },
      startedAt: new Date().toISOString(),
    };

    team.teammates.push(newTeammate);
    saveTeam(team);
    return newTeammate;
  } finally {
    releaseLock(teamId);
  }
}

export async function updateTeammate(
  teamId: string,
  teammateId: string,
  updates: Partial<TeammateInfo>
): Promise<boolean> {
  if (!await acquireLock(teamId)) {
    return false;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return false;

    const idx = team.teammates.findIndex(t => t.id === teammateId);
    if (idx === -1) return false;

    team.teammates[idx] = { ...team.teammates[idx], ...updates };
    saveTeam(team);
    return true;
  } finally {
    releaseLock(teamId);
  }
}

// ============================================================================
// TASK MANAGEMENT
// ============================================================================

export async function addTask(
  teamId: string,
  task: Omit<TeamTask, "id" | "status" | "createdAt" | "updatedAt">
): Promise<TeamTask | null> {
  if (!await acquireLock(teamId)) {
    return null;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return null;

    const newTask: TeamTask = {
      ...task,
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    team.tasks.push(newTask);
    saveTeam(team);
    return newTask;
  } finally {
    releaseLock(teamId);
  }
}

export async function claimTask(
  teamId: string,
  taskId: string,
  teammateId: string
): Promise<TeamTask | null> {
  if (!await acquireLock(teamId)) {
    return null;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return null;

    const task = team.tasks.find(t => t.id === taskId);
    if (!task) return null;

    // Check if task is claimable
    if (task.status !== "pending") {
      return null; // Already claimed or completed
    }

    // Check dependencies
    if (task.dependencies?.length) {
      const allDepsComplete = task.dependencies.every(depId => {
        const dep = team.tasks.find(t => t.id === depId);
        return dep?.status === "completed";
      });
      if (!allDepsComplete) {
        return null; // Dependencies not met
      }
    }

    // Check for file conflicts with other in-progress tasks
    if (task.files?.length) {
      const conflicts = team.tasks.filter(t =>
        t.status === "in_progress" &&
        t.id !== taskId &&
        t.files?.some(f => task.files?.includes(f))
      );
      if (conflicts.length > 0) {
        return null; // File conflict
      }
    }

    // Claim the task
    task.status = "in_progress";
    task.assignedTo = teammateId;
    task.updatedAt = new Date().toISOString();

    saveTeam(team);
    return task;
  } finally {
    releaseLock(teamId);
  }
}

export async function completeTask(
  teamId: string,
  taskId: string,
  result: string
): Promise<boolean> {
  if (!await acquireLock(teamId)) {
    return false;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return false;

    const task = team.tasks.find(t => t.id === taskId);
    if (!task) return false;

    task.status = "completed";
    task.result = result;
    task.updatedAt = new Date().toISOString();

    // Check if all tasks are done
    const allDone = team.tasks.every(t => t.status === "completed");
    if (allDone) {
      team.status = "completed";
    }

    saveTeam(team);
    return true;
  } finally {
    releaseLock(teamId);
  }
}

export async function failTask(
  teamId: string,
  taskId: string,
  error: string
): Promise<boolean> {
  if (!await acquireLock(teamId)) {
    return false;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return false;

    const task = team.tasks.find(t => t.id === taskId);
    if (!task) return false;

    task.status = "blocked";
    task.error = error;
    task.updatedAt = new Date().toISOString();

    saveTeam(team);
    return true;
  } finally {
    releaseLock(teamId);
  }
}

export function getAvailableTasks(team: TeamState): TeamTask[] {
  return team.tasks.filter(task => {
    if (task.status !== "pending") return false;

    // Check dependencies
    if (task.dependencies?.length) {
      const allDepsComplete = task.dependencies.every(depId => {
        const dep = team.tasks.find(t => t.id === depId);
        return dep?.status === "completed";
      });
      if (!allDepsComplete) return false;
    }

    // Check file conflicts
    if (task.files?.length) {
      const conflicts = team.tasks.filter(t =>
        t.status === "in_progress" &&
        t.files?.some(f => task.files?.includes(f))
      );
      if (conflicts.length > 0) return false;
    }

    return true;
  });
}

// ============================================================================
// MESSAGING
// ============================================================================

export async function sendMessage(
  teamId: string,
  from: string,
  to: string,
  content: string
): Promise<TeamMessage | null> {
  if (!await acquireLock(teamId)) {
    return null;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return null;

    const message: TeamMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      read: false,
    };

    team.messages.push(message);
    saveTeam(team);
    return message;
  } finally {
    releaseLock(teamId);
  }
}

export async function getUnreadMessages(
  teamId: string,
  recipientId: string
): Promise<TeamMessage[]> {
  const team = loadTeam(teamId);
  if (!team) return [];

  return team.messages.filter(m =>
    !m.read &&
    (m.to === recipientId || m.to === "all")
  );
}

export async function markMessagesRead(
  teamId: string,
  messageIds: string[]
): Promise<boolean> {
  if (!await acquireLock(teamId)) {
    return false;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return false;

    for (const msg of team.messages) {
      if (messageIds.includes(msg.id)) {
        msg.read = true;
      }
    }

    saveTeam(team);
    return true;
  } finally {
    releaseLock(teamId);
  }
}

// ============================================================================
// TEAM STATUS
// ============================================================================

export function getTeamProgress(team: TeamState): {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  blocked: number;
  percentComplete: number;
} {
  const total = team.tasks.length;
  const completed = team.tasks.filter(t => t.status === "completed").length;
  const inProgress = team.tasks.filter(t => t.status === "in_progress").length;
  const pending = team.tasks.filter(t => t.status === "pending").length;
  const blocked = team.tasks.filter(t => t.status === "blocked").length;

  return {
    total,
    completed,
    inProgress,
    pending,
    blocked,
    percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
  };
}

export async function setTeamStatus(
  teamId: string,
  status: TeamState["status"]
): Promise<boolean> {
  if (!await acquireLock(teamId)) {
    return false;
  }

  try {
    const team = loadTeam(teamId);
    if (!team) return false;

    team.status = status;
    saveTeam(team);
    return true;
  } finally {
    releaseLock(teamId);
  }
}
