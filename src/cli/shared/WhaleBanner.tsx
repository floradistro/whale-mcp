/**
 * Whale banner — clean Claude Code style
 */

import React from "react";
import { Box, Text } from "ink";
import { colors, symbols, boxTop, boxBottom } from "./Theme.js";

interface WhaleBannerProps {
  subtitle?: string;
  version?: string;
  compact?: boolean;
}

export function WhaleBanner({ subtitle, version, compact }: WhaleBannerProps) {
  if (compact) {
    return (
      <Box>
        <Text color={colors.brand} bold>{symbols.sparkle} whale</Text>
        {version && <Text color={colors.dim}> v{version}</Text>}
        {subtitle && <Text color={colors.muted}> {subtitle}</Text>}
      </Box>
    );
  }

  const width = 44;
  const titleLine = `${symbols.sparkle} whale` + (version ? `  v${version}` : "");
  const titlePad = Math.max(0, Math.floor((width - 2 - titleLine.length) / 2));

  return (
    <Box flexDirection="column">
      <Text color={colors.border}>{boxTop(width)}</Text>
      <Box>
        <Text color={colors.border}>{symbols.verticalBar}</Text>
        <Text>{" ".repeat(width - 2)}</Text>
        <Text color={colors.border}>{symbols.verticalBar}</Text>
      </Box>
      <Box>
        <Text color={colors.border}>{symbols.verticalBar}</Text>
        <Text>{" ".repeat(titlePad)}</Text>
        <Text color={colors.brand} bold>{symbols.sparkle} whale</Text>
        {version && <Text color={colors.dim}>  v{version}</Text>}
        <Text>{" ".repeat(Math.max(0, width - 2 - titlePad - titleLine.length))}</Text>
        <Text color={colors.border}>{symbols.verticalBar}</Text>
      </Box>
      {subtitle && (
        <Box>
          <Text color={colors.border}>{symbols.verticalBar}</Text>
          <Text>{" ".repeat(titlePad)}</Text>
          <Text color={colors.muted}>{subtitle}</Text>
          <Text>{" ".repeat(Math.max(0, width - 2 - titlePad - subtitle.length))}</Text>
          <Text color={colors.border}>{symbols.verticalBar}</Text>
        </Box>
      )}
      <Box>
        <Text color={colors.border}>{symbols.verticalBar}</Text>
        <Text>{" ".repeat(width - 2)}</Text>
        <Text color={colors.border}>{symbols.verticalBar}</Text>
      </Box>
      <Text color={colors.border}>{boxBottom(width)}</Text>
    </Box>
  );
}
