/**
 * Theme — Apple-inspired color palette and symbols for whale CLI
 *
 * Colors: macOS system palette (Dark mode).
 * Extended with purples, pinks, indigo for syntax/UI.
 * Minimal, elegant symbols — whitespace does the heavy lifting.
 */

// ============================================================================
// COLORS — macOS system palette (dark appearance)
// ============================================================================

export const colors = {
  // Accents
  brand:      "#0A84FF",   // systemBlue
  brandDim:   "#0071E3",   // Apple link blue
  success:    "#30D158",   // systemGreen
  error:      "#FF453A",   // systemRed
  warning:    "#FF9F0A",   // systemOrange
  info:       "#64D2FF",   // systemCyan

  // Extended accents
  pink:       "#FF375F",   // systemPink
  purple:     "#BF5AF2",   // systemPurple
  indigo:     "#5E5CE6",   // systemIndigo
  mint:       "#66D4CF",   // systemMint
  teal:       "#6AC4DC",   // systemTeal
  lavender:   "#D4BBFF",   // lavender
  roseGold:   "#FFB5C2",   // rose gold

  // Text hierarchy
  text:       "#F5F5F7",   // Apple primary text
  secondary:  "#A1A1A6",   // Apple secondary text
  tertiary:   "#6E6E73",   // Apple tertiary text
  quaternary: "#48484A",   // systemGray3

  // Legacy aliases
  muted:      "#A1A1A6",
  dim:        "#86868B",   // systemGray
  subtle:     "#6E6E73",
  border:     "#38383A",   // systemGray5

  // Roles
  user:       "#F5F5F7",
  assistant:  "#BF5AF2",   // systemPurple
  tool:       "#0A84FF",

  // Tool types
  localTool:  "#BF5AF2",   // purple — local
  serverTool: "#FF375F",   // pink — server/cloud

  // Financial
  gain:       "#30D158",   // systemGreen
  loss:       "#FF453A",   // systemRed

  // Surfaces
  panel:      "#1C1C1E",   // systemBackground (elevated)
  separator:  "#38383A",   // systemGray5
};

// ============================================================================
// SYMBOLS — minimal, clean
// ============================================================================

export const symbols = {
  // Status
  check:      "✓",
  cross:      "✕",
  warning:    "!",
  dot:        "·",
  bullet:     "●",

  // Navigation
  arrow:      "→",
  arrowRight: "›",
  chevron:    "›",

  // Roles
  user:       ">",
  assistant:  " ",

  // Tool types
  local:      "⚡",
  server:     "☁",

  // Structure
  divider:    "─",
  verticalBar:"│",
  topLeft:    "╭",
  topRight:   "╮",
  bottomLeft: "╰",
  bottomRight:"╯",
  tee:        "├",
  corner:     "└",

  // Brand
  sparkle:    "◆",
};

// ============================================================================
// HELPERS
// ============================================================================

export function boxLine(width: number): string {
  return "─".repeat(width);
}

export function boxTop(width: number): string {
  return "╭" + "─".repeat(width - 2) + "╮";
}

export function boxBottom(width: number): string {
  return "╰" + "─".repeat(width - 2) + "╯";
}
