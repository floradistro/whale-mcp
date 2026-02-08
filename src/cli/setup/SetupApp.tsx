/**
 * Setup Wizard (Ink)
 *
 * Step-by-step wizard: detect CLIs → collect Supabase creds → collect Anthropic key
 * → pick CLIs to install → write configs + ~/.swagmanager/config.json
 *
 * Usage: npx swagmanager-mcp setup
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { saveConfig } from "../services/config-store.js";
import { colors, symbols } from "../shared/Theme.js";

// ============================================================================
// CLI TARGETS
// ============================================================================

interface CLITarget {
  name: string;
  configPath: string;
  configKey: string;
  detected: boolean;
}

const home = homedir();

function detectCLIs(): CLITarget[] {
  return [
    {
      name: "Claude Code",
      configPath: join(home, ".claude", "settings.json"),
      configKey: "mcpServers",
      detected: existsSync(join(home, ".claude")),
    },
    {
      name: "Claude Desktop",
      configPath:
        process.platform === "darwin"
          ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
      configKey: "mcpServers",
      detected: existsSync(
        process.platform === "darwin"
          ? join(home, "Library", "Application Support", "Claude")
          : join(home, "AppData", "Roaming", "Claude")
      ),
    },
    {
      name: "Cursor",
      configPath: join(home, ".cursor", "mcp.json"),
      configKey: "mcpServers",
      detected: existsSync(join(home, ".cursor")),
    },
    {
      name: "Windsurf",
      configPath: join(home, ".codeium", "windsurf", "mcp_config.json"),
      configKey: "mcpServers",
      detected: existsSync(join(home, ".codeium", "windsurf")),
    },
    {
      name: "Gemini CLI",
      configPath: join(home, ".gemini", "settings.json"),
      configKey: "mcpServers",
      detected: existsSync(join(home, ".gemini")),
    },
  ];
}

function readJSON(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeJSON(path: string, data: Record<string, any>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ============================================================================
// STEPS
// ============================================================================

type Step = "detect" | "supabase_url" | "supabase_key" | "store_id" | "anthropic_key" | "select_clis" | "done";

export function SetupApp() {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("detect");
  const [clis, setClis] = useState<CLITarget[]>([]);
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseKey, setSupabaseKey] = useState("");
  const [storeId, setStoreId] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [selectedClis, setSelectedClis] = useState<Set<string>>(new Set());
  const [installedCount, setInstalledCount] = useState(0);
  const [inputValue, setInputValue] = useState("");

  // Detect CLIs on mount
  useEffect(() => {
    const detected = detectCLIs();
    setClis(detected);
    // Pre-select all detected CLIs
    setSelectedClis(new Set(detected.filter(c => c.detected).map(c => c.name)));
    // Skip detection screen, go straight to input
    const timer = setTimeout(() => setStep("supabase_url"), 50);
    return () => clearTimeout(timer);
  }, []);

  // Auto-exit after done
  useEffect(() => {
    if (step === "done") {
      const timer = setTimeout(() => exit(), 200);
      return () => clearTimeout(timer);
    }
  }, [step, exit]);

  const handleSubmit = (value: string) => {
    switch (step) {
      case "supabase_url":
        if (!value.trim()) return;
        setSupabaseUrl(value.trim());
        setInputValue("");
        setStep("supabase_key");
        break;
      case "supabase_key":
        if (!value.trim()) return;
        setSupabaseKey(value.trim());
        setInputValue("");
        setStep("store_id");
        break;
      case "store_id":
        setStoreId(value.trim());
        setInputValue("");
        setStep("anthropic_key");
        break;
      case "anthropic_key":
        setAnthropicKey(value.trim());
        setInputValue("");
        setStep("select_clis");
        break;
    }
  };

  const installToSelected = () => {
    const serverEntry = {
      type: "stdio",
      command: "npx",
      args: ["-y", "swagmanager-mcp"],
      env: {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: supabaseKey,
        ...(storeId ? { STORE_ID: storeId } : {}),
      },
    };

    let count = 0;
    for (const cli of clis) {
      if (!selectedClis.has(cli.name)) continue;
      const config = readJSON(cli.configPath);
      if (!config[cli.configKey]) config[cli.configKey] = {};
      config[cli.configKey].swagmanager = serverEntry;
      writeJSON(cli.configPath, config);
      count++;
    }

    // Also save to ~/.swagmanager/config.json
    saveConfig({
      supabase_url: supabaseUrl,
      supabase_key: supabaseKey,
      ...(storeId ? { store_id: storeId } : {}),
      ...(anthropicKey ? { anthropic_api_key: anthropicKey } : {}),
    });

    setInstalledCount(count);
    setStep("done");
  };

  const detectedClis = clis.filter(c => c.detected);

  return (
    <Box flexDirection="column" padding={1}>
      <Text color={colors.brand} bold>SwagManager MCP — Setup</Text>
      <Text color={colors.dim}>{symbols.divider.repeat(40)}</Text>
      <Box height={1} />

      {/* CLI Detection */}
      {clis.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={colors.muted}>Detected CLIs:</Text>
          {clis.map(cli => (
            <Text key={cli.name} color={cli.detected ? colors.success : colors.dim}>
              {"  "}{cli.detected ? symbols.check : symbols.cross} {cli.name}
            </Text>
          ))}
        </Box>
      )}

      {/* Supabase URL */}
      {step === "supabase_url" && (
        <Box>
          <Text color={colors.text}>Supabase URL: </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Box>
      )}
      {step !== "supabase_url" && supabaseUrl && (
        <Text color={colors.muted}>Supabase URL: {supabaseUrl.slice(0, 40)}...</Text>
      )}

      {/* Supabase Key */}
      {step === "supabase_key" && (
        <Box>
          <Text color={colors.text}>Service Role Key: </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Box>
      )}
      {step !== "supabase_key" && step !== "supabase_url" && supabaseKey && (
        <Text color={colors.muted}>Service Role Key: {symbols.check} Set</Text>
      )}

      {/* Store ID */}
      {step === "store_id" && (
        <Box>
          <Text color={colors.text}>Store ID (optional, enter to skip): </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Box>
      )}

      {/* Anthropic Key */}
      {step === "anthropic_key" && (
        <Box>
          <Text color={colors.text}>Anthropic API Key (for chat mode, enter to skip): </Text>
          <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} />
        </Box>
      )}

      {/* CLI Selection */}
      {step === "select_clis" && detectedClis.length > 0 && (
        <Box flexDirection="column">
          <Text color={colors.text}>Install to detected CLIs? (Enter to confirm)</Text>
          <Box height={1} />
          <CLISelector
            clis={detectedClis}
            selected={selectedClis}
            onToggle={(name) => {
              setSelectedClis(prev => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              });
            }}
            onConfirm={installToSelected}
          />
        </Box>
      )}
      {step === "select_clis" && detectedClis.length === 0 && (
        <Box flexDirection="column">
          <Text color={colors.warning}>No MCP clients detected. Saving config only.</Text>
          <ConfirmButton onConfirm={installToSelected} />
        </Box>
      )}

      {/* Done */}
      {step === "done" && (
        <Box flexDirection="column">
          <Box height={1} />
          <Text color={colors.success} bold>
            {symbols.check} Setup complete!
          </Text>
          {installedCount > 0 && (
            <Text color={colors.muted}>
              Installed to {installedCount} CLI{installedCount > 1 ? "s" : ""}. Restart to load.
            </Text>
          )}
          <Text color={colors.muted}>Config saved to ~/.swagmanager/config.json</Text>
          {anthropicKey && <Text color={colors.muted}>Chat mode ready: npx swagmanager-mcp chat</Text>}
        </Box>
      )}
    </Box>
  );
}

function CLISelector({
  clis,
  selected,
  onToggle,
  onConfirm,
}: {
  clis: CLITarget[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onConfirm: () => void;
}) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow) setCursor(c => Math.min(clis.length, c + 1));
    else if (input === " " && cursor < clis.length) onToggle(clis[cursor].name);
    else if (key.return) onConfirm();
  });

  return (
    <Box flexDirection="column">
      {clis.map((cli, i) => (
        <Text key={cli.name} color={i === cursor ? colors.brand : colors.text}>
          {i === cursor ? symbols.chevron : " "} [{selected.has(cli.name) ? "x" : " "}] {cli.name}
        </Text>
      ))}
      <Text color={cursor === clis.length ? colors.brand : colors.success}>
        {cursor === clis.length ? symbols.chevron : " "} {symbols.arrow} Confirm & Install
      </Text>
      <Box height={1} />
      <Text color={colors.dim}>Space to toggle, Enter to confirm</Text>
    </Box>
  );
}

function ConfirmButton({ onConfirm }: { onConfirm: () => void }) {
  useInput((_input, key) => {
    if (key.return) onConfirm();
  });

  return <Text color={colors.muted}>Press Enter to save config...</Text>;
}
