import { useId, type KeyboardEvent } from "react";
import { FRAME_COLORS, FRAME_MAX_H, FRAME_MAX_W, FRAME_MIN_H, FRAME_MIN_W, MAX_FRAME_TITLE, codePointLength, type FrameColor } from "@stickyard/shared";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { READ_ONLY, Section, SizeField, Swatch, SwatchGroup, TextStyleSection } from "../notes/StyleFields";
import type { BoardFrame, FrameEdit } from "./board";
import { FRAME_COLOR_NAMES, FRAME_INK_SWATCHES, frameSwatchStyle, frameTitleStyle } from "./style";

/**
 * A frame's fields in the Properties panel (md and up): Title (one line, a draft until Enter or
 * leaving the field, like the header), Colour, Title text (size, bold, italic, alignment and ink,
 * the note Title text fields; v10), Width and Height, and who added it. Delete is in
 * the panel's header. Phones have no frame editor. Read-only while disconnected.
 */
export function FrameFields({
  entry,
  live,
  author,
  onDraft,
  onCommit,
  onColour,
  onStyle,
  onSize,
}: {
  entry: BoardFrame;
  live: boolean;
  author: string;
  onDraft: (title: string) => void;
  onCommit: () => void;
  onColour: (color: FrameColor) => void;
  onStyle: (change: FrameEdit) => void;
  onSize: (w: number, h: number) => void;
}) {
  const id = useId();
  const { frame } = entry;
  const title = entry.draft ?? frame.title;
  const tooLong = codePointLength(title) > MAX_FRAME_TITLE;
  const confirmed = entry.confirmed !== null;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!tooLong) onCommit();
  };
  const size = (axis: "w" | "h") => (raw: string) => {
    const n = Math.round(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(n)) return null;
    const value = Math.min(axis === "w" ? FRAME_MAX_W : FRAME_MAX_H, Math.max(axis === "w" ? FRAME_MIN_W : FRAME_MIN_H, n));
    if (value !== frame[axis]) onSize(axis === "w" ? value : frame.w, axis === "h" ? value : frame.h);
    return value;
  };

  return (
    <div className="flex flex-col gap-md">
      <div className="flex flex-col gap-xs">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          name="frameTitle"
          autoComplete="off"
          value={title}
          disabled={!live}
          placeholder="Frame title"
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!tooLong) onCommit();
          }}
          aria-invalid={tooLong || undefined}
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="text-sm text-fg-muted">
          {live ? `One line, up to ${MAX_FRAME_TITLE} characters. Enter saves.` : READ_ONLY}
        </p>
        {tooLong && <FieldError>Frame titles can be up to {MAX_FRAME_TITLE} characters.</FieldError>}
      </div>

      <Section title="Colour">
        <SwatchGroup label="Frame colour" current={FRAME_COLOR_NAMES[frame.color]}>
          {FRAME_COLORS.map((key) => (
            <Swatch
              key={key}
              label={FRAME_COLOR_NAMES[key]}
              fill=""
              fillStyle={frameSwatchStyle(key)}
              pressed={key === frame.color}
              disabled={!live}
              onClick={() => onColour(key)}
            />
          ))}
        </SwatchGroup>
      </Section>

      <TextStyleSection
        part="title"
        style={frameTitleStyle(frame)}
        live={live}
        swatch={(key) => ({ fill: "", fillStyle: FRAME_INK_SWATCHES[key] })}
        onChange={(change) =>
          onStyle({
            ...(change.fontSize !== undefined ? { titleFontSize: change.fontSize } : {}),
            ...(change.bold !== undefined ? { titleBold: change.bold } : {}),
            ...(change.italic !== undefined ? { titleItalic: change.italic } : {}),
            ...(change.textColor !== undefined ? { titleTextColor: change.textColor } : {}),
            ...(change.align !== undefined ? { titleAlign: change.align } : {}),
          })
        }
      />

      <Section title="Size">
        <div className="flex gap-ms">
          <SizeField label="Width" name="frameWidth" value={frame.w} min={FRAME_MIN_W} max={FRAME_MAX_W} disabled={!live || !confirmed} onCommit={size("w")} />
          <SizeField label="Height" name="frameHeight" value={frame.h} min={FRAME_MIN_H} max={FRAME_MAX_H} disabled={!live || !confirmed} onCommit={size("h")} />
        </div>
        <p className="text-xs text-fg-muted">
          {FRAME_MIN_W} to {FRAME_MAX_W} wide, {FRAME_MIN_H} to {FRAME_MAX_H} tall. Or drag a corner of the selected frame.
        </p>
      </Section>

      <Section title="Details">
        <p className="text-sm">
          <span className="text-fg-muted">Added by </span>
          <span className="break-words">{author}</span>
        </p>
        <p className="text-sm text-fg-muted">Drag the title bar or border to move it with the notes inside; hold Alt to move it alone.</p>
      </Section>
    </div>
  );
}
