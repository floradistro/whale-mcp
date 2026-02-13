#!/usr/bin/env node

/**
 * whale code — local-first AI agent CLI
 *
 * Usage:
 *   whale                        Start interactive chat
 *   whale -p "prompt"            Non-interactive (print) mode
 *   whale login                  Log in with SwagManager credentials
 *   whale logout                 Clear saved session
 *   whale status                 Show connection status
 *   whale mcp list|add|remove    Manage MCP servers
 *   whale doctor                 Run diagnostics
 *   whale config [key] [value]   View/set configuration
 *   whale help                   Show this help
 *   (non-TTY stdin)              MCP stdio server for Claude Code / Cursor
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parseArgs } from "util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distDir = join(__dirname, "..", "dist");

// ── Parse CLI flags ──
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      // Print / headless mode
      print:                  { type: "boolean", short: "p" },
      "output-format":        { type: "string" },
      // Model & mode
      model:                  { type: "string", short: "m" },
      "permission-mode":      { type: "string" },
      // Session
      resume:                 { type: "string", short: "r" },
      continue:               { type: "boolean", short: "c" },
      "session-id":           { type: "string" },
      "no-session-persistence": { type: "boolean" },
      // Limits
      "max-turns":            { type: "string" },
      "max-budget-usd":       { type: "string" },
      effort:                 { type: "string" },
      // Tool filtering
      "allowed-tools":        { type: "string" },
      "disallowed-tools":     { type: "string" },
      // Fallback
      "fallback-model":       { type: "string" },
      // Serve mode
      port:                   { type: "string" },
      host:                   { type: "string" },
      // Debug / verbose
      debug:                  { type: "boolean" },
      verbose:                { type: "boolean", short: "v" },
      // Standard
      help:                   { type: "boolean", short: "h" },
      version:                { type: "boolean" },
    },
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error("Run 'whale help' for usage.");
  process.exit(1);
}

const { values: flags, positionals } = parsed;

// First positional is the subcommand (unless --print is used)
const subcommand = positionals[0];
// If --print, remaining positionals form the message
const printMessage = flags.print
  ? positionals.join(" ")
  : undefined;

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
  console.log(`  ${g}│${r}   ${c}${B}◆ whale code${r}  ${d}v4.7.0${r}                    ${g}│${r}`);
  console.log(`  ${g}│${r}   ${d}local-first AI agent CLI${r}               ${g}│${r}`);
  console.log(`  ${g}│${r}                                          ${g}│${r}`);
  console.log(`  ${g}╰──────────────────────────────────────────╯${r}`);
  console.log();
  console.log(`  ${B}Commands:${r}`);
  console.log(`    whale${d}                  Start chatting (default)${r}`);
  console.log(`    whale login${d}            Log in to SwagManager${r}`);
  console.log(`    whale logout${d}           Clear session${r}`);
  console.log(`    whale stores${d}           Switch active store${r}`);
  console.log(`    whale status${d}           Connection & tools${r}`);
  console.log(`    whale setup${d}            Install MCP to IDEs${r}`);
  console.log(`    whale mcp${d}              Manage MCP servers${r}`);
  console.log(`    whale doctor${d}           Run diagnostics${r}`);
  console.log(`    whale config${d}           View/set configuration${r}`);
  console.log(`    whale serve${d}            Local agent WebSocket server${r}`);
  console.log();
  console.log(`  ${B}Print Mode (non-interactive):${r}`);
  console.log(`    whale -p "prompt"${d}      Run single prompt, output to stdout${r}`);
  console.log(`    echo "prompt" | whale -p${d}  Read prompt from stdin${r}`);
  console.log();
  console.log(`  ${B}Flags:${r}`);
  console.log(`    -p, --print${d}                 Non-interactive mode${r}`);
  console.log(`    --output-format <fmt>${d}       text|json|stream-json (default: text)${r}`);
  console.log(`    -m, --model <name>${d}          sonnet|opus|haiku${r}`);
  console.log(`    --permission-mode <mode>${d}    default|plan|yolo${r}`);
  console.log(`    -r, --resume <id>${d}           Resume session by ID${r}`);
  console.log(`    -c, --continue${d}              Continue most recent session${r}`);
  console.log(`    --session-id <id>${d}           Custom session UUID${r}`);
  console.log(`    --no-session-persistence${d}    Ephemeral session${r}`);
  console.log(`    --max-turns <n>${d}             Limit agent turns${r}`);
  console.log(`    --max-budget-usd <n>${d}        Cost cap in USD${r}`);
  console.log(`    --effort <level>${d}            low|medium|high${r}`);
  console.log(`    --allowed-tools <list>${d}      Comma-separated tool whitelist${r}`);
  console.log(`    --disallowed-tools <list>${d}   Comma-separated tool blacklist${r}`);
  console.log(`    --fallback-model <name>${d}     Auto-fallback on overload${r}`);
  console.log(`    --debug${d}                     Debug logging to stderr${r}`);
  console.log(`    -v, --verbose${d}               Extra output${r}`);
  console.log();
  console.log(`  ${B}In chat:${r}`);
  console.log(`    ${d}Type ${r}/${d} to open command menu${r}`);
  console.log(`    ${d}^C to exit, esc to cancel${r}`);
  console.log();
}

// Build options object from flags
function buildOptions() {
  return {
    model: flags.model,
    permissionMode: flags["permission-mode"],
    resumeSessionId: flags.resume,
    continueLastSession: flags.continue,
    sessionId: flags["session-id"],
    noSessionPersistence: flags["no-session-persistence"],
    maxTurns: flags["max-turns"] ? parseInt(flags["max-turns"], 10) : undefined,
    maxBudgetUsd: flags["max-budget-usd"] ? parseFloat(flags["max-budget-usd"]) : undefined,
    effort: flags.effort,
    allowedTools: flags["allowed-tools"]?.split(",").map(s => s.trim()),
    disallowedTools: flags["disallowed-tools"]?.split(",").map(s => s.trim()),
    fallbackModel: flags["fallback-model"],
    debug: flags.debug,
    verbose: flags.verbose,
  };
}

// ── Version ──
if (flags.version) {
  // Read version from package.json
  try {
    const { readFileSync } = await import("fs");
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    console.log(pkg.version);
  } catch {
    console.log("4.7.0");
  }
  process.exit(0);
}

// ── Help ──
if (flags.help && !subcommand) {
  showHelp();
  process.exit(0);
}

// ── Print mode ──
if (flags.print) {
  const { runPrintMode } = await import(join(distDir, "cli", "print-mode.js"));
  const options = buildOptions();

  // Read stdin if available (non-TTY)
  let stdinContent = "";
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinContent = Buffer.concat(chunks).toString("utf-8").trim();
  }

  // Combine stdin + positional message
  const message = [stdinContent, printMessage].filter(Boolean).join("\n\n");
  if (!message) {
    console.error("Error: --print requires a message. Provide as argument or via stdin.");
    process.exit(1);
  }

  const exitCode = await runPrintMode({
    message,
    outputFormat: flags["output-format"] || "text",
    ...options,
  });
  process.exit(exitCode);
}

// ── Route subcommands ──
const command = subcommand;
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
    const { renderLogin } = await import(join(distDir, "cli", "app.js"));
    await renderLogin();
    break;
  }

  case "logout": {
    const { renderLogout } = await import(join(distDir, "cli", "app.js"));
    await renderLogout();
    break;
  }

  case "chat":
  case undefined: {
    if (process.stdin.isTTY) {
      const { renderChat } = await import(join(distDir, "cli", "app.js"));
      await renderChat(buildOptions());
    } else if (command === "chat") {
      console.error("Error: whale chat requires an interactive terminal.");
      process.exit(1);
    } else {
      // Non-TTY, no command → MCP stdio server
      await import(join(distDir, "index.js"));
    }
    break;
  }

  case "status": {
    const { renderStatus } = await import(join(distDir, "cli", "app.js"));
    await renderStatus();
    break;
  }

  case "setup": {
    if (!process.stdin.isTTY) {
      console.error("Error: whale setup requires an interactive terminal.");
      process.exit(1);
    }
    const { renderSetup } = await import(join(distDir, "cli", "app.js"));
    await renderSetup();
    break;
  }

  case "stores":
  case "store": {
    if (!process.stdin.isTTY) {
      console.error("Error: whale stores requires an interactive terminal.");
      process.exit(1);
    }
    const { renderStores } = await import(join(distDir, "cli", "app.js"));
    await renderStores();
    break;
  }

  case "mcp": {
    const { runMcpCommand } = await import(join(distDir, "cli", "commands", "mcp.js"));
    await runMcpCommand(positionals.slice(1));
    break;
  }

  case "doctor": {
    const { runDoctor } = await import(join(distDir, "cli", "commands", "doctor.js"));
    await runDoctor();
    break;
  }

  case "config": {
    const { runConfigCommand } = await import(join(distDir, "cli", "commands", "config-cmd.js"));
    await runConfigCommand(positionals.slice(1), flags);
    break;
  }

  case "serve": {
    const { runServeMode } = await import(join(distDir, "cli", "serve-mode.js"));
    await runServeMode({
      port: flags.port ? parseInt(flags.port, 10) : 3847,
      host: flags.host || "127.0.0.1",
      ...buildOptions(),
    });
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'whale help' for usage.`);
    process.exit(1);
}
