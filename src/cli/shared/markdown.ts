/**
 * Markdown rendering — Apple-polished terminal output
 *
 * Syntax theme: purples, blues, pinks — no yellow.
 * Financials: green for gains, red for losses/deductions.
 * Uses marked + marked-terminal + cli-highlight.
 */

import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import { createRequire } from "module";

// Note: chalk.level is auto-detected by supports-color.
// Apple_Terminal → level 2 (256-color), iTerm.app v3+ → level 3 (24-bit).
// Do NOT force level 3 — Terminal.app can't render 24-bit codes (shows gray).

const require = createRequire(import.meta.url);
const { highlight } = require("cli-highlight") as typeof import("cli-highlight");

// ============================================================================
// Apple Dark palette
// ============================================================================

const systemBlue   = chalk.hex("#0A84FF");
const systemCyan   = chalk.hex("#64D2FF");
const systemTeal   = chalk.hex("#6AC4DC");
const systemPink   = chalk.hex("#FF375F");
const systemPurple = chalk.hex("#BF5AF2");
const systemIndigo = chalk.hex("#5E5CE6");
const systemGreen  = chalk.hex("#30D158");
const systemMint   = chalk.hex("#66D4CF");
const systemRed    = chalk.hex("#FF453A");
const systemOrange = chalk.hex("#FF9F0A");
const text         = chalk.hex("#F5F5F7");
const secondary    = chalk.hex("#A1A1A6");
const tertiary     = chalk.hex("#6E6E73");
const separator    = chalk.hex("#38383A");
const lavender     = chalk.hex("#D4BBFF");
const roseGold     = chalk.hex("#FFB5C2");

// ============================================================================
// OSC 8 hyperlinks — only in terminals that support them
// ============================================================================

/** Detect if terminal supports OSC 8 clickable hyperlinks */
const supportsOsc8 = (() => {
  const tp = process.env.TERM_PROGRAM || "";
  if (/iterm|wezterm|kitty|hyper|warp|foot|alacritty/i.test(tp)) return true;
  if (process.env.VTE_VERSION) return true;     // GNOME Terminal, Tilix
  if (process.env.WT_SESSION) return true;       // Windows Terminal
  if (process.env.KONSOLE_VERSION) return true;  // Konsole
  // Apple Terminal.app does NOT support OSC 8
  return false;
})();

function hyperlink(url: string, text?: string): string {
  // mailto: → clean email address, no protocol prefix, no OSC 8
  if (url.startsWith("mailto:")) {
    const email = text || url.slice(7);
    return systemCyan(email);
  }

  // tel: → clean phone number
  if (url.startsWith("tel:")) {
    return systemCyan(text || url.slice(4));
  }

  const display = text || url;

  // OSC 8 clickable links — only where terminal supports them
  if (supportsOsc8) {
    return `\x1B]8;;${url}\x07${systemCyan.underline(display)}\x1B]8;;\x07`;
  }

  // Fallback: colored underlined text (no escape sequences)
  return systemCyan.underline(display);
}

// ============================================================================
// Path helpers
// ============================================================================

/** Shorten a file path for code block headers */
function shortenPathForHeader(fullPath: string, maxLen = 40): string {
  let p = fullPath;
  const cwd = process.cwd();
  const home = process.env.HOME || "";
  if (p.startsWith(cwd + "/")) p = p.slice(cwd.length + 1);
  else if (p.startsWith(cwd)) p = p.slice(cwd.length);
  else if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
  if (p.length <= maxLen) return p;
  const parts = p.split("/");
  const file = parts.pop()!;
  if (file.length >= maxLen - 4) return "…/" + file.slice(-(maxLen - 4));
  const parent = parts.pop();
  return parent ? "…/" + parent + "/" + file : "…/" + file;
}

// ============================================================================
// Syntax highlighting — purples / blues / pinks
// ============================================================================

