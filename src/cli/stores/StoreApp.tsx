/**
 * StoreApp — store selector
 *
 * Lists stores the user has access to. Select to switch.
 * Resets server tool cache so the new store takes effect immediately.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import {
  getStoresForUser,
  getValidToken,
  selectStore,
  type StoreInfo,
} from "../services/auth-service.js";
import { loadConfig } from "../services/config-store.js";
import { resetServerToolClient } from "../services/server-tools.js";
import { WhaleBanner } from "../shared/WhaleBanner.js";
import { colors, symbols, boxLine } from "../shared/Theme.js";

type Step = "loading" | "select" | "done" | "error";

export function StoreApp() {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("loading");
  const [stores, setStores] = useState<StoreInfo[]>([]);
  const [currentStoreId, setCurrentStoreId] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const config = loadConfig();
      setCurrentStoreId(config.store_id || "");

      const token = await getValidToken();
      if (!token) {
        setError("Not logged in. Run: whale login");
        setStep("error");
        return;
      }

      const userStores = await getStoresForUser(token, config.user_id || "");
      if (userStores.length === 0) {
        setError("No stores found for this account.");
        setStep("error");
        return;
      }

      if (userStores.length === 1) {
        // Only one store — auto-select if not already set
        if (config.store_id !== userStores[0].id) {
          selectStore(userStores[0].id, userStores[0].name);
          resetServerToolClient();
          setSelectedName(userStores[0].name);
          setStep("done");
        } else {
          setSelectedName(userStores[0].name);
          setStep("done");
        }
        return;
      }

      setStores(userStores);
      setStep("select");
    })();
  }, []);

  useEffect(() => {
    if (step === "done" || step === "error") {
      const timer = setTimeout(() => exit(), 500);
      return () => clearTimeout(timer);
    }
  }, [step, exit]);

  const handleSelect = (item: { label: string; value: string }) => {
    const store = stores.find((s) => s.id === item.value);
    if (!store) return;

    selectStore(store.id, store.name);
    resetServerToolClient();
    setSelectedName(store.name);
    setStep("done");
  };

  return (
    <Box flexDirection="column" padding={1}>
      <WhaleBanner subtitle="select store" compact />
      <Box height={1} />
      <Text color={colors.border}>{boxLine(44)}</Text>
      <Box height={1} />

      {step === "loading" && (
        <Box>
          <Text color={colors.brand}><Spinner type="dots" /></Text>
          <Text color={colors.secondary}> loading stores…</Text>
        </Box>
      )}

      {step === "select" && (
        <Box flexDirection="column">
          <Text color={colors.secondary}>  Select a store:</Text>
          <Box height={1} />
          <SelectInput
            items={stores.map((s) => ({
              label: s.name + (s.slug ? ` (${s.slug})` : "") + (s.id === currentStoreId ? "  current" : ""),
              value: s.id,
            }))}
            onSelect={handleSelect}
            indicatorComponent={({ isSelected }: { isSelected?: boolean }) => (
              <Text color={isSelected ? colors.brand : colors.quaternary}>
                {isSelected ? symbols.arrowRight : " "}{" "}
              </Text>
            )}
            itemComponent={({ isSelected, label }: { isSelected?: boolean; label: string }) => {
              const isCurrent = label.endsWith("  current");
              const displayLabel = isCurrent ? label.replace("  current", "") : label;
              return (
                <Box>
                  <Text color={isSelected ? colors.brand : colors.text} bold={isSelected}>
                    {displayLabel}
                  </Text>
                  {isCurrent && <Text color={colors.success}>  {symbols.dot} current</Text>}
                </Box>
              );
            }}
          />
        </Box>
      )}

      {step === "done" && (
        <Box flexDirection="column">
          <Box>
            <Text color={colors.success}>{symbols.check} </Text>
            <Text color={colors.text} bold>Store selected</Text>
          </Box>
          <Box height={1} />
          <Box>
            <Text color={colors.dim}>{"  "}store </Text>
            <Text color={colors.text}>{selectedName}</Text>
          </Box>
          <Box height={1} />
          <Text color={colors.secondary}>  Server tools will use this store.</Text>
        </Box>
      )}

      {step === "error" && (
        <Box flexDirection="column">
          <Box>
            <Text color={colors.error}>{symbols.cross} </Text>
            <Text color={colors.error}>{error}</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
