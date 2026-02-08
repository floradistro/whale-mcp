/**
 * Login/Signup Flow with whale branding
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import SelectInput from "ink-select-input";
import {
  signIn,
  signUp,
  getStoresForUser,
  selectStore,
  type StoreInfo,
} from "../services/auth-service.js";
import { WhaleBanner } from "../shared/WhaleBanner.js";
import { colors, symbols, boxLine } from "../shared/Theme.js";

type Step = "mode" | "email" | "password" | "authenticating" | "store_select" | "done" | "error";

export function LoginApp() {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("mode");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [error, setError] = useState("");
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [resultEmail, setResultEmail] = useState("");
  const [resultStore, setResultStore] = useState("");

  useEffect(() => {
    if (step === "done") {
      const timer = setTimeout(() => exit(), 300);
      return () => clearTimeout(timer);
    }
  }, [step, exit]);

  const handleModeSubmit = (value: string) => {
    if (value === "1" || value.toLowerCase().startsWith("l")) {
      setMode("login"); setStep("email");
    } else if (value === "2" || value.toLowerCase().startsWith("s")) {
      setMode("signup"); setStep("email");
    }
    setInputValue("");
  };

  const handleEmailSubmit = (value: string) => {
    if (!value.trim()) return;
    setEmail(value.trim()); setInputValue(""); setStep("password");
  };

  const handlePasswordSubmit = async (value: string) => {
    if (!value.trim()) return;
    setInputValue(""); setStep("authenticating");

    try {
      const result = mode === "login"
        ? await signIn(email, value)
        : await signUp(email, value);

      if (!result.success) { setError(result.error || "Authentication failed"); setStep("error"); return; }
      if (result.error && !result.config) { setError(result.error); setStep("error"); return; }

      const config = result.config!;
      setResultEmail(config.email || email);

      if (config.store_id) {
        setResultStore(config.store_name || config.store_id);
        setStep("done");
      } else {
        const userStores = await getStoresForUser(config.access_token!, config.user_id!);
        if (userStores.length === 0) { setError("No stores found. Contact your admin."); setStep("error"); }
        else if (userStores.length === 1) {
          selectStore(userStores[0].id, userStores[0].name);
          setResultStore(userStores[0].name); setStep("done");
        } else {
          setStores(userStores); setStep("store_select");
        }
      }
    } catch (err) { setError(String(err)); setStep("error"); }
  };

  const handleStoreSelect = (item: { label: string; value: string }) => {
    const store = stores.find((s) => s.id === item.value);
    if (store) { selectStore(store.id, store.name); setResultStore(store.name); setStep("done"); }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <WhaleBanner subtitle="authenticate" />
      <Box height={1} />
      <Text color={colors.border}>{boxLine(44)}</Text>
      <Box height={1} />

      {step === "mode" && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={colors.muted}>  1 </Text>
            <Text color={colors.text}>Login to existing account</Text>
          </Box>
          <Box marginBottom={1}>
            <Text color={colors.muted}>  2 </Text>
            <Text color={colors.text}>Create new account</Text>
          </Box>
          <Box height={1} />
          <Box>
            <Text color={colors.brand}>{symbols.arrowRight} </Text>
            <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleModeSubmit} placeholder="1 or 2" />
          </Box>
        </Box>
      )}

      {step === "email" && (
        <Box flexDirection="column">
          <Text color={colors.muted}>{mode === "login" ? "Login" : "Sign Up"}</Text>
          <Box height={1} />
          <Box>
            <Text color={colors.brand}>email </Text>
            <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleEmailSubmit} />
          </Box>
        </Box>
      )}

      {step === "password" && (
        <Box flexDirection="column">
          <Text color={colors.dim}>email: {email}</Text>
          <Box height={1} />
          <Box>
            <Text color={colors.brand}>password </Text>
            <TextInput value={inputValue} onChange={setInputValue} mask="*" onSubmit={handlePasswordSubmit} />
          </Box>
        </Box>
      )}

      {step === "authenticating" && (
        <Box>
          <Text color={colors.brand}><Spinner type="dots" /></Text>
          <Text color={colors.muted}> authenticating…</Text>
        </Box>
      )}

      {step === "store_select" && (
        <Box flexDirection="column">
          <Text color={colors.muted}>Select your store:</Text>
          <Box height={1} />
          <SelectInput
            items={stores.map((s) => ({ label: s.name + (s.slug ? ` (${s.slug})` : ""), value: s.id }))}
            onSelect={handleStoreSelect}
            indicatorComponent={({ isSelected }) => (
              <Text color={isSelected ? colors.brand : colors.dim}>
                {isSelected ? symbols.arrowRight : " "}{" "}
              </Text>
            )}
          />
        </Box>
      )}

      {step === "done" && (
        <Box flexDirection="column">
          <Box>
            <Text color={colors.success}>{symbols.check} </Text>
            <Text color={colors.text} bold>Logged in</Text>
          </Box>
          <Box height={1} />
          <Box>
            <Text color={colors.dim}>{"  "}user  </Text>
            <Text color={colors.text}>{resultEmail}</Text>
          </Box>
          <Box>
            <Text color={colors.dim}>{"  "}store </Text>
            <Text color={colors.text}>{resultStore}</Text>
          </Box>
          <Box height={1} />
          <Text color={colors.muted}>  Run `whale` to start chatting.</Text>
        </Box>
      )}

      {step === "error" && (
        <Box flexDirection="column">
          <Box>
            <Text color={colors.error}>{symbols.cross} </Text>
            <Text color={colors.error}>{error}</Text>
          </Box>
          <Box height={1} />
          <Text color={colors.dim}>  Try again: whale login</Text>
        </Box>
      )}
    </Box>
  );
}
