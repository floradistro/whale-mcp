/**
 * Subagent System — Claude Code-style Task tool for spawning specialized agents
 *
 * Subagents run in isolated context, enabling:
 * - Parallel exploration without polluting main context
 * - Specialized prompts per agent type
 * - Cost optimization (Haiku for simple tasks)
 * - Resume capability for long-running tasks
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import {
  LOCAL_TOOL_DEFINITIONS,
  executeLocalTool,
  isLocalTool,
} from "./local-tools.js";
import { LoopDetector } from "./loop-detector.js";
import { loadConfig } from "./config-store.js";
import { getValidToken, SUPABASE_URL } from "./auth-service.js";
import {
  isServerTool,
  loadServerToolDefinitions,
  executeServerTool,
} from "./server-tools.js";
import { createTurnContext, logSpan, generateSpanId, generateTraceId, getTurnNumber } from "./telemetry.js";
import { loadClaudeMd, classifyToolError } from "./agent-loop.js";
import { getGlobalEmitter } from "./agent-events.js";
import { getAgentDefinition } from "./agent-definitions.js";

// ============================================================================
// TYPES
// ============================================================================

export type BuiltinSubagentType =
  | "explore"           // Fast codebase exploration
  | "plan"              // Planning complex implementations
  | "general-purpose"   // Multi-step autonomous tasks
  | "research";         // Documentation lookups, web research

// Accepts built-in types + custom agent names from .whale/agents/
export type SubagentType = BuiltinSubagentType | (string & {});

export interface ParentTraceContext {
  traceId: string;      // 32 hex chars - inherited from parent
  spanId: string;       // 16 hex chars - becomes our parentSpanId
  conversationId?: string;
  turnNumber: number;   // Required - subagent inherits parent turn number
  userId?: string;
  userEmail?: string;
}

export interface SubagentOptions {
  prompt: string;
  subagent_type: SubagentType;
  model?: "sonnet" | "opus" | "haiku";
  resume?: string;               // Agent ID to resume from
  run_in_background?: boolean;   // Write output to file, return immediately
  max_turns?: number;            // Override default MAX_TURNS (clamped 1-50)
  name?: string;                 // Display name for agent
  parentContext?: string;        // Summary of parent conversation for context
  parentTraceContext?: ParentTraceContext;  // W3C trace context for hierarchical spans
}

export interface SubagentResult {
  success: boolean;
  output: string;
  agentId: string;
  tokensUsed: { input: number; output: number };
  toolsUsed: string[];
}

interface AgentState {
  id: string;
  type: SubagentType;
  model: string;
  messages: Anthropic.MessageParam[];
  toolsUsed: string[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MODEL_MAP: Record<string, string> = {
  sonnet: "claude-sonnet-4-20250514",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

const AGENTS_DIR = join(homedir(), ".swagmanager", "agents");

// Claude Code pattern: subagents should be discrete tasks, not open-ended
// Low turn limit prevents infinite loops and forces focused execution
const MAX_TURNS = 8;
const MAX_OUTPUT_TOKENS = 8192;

// ============================================================================
// AGENT PROMPTS — specialized per type
// ============================================================================

// Build agent prompt with working directory context
function buildAgentPrompt(type: SubagentType | string, cwd: string): string {
  const cwdContext = `
## Working Directory
You are working in: ${cwd}
All file paths should be relative to or absolute from this directory.
IMPORTANT: Focus ONLY on files within this directory. Do not get confused by other projects.
`;

  // Check for custom agent definition first
  const custom = getAgentDefinition(type);
  if (custom) return custom.prompt + cwdContext;

  const prompts: Record<SubagentType, string> = {
    explore: `You are an exploration agent. Your ONLY job is to quickly find specific information in the codebase, then STOP.

Tools available:
- glob: Find files by pattern (e.g., "**/*.ts")
- grep: Search file contents with regex
- read_file: Read file contents
- list_directory: List directory contents
${cwdContext}
## STOP CONDITIONS — You MUST stop when ANY of these are met:
1. You found the specific information requested
2. You've searched 3+ patterns without finding anything new
3. You've read the key files that answer the question
4. You've exhausted reasonable search patterns

