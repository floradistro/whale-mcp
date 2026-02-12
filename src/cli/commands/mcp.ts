/**
 * whale mcp — Manage MCP server configurations
 *
 * Usage:
 *   whale mcp list                          List configured servers
 *   whale mcp add <name> -- <cmd> [args...] Add stdio server
 *   whale mcp add --transport http <name> <url>  Add HTTP server
 *   whale mcp add -e KEY=VAL <name> -- <cmd>     Add with env vars
 *   whale mcp remove <name>                 Remove server
 *   whale mcp get <name>                    Show server config
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".swagmanager", "config.json");

interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport: "stdio" | "http";
  url?: string;
}

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

function getServers(config: Record<string, unknown>): Record<string, McpServerConfig> {
  return (config.mcpServers as Record<string, McpServerConfig>) || {};
}

export async function runMcpCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "list") {
    const config = loadConfig();
    const servers = getServers(config);
    const names = Object.keys(servers);

    if (names.length === 0) {
      console.log("No MCP servers configured.");
      console.log("Add one: whale mcp add <name> -- <command> [args...]");
      return;
    }

    console.log("Configured MCP servers:\n");
    for (const name of names) {
      const s = servers[name];
      if (s.transport === "http") {
        console.log(`  ${name} (http) → ${s.url}`);
      } else {
        const cmd = [s.command, ...(s.args || [])].join(" ");
        console.log(`  ${name} (stdio) → ${cmd}`);
      }
      if (s.env && Object.keys(s.env).length > 0) {
        console.log(`    env: ${Object.keys(s.env).join(", ")}`);
      }
    }
    return;
  }

  if (subcommand === "add") {
    const restArgs = args.slice(1);

    // Parse -e KEY=VAL and --transport flags
    const envVars: Record<string, string> = {};
    let transport: "stdio" | "http" = "stdio";
    const filteredArgs: string[] = [];

    for (let i = 0; i < restArgs.length; i++) {
      if (restArgs[i] === "-e" && i + 1 < restArgs.length) {
        const kv = restArgs[++i];
        const eqIdx = kv.indexOf("=");
        if (eqIdx > 0) {
          envVars[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
        }
      } else if (restArgs[i] === "--transport" && i + 1 < restArgs.length) {
        transport = restArgs[++i] as "stdio" | "http";
      } else {
        filteredArgs.push(restArgs[i]);
      }
    }

    if (transport === "http") {
      // whale mcp add --transport http <name> <url>
      const name = filteredArgs[0];
      const url = filteredArgs[1];
      if (!name || !url) {
        console.error("Usage: whale mcp add --transport http <name> <url>");
        process.exit(1);
      }

      const config = loadConfig();
      const servers = getServers(config);
      servers[name] = { transport: "http", url, env: Object.keys(envVars).length > 0 ? envVars : undefined };
      config.mcpServers = servers;
      saveConfig(config);
      console.log(`Added HTTP MCP server: ${name} → ${url}`);
      return;
    }

    // stdio: whale mcp add <name> -- <cmd> [args...]
    const dashDash = filteredArgs.indexOf("--");
    if (dashDash < 1) {
      console.error("Usage: whale mcp add <name> -- <command> [args...]");
      process.exit(1);
    }

    const name = filteredArgs[0];
    const command = filteredArgs[dashDash + 1];
    const cmdArgs = filteredArgs.slice(dashDash + 2);

    if (!name || !command) {
      console.error("Usage: whale mcp add <name> -- <command> [args...]");
      process.exit(1);
    }

    const config = loadConfig();
    const servers = getServers(config);
    servers[name] = {
      command,
      args: cmdArgs.length > 0 ? cmdArgs : undefined,
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
      transport: "stdio",
    };
    config.mcpServers = servers;
    saveConfig(config);
    console.log(`Added stdio MCP server: ${name} → ${[command, ...cmdArgs].join(" ")}`);
    return;
  }

  if (subcommand === "remove") {
    const name = args[1];
    if (!name) {
      console.error("Usage: whale mcp remove <name>");
      process.exit(1);
    }

    const config = loadConfig();
    const servers = getServers(config);
    if (!servers[name]) {
      console.error(`MCP server not found: ${name}`);
      process.exit(1);
    }

    delete servers[name];
    config.mcpServers = servers;
    saveConfig(config);
    console.log(`Removed MCP server: ${name}`);
    return;
  }

  if (subcommand === "get") {
    const name = args[1];
    if (!name) {
      console.error("Usage: whale mcp get <name>");
      process.exit(1);
    }

    const config = loadConfig();
    const servers = getServers(config);
    const server = servers[name];
    if (!server) {
      console.error(`MCP server not found: ${name}`);
      process.exit(1);
    }

    console.log(JSON.stringify(server, null, 2));
    return;
  }

  console.error(`Unknown mcp subcommand: ${subcommand}`);
  console.error("Usage: whale mcp list|add|remove|get");
  process.exit(1);
}
