/**
 * LSP Manager — Language Server Protocol client for code intelligence
 *
 * Provides go-to-definition, find-references, hover, document/workspace symbols,
 * go-to-implementation, and call hierarchy via stdio JSON-RPC to language servers.
 *
 * Zero external dependencies — Node.js builtins only (child_process, Buffer).
 * Servers are lazy-spawned on first request and keyed by language + workspace root.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, dirname, extname } from "path";

// ============================================================================
// LANGUAGE CONFIG
// ============================================================================

interface LanguageConfig {
  id: string;               // Canonical server group (dedup key)
  languageIds: string[];     // LSP language IDs this server handles
  binaries: string[];        // Try in order
  args: string[];
  installHint: string;
}

const LANG_CONFIGS: LanguageConfig[] = [
  {
    id: "typescript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    binaries: ["typescript-language-server"],
    args: ["--stdio"],
    installHint: "npm i -g typescript-language-server typescript",
  },
  {
    id: "python",
    languageIds: ["python"],
    binaries: ["pyright-langserver", "pylsp", "python-language-server"],
    args: ["--stdio"],
    installHint: "npm i -g pyright",
  },
  {
    id: "rust",
    languageIds: ["rust"],
    binaries: ["rust-analyzer"],
    args: [],
    installHint: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    languageIds: ["go"],
    binaries: ["gopls"],
    args: ["serve"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "clangd",
    languageIds: ["c", "cpp"],
    binaries: ["clangd"],
    args: [],
    installHint: "brew install llvm (or apt install clangd)",
  },
  {
    id: "java",
    languageIds: ["java"],
    binaries: ["jdtls"],
    args: [],
    installHint: "brew install jdtls",
  },
];

const EXT_TO_LANGID: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".jsx": "javascriptreact",
  ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rs": "rust", ".go": "go",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".java": "java",
};

// Build lookup: languageId → config
const LANGID_TO_CONFIG = new Map<string, LanguageConfig>();
for (const cfg of LANG_CONFIGS) {
  for (const lid of cfg.languageIds) {
    LANGID_TO_CONFIG.set(lid, cfg);
  }
}

// ============================================================================
// JSON-RPC MESSAGE BUFFER
// ============================================================================

class MessageBuffer {
  private buffer = Buffer.alloc(0);

  append(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  tryRead(): object | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;

    const header = this.buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      this.buffer = this.buffer.subarray(headerEnd + 4);
      return null;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;

    if (this.buffer.length < bodyStart + contentLength) return null;

    const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
    this.buffer = this.buffer.subarray(bodyStart + contentLength);

    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
}

function encodeMessage(msg: object): Buffer {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.from(header + body, "utf-8");
}

// ============================================================================
// LSP SERVER
// ============================================================================

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OpenedFile {
  uri: string;
  version: number;
  contentHash: string;   // Quick change detection
  mtimeMs: number;       // Disk mtime when last synced
}

interface LSPServer {
  process: ChildProcess;
  configId: string;
  workspaceRoot: string;
  messageBuffer: MessageBuffer;
  nextId: number;
  pending: Map<number, PendingRequest>;
  openedFiles: Map<string, OpenedFile>;  // uri → file state
  ready: boolean;
  alive: boolean;
  projectIndexed: boolean;  // True after workspace/symbol probe succeeds
  capabilities: any;
  initPromise: Promise<void>;
}

const servers = new Map<string, LSPServer>();
const REQUEST_TIMEOUT = 30_000;
let cleanupRegistered = false;

// Simple content hash for change detection (fast, not crypto)
function quickHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function findBinary(binaries: string[]): string | null {
  for (const bin of binaries) {
    try {
      execSync(`which ${bin} 2>/dev/null`, { encoding: "utf-8" });
      return bin;
    } catch {
      continue;
    }
  }
  return null;
}

function findWorkspaceRoot(filePath: string): string {
  let dir = dirname(resolve(filePath));
  const markers = [".git", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py"];
  for (let i = 0; i < 20; i++) {
    for (const marker of markers) {
      if (existsSync(resolve(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(resolve(filePath));
}

function fileUri(filePath: string): string {
  const abs = resolve(filePath);
  return "file://" + abs.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return decodeURIComponent(uri.slice(7));
  return decodeURIComponent(uri);
}

// ============================================================================
// SERVER LIFECYCLE
// ============================================================================

function spawnServer(config: LanguageConfig, workspaceRoot: string): LSPServer {
  const binary = findBinary(config.binaries);
  if (!binary) {
    throw new Error(`No language server found for ${config.id}. Install: ${config.installHint}`);
  }

  const child = spawn(binary, config.args, {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const key = `${config.id}:${workspaceRoot}`;

  const server: LSPServer = {
    process: child,
    configId: config.id,
    workspaceRoot,
    messageBuffer: new MessageBuffer(),
    nextId: 1,
    pending: new Map(),
    openedFiles: new Map(),
    ready: false,
    alive: true,
    projectIndexed: false,
    capabilities: null,
    initPromise: Promise.resolve(),
  };

  child.stdout!.on("data", (data: Buffer) => {
    server.messageBuffer.append(data);
    let msg: object | null;
    while ((msg = server.messageBuffer.tryRead()) !== null) {
      handleMessage(server, msg as any);
    }
  });

  child.stderr!.on("data", () => { /* discard */ });

  child.on("exit", () => {
    server.alive = false;
    servers.delete(key);
    for (const [, req] of server.pending) {
      clearTimeout(req.timer);
      req.reject(new Error("Language server exited"));
    }
    server.pending.clear();
  });

  // Register cleanup on first server
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", shutdownAll);
    process.on("SIGINT", () => { shutdownAll(); process.exit(0); });
    process.on("SIGTERM", () => { shutdownAll(); process.exit(0); });
  }

  server.initPromise = initializeServer(server);
  servers.set(key, server);
  return server;
}