## Guidelines:
- FIRST: One quick search (glob or grep) to locate relevant files
- Read only the necessary files to answer the question
- DO NOT continue exploring after you have the answer
- DO NOT read files that aren't directly relevant

## Output Format:
Return a concise summary with:
- File paths and line numbers for relevant code
- Key code snippets (brief)
- Direct answer to the question asked

IMPORTANT: Complete in 2-4 turns. If you haven't found it by turn 4, summarize what you found and STOP.`,

    plan: `You are a planning agent. Your ONLY job is to analyze the codebase and create an implementation plan, then STOP.

Tools available:
- glob: Find files by pattern
- grep: Search file contents
- read_file: Read file contents
- list_directory: List directory contents
${cwdContext}
## STOP CONDITIONS — You MUST stop when:
1. You've identified the files that need changes
2. You've understood the existing patterns/architecture
3. You've created a concrete plan with specific steps

## Guidelines:
- FIRST: Quick search to find relevant files
- Read only files needed to understand the architecture
- DO NOT read every file — focus on entry points and key modules
- Create the plan as soon as you understand the structure

## Output Format — Return EXACTLY this structure:
### Summary
[1-2 sentences on the approach]

### Files to Modify
- path/to/file.ts: [what changes]

### Implementation Steps
1. [Specific step]
2. [Specific step]

### Risks
- [Any considerations]

IMPORTANT: Complete in 3-5 turns. If you haven't finished by turn 5, output your best plan and STOP.`,

    "general-purpose": `You are an autonomous agent for discrete tasks. Complete the task, then STOP.

Tools available:
- File operations: read_file, write_file, edit_file, glob, grep
- Shell: run_command
- Search: search_files, search_content
- Web: web_fetch
${cwdContext}
## STOP CONDITIONS — You MUST stop when:
1. The specific task is complete
2. You've verified the changes work (if applicable)
3. You encounter a blocker you cannot resolve

## Guidelines:
- Understand what exists before making changes
- Make targeted changes — don't over-engineer
- Verify your changes if possible (run tests, check syntax)
- If blocked, explain the blocker and STOP

## Output Format:
### What I Did
[Brief summary of actions taken]

### Files Modified
- path/to/file.ts: [change description]

### Verification
[How you verified it works, or N/A]

### Issues (if any)
[Any problems encountered]

IMPORTANT: This is a discrete task. Complete it in 4-6 turns maximum. Do not loop.`,

    research: `You are a research agent. Find the specific information requested, then STOP.

Tools available:
- web_fetch: Fetch and parse web content
- web_search: Search the web
- read_file: Read local files
- grep: Search local file contents
${cwdContext}
## STOP CONDITIONS — You MUST stop when:
1. You found the answer to the question
2. You've checked 2-3 authoritative sources
3. You've gathered enough information to answer

## Guidelines:
- Search for official documentation first
- Check 2-3 sources, not 10
- DO NOT keep searching after you have the answer
- Summarize findings immediately when you have enough

## Output Format:
### Answer
[Direct answer to the question]

### Key Points
- [Important detail 1]
- [Important detail 2]

### Sources
- [URL 1]: [what it says]
- [URL 2]: [what it says]

### Caveats
[Any version requirements or limitations]

IMPORTANT: Complete in 2-4 turns. Stop as soon as you have a good answer.`,
  };

  return prompts[type] || prompts["general-purpose"];
}

// ============================================================================
// AGENT STATE PERSISTENCE
// ============================================================================

function ensureAgentsDir(): void {
  if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
}

