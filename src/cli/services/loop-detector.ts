/**
 * Loop Detector — Circuit breaker for repetitive tool calls
 *
 * Two tiers of protection:
 * 1. Per-turn: blocks identical calls (4x) and consecutive errors (3x) within a turn
 * 2. Per-session: remembers failed strategies across turns, tracks total errors,
 *    and detects when the agent is stuck (consecutive failed turns)
 *
 * Uses SHA-256 hash of {name, ...input} in a sliding window.
 */

import { createHash } from "crypto";

export interface LoopCheckResult {
  blocked: boolean;
  reason?: string;
}

export interface BailCheckResult {
  shouldBail: boolean;
  message?: string;
}

export class LoopDetector {
  // Per-turn state (reset each turn)
  private history: { name: string; inputHash: string }[] = [];
  private consecutiveErrors = new Map<string, number>();
  private turnErrors = 0;
  private turnHadErrors = false;

  // Per-session state (persists across turns)
  private sessionErrors = new Map<string, number>();
  private failedStrategies = new Set<string>();
  private consecutiveFailedTurns = 0;
  private totalSessionErrors = 0;

  // Thresholds
  static IDENTICAL_CALL_LIMIT = 4;
  static CONSECUTIVE_ERROR_LIMIT = 3;
  static TURN_ERROR_LIMIT = 5;
  static WINDOW = 20;

  // Session-level thresholds
  static SESSION_TOOL_ERROR_LIMIT = 10;    // Per-tool errors across entire session
  static CONSECUTIVE_FAILED_TURN_LIMIT = 3; // Turns in a row with errors → bail

  /**
   * Record a tool call and check if it should be blocked.
   * Call BEFORE executing the tool.
   */
  recordCall(name: string, input: Record<string, unknown>): LoopCheckResult {
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ name, ...input }))
      .digest("hex");

    // SESSION-LEVEL: Block strategies that already failed in previous turns
    if (this.failedStrategies.has(inputHash)) {
      return {
        blocked: true,
        reason: `Blocked: this exact "${name}" call failed in a previous turn. You must try a fundamentally different approach — re-read the code, change your strategy, or ask the user for clarification.`,
      };
    }

    // SESSION-LEVEL: Tool has failed too many times across the session
    const sessionErrorCount = this.sessionErrors.get(name) || 0;
    if (sessionErrorCount >= LoopDetector.SESSION_TOOL_ERROR_LIMIT) {
      return {
        blocked: true,
        reason: `Tool "${name}" has failed ${sessionErrorCount} times this session. Stop using this tool and try a completely different approach.`,
      };
    }

    // TURN-LEVEL: Too many errors across ANY tools this turn
    if (this.turnErrors >= LoopDetector.TURN_ERROR_LIMIT) {
      return {
        blocked: true,
        reason: `${this.turnErrors} errors this turn. Stop and re-assess your approach. Read the error messages, re-read the relevant files, then try again.`,
      };
    }

    // TURN-LEVEL: Consecutive errors for this specific tool
    const errorCount = this.consecutiveErrors.get(name) || 0;
    if (errorCount >= LoopDetector.CONSECUTIVE_ERROR_LIMIT) {
      return {
        blocked: true,
        reason: `Tool "${name}" blocked: failed ${errorCount} times consecutively. Try a different approach.`,
      };
    }

    // TURN-LEVEL: Identical calls in sliding window
    const windowSlice = this.history.slice(-LoopDetector.WINDOW);
    const identicalCount = windowSlice.filter(h => h.inputHash === inputHash).length;

    if (identicalCount >= LoopDetector.IDENTICAL_CALL_LIMIT) {
      return {
        blocked: true,
        reason: `Tool "${name}" blocked: identical call made ${identicalCount} times in last ${LoopDetector.WINDOW} calls. Try a different approach or different parameters.`,
      };
    }

    // Record this call
    this.history.push({ name, inputHash });
    if (this.history.length > LoopDetector.WINDOW * 2) {
      this.history = this.history.slice(-LoopDetector.WINDOW);
    }

    return { blocked: false };
  }

  /**
   * Record the result of a tool execution.
   * Call AFTER executing the tool. Pass input to track failed strategies.
   */
  recordResult(name: string, success: boolean, input?: Record<string, unknown>): void {
    if (success) {
      this.consecutiveErrors.delete(name);
    } else {
      // Per-turn tracking
      const current = this.consecutiveErrors.get(name) || 0;
      this.consecutiveErrors.set(name, current + 1);
      this.turnErrors++;
      this.turnHadErrors = true;

      // Per-session tracking
      const sessionCount = this.sessionErrors.get(name) || 0;
      this.sessionErrors.set(name, sessionCount + 1);
      this.totalSessionErrors++;

      // Remember the exact failed strategy so it's blocked in future turns
      if (input) {
        const inputHash = createHash("sha256")
          .update(JSON.stringify({ name, ...input }))
          .digest("hex");
        this.failedStrategies.add(inputHash);
        // Cap the set to avoid unbounded memory growth
        if (this.failedStrategies.size > 200) {
          const arr = Array.from(this.failedStrategies);
          this.failedStrategies = new Set(arr.slice(-100));
        }
      }
    }
  }

  /**
   * Call at the end of each turn (after all tool results processed).
   * Tracks consecutive failed turns for bail-out detection.
   */
  endTurn(): BailCheckResult {
    if (this.turnHadErrors) {
      this.consecutiveFailedTurns++;
    } else {
      this.consecutiveFailedTurns = 0;
    }

    if (this.consecutiveFailedTurns >= LoopDetector.CONSECUTIVE_FAILED_TURN_LIMIT) {
      return {
        shouldBail: true,
        message: `You have had errors in ${this.consecutiveFailedTurns} consecutive turns (${this.totalSessionErrors} total errors this session). Your current approach is not working. STOP making edits and instead: 1) Re-read the error messages carefully, 2) Re-read the source files you're modifying, 3) Explain to the user what you've tried and what's failing, 4) Ask for guidance before proceeding.`,
      };
    }

    return { shouldBail: false };
  }

  /**
   * Reset per-turn state. Call at the start of each new iteration.
   * Preserves session-level state (failed strategies, session errors).
   */
  resetTurn(): void {
    this.history = [];
    this.consecutiveErrors.clear();
    this.turnErrors = 0;
    this.turnHadErrors = false;
  }

  /**
   * Full reset — new conversation. Clears everything.
   */
  reset(): void {
    this.history = [];
    this.consecutiveErrors.clear();
    this.turnErrors = 0;
    this.turnHadErrors = false;
    this.sessionErrors.clear();
    this.failedStrategies.clear();
    this.consecutiveFailedTurns = 0;
    this.totalSessionErrors = 0;
  }

  /** Get session error stats for telemetry */
  getSessionStats(): { totalErrors: number; failedStrategies: number; consecutiveFailedTurns: number } {
    return {
      totalErrors: this.totalSessionErrors,
      failedStrategies: this.failedStrategies.size,
      consecutiveFailedTurns: this.consecutiveFailedTurns,
    };
  }
}