async function getOrCreateServer(filePath: string): Promise<LSPServer> {
  const ext = extname(filePath).toLowerCase();
  const langId = EXT_TO_LANGID[ext];
  if (!langId) throw new Error(`No language server configured for ${ext} files`);

  const config = LANGID_TO_CONFIG.get(langId);
  if (!config) throw new Error(`No language config for ${langId}`);

  const workspaceRoot = findWorkspaceRoot(filePath);
  const key = `${config.id}:${workspaceRoot}`;

  const existing = servers.get(key);

  // Auto-restart: if server died, remove and respawn
  if (existing && !existing.alive) {
    servers.delete(key);
  } else if (existing && existing.ready) {
    return existing;
  } else if (existing) {
    await existing.initPromise;
    return existing;
  }

  const server = spawnServer(config, workspaceRoot);
  await server.initPromise;
  return server;
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

function handleMessage(server: LSPServer, msg: any): void {
  // Response to a request we sent
  if ("id" in msg && "result" in msg || "id" in msg && "error" in msg) {
    if (server.pending.has(msg.id)) {
      const req = server.pending.get(msg.id)!;
      server.pending.delete(msg.id);
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        req.resolve(msg.result);
      }
      return;
    }
  }

  // Server-initiated request — respond to avoid timeouts on the server side
  if ("id" in msg && "method" in msg) {
    const response: any = { jsonrpc: "2.0", id: msg.id };
    switch (msg.method) {
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
        response.result = null;
        break;
      case "workspace/configuration":
        // Return empty config for each requested scope
        response.result = (msg.params?.items || []).map(() => ({}));
        break;
      case "window/showMessageRequest":
        response.result = null; // Dismiss
        break;
      default:
        response.result = null;
        break;
    }
    server.process.stdin!.write(encodeMessage(response));
    return;
  }

  // Other notifications (diagnostics, etc.) silently ignored
}

function sendRequest(server: LSPServer, method: string, params: any): Promise<any> {
  if (!server.alive) return Promise.reject(new Error("Language server is not running"));
  return new Promise((resolve, reject) => {
    const id = server.nextId++;
    const timer = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`LSP request timed out: ${method}`));
    }, REQUEST_TIMEOUT);

    server.pending.set(id, { resolve, reject, timer });
    server.process.stdin!.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
  });
}

function sendNotification(server: LSPServer, method: string, params: any): void {
  if (!server.alive) return;
  server.process.stdin!.write(encodeMessage({ jsonrpc: "2.0", method, params }));
}

