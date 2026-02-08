/**
 * CLI App Entry Point
 *
 * Dynamic imports for each mode — keeps MCP server path clean.
 */

import React from "react";
import { render } from "ink";

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

export async function renderChat(): Promise<void> {
  const { matrixIntro } = await import("./shared/MatrixIntro.js");
  await matrixIntro();
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