const appleTheme = {
  // Keywords — pink bold
  keyword:    systemPink.bold,
  built_in:   systemPurple,
  type:       systemCyan,
  literal:    systemIndigo,
  number:     systemMint,
  regexp:     systemPink,

  // Strings — lavender
  string:     lavender,
  subst:      systemCyan,
  symbol:     systemPurple,

  // Functions & classes — blue
  class:      systemCyan.bold,
  function:   systemBlue,
  title:      systemBlue.bold,
  params:     roseGold,

  // Comments — tertiary italic
  comment:    tertiary.italic,
  doctag:     secondary.italic,
  meta:       systemIndigo,
  "meta-keyword": systemPink,
  "meta-string":  lavender,

  // Tags (HTML/JSX)
  tag:        systemPink,
  name:       systemCyan,
  attr:       systemPurple,
  attribute:  systemPurple,

  // Variables & properties
  variable:   systemCyan,
  property:   systemBlue,

  // Diff
  addition:   systemGreen,
  deletion:   systemRed,

  // Lists & markup
  bullet:     systemPurple,
  code:       systemPink,
  emphasis:   chalk.italic,
  strong:     chalk.bold,
  link:       systemCyan.underline,
  quote:      secondary.italic,

  // Selectors (CSS)
  "selector-tag":    systemPink,
  "selector-id":     systemBlue,
  "selector-class":  systemPurple,
  "selector-pseudo": systemCyan,
  "selector-attr":   lavender,

  // Template
  "template-tag":      systemPink,
  "template-variable": systemCyan,

  // JSON property names — purple
  section: systemPurple,

  // Fallback
  default: (s: string) => s,
};

// ============================================================================
// Financial coloring
// ============================================================================

function colorizeFinancials(str: string): string {
  return str
    // NOTE: URL hyperlinking is handled by marked's GFM autolink + link/href handlers.
    // Do NOT add URL patterns here — it causes links to render 3-5x.
    // Negative dollar amounts → red  (-$1,234.56)
    .replace(/(-\$[\d,]+\.?\d*)/g, (m) => systemRed(m))
    // Positive dollar amounts → green  ($1,234.56)
    .replace(/((?:^|[^-])\$[\d,]+\.?\d*)/g, (m) => systemGreen(m))
    // Negative percentages → red
    .replace(/(-\d+\.?\d*%)/g, (m) => systemRed(m))
    // Positive percentages → cyan
    .replace(/((?:^|[^-])\d+\.?\d*%)/g, (m) => systemCyan(m))
    // Explicit positive → green
    .replace(/(\+\$?[\d,]+\.?\d*)/g, (m) => systemGreen(m))
    // Words: profit, revenue, gain, increase, running, ready → green
    .replace(/\b(profit|revenue|gain|increase|in stock|available|running|ready|started|listening|compiled)\b/gi, (m) => systemGreen(m))
    // Words: loss, deduction, decrease, cost, expense, out of stock, failed → red
    .replace(/\b(loss|deduction|decrease|deficit|expense|out of stock|low stock|overdue|expired|cancelled|failed|error|crashed|EADDRINUSE|ENOENT)\b/gi, (m) => systemRed(m));
}

// ============================================================================
// Markdown renderer
// ============================================================================

marked.use(
  markedTerminal(
    {
      // Headings — bold blue
      firstHeading: systemBlue.bold,
      heading: systemBlue.bold,

      // Inline
      codespan: systemPink,
      strong: text.bold,
      em: lavender.italic,

      // Blocks
      blockquote: secondary.italic,
      paragraph: (body: string) => colorizeFinancials(body),
      hr: () => separator("─".repeat(50)),

      // Links — OSC 8 clickable (single source of truth for URL rendering)
      // NOTE: Only use `link` handler, NOT `href` — having both causes double-hyperlinking
      link: (href: string, _title: string, text: string) => hyperlink(href, text !== href ? text : undefined),

      // Lists — purple bullets, financial-aware
      list: (body: string, ordered: boolean) => {
        if (ordered) {
          let n = 0;
          return body.replace(/^\* /gm, () => {
            n++;
            return `${systemIndigo(String(n) + ".")} `;
          });
        }
        return body.replace(/^\* /gm, `${systemPurple("●")} `);
      },
      listitem: (itemText: string) => {
        return colorizeFinancials(itemText);
      },

      // Layout — adapt to terminal width
      reflowText: false,
      showSectionPrefix: false,
      width: Math.min(120, process.stdout.columns || 80),
      tab: 2,
    } as any,
    {
      // cli-highlight — purple/blue/pink syntax theme
      theme: appleTheme,
      ignoreIllegals: true,
    }
  )
);

// ============================================================================
// Diff renderer — background colors + word-level diff (Claude Code parity)
// ============================================================================