function saveAgentState(state: AgentState): void {
  ensureAgentsDir();
  const path = join(AGENTS_DIR, `${state.id}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

function loadAgentState(agentId: string): AgentState | null {
  const path = join(AGENTS_DIR, `${agentId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function generateAgentId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// TOOL FILTERING — restrict tools per agent type
// ============================================================================

function getToolsForAgent(type: SubagentType | string): string[] {
  // Check for custom agent definition with explicit tools
  const custom = getAgentDefinition(type);
  if (custom?.tools && custom.tools.length > 0) return custom.tools;

  switch (type) {
    case "explore":
      return ["glob", "grep", "read_file", "list_directory", "search_files", "search_content"];
    case "plan":
      return ["glob", "grep", "read_file", "list_directory", "search_files", "search_content"];
    case "research":
      return ["web_fetch", "web_search", "read_file", "grep", "glob"];
    case "general-purpose":
      // All tools
      return [
        "read_file", "write_file", "edit_file", "list_directory",
        "search_files", "search_content", "run_command",
        "glob", "grep", "notebook_edit", "web_fetch", "tasks",
      ];
    default:
      return ["read_file", "glob", "grep"];
  }
}

async function getFilteredTools(type: SubagentType): Promise<Anthropic.Tool[]> {
  const allowedNames = new Set(getToolsForAgent(type));

  // Local tools
  const localTools: Anthropic.Tool[] = LOCAL_TOOL_DEFINITIONS
    .filter((t) => allowedNames.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool["input_schema"],
    }));

  // Add web_search from server tools if allowed
  if (allowedNames.has("web_search")) {
    try {
      const serverTools = await loadServerToolDefinitions();
      const webSearch = serverTools.find((t) => t.name === "web_search");
      if (webSearch) localTools.push(webSearch);
    } catch { /* server tools unavailable */ }
  }

  return localTools;
}

// ============================================================================
// DISPLAY HELPERS — icons and colors for trace visualization
// ============================================================================

function getAgentIcon(type: SubagentType): string {
  const icons: Record<SubagentType, string> = {
    explore: "🔍",      // Magnifying glass for exploration
    plan: "📋",         // Clipboard for planning
    "general-purpose": "🤖",  // Robot for autonomous work
    research: "📚",     // Books for research
  };
  return icons[type] || "⚙️";
}

function getAgentColor(type: SubagentType): string {
  const colors: Record<SubagentType, string> = {
    explore: "#3B82F6",      // Blue for exploration
    plan: "#8B5CF6",         // Purple for planning
    "general-purpose": "#10B981",  // Green for general work
    research: "#F59E0B",     // Amber for research
  };
  return colors[type] || "#6B7280";
}

// ============================================================================
// API CLIENT — uses proxy first, falls back to direct
// ============================================================================

const PROXY_URL = `${SUPABASE_URL}/functions/v1/agent-proxy`;

interface ProxyResponse {
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

const API_TIMEOUT_MS = 120000; // 2 minute timeout for API calls

// ============================================================================
// STREAMING API CALL — uses streaming to keep event loop responsive
// ============================================================================

async function callAPI(
  modelId: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[]
): Promise<ProxyResponse> {
  // Try proxy with JWT first (streaming for responsiveness)
  const token = await getValidToken();
  if (token) {
    try {
      const response = await fetch(PROXY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages,
          system: systemPrompt,
          tools,
          model: modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true, // Streaming keeps UI responsive
        }),
      });

      if (response.ok && response.body) {
        return processProxyStream(response.body);
      }

      // If not 404, throw error
      if (response.status !== 404) {
        const body = await response.text();
        throw new Error(`Proxy error (${response.status}): ${body}`);
      }
    } catch (err: any) {
      if (err.message && !err.message.includes("404")) {
        throw err;
      }
    }
  }

  // Fallback: direct Anthropic SDK (streaming)
  const apiKey = process.env.ANTHROPIC_API_KEY || loadConfig().anthropic_api_key;
  if (apiKey) {
    return callAPIDirectStreaming(apiKey, modelId, systemPrompt, messages, tools);
  }

  throw new Error(
    token
      ? "Proxy unavailable and no ANTHROPIC_API_KEY set."
      : "No API key available. Set ANTHROPIC_API_KEY or run `whale login`."
  );
}

