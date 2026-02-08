#!/usr/bin/env node
/**
 * SwagManager MCP — Interactive Setup
 *
 * Detects installed MCP-compatible CLIs and writes config for each.
 * Usage: npx swagmanager-mcp setup
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { createInterface } from "readline";

// ============================================================================
// CLI CONFIG TARGETS
// ============================================================================

interface CLITarget {
  name: string;
  configPath: string;
  configKey: string; // JSON key that holds MCP servers
  detect: () => boolean;
  format: (servers: Record<string, any>) => Record<string, any>;
}

const home = homedir();

const CLI_TARGETS: CLITarget[] = [
  {
    name: "Claude Code",
    configPath: join(home, ".claude", "settings.json"),
    configKey: "mcpServers",
    detect: () => existsSync(join(home, ".claude")),
    format: (servers) => servers,
  },
  {
    name: "Claude Desktop",
    configPath:
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    configKey: "mcpServers",
    detect: () =>
      existsSync(
        process.platform === "darwin"
          ? join(home, "Library", "Application Support", "Claude")
          : join(home, "AppData", "Roaming", "Claude")
      ),
    format: (servers) => servers,
  },
  {
    name: "Cursor",
    configPath: join(home, ".cursor", "mcp.json"),
    configKey: "mcpServers",
    detect: () => existsSync(join(home, ".cursor")),
    format: (servers) => servers,
  },
  {
    name: "Windsurf",
    configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
    configKey: "mcpServers",
    detect: () => existsSync(join(home, ".codeium", "windsurf")),
    format: (servers) => servers,
  },
  {
    name: "Gemini CLI",
    configPath: join(home, ".gemini", "settings.json"),
    configKey: "mcpServers",
    detect: () => existsSync(join(home, ".gemini")),
    format: (servers) => servers,
  },
];

// ============================================================================
// HELPERS
// ============================================================================

function readJSON(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJSON(path: string, data: Record<string, any>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function promptYN(rl: ReturnType<typeof createInterface>, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  return new Promise((resolve) => {
    rl.question(`${question} ${hint} `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === "") resolve(defaultYes);
      else resolve(a === "y" || a === "yes");
    });
  });
}

// ============================================================================
// MAIN
// ============================================================================

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("");
  console.log("  SwagManager MCP — Setup");
  console.log("  ═══════════════════════");
  console.log("");

  // Detect installed CLIs
  const detected = CLI_TARGETS.filter((t) => t.detect());
  const notDetected = CLI_TARGETS.filter((t) => !t.detect());

  if (detected.length > 0) {
    console.log("  Detected CLIs:");
    detected.forEach((t) => console.log(`    + ${t.name}`));
  }
  if (notDetected.length > 0) {
    console.log("  Not found:");
    notDetected.forEach((t) => console.log(`    - ${t.name}`));
  }
  console.log("");

  if (detected.length === 0) {
    console.log("  No supported MCP clients detected.");
    console.log("  Install Claude Code, Claude Desktop, Cursor, Windsurf, or Gemini CLI first.");
    rl.close();
    return;
  }

  // Collect credentials
  console.log("  Enter your Supabase credentials:");
  console.log("");

  const supabaseUrl = await prompt(rl, "  Supabase URL");
  if (!supabaseUrl) {
    console.log("  Supabase URL is required. Aborting.");
    rl.close();
    return;
  }

  const supabaseKey = await prompt(rl, "  Supabase Service Role Key");
  if (!supabaseKey) {
    console.log("  Service Role Key is required. Aborting.");
    rl.close();
    return;
  }

  const storeId = await prompt(rl, "  Store ID (optional, press enter to skip)");

  console.log("");

  // Build MCP server entry
  const serverEntry: Record<string, any> = {
    type: "stdio",
    command: "npx",
    args: ["-y", "swagmanager-mcp"],
    env: {
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: supabaseKey,
      ...(storeId ? { STORE_ID: storeId } : {}),
    },
  };

  // Install to each detected CLI
  let installed = 0;
  for (const target of detected) {
    const install = await promptYN(rl, `  Install to ${target.name}?`);
    if (!install) continue;

    const config = readJSON(target.configPath);
    if (!config[target.configKey]) config[target.configKey] = {};

    // Check for existing entry
    if (config[target.configKey].swagmanager) {
      const overwrite = await promptYN(rl, `    swagmanager already configured in ${target.name}. Overwrite?`, false);
      if (!overwrite) continue;
    }

    config[target.configKey].swagmanager = target.format(serverEntry);
    writeJSON(target.configPath, config);
    console.log(`    Wrote ${target.configPath}`);
    installed++;
  }

  console.log("");
  if (installed > 0) {
    console.log(`  Done! Installed to ${installed} CLI${installed > 1 ? "s" : ""}.`);
    console.log("  Restart your CLI(s) to load the MCP server.");
  } else {
    console.log("  No changes made.");
  }
  console.log("");

  rl.close();
}

// Run if called directly
const isDirectRun = process.argv[1]?.includes("setup");
if (isDirectRun) {
  runSetup().catch(console.error);
}
