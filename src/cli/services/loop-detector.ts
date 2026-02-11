/**
 * Loop Detector — Circuit breaker for repetitive tool calls
 *
 * Prevents agents from getting stuck in infinite loops by:
 * 1. Blocking identical tool calls after IDENTICAL_CALL_LIMIT repetitions
 * 2. Blocking tools that fail CONSECUTIVE_ERROR_LIMIT times in a row
 *
 * Uses SHA-256 hash of {name, ...input} in a sliding window.
 */

import { createHash } from "crypto";

export interface LoopCheckResult {
  blocked: boolean;
  reason?: string;
}

export class LoopDetector {
  private history: { name: string; inputHash: string }[] = [];
  private consecutiveErrors = new Map<string, number>();
  private turnErrors = 0;

  static IDENTICAL_CALL_LIMIT = 4;
  static CONSECUTIVE_ERROR_LIMIT = 3;
  static TURN_ERROR_LIMIT = 5;
  static WINDOW = 20;

  /**
   * Record a tool call and check if it should be blocked.
   * Call BEFORE executing the tool.
   */
  recordCall(name: string, input: Record<string, unknown>): LoopCheckResult {
    // Strategy-level circuit breaker: too many errors across ANY tools this turn
    if (this.turnErrors >= LoopDetector.TURN_ERROR_LIMIT) {
      return {
        blocked: true,
        reason: `${this.turnErrors} errors this turn. Stop and re-assess your approach. Read relevant files before retrying.`,
      };
    }

    const inputHash = createHash("sha256")
      .update(JSON.stringify({ name, ...input }))
      .digest("hex");

    // Check consecutive errors for this specific tool
    const errorCount = this.consecutiveErrors.get(name) || 0;
    if (errorCount >= LoopDetector.CONSECUTIVE_ERROR_LIMIT) {
      return {
        blocked: true,
        reason: `Tool "${name}" blocked: failed ${errorCount} times consecutively. Try a different approach.`,
      };
    }

    // Check identical calls in sliding window
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
   * Call AFTER executing the tool.
   */
  recordResult(name: string, success: boolean): void {
    if (success) {
      this.consecutiveErrors.delete(name);
    } else {
      const current = this.consecutiveErrors.get(name) || 0;
      this.consecutiveErrors.set(name, current + 1);
      this.turnErrors++;
    }
  }

  /**
   * Reset all tracking. Call on new user message.
   */
  reset(): void {
    this.history = [];
    this.consecutiveErrors.clear();
    this.turnErrors = 0;
  }
}