// Process proxy SSE stream into response
async function processProxyStream(body: ReadableStream<Uint8Array>): Promise<ProxyResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let text = "";
  const toolUseBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  let chunkCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Yield to event loop every 5 chunks to keep UI responsive
      chunkCount++;
      if (chunkCount % 5 === 0) {
        await yieldToEventLoop();
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;

        let event: any;
        try { event = JSON.parse(data); } catch { continue; }

        switch (event.type) {
          case "message_start":
            inputTokens = event.message?.usage?.input_tokens || 0;
            break;
          case "content_block_start":
            if (event.content_block?.type === "tool_use") {
              toolUseBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                inputJson: "",
              });
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta") {
              text += event.delta.text || "";
            } else if (event.delta?.type === "input_json_delta") {
              const block = toolUseBlocks.get(event.index);
              if (block) block.inputJson += event.delta.partial_json || "";
            }
            break;
          case "message_delta":
            stopReason = event.delta?.stop_reason || "end_turn";
            outputTokens = event.usage?.output_tokens || 0;
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Build content blocks
  const content: Anthropic.ContentBlock[] = [];
  if (text) {
    content.push({ type: "text", text } as Anthropic.TextBlock);
  }
  for (const [, block] of toolUseBlocks) {
    let input = {};
    try { input = JSON.parse(block.inputJson); } catch {}
    content.push({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input,
    } as Anthropic.ToolUseBlock);
  }

  return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason };
}

// Direct Anthropic SDK streaming
async function callAPIDirectStreaming(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[]
): Promise<ProxyResponse> {
  const client = new Anthropic({ apiKey, timeout: API_TIMEOUT_MS });

  let text = "";
  const toolUseBlocks: Map<number, { id: string; name: string; inputJson: string }> = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";
  let eventCount = 0;

  const stream = client.messages.stream({
    model: modelId,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    tools,
    messages,
  });

  for await (const event of stream) {
    // Yield to event loop every 10 events to keep UI responsive
    eventCount++;
    if (eventCount % 10 === 0) {
      await yieldToEventLoop();
    }

    switch (event.type) {
      case "message_start":
        inputTokens = (event as any).message?.usage?.input_tokens || 0;
        break;
      case "content_block_start":
        if ((event as any).content_block?.type === "tool_use") {
          toolUseBlocks.set((event as any).index, {
            id: (event as any).content_block.id,
            name: (event as any).content_block.name,
            inputJson: "",
          });
        }
        break;
      case "content_block_delta":
        if ((event as any).delta?.type === "text_delta") {
          text += (event as any).delta.text || "";
        } else if ((event as any).delta?.type === "input_json_delta") {
          const block = toolUseBlocks.get((event as any).index);
          if (block) block.inputJson += (event as any).delta.partial_json || "";
        }
        break;
      case "message_delta":
        stopReason = (event as any).delta?.stop_reason || "end_turn";
        outputTokens = (event as any).usage?.output_tokens || 0;
        break;
    }
  }

  // Build content blocks
  const content: Anthropic.ContentBlock[] = [];
  if (text) {
    content.push({ type: "text", text } as Anthropic.TextBlock);
  }
  for (const [, block] of toolUseBlocks) {
    let input = {};
    try { input = JSON.parse(block.inputJson); } catch {}
    content.push({
      type: "tool_use",
      id: block.id,
      name: block.name,
      input,
    } as Anthropic.ToolUseBlock);
  }

  return { content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason };
}

// ============================================================================
// SUBAGENT EXECUTION
// ============================================================================

// Progress emitter — uses event system instead of stderr to avoid UI conflicts
// The global emitter batches and routes these to ChatApp without causing re-renders
// NOTE: No module-level mutable state — agentId/turn passed through function params for parallel safety

function emitSubagentProgress(agentType: SubagentType, agentId: string, message: string, turn?: number, toolName?: string): void {
  const emitter = getGlobalEmitter();
  emitter.emitSubagentProgress(agentId, agentType, message, turn, toolName);
}

// Yield to event loop to prevent blocking and allow Ink to render
// Using setTimeout(0) instead of setImmediate gives React more time to flush
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// Longer yield for UI-critical moments (before long API calls)
function yieldForRender(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 16)); // ~1 frame at 60fps
}