// Background colors for diff lines — 256-color safe (exact cube values)
// At level 2: #005f00 → index 22, #5f0000 → index 52, etc.
const diffAddedBg     = chalk.bgHex("#005f00").white;           // dark green bg, white text
const diffRemovedBg   = chalk.bgHex("#5f0000").white;           // dark red bg, white text
const diffWordAdded   = chalk.bgHex("#008700").whiteBright.bold; // brighter green bg, bold white
const diffWordRemoved = chalk.bgHex("#870000").whiteBright.bold; // brighter red bg, bold white

/** Compute word-level diff between two lines. Returns arrays of {text, changed} segments. */
function wordDiff(oldLine: string, newLine: string): { old: {text: string; changed: boolean}[]; new: {text: string; changed: boolean}[] } {
  const oldWords = oldLine.split(/(\s+)/);
  const newWords = newLine.split(/(\s+)/);

  // If lines are too different (>50% changed), skip word diff
  const maxLen = Math.max(oldWords.length, newWords.length);
  if (maxLen === 0) return { old: [{text: oldLine, changed: true}], new: [{text: newLine, changed: true}] };

  // Simple LCS-based diff
  let diffCount = 0;
  const minLen = Math.min(oldWords.length, newWords.length);
  for (let i = 0; i < minLen; i++) {
    if (oldWords[i] !== newWords[i]) diffCount++;
  }
  diffCount += Math.abs(oldWords.length - newWords.length);

  if (diffCount / maxLen > 0.5) {
    return { old: [{text: oldLine, changed: true}], new: [{text: newLine, changed: true}] };
  }

  // Build segments
  const oldSegs: {text: string; changed: boolean}[] = [];
  const newSegs: {text: string; changed: boolean}[] = [];

  for (let i = 0; i < maxLen; i++) {
    const ow = oldWords[i] || "";
    const nw = newWords[i] || "";
    if (ow === nw) {
      if (ow) { oldSegs.push({text: ow, changed: false}); newSegs.push({text: nw, changed: false}); }
    } else {
      if (ow) oldSegs.push({text: ow, changed: true});
      if (nw) newSegs.push({text: nw, changed: true});
    }
  }

  return { old: oldSegs, new: newSegs };
}

/** Render segments with word-level highlighting */
function renderSegments(segs: {text: string; changed: boolean}[], wordStyle: (s: string) => string, lineStyle: (s: string) => string): string {
  return segs.map(s => s.changed ? wordStyle(s.text) : lineStyle(s.text)).join("");
}