async function initializeServer(server: LSPServer): Promise<void> {
  const result = await sendRequest(server, "initialize", {
    processId: process.pid,
    rootUri: fileUri(server.workspaceRoot),
    rootPath: server.workspaceRoot,
    capabilities: {
      textDocument: {
        synchronization: {
          didOpen: true,
          didClose: true,
          didChange: 1, // Full content sync
          willSave: false,
          willSaveWaitUntil: false,
          didSave: false,
        },
        definition: { dynamicRegistration: false },
        references: { dynamicRegistration: false },
        hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        implementation: { dynamicRegistration: false },
        callHierarchy: { dynamicRegistration: false },
      },
      workspace: {
        symbol: { dynamicRegistration: false },
        workspaceFolders: true,
        configuration: true,
      },
      window: {
        workDoneProgress: true,
      },
    },
    workspaceFolders: [{ uri: fileUri(server.workspaceRoot), name: server.workspaceRoot.split("/").pop() }],
  });

  server.capabilities = result.capabilities;
  sendNotification(server, "initialized", {});
  server.ready = true;
}

// ============================================================================
// DOCUMENT SYNC
// ============================================================================

/**
 * Open or re-sync a file with the language server.
 * - First open: sends didOpen + probes with documentSymbol to ensure server is ready
 * - Subsequent: checks mtime → if changed, sends didChange + re-probes
 *
 * The probe (documentSymbol request) is key: the server must fully parse the file
 * to respond, so when it returns we know all symbols/types are available.
 * This is more reliable than waiting for diagnostics notifications.
 */
async function ensureFileOpen(server: LSPServer, filePath: string): Promise<void> {
  const uri = fileUri(filePath);
  const absPath = resolve(filePath);

  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(absPath, "utf-8");
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    throw new Error(`Cannot read file: ${filePath}`);
  }

  const hash = quickHash(text);
  const existing = server.openedFiles.get(uri);

  if (existing) {
    // Already open — check if content changed
    if (existing.mtimeMs === mtimeMs && existing.contentHash === hash) {
      return; // No changes
    }

    // File changed on disk — send didChange with full content
    existing.version++;
    existing.contentHash = hash;
    existing.mtimeMs = mtimeMs;

    sendNotification(server, "textDocument/didChange", {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    });

    // Probe: force server to re-process the file before we query it
    await sendRequest(server, "textDocument/documentSymbol", { textDocument: { uri } });
    return;
  }

  // First open
  const ext = extname(filePath).toLowerCase();
  const langId = EXT_TO_LANGID[ext] || "plaintext";

  const openedFile: OpenedFile = { uri, version: 1, contentHash: hash, mtimeMs };
  server.openedFiles.set(uri, openedFile);

  sendNotification(server, "textDocument/didOpen", {
    textDocument: { uri, languageId: langId, version: 1, text },
  });

  // Probe: documentSymbol ensures the server has parsed this file's AST.
  await sendRequest(server, "textDocument/documentSymbol", { textDocument: { uri } });

  // On first file open, also probe with workspace/symbol to wait for full
  // project indexing (type checking, cross-file resolution). This takes ~10s
  // on cold start but is essential for hover/definition to work correctly.
  // Subsequent files skip this since the project is already indexed.
  if (!server.projectIndexed) {
    await sendRequest(server, "workspace/symbol", { query: "" });
    server.projectIndexed = true;
  }
}

/**
 * Notify server that a file was modified externally (by edit_file, write_file, etc.).
 * Call this from local-tools after any file modification.
 */
export function notifyFileChanged(filePath: string): void {
  const absPath = resolve(filePath);
  const uri = fileUri(absPath);

  // Find any server that has this file open and invalidate it
  for (const server of servers.values()) {
    const opened = server.openedFiles.get(uri);
    if (opened) {
      // Force mtime to 0 so next ensureFileOpen detects the change
      opened.mtimeMs = 0;
    }
  }
}

// ============================================================================
// OPERATIONS
// ============================================================================

type Operation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";

const OPERATIONS = new Set<Operation>([
  "goToDefinition", "findReferences", "hover",
  "documentSymbol", "workspaceSymbol", "goToImplementation",
  "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
]);

function toPosition(line: number, character: number): { line: number; character: number } {
  return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
}