export async function runSubagent(options: SubagentOptions): Promise<SubagentResult> {
  const { prompt, subagent_type, model = "sonnet", resume, max_turns, name, parentContext, parentTraceContext } = options;

  const agentId = resume || generateAgentId();
  const modelId = MODEL_MAP[model] || MODEL_MAP.sonnet;
  const cwd = process.cwd();
  const systemPrompt = buildAgentPrompt(subagent_type, cwd);
  const startTime = Date.now();
  const effectiveMaxTurns = max_turns ? Math.max(1, Math.min(50, max_turns)) : MAX_TURNS;

  // Extract short description from prompt (first sentence or 60 chars)
  const descMatch = prompt.match(/^[^.!?\n]+/);
  const shortDescription = name || (descMatch
    ? descMatch[0].slice(0, 60) + (descMatch[0].length > 60 ? "…" : "")
    : prompt.slice(0, 60) + (prompt.length > 60 ? "…" : ""));

  // Emit subagent start event
  const emitter = getGlobalEmitter();
  emitter.emitSubagentStart(agentId, subagent_type, model, shortDescription);

  // Load or create agent state
  let state = resume ? loadAgentState(resume) : null;
  if (!state) {
    state = {
      id: agentId,
      type: subagent_type,
      model: modelId,
      messages: [],
      toolsUsed: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const loopDetector = new LoopDetector();

  // Get filtered tools for this agent type
  const tools = await getFilteredTools(subagent_type);

  // Build full system prompt with optional parent context
  let fullSystemPrompt = systemPrompt;
  if (parentContext) {
    fullSystemPrompt += `\n\n## Parent Conversation Context\n${parentContext}`;
  }

  // Add CLAUDE.md if available
  const claudeMd = loadClaudeMd();
  if (claudeMd) {
    fullSystemPrompt += `\n\n## Project Instructions\n${claudeMd.content}`;
  }

  // Add user prompt to messages
  state.messages.push({ role: "user", content: prompt });

  let totalIn = 0;
  let totalOut = 0;
  let finalText = "";

  // Create subagent span context — inherit parent's trace context for hierarchy
  // IMPORTANT: Don't increment global turn number — subagent is part of parent turn
  const subagentSpanId = generateSpanId();
  const turnCtx = {
    source: "claude_code" as const,
    serviceName: "whale-cli",
    serviceVersion: "2.1.0",
    model: modelId,
    agentId,
    agentName: name || `subagent-${subagent_type}`,
    // Inherit parent's trace to keep hierarchy intact
    traceId: parentTraceContext?.traceId || generateTraceId(),
    spanId: subagentSpanId,
    parentSpanId: parentTraceContext?.spanId, // Parent's spanId becomes our parentSpanId
    conversationId: parentTraceContext?.conversationId,
    turnNumber: parentTraceContext?.turnNumber, // Inherit parent turn, don't increment
    userId: parentTraceContext?.userId,
    userEmail: parentTraceContext?.userEmail,
    traceFlags: 1,
  };

  try {
    for (let turn = 0; turn < effectiveMaxTurns; turn++) {
      // Emit progress and yield before API call to keep UI responsive
      emitSubagentProgress(subagent_type, agentId, `turn ${turn + 1}: calling API...`, turn + 1);
      await yieldForRender(); // Give Ink time to render the progress update

      // Use proxy-first API call
      const apiStart = Date.now();
      const response = await callAPI(
        modelId,
        fullSystemPrompt,
        state.messages,
        tools
      );
      const apiDuration = Date.now() - apiStart;

      // Yield after API call
      await yieldToEventLoop();

      totalIn += response.usage.input_tokens;
      totalOut += response.usage.output_tokens;

      // Log API call as child span
      logSpan({
        action: "claude_api_request",
        durationMs: apiDuration,
        context: {
          ...turnCtx,
          spanId: generateSpanId(), // New span for this API call
          parentSpanId: turnCtx.spanId, // Parent is the subagent
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          model: modelId,
        },
        details: {
          "gen_ai.request.model": modelId,
          "gen_ai.usage.input_tokens": response.usage.input_tokens,
          "gen_ai.usage.output_tokens": response.usage.output_tokens,
          agent_id: agentId,
          agent_type: subagent_type,
          turn: turn + 1,
          stop_reason: response.stop_reason,
          is_subagent_api: true,
        },
      });

      // Yield to event loop to keep UI responsive
      await yieldToEventLoop();

      // Extract text and tool use
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (textBlocks.length) {
        finalText = textBlocks.map((b) => b.text).join("\n");
      }

      // No tool calls — we're done
      if (toolBlocks.length === 0 || response.stop_reason === "end_turn") {
        emitSubagentProgress(subagent_type, agentId, `done (${turn + 1} turn${turn > 0 ? "s" : ""})`, turn + 1);
        break;
      }

      // Emit tool usage progress
      const toolNames = toolBlocks.map(b => b.name).join(", ");
      emitSubagentProgress(subagent_type, agentId, `using: ${toolNames}`, turn + 1);

      // Execute tools and log each as a child span
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolBlocks) {
        // Circuit breaker check
        const loopCheck = loopDetector.recordCall(tu.name, tu.input as Record<string, unknown>);
        if (loopCheck.blocked) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: loopCheck.reason }),
          });
          continue;
        }

        // Emit tool start events (both progress + structured)
        emitSubagentProgress(subagent_type, agentId, `running ${tu.name}`, turn + 1, tu.name);
        emitter.emitSubagentToolStart(agentId, tu.name, tu.input as Record<string, unknown>);

        const toolStart = Date.now();
        let result: { success: boolean; output: string };

        if (isLocalTool(tu.name)) {
          result = await executeLocalTool(tu.name, tu.input as Record<string, unknown>);
        } else if (isServerTool(tu.name)) {
          result = await executeServerTool(tu.name, tu.input as Record<string, unknown>, turnCtx);
        } else {
          result = { success: false, output: `Unknown tool: ${tu.name}` };
        }

        const toolDuration = Date.now() - toolStart;
        loopDetector.recordResult(tu.name, result.success);

        // Emit tool end event (structured)
        emitter.emitSubagentToolEnd(agentId, tu.name, result.success, toolDuration);

        // Log tool call as child span of the subagent
        logSpan({
          action: `tool.${tu.name}`,
          durationMs: toolDuration,
          context: {
            ...turnCtx,
            spanId: generateSpanId(),
            parentSpanId: turnCtx.spanId,
          },
          error: result.success ? undefined : result.output,
          details: {
            tool_type: "subagent_tool",
            tool_input: tu.input,
            tool_result: result.output.length <= 2000 ? result.output : result.output.slice(0, 2000) + `... (${result.output.length} chars total)`,
            description: (tu.input as Record<string, unknown>).description || (tu.input as Record<string, unknown>).command || (tu.input as Record<string, unknown>).path || undefined,
            error_type: result.success ? undefined : classifyToolError(result.output),
            agent_id: agentId,
            agent_type: subagent_type,
            is_subagent_tool: true,
            iteration: turn,
          },
        });

        // Track tool usage
        if (!state.toolsUsed.includes(tu.name)) {
          state.toolsUsed.push(tu.name);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result.success ? result.output : { error: result.output }),
        });

        // Yield to event loop after each tool
        await yieldToEventLoop();
      }

      // Append assistant response + tool results
      state.messages.push({
        role: "assistant",
        content: response.content,
      });
      state.messages.push({
        role: "user",
        content: toolResults,
      });
    }

    // Save state for potential resume
    state.updatedAt = new Date().toISOString();
    saveAgentState(state);

    // Log the subagent's final response as a chat.assistant_response span
    // This ensures the full output is visible in the telemetry waterfall
    if (finalText) {
      logSpan({
        action: "chat.assistant_response",
        durationMs: Date.now() - startTime,
        context: {
          ...turnCtx,
          spanId: generateSpanId(),
          parentSpanId: turnCtx.spanId,
          inputTokens: totalIn,
          outputTokens: totalOut,
        },
        details: {
          response: finalText,
          agent_id: agentId,
          agent_name: name || `subagent-${subagent_type}`,
          agent_type: subagent_type,
          is_subagent: true,
          model: modelId,
          input_tokens: totalIn,
          output_tokens: totalOut,
          turn_count: Math.floor(state.messages.length / 2),
          tool_calls: state.toolsUsed.length,
          tool_names: state.toolsUsed,
        },
      });
    }

    // Log telemetry with rich metadata for trace visualization
    logSpan({
      action: `subagent.${subagent_type}`,
      durationMs: Date.now() - new Date(state.createdAt).getTime(),
      context: {
        ...turnCtx,
        inputTokens: totalIn,
        outputTokens: totalOut,
      },
      details: {
        // Core identification
        agent_id: agentId,
        agent_type: subagent_type,
        model: modelId,

        // Execution metrics
        turns: state.messages.length / 2,
        tools_used: state.toolsUsed,
        tool_count: state.toolsUsed.length,

        // Hierarchy info for visualization
        is_subagent: true,
        parent_trace_id: parentTraceContext?.traceId,
        parent_span_id: parentTraceContext?.spanId,

        // Rich display metadata
        display_name: `${subagent_type.charAt(0).toUpperCase() + subagent_type.slice(1)} Agent`,
        display_icon: getAgentIcon(subagent_type),
        display_color: getAgentColor(subagent_type),

        // Summary for trace feed (2000 chars for meaningful preview)
        summary: finalText.slice(0, 2000) + (finalText.length > 2000 ? "..." : ""),
        prompt_preview: prompt.slice(0, 200) + (prompt.length > 200 ? "..." : ""),
      },
    });

    // Emit subagent done event
    emitter.emitSubagentDone(
      agentId,
      subagent_type,
      true,
      finalText || "(No output from agent)",
      { input: totalIn, output: totalOut },
      state.toolsUsed,
      Date.now() - startTime
    );

    return {
      success: true,
      output: finalText || "(No output from agent)",
      agentId,
      tokensUsed: { input: totalIn, output: totalOut },
      toolsUsed: state.toolsUsed,
    };
  } catch (err: any) {
    // Emit subagent error event
    emitter.emitSubagentDone(
      agentId,
      subagent_type,
      false,
      `Agent error: ${err.message || err}`,
      { input: totalIn, output: totalOut },
      state.toolsUsed,
      Date.now() - startTime
    );

    return {
      success: false,
      output: `Agent error: ${err.message || err}`,
      agentId,
      tokensUsed: { input: totalIn, output: totalOut },
      toolsUsed: state.toolsUsed,
    };
  }
}