function renderDiff(code: string): string {
  const lines = code.split("\n");
  const termWidth = (process.stdout.columns || 80) - 6; // -6 for nested margins (MessageList=2 + ToolIndicator=2 + safety=2)

  // Parse into segments from unified diff format
  type Seg = { type: "remove" | "add" | "context"; content: string; lineNo: number };
  const segments: Seg[] = [];
  let oldLineNo = 1, newLineNo = 1;
  let seenDiff = false;

  for (const line of lines) {
    // Skip file headers (--- a/file, +++ b/file)
    if (line.startsWith("---") || line.startsWith("+++")) continue;

    // Hunk header — extract line numbers
    const hunkMatch = line.match(/^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
    if (hunkMatch) {
      oldLineNo = parseInt(hunkMatch[1]);
      newLineNo = parseInt(hunkMatch[2]);
      seenDiff = true;
      continue;
    }

    // Skip non-diff header lines (e.g., "File edited:", "Applied N edits")
    if (!seenDiff && !line.startsWith("-") && !line.startsWith("+") && !line.startsWith(" ")) {
      continue;
    }
    seenDiff = true;

    if (line.startsWith("-")) {
      segments.push({ type: "remove", content: line.slice(1), lineNo: oldLineNo });
      oldLineNo++;
    } else if (line.startsWith("+")) {
      segments.push({ type: "add", content: line.slice(1), lineNo: newLineNo });
      newLineNo++;
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      segments.push({ type: "context", content, lineNo: newLineNo });
      oldLineNo++;
      newLineNo++;
    }
  }

  if (segments.length === 0) return code; // fallback

  // Gutter width from max line number
  const maxLineNo = segments.reduce((max, s) => Math.max(max, s.lineNo), 0);
  const gutterW = Math.max(3, String(maxLineNo).length);

  const out: string[] = [];
  let i = 0;

  while (i < segments.length) {
    const seg = segments[i];

    if (seg.type === "remove") {
      // Collect consecutive removes
      const removes: Seg[] = [];
      while (i < segments.length && segments[i].type === "remove") {
        removes.push(segments[i]);
        i++;
      }
      // Collect consecutive adds
      const adds: Seg[] = [];
      while (i < segments.length && segments[i].type === "add") {
        adds.push(segments[i]);
        i++;
      }

      // Pair for word-level diff
      const pairCount = Math.min(removes.length, adds.length);

      for (let j = 0; j < removes.length; j++) {
        const r = removes[j];
        const rPrefix = `${String(r.lineNo).padStart(gutterW)} - `;

        if (j < pairCount) {
          const a = adds[j];
          const aPrefix = `${String(a.lineNo).padStart(gutterW)} + `;
          const wd = wordDiff(r.content, a.content);

          // Removed line with word highlights
          const rPad = Math.max(0, termWidth - rPrefix.length - r.content.length);
          out.push(diffRemovedBg(rPrefix) + renderSegments(wd.old, diffWordRemoved, diffRemovedBg) + diffRemovedBg(" ".repeat(rPad)));

          // Added line with word highlights
          const aPad = Math.max(0, termWidth - aPrefix.length - a.content.length);
          out.push(diffAddedBg(aPrefix) + renderSegments(wd.new, diffWordAdded, diffAddedBg) + diffAddedBg(" ".repeat(aPad)));
        } else {
          // Unpaired remove
          const raw = rPrefix + r.content;
          const pad = Math.max(0, termWidth - raw.length);
          out.push(diffRemovedBg(raw + " ".repeat(pad)));
        }
      }

      // Unpaired adds
      for (let j = pairCount; j < adds.length; j++) {
        const a = adds[j];
        const prefix = `${String(a.lineNo).padStart(gutterW)} + `;
        const raw = prefix + a.content;
        const pad = Math.max(0, termWidth - raw.length);
        out.push(diffAddedBg(raw + " ".repeat(pad)));
      }
      continue;
    }

    if (seg.type === "add") {
      // Standalone add (no preceding remove)
      const prefix = `${String(seg.lineNo).padStart(gutterW)} + `;
      const raw = prefix + seg.content;
      const pad = Math.max(0, termWidth - raw.length);
      out.push(diffAddedBg(raw + " ".repeat(pad)));
      i++;
      continue;
    }

    // Context line — dim line number, plain content, no background
    const prefix = tertiary(`${String(seg.lineNo).padStart(gutterW)}   `);
    out.push(prefix + seg.content);
    i++;
  }

  return out.join("\n") + "\n";
}

// ============================================================================
// Bar chart renderer — ```chart code blocks
// ============================================================================

const barGradient = [
  chalk.hex("#BF5AF2"),  // purple
  chalk.hex("#5E5CE6"),  // indigo
  chalk.hex("#0A84FF"),  // blue
  chalk.hex("#64D2FF"),  // cyan
  chalk.hex("#6AC4DC"),  // teal
  chalk.hex("#30D158"),  // green
  chalk.hex("#FF9F0A"),  // orange
  chalk.hex("#FF375F"),  // pink
];

interface ChartEntry {
  label: string;
  value: number;
  raw: string;
}

function renderBarChart(code: string): string {
  const lines = code.trim().split("\n").filter(l => l.trim());

  // Optional title — first line without "label: number" pattern
  let title = "";
  let dataLines = lines;
  if (lines.length > 1 && !/:\s*[$\-+]?[\d,]+/.test(lines[0])) {
    title = lines[0].trim();
    dataLines = lines.slice(1);
  }

  // Parse "Label: $1,234.56" or "Label: 42%" or "Label: 1000"
  const entries: ChartEntry[] = [];
  for (const line of dataLines) {
    const m = line.match(/^(.+?):\s*([+\-]?\$?[\d,]+\.?\d*%?)\s*$/);
    if (!m) continue;
    const label = m[1].trim();
    const raw = m[2].trim();
    const value = Math.abs(parseFloat(raw.replace(/[$,%]/g, "")));
    if (!isNaN(value)) entries.push({ label, value, raw });
  }

  if (entries.length === 0) return code;

  const maxVal = Math.max(...entries.map(e => e.value));
  const maxLabel = Math.max(...entries.map(e => e.label.length));
  const maxRaw = Math.max(...entries.map(e => e.raw.length));
  const termWidth = process.stdout.columns || 80;
  const barWidth = Math.min(36, Math.max(12, termWidth - 8 - maxLabel - maxRaw));

  const out: string[] = [];

  if (title) {
    out.push(`  ${systemBlue.bold(title)}`);
    out.push("");
  }

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const ratio = maxVal > 0 ? e.value / maxVal : 0;
    const filled = Math.round(ratio * barWidth);
    const color = barGradient[i % barGradient.length];

    const label = secondary(e.label.padStart(maxLabel));
    const bar = color("█".repeat(filled)) + chalk.hex("#2C2C2E")("░".repeat(barWidth - filled));
    const val = e.raw.includes("$")
      ? systemGreen(e.raw.padStart(maxRaw))
      : e.raw.includes("%")
        ? systemCyan(e.raw.padStart(maxRaw))
        : systemMint(e.raw.padStart(maxRaw));

    out.push(`  ${label}  ${bar}  ${val}`);
  }

  return "\n" + out.join("\n") + "\n";
}

