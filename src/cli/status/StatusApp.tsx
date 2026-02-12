/**
 * Status Dashboard with whale branding
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { createClient } from "@supabase/supabase-js";
import { resolveConfig, loadConfig } from "../services/config-store.js";
import { isLoggedIn, getValidToken, createAuthenticatedClient } from "../services/auth-service.js";
import { LOCAL_TOOL_NAMES } from "../services/local-tools.js";
import { WhaleBanner } from "../shared/WhaleBanner.js";
import { colors, symbols, boxLine } from "../shared/Theme.js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

function getVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf-8"));
    return pkg.version || "?";
  } catch { return "?"; }
}

interface StatusData {
  version: string;
  supabaseOk: boolean;
  storeId: string;
  storeName: string;
  serverTools: number;
  localTools: number;
  agents: Array<{ id: string; name: string; model: string; enabled_tools: string[] }>;
  loggedIn: boolean;
  email: string;
  error?: string;
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box>
      <Text color={colors.dim}>  {label.padEnd(18)}</Text>
      <Text color={color || colors.text}>{value}</Text>
    </Box>
  );
}

export function StatusApp() {
  const { exit } = useApp();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const config = resolveConfig();
      const file = loadConfig();
      const version = getVersion();
      const loggedIn = isLoggedIn();

      let supabase;
      if (loggedIn) {
        const token = await getValidToken();
        if (token) supabase = createAuthenticatedClient(token);
      } else if (config.supabaseUrl && config.supabaseKey) {
        supabase = createClient(config.supabaseUrl, config.supabaseKey);
      }

      if (!supabase) {
        setStatus({
          version, supabaseOk: false,
          storeId: config.storeId || file.store_id || "—",
          storeName: file.store_name || "",
          serverTools: 0, localTools: LOCAL_TOOL_NAMES.size,
          agents: [], loggedIn, email: file.email || "",
          error: loggedIn ? "Session expired. Run: whale login" : "Not configured. Run: whale login",
        });
        setLoading(false); return;
      }

      try {
        const [toolsRes, agentsRes, storeRes] = await Promise.all([
          supabase.from("ai_tool_registry").select("name").eq("is_active", true),
          supabase.from("ai_agent_config").select("id, name, model, enabled_tools").eq("is_active", true),
          (config.storeId || file.store_id)
            ? supabase.from("stores").select("name").eq("id", config.storeId || file.store_id).single()
            : Promise.resolve({ data: null, error: null }),
        ]);

        setStatus({
          version, supabaseOk: true,
          storeId: config.storeId || file.store_id || "—",
          storeName: file.store_name || storeRes.data?.name || "",
          serverTools: toolsRes.data?.length || 0,
                   localTools: LOCAL_TOOL_NAMES.size,
          agents: (agentsRes.data || []) as StatusData["agents"],
          loggedIn, email: file.email || "",
        });
      } catch (err) {
        setStatus({
          version, supabaseOk: false,
          storeId: config.storeId || file.store_id || "—",
          storeName: file.store_name || "",
          serverTools: 0, localTools: LOCAL_TOOL_NAMES.size,
          agents: [], loggedIn, email: file.email || "",
          error: `Connection failed: ${err}`,
        });
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!loading) { const t = setTimeout(() => exit(), 100); return () => clearTimeout(t); }
  }, [loading, exit]);

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <WhaleBanner version={getVersion()} />
        <Box height={1} />
        <Box>
          <Text color={colors.brand}>  <Spinner type="dots" /></Text>
          <Text color={colors.muted}> connecting…</Text>
        </Box>
      </Box>
    );
  }

  if (!status) return null;

  return (
    <Box flexDirection="column" padding={1}>
      <WhaleBanner version={status.version} />
      <Box height={1} />
      <Text color={colors.border}>{boxLine(44)}</Text>
      <Box height={1} />

      {/* Auth */}
      <Row
        label="auth"
        value={status.loggedIn ? `${symbols.check} logged in` : `${symbols.cross} not logged in`}
        color={status.loggedIn ? colors.success : colors.warning}
      />
      {status.email && <Row label="user" value={status.email} />}

      {/* Connection */}
      <Row
        label="supabase"
        value={status.supabaseOk ? `${symbols.check} connected` : `${symbols.cross} disconnected`}
        color={status.supabaseOk ? colors.success : colors.error}
      />
      {status.storeName && <Row label="store" value={status.storeName} />}
      {!status.storeName && <Row label="store id" value={status.storeId} />}

      {/* Tools */}
      <Box height={1} />
      <Row label="server tools" value={`${status.serverTools} (edge function)`} />
      <Row label="local tools" value={`${status.localTools} (file, shell, search)`} />

      {/* Only show Anthropic key in legacy mode */}
      {!status.loggedIn && (
        <Row
          label="anthropic key"
          value={resolveConfig().anthropicApiKey ? `${symbols.check} set` : `${symbols.cross} not set`}
          color={resolveConfig().anthropicApiKey ? colors.success : colors.warning}
        />
      )}

      {/* Agents */}
      {status.agents.length > 0 && (
        <>
          <Box height={1} />
          <Text color={colors.border}>{boxLine(44)}</Text>
          <Text color={colors.muted}>  agents</Text>
          <Box height={1} />
          {status.agents.map((agent) => (
            <Box key={agent.id} marginLeft={2}>
              <Text color={colors.brand}>{symbols.arrowRight} </Text>
              <Text color={colors.text} bold>{agent.name}</Text>
              <Text color={colors.dim}>  {agent.model}</Text>
              <Text color={colors.subtle}>  ({agent.enabled_tools?.length || "all"} tools)</Text>
            </Box>
          ))}
        </>
      )}

      {status.error && (
        <>
          <Box height={1} />
          <Text color={colors.error}>  {symbols.cross} {status.error}</Text>
        </>
      )}
    </Box>
  );
}