// ============================================================================
// BACKGROUND AGENT EXECUTION
// ============================================================================

export async function runSubagentBackground(options: SubagentOptions): Promise<{ agentId: string; outputFile: string }> {
  const agentId = options.resume || generateAgentId();
  const outputFile = join(tmpdir(), `whale-agent-${agentId}.output`);

  // Write initial status
  writeFileSync(outputFile, `Agent ${agentId} started (${options.subagent_type})\n`, "utf-8");

  // Import background process tracker (dynamic to avoid circular deps)
  const bgModule = await import("./background-processes.js");
  bgModule.registerBackgroundAgent(agentId, options.subagent_type, outputFile);

  // Start agent in detached async — don't await
  runSubagent({ ...options, resume: undefined }).then(result => {
    appendFileSync(outputFile, `\n---DONE---\n${JSON.stringify({ success: result.success, agentId: result.agentId, output: result.output })}\n`, "utf-8");
    import("./background-processes.js").then(m => m.markAgentDone(agentId, result.success));
  }).catch(err => {
    appendFileSync(outputFile, `\n---ERROR---\n${err.message}\n`, "utf-8");
    import("./background-processes.js").then(m => m.markAgentDone(agentId, false));
  });

  return { agentId, outputFile };
}

// ============================================================================
// TOOL DEFINITION — for integration with main agent loop
// ============================================================================

// Following Claude Code pattern: discrete, focused tasks with clear completion criteria
export const TASK_TOOL_DEFINITION: Anthropic.Tool = {
  name: "task",
  description: `Launch a subagent for a DISCRETE, focused task. The agent runs autonomously and returns a summary.

IMPORTANT: Use for tasks completable in 2-6 turns, NOT open-ended exploration.

Agent types:
- explore: Find specific files/code (2-4 turns)
- plan: Create implementation plan (3-5 turns)
- general-purpose: Complete a specific task (4-6 turns)
- research: Look up specific info (2-4 turns)

Each agent has explicit stop conditions and will complete, not loop.`,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Specific task with clear completion criteria. Include: what to find/do, where to look, what to return.",
      },
      subagent_type: {
        type: "string",
        enum: ["explore", "plan", "general-purpose", "research"],
        description: "Agent type: explore=find, plan=design, general-purpose=do, research=lookup.",
      },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku"],
        description: "Haiku for simple lookups, Sonnet (default) for most, Opus for complex reasoning.",
      },
      resume: {
        type: "string",
        description: "Agent ID to resume (rarely needed).",
      },
    },
    required: ["prompt", "subagent_type"],
  },
};