// ============================================================================
// Table renderer — intercepts markdown tables before markedTerminal
// ============================================================================

// Row tone detection for background tinting
type RowTone = "positive" | "negative" | "neutral";

function getRowTone(cells: string[]): RowTone {
  for (const cell of cells) {
    const t = cell.trim();
    // Negative financial → red row
    if (/^-\$[\d,]+/.test(t) || /^-\d+\.?\d*%/.test(t)) return "negative";
    // Explicit positive delta → green row
    if (/^\+\d/.test(t) || /^\+\$/.test(t)) return "positive";
    // Status badges
    if (/^`?[✕✗]/.test(t) || /cancelled|failed|rejected|error|out of stock|low stock/i.test(t)) return "negative";
    if (/^`?[✓●]/.test(t) || /completed|received|approved|active|success|paid|published/i.test(t)) return "positive";
  }
  return "neutral";
}

// Background tints for row-level coloring
const rowBgPositive = chalk.bgHex("#0d1f14");  // subtle green tint
const rowBgNegative = chalk.bgHex("#1f0d10");  // subtle red tint

function colorizeCell(val: string, isHeader: boolean, rowTone: RowTone = "neutral"): string {
  const trimmed = val.trim();
  if (!trimmed) return text("");
  if (isHeader) return systemIndigo.bold(trimmed);

  // Badge format: `✓ status` or `◆ status` or `○ status` or `✕ status`
  const badgeMatch = trimmed.match(/^`([✓●◆○✕◦])\s+(.+)`$/);
  if (badgeMatch) {
    const [, icon, label] = badgeMatch;
    if (icon === "✓" || icon === "●") return systemGreen(`${icon} ${label}`);
    if (icon === "◆") return systemCyan(`${icon} ${label}`);
    if (icon === "○") return systemOrange(`${icon} ${label}`);
    if (icon === "✕") return systemRed(`${icon} ${label}`);
    return secondary(`${icon} ${label}`);
  }

  // Inline code (UUID, SKU, transfer number) — subtle style
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return systemPurple(trimmed.slice(1, -1));
  }

  // Bold text
  if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
    return text.bold(trimmed.slice(2, -2));
  }

  // Negative values → red
  if (/^-\$?[\d,]+\.?\d*$/.test(trimmed) || /^-\d+\.?\d*%$/.test(trimmed)) {
    return systemRed(trimmed);
  }
  // Positive financial → green
  if (/^\+?\$[\d,]+\.?\d*$/.test(trimmed) || /^\$[\d,]+\.?\d*$/.test(trimmed)) {
    return systemGreen(trimmed);
  }
  // Percentages → cyan
  if (/^\d+\.?\d*%$/.test(trimmed)) {
    return systemCyan(trimmed);
  }
  // Plain numbers → mint
  if (/^[\d,]+\.?\d*$/.test(trimmed)) {
    return systemMint(trimmed);
  }
  // Status words
  if (/^(active|success|complete|approved|in stock|available)/i.test(trimmed)) {
    return systemGreen(trimmed);
  }
  if (/^(inactive|error|failed|cancelled|out of stock|low|overdue|expired)/i.test(trimmed)) {
    return systemRed(trimmed);
  }
  if (/^(pending|draft|processing)/i.test(trimmed)) {
    return systemOrange(trimmed);
  }

  // Apply row tone tint to text cells
  if (rowTone === "positive") return rowBgPositive(text(trimmed));
  if (rowTone === "negative") return rowBgNegative(text(trimmed));
  return text(trimmed);
}