async function runOperation(
  operation: Operation,
  server: LSPServer,
  filePath: string,
  line: number,
  character: number,
  query?: string,
): Promise<string> {
  const uri = fileUri(filePath);
  const pos = toPosition(line, character);

  switch (operation) {
    case "goToDefinition": {
      const result = await sendRequest(server, "textDocument/definition", {
        textDocument: { uri }, position: pos,
      });
      return formatLocations(result, "Definition");
    }

    case "findReferences": {
      const result = await sendRequest(server, "textDocument/references", {
        textDocument: { uri }, position: pos,
        context: { includeDeclaration: true },
      });
      return formatLocations(result, "References");
    }

    case "hover": {
      const result = await sendRequest(server, "textDocument/hover", {
        textDocument: { uri }, position: pos,
      });
      return formatHover(result);
    }

    case "documentSymbol": {
      const result = await sendRequest(server, "textDocument/documentSymbol", {
        textDocument: { uri },
      });
      return formatDocumentSymbols(result, filePath);
    }

    case "workspaceSymbol": {
      const result = await sendRequest(server, "workspace/symbol", {
        query: query || "",
      });
      return formatWorkspaceSymbols(result);
    }

    case "goToImplementation": {
      const result = await sendRequest(server, "textDocument/implementation", {
        textDocument: { uri }, position: pos,
      });
      return formatLocations(result, "Implementations");
    }

    case "prepareCallHierarchy": {
      const result = await sendRequest(server, "textDocument/prepareCallHierarchy", {
        textDocument: { uri }, position: pos,
      });
      return formatCallHierarchyItems(result);
    }

    case "incomingCalls": {
      const items = await sendRequest(server, "textDocument/prepareCallHierarchy", {
        textDocument: { uri }, position: pos,
      });
      if (!items || (Array.isArray(items) && items.length === 0)) {
        return "No call hierarchy item found at this position.";
      }
      const item = Array.isArray(items) ? items[0] : items;
      const result = await sendRequest(server, "callHierarchy/incomingCalls", { item });
      return formatIncomingCalls(result);
    }

    case "outgoingCalls": {
      const items = await sendRequest(server, "textDocument/prepareCallHierarchy", {
        textDocument: { uri }, position: pos,
      });
      if (!items || (Array.isArray(items) && items.length === 0)) {
        return "No call hierarchy item found at this position.";
      }
      const item = Array.isArray(items) ? items[0] : items;
      const result = await sendRequest(server, "callHierarchy/outgoingCalls", { item });
      return formatOutgoingCalls(result);
    }

    default:
      return `Unknown operation: ${operation}`;
  }
}

// ============================================================================
// RESULT FORMATTERS
// ============================================================================

function normalizeLocations(result: any): Array<{ uri: string; range: any }> {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.map(item => {
      if (item.targetUri) {
        return { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange };
      }
      return item;
    });
  }
  if (result.uri) return [result];
  if (result.targetUri) {
    return [{ uri: result.targetUri, range: result.targetSelectionRange || result.targetRange }];
  }
  return [];
}

function formatLocations(result: any, label: string): string {
  const locations = normalizeLocations(result);
  if (locations.length === 0) return `No ${label.toLowerCase()} found.`;

  const byFile = new Map<string, Array<{ line: number; char: number }>>();
  for (const loc of locations) {
    const path = uriToPath(loc.uri);
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path)!.push({
      line: loc.range.start.line + 1,
      char: loc.range.start.character + 1,
    });
  }

  const lines: string[] = [`${label} (${locations.length}):`];
  for (const [path, positions] of byFile) {
    if (byFile.size > 1) lines.push(`  ${path}`);
    for (const pos of positions) {
      const prefix = byFile.size > 1 ? "    " : "  ";
      lines.push(`${prefix}${path}:${pos.line}:${pos.char}`);
    }
  }
  return lines.join("\n");
}

function formatHover(result: any): string {
  if (!result || !result.contents) return "No hover information.";

  const contents = result.contents;
  if (typeof contents === "string") return contents;

  if (contents.kind === "markdown" || contents.kind === "plaintext") {
    return contents.value || "";
  }

  if (contents.language && contents.value) {
    return `\`\`\`${contents.language}\n${contents.value}\n\`\`\``;
  }

  if (Array.isArray(contents)) {
    return contents
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c.language && c.value) return `\`\`\`${c.language}\n${c.value}\n\`\`\``;
        if (c.value) return c.value;
        return String(c);
      })
      .join("\n\n");
  }

  return JSON.stringify(contents, null, 2);
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind] || `Kind(${kind})`;
}

