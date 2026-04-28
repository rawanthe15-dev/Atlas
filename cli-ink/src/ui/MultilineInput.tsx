import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  isFocused?: boolean;
  /** Called when the user presses Tab. Return a replacement value (with cursor at end) or null to ignore. */
  onTab?: (currentValue: string) => string | null;
  /**
   * Which key submits.
   * - `"enter"` (default): Enter submits, Alt/Shift+Enter inserts newline
   * - `"ctrl-s"`: Enter always inserts newline; Ctrl+S submits. Used by
   *   the SOUL/USER editor modal where Enter must add a line break.
   */
  submitKey?: "enter" | "ctrl-s";
}

interface CursorPos {
  line: number;
  col: number;
}

function valueToLines(v: string): string[] {
  return v.split("\n");
}

function offsetFromCursor(value: string, cursor: CursorPos): number {
  const lines = valueToLines(value);
  let offset = 0;
  for (let i = 0; i < cursor.line; i++) offset += lines[i].length + 1;
  return offset + cursor.col;
}

function cursorFromOffset(value: string, offset: number): CursorPos {
  let pos = 0;
  const lines = valueToLines(value);
  for (let i = 0; i < lines.length; i++) {
    if (offset <= pos + lines[i].length) {
      return { line: i, col: offset - pos };
    }
    pos += lines[i].length + 1;
  }
  return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

/**
 * Multi-line text input.
 *
 * Keymap:
 * - typed chars → insert at cursor
 * - Enter → submit
 * - Alt+Enter / Shift+Enter / Meta+Enter → insert newline
 * - Backspace → delete char before cursor
 * - Left/Right → move cursor
 * - Up/Down → move between lines
 *
 * The cursor is rendered as an inverse-video character so the user knows
 * where their next keystroke lands across multiple lines.
 */
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  isFocused = true,
  onTab,
  submitKey = "enter",
}: Props): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Keep the cursor inside the value if value shrinks externally.
  useEffect(() => {
    if (cursorOffset > value.length) setCursorOffset(value.length);
  }, [value, cursorOffset]);

  useInput(
    (input, key) => {
      if (disabled) return;

      // Tab → defer to the parent for autocomplete.
      if (key.tab && onTab) {
        const next = onTab(value);
        if (next !== null) {
          onChange(next);
          setCursorOffset(next.length);
        }
        return;
      }

      // Submit handling depends on submitKey mode.
      if (submitKey === "ctrl-s") {
        if (key.ctrl && (input === "s" || input === "\x13")) {
          onSubmit(value);
          return;
        }
        if (key.return) {
          insert("\n");
          return;
        }
      } else {
        // Enter alone → submit. Alt/Shift/Meta+Enter → newline.
        if (key.return) {
          if (key.meta || key.shift) {
            insert("\n");
            return;
          }
          onSubmit(value);
          return;
        }
      }

      if (key.backspace || key.delete) {
        if (cursorOffset === 0) return;
        const next = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(cursorOffset - 1);
        return;
      }

      if (key.leftArrow) {
        setCursorOffset(Math.max(0, cursorOffset - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset(Math.min(value.length, cursorOffset + 1));
        return;
      }
      if (key.upArrow) {
        const c = cursorFromOffset(value, cursorOffset);
        if (c.line === 0) return;
        const lines = valueToLines(value);
        const targetCol = Math.min(c.col, lines[c.line - 1].length);
        setCursorOffset(offsetFromCursor(value, { line: c.line - 1, col: targetCol }));
        return;
      }
      if (key.downArrow) {
        const c = cursorFromOffset(value, cursorOffset);
        const lines = valueToLines(value);
        if (c.line >= lines.length - 1) return;
        const targetCol = Math.min(c.col, lines[c.line + 1].length);
        setCursorOffset(offsetFromCursor(value, { line: c.line + 1, col: targetCol }));
        return;
      }

      // Ignore the rest of the special keys; only insert printable input.
      if (input && !key.ctrl) insert(input);

      function insert(s: string): void {
        const next = value.slice(0, cursorOffset) + s + value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(cursorOffset + s.length);
      }
    },
    { isActive: isFocused && !disabled },
  );

  const lines = value.length > 0 ? valueToLines(value) : [""];
  const cursor = cursorFromOffset(value, cursorOffset);
  const showPlaceholder = !value && !!placeholder && !disabled;

  return (
    <Box flexDirection="column">
      {showPlaceholder ? (
        <Text dimColor italic>
          {placeholder}
        </Text>
      ) : (
        lines.map((line, i) => {
          if (i !== cursor.line || disabled || !isFocused) {
            return (
              <Text key={i}>{line.length === 0 ? " " : line}</Text>
            );
          }
          // Render the cursor: split the line at the cursor column.
          const before = line.slice(0, cursor.col);
          const at = line[cursor.col] ?? " ";
          const after = line.slice(cursor.col + 1);
          return (
            <Text key={i}>
              {before}
              <Text inverse>{at}</Text>
              {after}
            </Text>
          );
        })
      )}
    </Box>
  );
}
