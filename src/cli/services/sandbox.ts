/**
 * Bash Sandbox — macOS sandbox-exec wrapper for shell commands
 *
 * Restricts file writes to:
 *   - Current working directory (cwd)
 *   - /tmp and /private/tmp
 *   - ~/.swagmanager/
 *   - /dev (for terminal I/O)
 *   - /private/var/folders (macOS temp)
 *
 * Allows all reads and network access.
 * Only active on macOS. Linux: passthrough (future work).
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

// ============================================================================
// SANDBOX PROFILE
// ============================================================================

function buildSandboxProfile(cwd: string): string {
  const home = homedir();
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "${home}/.swagmanager"))
(allow file-write* (subpath "/dev"))
(allow file-write* (subpath "/private/var/folders"))
`;
}

// ============================================================================
// TEMP PROFILE MANAGEMENT
// ============================================================================

const SANDBOX_DIR = join(homedir(), ".swagmanager", "sandbox");
let profileCounter = 0;

function writeTempProfile(profile: string): string {
  if (!existsSync(SANDBOX_DIR)) {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  }
  const profilePath = join(SANDBOX_DIR, `profile-${process.pid}-${profileCounter++}.sb`);
  writeFileSync(profilePath, profile, "utf-8");
  return profilePath;
}

function cleanupProfile(profilePath: string): void {
  try {
    if (existsSync(profilePath)) unlinkSync(profilePath);
  } catch { /* best effort */ }
}

// ============================================================================
// SHELL ESCAPING
// ============================================================================

function shellEscape(s: string): string {
  // Use single quotes and escape any existing single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Wrap a command with macOS sandbox-exec.
 * Returns the original command unchanged on non-macOS platforms.
 */
export function sandboxCommand(command: string, cwd: string): { wrapped: string; profilePath: string | null } {
  if (process.platform !== "darwin") {
    return { wrapped: command, profilePath: null };
  }

  const profile = buildSandboxProfile(cwd);
  const profilePath = writeTempProfile(profile);

  const wrapped = `sandbox-exec -f ${shellEscape(profilePath)} /bin/bash -c ${shellEscape(command)}`;

  return { wrapped, profilePath };
}

/**
 * Clean up sandbox profile after command execution.
 */
export function cleanupSandbox(profilePath: string | null): void {
  if (profilePath) cleanupProfile(profilePath);
}

/**
 * Check if sandbox-exec is available on this platform.
 */
export function isSandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const { execSync } = require("child_process");
    execSync("which sandbox-exec", { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