function formatDocumentSymbols(result: any, filePath: string): string {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return `No symbols found in ${filePath}`;
  }

  const lines: string[] = [`Symbols in ${filePath}:`];

  function walk(symbols: any[], indent: number): void {
    for (const sym of symbols) {
      const kind = symbolKindName(sym.kind);
      const line = sym.range?.start?.line != null
        ? sym.range.start.line + 1
        : sym.location?.range?.start?.line != null
          ? sym.location.range.start.line + 1
          : "?";
      lines.push(`${"  ".repeat(indent + 1)}${kind} ${sym.name}  :${line}`);
      if (sym.children?.length) walk(sym.children, indent + 1);
    }
  }

  walk(result, 0);
  return lines.join("\n");
}

function formatWorkspaceSymbols(result: any): string {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return "No workspace symbols found.";
  }

  const lines: string[] = [`Workspace symbols (${result.length}):`];
  for (const sym of result.slice(0, 100)) {
    const kind = symbolKindName(sym.kind);
    const path = sym.location?.uri ? uriToPath(sym.location.uri) : "?";
    const line = sym.location?.range?.start?.line != null ? sym.location.range.start.line + 1 : "?";
    lines.push(`  ${kind} ${sym.name}  ${path}:${line}`);
  }
  if (result.length > 100) lines.push(`  ... and ${result.length - 100} more`);
  return lines.join("\n");
}

function formatCallHierarchyItems(result: any): string {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return "No call hierarchy item found at this position.";
  }

  const lines: string[] = ["Call hierarchy items:"];
  for (const item of result) {
    const kind = symbolKindName(item.kind);
    const path = item.uri ? uriToPath(item.uri) : "?";
    const line = item.range?.start?.line != null ? item.range.start.line + 1 : "?";
    lines.push(`  ${kind} ${item.name}  ${path}:${line}`);
  }
  return lines.join("\n");
}

function formatIncomingCalls(result: any): string {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return "No incoming calls found.";
  }

  const lines: string[] = [`Incoming calls (${result.length}):`];
  for (const call of result) {
    const from = call.from;
    const kind = symbolKindName(from.kind);
    const path = from.uri ? uriToPath(from.uri) : "?";
    const line = from.range?.start?.line != null ? from.range.start.line + 1 : "?";
    lines.push(`  ${kind} ${from.name}  ${path}:${line}`);
  }
  return lines.join("\n");
}

function formatOutgoingCalls(result: any): string {
  if (!result || !Array.isArray(result) || result.length === 0) {
    return "No outgoing calls found.";
  }

  const lines: string[] = [`Outgoing calls (${result.length}):`];
  for (const call of result) {
    const to = call.to;
    const kind = symbolKindName(to.kind);
    const path = to.uri ? uriToPath(to.uri) : "?";
    const line = to.range?.start?.line != null ? to.range.start.line + 1 : "?";
    lines.push(`  ${kind} ${to.name}  ${path}:${line}`);
  }
  return lines.join("\n");
}

// ============================================================================
// CLEANUP
// ============================================================================

function shutdownAll(): void {
  for (const [key, server] of servers) {
    try {
      const id = server.nextId++;
      server.process.stdin!.write(encodeMessage({ jsonrpc: "2.0", id, method: "shutdown", params: null }));
      sendNotification(server, "exit", null);
      setTimeout(() => {
        try { server.process.kill("SIGTERM"); } catch { /* dead */ }
      }, 2000);
    } catch {
      try { server.process.kill("SIGTERM"); } catch { /* dead */ }
    }
    servers.delete(key);
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function executeLSP(
  operation: string,
  input: Record<string, unknown>,
): Promise<{ success: boolean; output: string }> {
  const op = operation as Operation;
  if (!OPERATIONS.has(op)) {
    return {
      success: false,
      output: `Unknown LSP operation: ${operation}. Valid: ${[...OPERATIONS].join(", ")}`,
    };
  }

  const filePath = input.filePath as string;
  const line = input.line as number;
  const character = input.character as number;
  const query = input.query as string | undefined;

  if (!filePath) return { success: false, output: "filePath is required" };
  if (!line || line < 1) return { success: false, output: "line is required (1-based)" };
  if (!character || character < 1) return { success: false, output: "character is required (1-based)" };

  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { success: false, output: `File not found: ${resolved}` };
  }

  try {
    const server = await getOrCreateServer(resolved);
    await ensureFileOpen(server, resolved);
    const result = await runOperation(op, server, resolved, line, character, query);
    return { success: true, output: result };
  } catch (err: any) {
    return { success: false, output: `LSP error: ${err.message || err}` };
  }
}
