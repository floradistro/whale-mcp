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
    // Words: profit, revenue, gain, increase → green
    .replace(/\b(profit|revenue|gain|increase|in stock|available)\b/gi, (m) => systemGreen(m))
    // Words: loss, deduction, decrease, cost, expense, out of stock → red
    .replace(/\b(loss|deduction|decrease|deficit|expense|out of stock|low stock|overdue|expired|cancelled)\b/gi, (m) => systemRed(m));
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
      paragraph: text,
      hr: () => separator("─".repeat(50)),

      // Links
      link: systemCyan,
      href: systemCyan.underline,

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

      // Tables — polished
      table: (header: string, body: string) => {
        const divider = separator("─".repeat(64));
        return `\n${header}${divider}\n${body}\n`;
      },
      tablerow: (content: string) => {
        return `${content}\n`;
      },
      tablecell: (content: string, flags: { header?: boolean; align?: string }) => {
        const trimmed = content.trim();

        if (flags.header) {
          return systemIndigo.bold(content.padEnd(18)) + " ";
        }

        // Negative values → red
        if (/^-\$?[\d,]+\.?\d*$/.test(trimmed) || /^-\d+\.?\d*%$/.test(trimmed)) {
          return systemRed(content.padEnd(18)) + " ";
        }
        // Positive financial → green
        if (/^\+?\$[\d,]+\.?\d*$/.test(trimmed) || /^\+\d+/.test(trimmed)) {
          return systemGreen(content.padEnd(18)) + " ";
        }
        // Plain numbers → mint
        if (/^[\d,]+\.?\d*$/.test(trimmed)) {
          return systemMint(content.padEnd(18)) + " ";
        }
        // Percentages → cyan
        if (/^\d+\.?\d*%$/.test(trimmed)) {
          return systemCyan(content.padEnd(18)) + " ";
        }
        // Status words
        if (/^(active|success|complete|approved|in stock)/i.test(trimmed)) {
          return systemGreen(content.padEnd(18)) + " ";
        }
        if (/^(inactive|error|failed|cancelled|out of stock|low|overdue)/i.test(trimmed)) {
          return systemRed(content.padEnd(18)) + " ";
        }
        if (/^(pending|draft|processing)/i.test(trimmed)) {
          return systemOrange(content.padEnd(18)) + " ";
        }

        return text(content.padEnd(18)) + " ";
      },

      // Layout
      reflowText: false,
      showSectionPrefix: false,
      width: 80,
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
  const barWidth = Math.min(36, Math.max(16, 56 - maxLabel - maxRaw));

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

// Register chart extension — intercepts ```chart blocks before markedTerminal
marked.use({
  renderer: {
    code(this: any, token: any) {
      const lang = (typeof token === "object" ? token.lang : arguments[1]) || "";
      const code = typeof token === "object" ? token.text : token;
      if (lang === "chart" || lang === "bar") {
        return renderBarChart(code);
      }
      return false; // fall through to markedTerminal
    },
  } as any,
});

/**
 * Render markdown to ANSI-styled terminal string.
 */
export function renderMarkdown(input: string): string {
  const result = marked.parse(input) as string;
  return result.replace(/\n+$/, "");
}
