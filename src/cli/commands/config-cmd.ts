/**
 * whale config — View and set configuration from the CLI
 *
 * Usage:
 *   whale config                Show all settings
 *   whale config <key>          Read single key
 *   whale config <key> <value>  Write single key
 *   whale config --reset        Reset to defaults
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".swagmanager", "config.json");
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const KNOWN_KEYS = [
  "model", "permission_mode", "anthropic_api_key",
  "store_id", "store_name", "mcpServers",
];

function loadConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { return {}; }
}

function saveConfig(config: Record<string, unknown>): void {
  const dir = join(homedir(), ".swagmanager");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function maskSecret(key: string, value: string): string {
  if (key.includes("key") || key.includes("token") || key.includes("secret")) {
    if (value.length > 8) {
      return value.slice(0, 4) + "..." + value.slice(-4);
    }
    return "***";
  }
  return value;
}

export async function runConfigCommand(args: string[], flags: Record<string, unknown>): Promise<void> {
  if (flags.reset) {
    const dir = join(homedir(), ".swagmanager");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2), { mode: 0o600 });
    console.log("Configuration reset to defaults.");
    return;
  }

  const key = args[0];
  const value = args[1];

  if (!key) {
    // Show all settings
    const config = loadConfig();
    console.log(`\n  ${BOLD}whale config${RESET} ${DIM}(${CONFIG_PATH})${RESET}\n`);

    if (Object.keys(config).length === 0) {
      console.log("  No configuration set.");
      console.log(`  ${DIM}Set a value: whale config <key> <value>${RESET}`);
    } else {
      for (const [k, v] of Object.entries(config)) {
        if (typeof v === "object" && v !== null) {
          console.log(`  ${k}:`);
          for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
            const display = typeof sv === "string" ? maskSecret(sk, sv) : JSON.stringify(sv);
            console.log(`    ${sk}: ${DIM}${display}${RESET}`);
          }
        } else {
          const display = typeof v === "string" ? maskSecret(k, v) : String(v);
          console.log(`  ${k}: ${DIM}${display}${RESET}`);
        }
      }
    }
    console.log();
    return;
  }

  if (!value) {
    // Read single key
    const config = loadConfig();
    const v = config[key];
    if (v === undefined) {
      console.log(`${key}: (not set)`);
    } else if (typeof v === "object") {
      console.log(JSON.stringify(v, null, 2));
    } else {
      console.log(typeof v === "string" ? maskSecret(key, v) : String(v));
    }
    return;
  }

  // Write single key
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
  console.log(`${key} = ${value}`);
}
