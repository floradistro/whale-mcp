/**
 * OTA Auto-Updater for SwagManager MCP Server
 *
 * Checks the npm registry for newer versions and self-updates.
 * - Runs on server startup (non-blocking)
 * - Runs periodically (default: every 4 hours)
 * - Updates in-place via `npm install -g` or local install
 * - Signals the process to restart after update
 */

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import https from "https";

// ============================================================================
// CONFIG
// ============================================================================

const PACKAGE_NAME = "swagmanager-mcp";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

// ============================================================================
// HELPERS
// ============================================================================

function getCurrentVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseVersion(v: string): number[] {
  return v.replace(/^v/, "").split(".").map(Number);
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

function fetchLatestVersion(): Promise<{ version: string; changelog?: string } | null> {
  return new Promise((resolve) => {
    const req = https.get(REGISTRY_URL, { timeout: 10_000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve({
            version: data.version,
            changelog: data.changelog || data.description,
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function runNpmInstall(version: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["install", "-g", `${PACKAGE_NAME}@${version}`];
    console.error(`[updater] Running: npm ${args.join(" ")}`);

    execFile("npm", args, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[updater] Install failed: ${error.message}`);
        if (stderr) console.error(`[updater] stderr: ${stderr}`);
        resolve(false);
      } else {
        console.error(`[updater] Install succeeded`);
        if (stdout) console.error(`[updater] ${stdout.trim()}`);
        resolve(true);
      }
    });
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  updated: boolean;
}

/**
 * Check for updates and install if available.
 * Returns the result without restarting — caller decides restart behavior.
 */
export async function checkForUpdates(autoInstall = true): Promise<UpdateCheckResult> {
  const currentVersion = getCurrentVersion();

  const latest = await fetchLatestVersion();
  if (!latest) {
    console.error(`[updater] Could not reach npm registry (offline?)`);
    return { currentVersion, latestVersion: null, updateAvailable: false, updated: false };
  }

  const updateAvailable = isNewer(latest.version, currentVersion);

  if (!updateAvailable) {
    console.error(`[updater] Up to date (v${currentVersion})`);
    return { currentVersion, latestVersion: latest.version, updateAvailable: false, updated: false };
  }

  console.error(`[updater] Update available: v${currentVersion} → v${latest.version}`);

  if (!autoInstall) {
    return { currentVersion, latestVersion: latest.version, updateAvailable: true, updated: false };
  }

  const installed = await runNpmInstall(latest.version);

  if (installed) {
    console.error(`[updater] Updated to v${latest.version}. Restart to use new version.`);
  }

  return {
    currentVersion,
    latestVersion: latest.version,
    updateAvailable: true,
    updated: installed,
  };
}

/**
 * Start periodic update checks in the background.
 * First check runs immediately (non-blocking), then every CHECK_INTERVAL_MS.
 */
export function startUpdateLoop(autoInstall = true): NodeJS.Timeout {
  // Initial check (fire-and-forget)
  checkForUpdates(autoInstall).catch(() => {});

  // Periodic checks
  const timer = setInterval(() => {
    checkForUpdates(autoInstall).catch(() => {});
  }, CHECK_INTERVAL_MS);

  // Don't prevent process exit
  timer.unref();

  return timer;
}
