/**
 * Markdown rendering — Apple-polished terminal output
 *
 * Clean typography, subtle colors, proper table support.
 * Uses marked + marked-terminal + cli-table3 for tables.
 */

import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";

// Apple Dark palette
const blue    = chalk.hex("#0A84FF");
const purple  = chalk.hex("#BF5AF2");
const cyan    = chalk.hex("#64D2FF");
const orange  = chalk.hex("#FF9F0A");
const text    = chalk.hex("#F5F5F7");
const secondary = chalk.hex("#A1A1A6");
const tertiary  = chalk.hex("#6E6E73");
const separator = chalk.hex("#38383A");

marked.use(
  markedTerminal({
    // Headings — bold blue, clean
    firstHeading: blue.bold,
    heading: blue.bold,

    // Inline styles
    codespan: orange,
    strong: text.bold,
    em: secondary.italic,

    // Blocks
    blockquote: secondary.italic,
    paragraph: text,
    hr: () => separator("─".repeat(50)),

    // Links
    link: cyan,
    href: cyan.underline,

    // Lists
    listitem: text,

    // Tables — cleaner rendering (commented out due to TypeScript type mismatch)
    // tableOptions: {
    //   chars: {
    //     top: "─", "top-mid": "┬", "top-left": "┌", "top-right": "┐",
    //     bottom: "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘",
    //     left: "│", "left-mid": "├",
    //     mid: "─", "mid-mid": "┼",
    //     right: "│", "right-mid": "┤",
    //     middle: "│",
    //   },
    //   style: {
    //     head: ["cyan"],
    //     border: ["gray"],
    //   },
    // },

    // Layout
    reflowText: false,
    showSectionPrefix: false,
    width: 80,
    tab: 2,
  })
);

/**
 * Render markdown to ANSI-styled terminal string.
 * Synchronous — safe for render functions.
 */
export function renderMarkdown(text: string): string {
  const result = marked.parse(text) as string;
  return result.replace(/\n+$/, "");
}
