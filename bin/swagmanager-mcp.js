#!/usr/bin/env node

/**
 * whale — local-first AI agent CLI
 *
 * Usage:
 *   whale              — Start chat (default, interactive terminal)
 *   whale login        — Log in with SwagManager credentials
 *   whale logout       — Clear saved session
 *   whale status       — Show connection status
 *   whale help         — Show this help
 *   (non-TTY stdin)    — MCP stdio server for Claude Code / Cursor
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const command = process.argv[2];

// ── Help ──
function showHelp() {
  const d = "\x1b[2m";
  const B = "\x1b[1m";
  const r = "\x1b[0m";
  const c = "\x1b[38;2;99;102;241m";
  const g = "\x1b[38;2;100;116;139m";

  console.log();
  console.log(`  ${g}╭──────────────────────────────────────────╮${r}`);
  console.log(`  ${g}│${r}                                          ${g}│${r}`);
  console.log(`  ${g}│${r}   ${c}${B}◆ whale${r}  ${d}v2.1.0${r}                         ${g}│${r}`);
  console.log(`  ${g}│${r}   ${d}local-first AI agent CLI${r}               ${g}│${r}`);
  console.log(`  ${g}│${r}                                          ${g}│${r}`);
  console.log(`  ${g}╰──────────────────────────────────────────╯${r}`);
  console.log();
  console.log(`  ${B}Commands:${r}`);
  console.log(`    whale${d}             Start chatting (default)${r}`);
  console.log(`    whale login${d}       Log in to SwagManager${r}`);
  console.log(`    whale logout${d}      Clear session${r}`);
  console.log(`    whale status${d}      Connection & tools${r}`);
  console.log(`    whale setup${d}       Install MCP to IDEs${r}`);
  console.log();
  console.log(`  ${B}In chat:${r}`);
  console.log(`    ${d}Type ${r}/${d} to open command menu${r}`);
  console.log(`    ${d}^C to exit, esc to cancel${r}`);
  console.log();
}

// ── Route ──
switch (command) {
  case "help":
  case "--help":
  case "-h":
    showHelp();
    break;

  case "login": {
    if (!process.stdin.isTTY) {
      console.error("Error: whale login requires an interactive terminal.");
      process.exit(1);
    }
    const { renderLogin } = await import(join(__dirname, "..", "dist", "cli", "app.js"));
    await renderLogin();
    break;
  }

  case "logout": {
    const { renderLogout } = await import(join(__dirname, "..", "dist", "cli", "app.js"));
    await renderLogout();
    break;
  }

  case "chat":
  case undefined: {
    if (process.stdin.isTTY) {
      const { renderChat } = await import(join(__dirname, "..", "dist", "cli", "app.js"));
      await renderChat();
    } else if (command === "chat") {
      console.error("Error: whale chat requires an interactive terminal.");
      process.exit(1);
    } else {
      // Non-TTY, no command → MCP stdio server
      await import(join(__dirname, "..", "dist", "index.js"));
    }
    break;
  }

  case "status": {
    const { renderStatus } = await import(join(__dirname, "..", "dist", "cli", "app.js"));
    await renderStatus();
    break;
  }

  case "setup": {
    if (!process.stdin.isTTY) {
      console.error("Error: whale setup requires an interactive terminal.");
      process.exit(1);
    }
    const { renderSetup } = await import(join(__dirname, "..", "dist", "cli", "app.js"));
    await renderSetup();
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'whale help' for usage.`);
    process.exit(1);
}