function renderTable(token: any): string {
  // Extract cell text from token — handles both inline tokens and plain text
  function getCellText(cell: any): string {
    if (!cell) return "";
    if (typeof cell === "string") return cell;
    if (cell.text !== undefined) return String(cell.text);
    if (cell.tokens) {
      return cell.tokens.map((t: any) => t.raw || t.text || "").join("");
    }
    return String(cell);
  }

  const headers: string[] = (token.header || []).map((h: any) => getCellText(h));
  const rows: string[][] = (token.rows || []).map((row: any) =>
    row.map((cell: any) => getCellText(cell))
  );

  if (headers.length === 0) return "";

  // Responsive column widths based on terminal width
  const termWidth = process.stdout.columns || 80;
  const N = headers.length;
  // Overhead: "  ╭" (3) + N+1 border chars + N*2 cell padding + "╮"
  const overhead = 3 + (N + 1) + (N * 2);
  const availableForContent = termWidth - overhead;
  // Scale minimum column width down for narrow terminals
  const minCol = termWidth < 70 ? 3 : termWidth < 90 ? 4 : 6;
  const maxPerCol = Math.max(minCol, Math.floor(availableForContent / N));

  const colWidths = headers.map((h: string, i: number) => {
    const dataMax = rows.reduce((max: number, row: string[]) =>
      Math.max(max, (row[i] || "").length), 0);
    return Math.min(maxPerCol, Math.max(minCol, h.length, dataMax) + 2);
  });

  const border = chalk.hex("#48484A");
  const out: string[] = [];

  // Top border: ╭──────┬──────╮
  out.push(border("  ╭" + colWidths.map((w: number) => "─".repeat(w + 2)).join("┬") + "╮"));

  // Header row (truncate headers to fit)
  const hdrLine = headers.map((h: string, i: number) => {
    const display = h.length > colWidths[i] ? h.slice(0, colWidths[i] - 1) + "…" : h;
    return " " + systemIndigo.bold(display.padEnd(colWidths[i])) + " ";
  }).join(border("│"));
  out.push(border("  │") + hdrLine + border("│"));

  // Header/body divider: ├──────┼──────┤
  out.push(border("  ├" + colWidths.map((w: number) => "─".repeat(w + 2)).join("┼") + "┤"));

  // Data rows (truncate values to fit, with row-level background tinting)
  for (const row of rows) {
    const tone = getRowTone(row);
    const cells = headers.map((_: string, i: number) => {
      const raw = row[i] || "";
      const display = raw.length > colWidths[i] ? raw.slice(0, colWidths[i] - 1) + "…" : raw;
      const colored = colorizeCell(display, false, tone);
      const extraPad = Math.max(0, colWidths[i] - display.length);
      const cellContent = " " + colored + " ".repeat(extraPad) + " ";
      // Apply subtle background tint to the entire cell for positive/negative rows
      if (tone === "positive") return rowBgPositive(cellContent);
      if (tone === "negative") return rowBgNegative(cellContent);
      return cellContent;
    }).join(border("│"));
    out.push(border("  │") + cells + border("│"));
  }

  // Bottom border: ╰──────┴──────╯
  out.push(border("  ╰" + colWidths.map((w: number) => "─".repeat(w + 2)).join("┴") + "╯"));

  return "\n" + out.join("\n") + "\n";
}

