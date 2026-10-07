import { useId } from "react";
import { FRAME_COLORS, FRAME_MAX_H, FRAME_MAX_W, FRAME_MIN_H, FRAME_MIN_W, type Frame } from "@stickyard/shared";
import { Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { MIXED, READ_ONLY, Section, SizeField, Swatch, SwatchGroup, TextStyleSection } from "../notes/StyleFields";
import type { PartStyle } from "../notes/style";
import type { FrameEdit } from "./board";
import { FRAME_COLOR_NAMES, FRAME_INK_SWATCHES, frameSwatchStyle, frameTitleStyle } from "./style";

/** Each title style key and the frame field that holds it. */
const TITLE_FIELDS = {
  fontSize: "titleFontSize",
  bold: "titleBold",
  italic: "titleItalic",
  textColor: "titleTextColor",
  align: "titleAlign",
} as const satisfies Record<keyof PartStyle, keyof Frame>;

/** Text for the fields several frames can't share. */
export const FRAMES_TEXT = {
  title: "Edit titles one frame at a time.",
  size: "Use Match size (Arrange in the top bar) to give them one size.",
} as const;

/**
 * Two or more frames selected alone (v0.20.0, Properties md and up): Colour and Title text apply
 * to every selected frame (RoomSession.editFrames: one frameEdit each, paced, one undo step).
 * Fields that differ show "Mixed". Title and Width/Height can't be set for several at once: Title
 * shows the shared title or "Mixed", disabled; Width and Height are disabled and point to Match
 * size. Delete is in the panel's header. Read-only while disconnected or locked out.
 */
export function FramesFields({ frames, live, onEdit }: { frames: readonly Frame[]; live: boolean; onEdit: (change: FrameEdit) => void }) {
  const id = useId();
  const first = frames[0];
  if (!first) return null;
  const differs = (key: keyof Frame) => frames.some((f) => f[key] !== first[key]);
  const titleMixed = differs("title");
  return (
    <div className="flex flex-col gap-md">
      <p className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">
        Colour and title text change every selected frame. Drag one to move them all with the notes inside.
      </p>
      <div className="flex flex-col gap-xs">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          name="frameTitle"
          value={titleMixed ? "" : first.title}
          placeholder={titleMixed ? MIXED : "Frame title"}
          disabled
          readOnly
          aria-describedby={`${id}-title-help`}
        />
        <p id={`${id}-title-help`} className="text-sm text-fg-muted">
          {FRAMES_TEXT.title}
        </p>
      </div>

      <Section title="Colour">
        <SwatchGroup label="Frame colour" current={differs("color") ? MIXED : FRAME_COLOR_NAMES[first.color]}>
          {FRAME_COLORS.map((key) => (
            <Swatch
              key={key}
              label={FRAME_COLOR_NAMES[key]}
              fill=""
              fillStyle={frameSwatchStyle(key)}
              pressed={!differs("color") && key === first.color}
              disabled={!live}
              onClick={() => onEdit({ color: key })}
            />
          ))}
        </SwatchGroup>
        {!live && <p className="text-sm text-fg-muted">{READ_ONLY}</p>}
      </Section>

      <TextStyleSection
        part="title"
        style={frameTitleStyle(first)}
        live={live}
        differs={(key) => key in TITLE_FIELDS && differs(TITLE_FIELDS[key as keyof typeof TITLE_FIELDS])}
        swatch={(key) => ({ fill: "", fillStyle: FRAME_INK_SWATCHES[key] })}
        onChange={(change) =>
          onEdit(Object.fromEntries(Object.entries(change).map(([key, value]) => [TITLE_FIELDS[key as keyof PartStyle], value])) as FrameEdit)
        }
      />

      <Section title="Size">
        <div className="flex gap-ms">
          <SizeField label="Width" name="frameWidth" value={first.w} min={FRAME_MIN_W} max={FRAME_MAX_W} disabled mixed={differs("w")} onCommit={() => null} />
          <SizeField label="Height" name="frameHeight" value={first.h} min={FRAME_MIN_H} max={FRAME_MAX_H} disabled mixed={differs("h")} onCommit={() => null} />
        </div>
        <p data-frames-size-hint="" className="text-xs text-fg-muted">
          {FRAMES_TEXT.size}
        </p>
      </Section>
    </div>
  );
}
