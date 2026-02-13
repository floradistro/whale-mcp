/**
 * ChatInput — Custom input with bracketed paste + image attachments
 *
 * Replaces ink-text-input with raw stdin handling to fix:
 * - Paste losing content on enter (newlines in paste triggered submit)
 * - Multi-line paste mangled/unformatted
 * - No drag-drop image support
 *
 * Features:
 * - Bracketed paste mode — clean multi-line paste
 * - Drag-drop images — detects image file paths, attaches as chips
 * - Image chips above input like Claude Code: [image1.png] [image2.jpg]
 * - Backspace on empty input removes last image
 * - Slash command menu preserved
 * - Multi-line input with ⎸ continuation markers
 */

import { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import SelectInput from "ink-select-input";
import { readFileSync, existsSync, statSync } from "fs";
import { basename, extname } from "path";
import { colors } from "../shared/Theme.js";

// ── Types ──

export interface ImageAttachment {
  path: string;
  name: string;
  base64: string;
  mediaType: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help",     description: "Show available commands" },
  { name: "/tools",    description: "List all tools" },
  { name: "/model",    description: "Switch model (sonnet/opus/haiku)" },
  { name: "/compact",  description: "Compress conversation context" },
  { name: "/save",     description: "Save session to disk" },
  { name: "/sessions", description: "List saved sessions" },
  { name: "/resume",   description: "Resume a saved session" },
  { name: "/mcp",      description: "Server connection status" },
  { name: "/store",    description: "Switch active store" },
  { name: "/status",   description: "Show session info" },
  { name: "/agents",   description: "List available agent types" },
  { name: "/remember", description: "Remember a fact across sessions" },
  { name: "/forget",   description: "Forget a remembered fact" },
  { name: "/memory",   description: "List all remembered facts" },
  { name: "/mode",     description: "Permission mode (default/plan/yolo)" },
  { name: "/update",   description: "Check for updates & install" },
  { name: "/clear",    description: "Clear conversation" },
  { name: "/exit",     description: "Exit" },
];

// ── Constants ──

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_DISPLAY_LINES = 8;

// ── Helpers ──

function dividerLine(): string {
  const w = (process.stdout.columns || 80) - 2;
  return "─".repeat(Math.max(20, w));
}

function isImagePath(text: string): boolean {
  const p = text.trim().replace(/\\ /g, " ").replace(/^['"]|['"]$/g, "");
  if (!p || p.includes("\n")) return false;
  const ext = extname(p).toLowerCase();
  return ext in IMAGE_EXTENSIONS && existsSync(p);
}

function loadImage(filePath: string): ImageAttachment | null {
  try {
    const p = filePath.trim().replace(/\\ /g, " ").replace(/^['"]|['"]$/g, "");
    const ext = extname(p).toLowerCase();
    const mediaType = IMAGE_EXTENSIONS[ext];
    if (!mediaType) return null;
    const stat = statSync(p);
    if (stat.size > MAX_IMAGE_SIZE) return null;
    const data = readFileSync(p);
    return { path: p, name: basename(p), base64: data.toString("base64"), mediaType };
  } catch {
    return null;
  }
}

function getCursorLineCol(text: string, cursor: number): { line: number; col: number } {
  let pos = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (cursor <= pos + lines[i].length) {
      return { line: i, col: cursor - pos };
    }
    pos += lines[i].length + 1;
  }
  return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

// ── Props ──

interface ChatInputProps {
  onSubmit: (message: string, images?: ImageAttachment[]) => void;
  onCommand: (command: string) => void;
  disabled: boolean;
  agentName?: string;
}

// ── Component ──

export function ChatInput({ onSubmit, onCommand, disabled, agentName }: ChatInputProps) {
  const { stdin } = useStdin();

  // Input state — ref for synchronous handler access, state for render
  const inputRef = useRef({ value: "", cursor: 0 });
  const [displayValue, setDisplayValue] = useState("");
  const [displayCursor, setDisplayCursor] = useState(0);

  // Mode & attachments
  const [menuMode, setMenuMode] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const imagesRef = useRef<ImageAttachment[]>([]);

  // Paste tracking
  const isPasting = useRef(false);
  const pasteBuffer = useRef("");

  // Sync image ref
  useEffect(() => { imagesRef.current = images; }, [images]);

  // ── Enable bracketed paste mode ──
  useEffect(() => {
    process.stdout.write("\x1b[?2004h");
    return () => { process.stdout.write("\x1b[?2004l"); };
  }, []);

  // ── Update helper ──
  function update(value: string, cursor: number) {
    inputRef.current = { value, cursor };
    setDisplayValue(value);
    setDisplayCursor(cursor);
  }

  // ── Process paste content ──
  function processPaste(text: string) {
    const clean = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Check if ALL non-empty lines are image paths → attach them
    const lines = clean.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every(l => isImagePath(l))) {
      const newImages: ImageAttachment[] = [];
      for (const line of lines) {
        const img = loadImage(line);
        if (img) newImages.push(img);
      }
      if (newImages.length > 0) {
        setImages(prev => [...prev, ...newImages]);
        return;
      }
    }

    // Slash command pasted directly
    if (clean.startsWith("/") && !clean.includes("\n") && inputRef.current.value === "") {
      onCommand(clean.trim());
      update("", 0);
      return;
    }

    // Insert as text
    const { value: val, cursor: cur } = inputRef.current;
    const newValue = val.slice(0, cur) + clean + val.slice(cur);
    update(newValue, cur + clean.length);
  }

  // ── Handle submit ──
  function handleSubmit() {
    const text = inputRef.current.value.trim();
    const imgs = imagesRef.current;

    if (!text && imgs.length === 0) return;

    if (text.startsWith("/") && imgs.length === 0) {
      update("", 0);
      onCommand(text);
      return;
    }

    onSubmit(text, imgs.length > 0 ? imgs : undefined);
    update("", 0);
    setImages([]);
  }

  // ── Raw stdin handler ──
  useEffect(() => {
    if (!stdin || disabled || menuMode) return;

    const onData = (data: Buffer) => {
      const str = data.toString("utf-8");

      // ── Bracketed paste detection ──
      if (str.includes("\x1b[200~")) {
        isPasting.current = true;
        let text = str.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
        pasteBuffer.current += text;
        if (str.includes("\x1b[201~")) {
          isPasting.current = false;
          const paste = pasteBuffer.current;
          pasteBuffer.current = "";
          processPaste(paste);
        }
        return;
      }

      if (isPasting.current) {
        if (str.includes("\x1b[201~")) {
          isPasting.current = false;
          pasteBuffer.current += str.replace(/\x1b\[201~/g, "");
          const paste = pasteBuffer.current;
          pasteBuffer.current = "";
          processPaste(paste);
        } else {
          pasteBuffer.current += str;
        }
        return;
      }

      // ── Control chars handled by ChatApp ──
      if (str === "\x03" || str === "\x05") return; // Ctrl+C, Ctrl+E

      // ── Enter ──
      if (str === "\r" || str === "\n") {
        handleSubmit();
        return;
      }

      // ── Tab ── (no-op in input)
      if (str === "\t") return;

      // ── Backspace ──
      if (str === "\x7f" || str === "\b") {
        const { value: val, cursor: cur } = inputRef.current;
        if (cur > 0) {
          update(val.slice(0, cur - 1) + val.slice(cur), cur - 1);
        } else if (val === "" && imagesRef.current.length > 0) {
          // Empty input + backspace → remove last image
          setImages(prev => prev.slice(0, -1));
        }
        return;
      }

      // ── Ctrl+U — clear line ──
      if (str === "\x15") {
        update("", 0);
        setImages([]);
        return;
      }

      // ── Ctrl+W — delete word ──
      if (str === "\x17") {
        const { value: val, cursor: cur } = inputRef.current;
        const before = val.slice(0, cur);
        const match = before.match(/\S+\s*$/);
        if (match) {
          const len = match[0].length;
          update(val.slice(0, cur - len) + val.slice(cur), cur - len);
        }
        return;
      }

      // ── Ctrl+A — home ──
      if (str === "\x01") {
        update(inputRef.current.value, 0);
        return;
      }

      // ── Escape sequences ──
      if (str.startsWith("\x1b[")) {
        const { value: val, cursor: cur } = inputRef.current;

        if (str === "\x1b[C") { // Right
          update(val, Math.min(cur + 1, val.length));
        } else if (str === "\x1b[D") { // Left
          update(val, Math.max(cur - 1, 0));
        } else if (str === "\x1b[H" || str === "\x1b[1~") { // Home
          update(val, 0);
        } else if (str === "\x1b[F" || str === "\x1b[4~") { // End
          update(val, val.length);
        } else if (str === "\x1b[3~") { // Delete
          if (cur < val.length) {
            update(val.slice(0, cur) + val.slice(cur + 1), cur);
          }
        } else if (str === "\x1b[A" || str === "\x1b[B") { // Up/Down
          const lines = val.split("\n");
          if (lines.length > 1) {
            const { line: curLine, col: curCol } = getCursorLineCol(val, cur);
            const targetLine = str === "\x1b[A"
              ? Math.max(0, curLine - 1)
              : Math.min(lines.length - 1, curLine + 1);
            if (targetLine !== curLine) {
              const targetCol = Math.min(curCol, lines[targetLine].length);
              let newCursor = 0;
              for (let i = 0; i < targetLine; i++) newCursor += lines[i].length + 1;
              newCursor += targetCol;
              update(val, newCursor);
            }
          }
        }
        // Ignore unrecognized escape sequences
        return;
      }

      // ── Standalone escape ──
      if (str === "\x1b") return;

      // ── Multi-character non-escape = paste without brackets ──
      if (str.length > 1 && !str.startsWith("\x1b")) {
        const codePoints = [...str];
        if (codePoints.length === 1) {
          // Single code point (emoji etc.)
          const { value: val, cursor: cur } = inputRef.current;
          update(val.slice(0, cur) + str + val.slice(cur), cur + str.length);
        } else {
          processPaste(str);
        }
        return;
      }

      // ── Single printable character ──
      if (str.length === 1 && str.charCodeAt(0) >= 0x20) {
        const { value: val, cursor: cur } = inputRef.current;

        // Slash menu trigger
        if (str === "/" && val === "") {
          setMenuMode(true);
          return;
        }

        update(val.slice(0, cur) + str + val.slice(cur), cur + 1);
      }
    };

    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, disabled, menuMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Menu dismiss (uses Ink's useInput for SelectInput compatibility) ──
  useInput((_input, key) => {
    if (!menuMode || disabled) return;
    if (key.escape || key.delete || key.backspace) {
      setMenuMode(false);
    }
  }, { isActive: menuMode });

  const handleMenuSelect = (item: { label: string; value: string }) => {
    setMenuMode(false);
    update("", 0);
    onCommand(item.value);
  };

  // ── Render ──

  const divider = dividerLine();

  // Disabled — minimal divider
  if (disabled) {
    return (
      <Box flexDirection="column">
        <Text>{" "}</Text>
        <Text color={colors.separator}>{divider}</Text>
      </Box>
    );
  }

  // Slash command menu
  if (menuMode) {
    const items = SLASH_COMMANDS.map((c) => ({
      label: c.name,
      value: c.name,
    }));

    return (
      <Box flexDirection="column">
        <Text>{" "}</Text>
        <Text color={colors.separator}>{divider}</Text>
        <SelectInput
          items={items}
          onSelect={handleMenuSelect}
          indicatorComponent={({ isSelected = false }: { isSelected?: boolean }) => (
            <Text color={isSelected ? colors.brand : colors.quaternary}>
              {isSelected ? "›" : " "}{" "}
            </Text>
          )}
          itemComponent={({ isSelected = false, label = "" }: { isSelected?: boolean; label?: string }) => {
            const cmd = SLASH_COMMANDS.find((c) => c.name === label);
            return (
              <Text>
                <Text color={isSelected ? colors.brand : colors.secondary} bold={isSelected}>
                  {label}
                </Text>
                <Text color={colors.tertiary}>  {cmd?.description}</Text>
              </Text>
            );
          }}
        />
        <Text color={colors.quaternary}>  esc to dismiss</Text>
      </Box>
    );
  }

  // ── Normal input rendering ──

  const lines = displayValue.split("\n");
  const { line: cursorLine, col: cursorCol } = displayValue
    ? getCursorLineCol(displayValue, displayCursor)
    : { line: 0, col: 0 };

  // Truncate display for very long pastes
  const isTruncated = lines.length > MAX_DISPLAY_LINES;
  const visibleLines = isTruncated
    ? [...lines.slice(0, MAX_DISPLAY_LINES - 1), `… ${lines.length - MAX_DISPLAY_LINES + 1} more lines`]
    : lines;

  return (
    <Box flexDirection="column">
      <Text>{" "}</Text>

      {/* Image chips */}
      {images.length > 0 && (
        <Box>
          <Text>  </Text>
          {images.map((img, i) => (
            <Text key={i}>
              <Text color="#5E5CE6">[</Text>
              <Text color="#A0A0A8">{img.name}</Text>
              <Text color="#5E5CE6">]</Text>
              <Text> </Text>
            </Text>
          ))}
        </Box>
      )}

      <Text color={colors.separator}>{divider}</Text>

      {/* Single-line input */}
      {lines.length <= 1 ? (
        <Box>
          <Text color="#E5E5EA" bold>{"❯"} </Text>
          {!displayValue ? (
            <Text>
              <Text inverse> </Text>
              <Text color={colors.dim}>{`Message ${agentName || "whale"}, or type / for commands`}</Text>
            </Text>
          ) : (
            <Text>
              {displayValue.slice(0, displayCursor)}
              <Text inverse>{displayCursor < displayValue.length ? displayValue[displayCursor] : " "}</Text>
              {displayCursor < displayValue.length ? displayValue.slice(displayCursor + 1) : ""}
            </Text>
          )}
        </Box>
      ) : (
        /* Multi-line input */
        <Box flexDirection="column">
          {visibleLines.map((line, i) => {
            const isRealLine = !isTruncated || i < MAX_DISPLAY_LINES - 1;
            const isCursorOnLine = isRealLine && i === cursorLine;

            return (
              <Box key={i}>
                <Text color="#E5E5EA" bold>{i === 0 ? "❯" : "⎸"} </Text>
                {isCursorOnLine ? (
                  <Text>
                    {line.slice(0, cursorCol)}
                    <Text inverse>{cursorCol < line.length ? line[cursorCol] : " "}</Text>
                    {cursorCol < line.length ? line.slice(cursorCol + 1) : ""}
                  </Text>
                ) : (
                  <Text color={isRealLine ? undefined : "#636366"}>{line}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
