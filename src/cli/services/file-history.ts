/**
 * File History — backup files before modification
 *
 * On every write_file/edit_file/multi_edit, the original content is saved to:
 *   ~/.swagmanager/file-history/{sessionId}/{timestamp}-{basename}
 *
 * Limit: 100 backups per session (FIFO cleanup).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const HISTORY_BASE = join(homedir(), ".swagmanager", "file-history");
const MAX_BACKUPS_PER_SESSION = 100;

let currentSessionId: string | null = null;

export function setFileHistorySessionId(sessionId: string): void {
  currentSessionId = sessionId;
}

function getSessionDir(): string | null {
  if (!currentSessionId) return null;
  const dir = join(HISTORY_BASE, currentSessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Save a backup of a file before it is modified.
 * No-op if the file doesn't exist yet (new file creation).
 */
export function backupFile(filePath: string): void {
  if (!currentSessionId) return;
  if (!existsSync(filePath)) return;

  try {
    const dir = getSessionDir();
    if (!dir) return;

    const content = readFileSync(filePath);
    const ts = Date.now();
    const name = basename(filePath);
    const backupName = `${ts}-${name}`;
    const backupPath = join(dir, backupName);

    writeFileSync(backupPath, content);

    // FIFO cleanup
    cleanupOldBackups(dir);
  } catch {
    // Best effort — don't fail the actual operation
  }
}

function cleanupOldBackups(dir: string): void {
  try {
    const files = readdirSync(dir).sort();
    if (files.length > MAX_BACKUPS_PER_SESSION) {
      const toRemove = files.slice(0, files.length - MAX_BACKUPS_PER_SESSION);
      for (const f of toRemove) {
        try { unlinkSync(join(dir, f)); } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}

/**
 * List backups for the current session.
 */
export function listBackups(): Array<{ name: string; path: string }> {
  const dir = getSessionDir();
  if (!dir || !existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .sort()
      .reverse()
      .map(name => ({ name, path: join(dir, name) }));
  } catch {
    return [];
  }
}
