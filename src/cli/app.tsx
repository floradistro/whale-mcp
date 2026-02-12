/**
 * CLI App Entry Point
 *
 * Dynamic imports for each mode — keeps MCP server path clean.
 */

import React from "react";
import { render } from "ink";

// ============================================================================
// CHAT OPTIONS — passed from CLI argument parsing
// ============================================================================

export interface ChatOptions {
  model?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  continueLastSession?: boolean;
  sessionId?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  fallbackModel?: string;
  debug?: boolean;
  verbose?: boolean;
}

export async function renderLogin(): Promise<void> {
  const { LoginApp } = await import("./login/LoginApp.js");
  const { waitUntilExit } = render(<LoginApp />);
  await waitUntilExit();
}

export async function renderLogout(): Promise<void> {
  const { signOut, isLoggedIn } = await import("./services/auth-service.js");
  if (!isLoggedIn()) {
    console.log("Not logged in.");
  } else {
    signOut();
    console.log("Logged out. Tokens cleared.");
  }
}

export async function renderChat(options?: ChatOptions): Promise<void> {
  const { matrixIntro } = await import("./shared/MatrixIntro.js");
  await matrixIntro();

  // Apply options before starting chat
  if (options?.model || options?.permissionMode) {
    const agentLoop = await import("./services/agent-loop.js");
    if (options.model) agentLoop.setModel(options.model);
    if (options.permissionMode) {
      agentLoop.setPermissionMode(options.permissionMode as "default" | "plan" | "yolo");
    }
  }

  const { ChatApp } = await import("./chat/ChatApp.js");
  const { waitUntilExit } = render(<ChatApp />);
  await waitUntilExit();
}

export async function renderSetup(): Promise<void> {
  const { SetupApp } = await import("./setup/SetupApp.js");
  const { waitUntilExit } = render(<SetupApp />);
  await waitUntilExit();
}

export async function renderStatus(): Promise<void> {
  const { StatusApp } = await import("./status/StatusApp.js");
  const { waitUntilExit } = render(<StatusApp />);
  await waitUntilExit();
}

export async function renderStores(): Promise<void> {
  const { StoreApp } = await import("./stores/StoreApp.js");
  const { waitUntilExit } = render(<StoreApp />);
  await waitUntilExit();
}
