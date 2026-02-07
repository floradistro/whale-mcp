#!/usr/bin/env node

/**
 * SwagManager MCP Server CLI
 *
 * Usage:
 *   npx @swagmanager/mcp
 *   swagmanager-mcp
 *
 * Environment variables:
 *   SUPABASE_URL              - Your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Your Supabase service role key
 *   STORE_ID                  - Default store ID (optional)
 *   SWAG_API_KEY              - API key for auth (future)
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import and run the server
const serverPath = join(__dirname, "..", "dist", "index.js");
await import(serverPath);