// Register chart + table extensions — intercepts before markedTerminal
marked.use({
  renderer: {
    code(this: any, token: any) {
      const rawLang = (typeof token === "object" ? token.lang : arguments[1]) || "";
      const code = typeof token === "object" ? token.text : token;

      // Parse lang:subtitle (e.g. "typescript:src/foo.ts")
      const colonIdx = rawLang.indexOf(":");
      const lang = colonIdx > 0 ? rawLang.slice(0, colonIdx) : rawLang;
      const subtitle = colonIdx > 0 ? rawLang.slice(colonIdx + 1) : "";

      if (lang === "chart" || lang === "bar") {
        return renderBarChart(code);
      }
      if (lang === "diff") {
        return renderDiff(code);
      }
      {
        // Command output mode: bash without subtitle = run_command output
        // → no line numbers, wider content area, clean indent
        const isCommandOutput = (lang === "bash" || lang === "terminal") && !subtitle;
        const highlightLang = lang === "terminal" ? "bash" : lang;

        // Build header: ── lang ── subtitle ──────
        const termWidth = process.stdout.columns || 80;
        const headerWidth = Math.max(20, termWidth - 6);
        const displayLang = isCommandOutput ? "bash" : lang;
        let header: string;
        if (displayLang && subtitle) {
          const shortSub = shortenPathForHeader(subtitle, headerWidth - displayLang.length - 10);
          const pad = Math.max(2, headerWidth - displayLang.length - shortSub.length - 6);
          header = separator("  ── ") + tertiary(displayLang) + separator(" ── ") + secondary(shortSub) + separator(` ${"─".repeat(pad)}`);
        } else if (displayLang) {
          const pad = Math.max(2, headerWidth - displayLang.length - 3);
          header = separator("  ── ") + tertiary(displayLang) + separator(` ${"─".repeat(pad)}`);
        } else {
          header = separator("  ──" + "─".repeat(headerWidth - 2));
        }

        // Calculate max line width to prevent wrapping
        const lineCount = code.split("\n").length;
        const gutterW = isCommandOutput ? 0 : String(lineCount).length;
        const gutterOverhead = isCommandOutput ? 4 : (2 + gutterW + 3); // "    " or "  123 │ "
        const maxLineWidth = Math.max(20, termWidth - gutterOverhead - 2);

        // Pre-truncate lines BEFORE highlighting (avoids cutting ANSI codes)
        const truncatedCode = code.split("\n").map((line: string) => {
          if (line.length > maxLineWidth) {
            return line.slice(0, maxLineWidth - 1) + "…";
          }
          return line;
        }).join("\n");

        let highlighted: string;
        if (highlightLang) {
          try {
            const origWarn = console.warn;
            console.warn = () => {};
            try {
              highlighted = highlight(truncatedCode, { language: highlightLang, ignoreIllegals: true, theme: appleTheme });
            } finally {
              console.warn = origWarn;
            }
          } catch {
            highlighted = truncatedCode;
          }
        } else {
          highlighted = truncatedCode;
        }

        const hLines = highlighted.split("\n");

        if (isCommandOutput) {
          // Command output: no line numbers, 4-space indent
          const body = hLines.map(l => "    " + l).join("\n");
          return "\n" + header + "\n" + body + "\n";
        } else {
          // Code with line numbers + gutter
          const numbered = hLines.map((l, i) => {
            const num = tertiary(String(i + 1).padStart(gutterW));
            return "  " + num + separator(" │ ") + l;
          }).join("\n");
          return "\n" + header + "\n" + numbered + "\n";
        }
      }
    },
    table(this: any, token: any) {
      return renderTable(token);
    },
  } as any,
});

/**
 * Close incomplete markdown fences for safe streaming rendering.
 * Handles: code fences, bold, inline code, incomplete tables.
 */
export function closeIncompleteFences(input: string): string {
  let result = input;

  // Close unclosed code fences (```...without closing ```)
  const fenceMatches = result.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    result += "\n```";
  }

  // Close unclosed inline backticks (odd count)
  const backtickCount = (result.match(/(?<!`)`(?!`)/g) || []).length;
  if (backtickCount % 2 !== 0) {
    result += "`";
  }

  // Close unclosed bold markers (odd pairs of **)
  const boldMatches = result.match(/\*\*/g);
  if (boldMatches && boldMatches.length % 2 !== 0) {
    result += "**";
  }

  // Close unclosed italic markers (single * not part of **)
  // Count standalone * (not part of **)
  const stripped = result.replace(/\*\*/g, "");
  const italicCount = (stripped.match(/\*/g) || []).length;
  if (italicCount % 2 !== 0) {
    result += "*";
  }

  return result;
}

/**
 * Render markdown to ANSI-styled terminal string.
 * Optionally applies streaming-safe fence closing.
 */
export function renderMarkdown(input: string, streaming = false): string {
  const safe = streaming ? closeIncompleteFences(input) : input;
  const result = marked.parse(safe) as string;
  return result.replace(/\n+$/, "");
}
