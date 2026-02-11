/**
 * Agent Definitions — custom agent types from markdown files
 *
 * Matches Claude Code's .claude/agents/ pattern:
 *
 *   .whale/agents/reviewer.md:
 *     ---
 *     description: Reviews code for security issues
 *     tools: read_file, glob, grep
 *     ---
 *     You are a security review agent...
 *
 * Load order:
 * 1. ~/.swagmanager/agents/*.md (global)
 * 2. .whale/agents/*.md (local, overrides global)
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

// ============================================================================
// TYPES
// ============================================================================

export interface AgentDefinition {
  name: string;          // filename without .md
  prompt: string;        // file content (system prompt for the agent)
  description?: string;  // from frontmatter
  tools?: string[];      // from frontmatter: which tools the agent can use
  source: "global" | "local";
}

// ============================================================================
// PATHS
// ============================================================================

const GLOBAL_AGENTS_DIR = join(homedir(), ".swagmanager", "agents");
const LOCAL_AGENTS_DIR = ".whale/agents";

// ============================================================================
// LOADING
// ============================================================================

function parseFrontmatter(content: string): { description?: string; tools?: string[]; body: string } {
  if (!content.startsWith("---")) return { body: content.trim() };

  const endIndex = content.indexOf("---", 3);
  if (endIndex === -1) return { body: content.trim() };

  const frontmatter = content.slice(3, endIndex).trim();
  const body = content.slice(endIndex + 3).trim();

  // Parse description
  const descMatch = frontmatter.match(/description:\s*(.+)/i);
  const description = descMatch?.[1]?.trim();

  // Parse tools (comma-separated)
  const toolsMatch = frontmatter.match(/tools:\s*(.+)/i);
  const tools = toolsMatch?.[1]?.split(",").map(t => t.trim()).filter(Boolean);

  return { description, tools, body };
}

function loadAgentsFromDir(dir: string, source: "global" | "local"): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  const agents: AgentDefinition[] = [];

  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md"));

    for (const file of files) {
      const name = basename(file, ".md");
      const path = join(dir, file);

      try {
        const content = readFileSync(path, "utf-8");
        const { description, tools, body } = parseFrontmatter(content);

        agents.push({
          name,
          prompt: body,
          description,
          tools,
          source,
        });
      } catch { /* skip unreadable */ }
    }
  } catch { /* skip inaccessible */ }

  return agents;
}

export function loadAgentDefinitions(): AgentDefinition[] {
  const agents: AgentDefinition[] = [];

  // Load global agents first
  agents.push(...loadAgentsFromDir(GLOBAL_AGENTS_DIR, "global"));

  // Load local agents (override global with same name)
  const localDir = join(process.cwd(), LOCAL_AGENTS_DIR);
  const localAgents = loadAgentsFromDir(localDir, "local");

  for (const local of localAgents) {
    const existingIndex = agents.findIndex(a => a.name === local.name);
    if (existingIndex >= 0) {
      agents[existingIndex] = local;
    } else {
      agents.push(local);
    }
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgentDefinition(name: string): AgentDefinition | undefined {
  const agents = loadAgentDefinitions();
  return agents.find(a => a.name === name);
}
