/**
 * StoreSelector — inline store picker for chat
 *
 * Renders a SelectInput with stores. Esc to cancel.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { colors, symbols } from "../shared/Theme.js";
import type { StoreInfo } from "../services/auth-service.js";

interface StoreSelectorProps {
  stores: StoreInfo[];
  currentStoreId: string;
  onSelect: (store: StoreInfo) => void;
  onCancel: () => void;
}

export function StoreSelector({ stores, currentStoreId, onSelect, onCancel }: StoreSelectorProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const items = stores.map((s) => ({
    label: s.name + (s.slug ? ` (${s.slug})` : ""),
    value: s.id,
  }));

  const handleSelect = (item: { label: string; value: string }) => {
    const store = stores.find((s) => s.id === item.value);
    if (store) onSelect(store);
  };

  return (
    <Box flexDirection="column">
      <Text color={colors.secondary}>  Select store:</Text>
      <Box height={1} />
      <SelectInput
        items={items}
        onSelect={handleSelect}
        indicatorComponent={({ isSelected }: { isSelected?: boolean }) => (
          <Text color={isSelected ? colors.brand : colors.quaternary}>
            {isSelected ? symbols.arrowRight : " "}{" "}
          </Text>
        )}
        itemComponent={({ isSelected, label }: { isSelected?: boolean; label: string }) => {
          const store = stores.find((s) => label.startsWith(s.name));
          const isCurrent = store?.id === currentStoreId;
          return (
            <Box>
              <Text color={isSelected ? colors.brand : colors.text} bold={isSelected}>
                {label}
              </Text>
              {isCurrent && <Text color={colors.success}>  {symbols.dot} current</Text>}
            </Box>
          );
        }}
      />
      <Text color={colors.quaternary}>  esc to cancel</Text>
    </Box>
  );
}
