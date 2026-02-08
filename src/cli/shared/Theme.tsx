/**
 * Theme — Apple-inspired color palette and symbols for whale CLI
 *
 * Colors based on macOS system palette (Dark mode).
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
  warning:    "#FFD60A",   // systemYellow
  info:       "#64D2FF",   // systemCyan

  // Text hierarchy
  text:       "#F5F5F7",   // Apple primary text
  secondary:  "#A1A1A6",   // Apple secondary text
  tertiary:   "#6E6E73",   // Apple tertiary text
  quaternary: "#48484A",   // systemGray3

  // Legacy aliases (keep for compatibility)
  muted:      "#A1A1A6",
  dim:        "#86868B",   // systemGray
  subtle:     "#6E6E73",
  border:     "#38383A",   // systemGray5

  // Roles
  user:       "#F5F5F7",   // clean white for user
  assistant:  "#BF5AF2",   // systemPurple
  tool:       "#0A84FF",   // systemBlue

  // Tool types
  localTool:  "#64D2FF",   // systemCyan — local ops
  serverTool: "#FF9F0A",   // systemOrange — server/cloud

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
  localTool:  "›",
  serverTool: "›",

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
  sparkle:    "whale",
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
