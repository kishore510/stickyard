import { useEffect, useId, useState, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic } from "lucide-react";
import {
  NOTE_ALIGNS,
  NOTE_COLORS,
  NOTE_FONT_SIZES,
  NOTE_MAX_H,
  NOTE_MAX_W,
  NOTE_MIN_H,
  NOTE_MIN_W,
  NOTE_TEXT_COLORS,
  type Note,
  type NoteAlign,
  type NoteFontSize,
} from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import type { StylePatch } from "./board";
import { NOTE_COLOR_CLASSES, NOTE_COLOR_NAMES } from "./colours";
import { sizeFieldValue } from "./size";
import { NOTE_FONT_SIZE_NAMES, NOTE_TEXT_COLOR_NAMES, NOTE_TEXT_COLOR_SWATCHES, alignLabel } from "./style";

/*
 * A note's colour, text style and size fields, laid out like Chalkline's Properties sections
 * (src/editor/fields.tsx and TextControls.tsx there): an uppercase section heading, swatches
 * (the chosen one ringed and pressed), a native select for the size (best on touch), icon toggle
 * buttons for Bold and Italic, an alignment radio group, and Width/Height number fields that
 * commit on Enter or blur. Every control is a 44px target and is disabled (and looks it) while
 * disconnected. Each change is one optimistic edit (see RoomSession.styleNote / setNoteSize).
 */

export const READ_ONLY = "Read only while disconnected.";

export function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <section className="flex flex-col gap-ms border-t border-border pt-md">
      <h3 id={id} className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Swatch({
  label,
  fill,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  fill: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-touch cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-surface-muted aria-pressed:bg-accent-subtle",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-swatch rounded-full border border-border-strong", fill, pressed && "ring-2 ring-accent ring-offset-2 ring-offset-surface")}
      />
    </button>
  );
}

/** A labelled group of swatches, with the current choice named beside the label (as in Chalkline). */
function SwatchGroup({ label, current, children }: { label: string; current: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-xs">
      <div className="flex items-baseline justify-between gap-sm text-sm">
        <span id={id} className="font-medium text-fg">
          {label}
        </span>
        <span className="truncate text-xs text-fg-muted">{current}</span>
      </div>
      <div className="flex flex-wrap gap-2xs">{children}</div>
    </div>
  );
}

export function ColourSection({ note, live, onStyle }: { note: Note; live: boolean; onStyle: (change: StylePatch) => void }) {
  return (
    <Section title="Colour">
      <SwatchGroup label="Note colour" current={NOTE_COLOR_NAMES[note.color]}>
        {NOTE_COLORS.map((key) => (
          <Swatch
            key={key}
            label={NOTE_COLOR_NAMES[key]}
            fill={NOTE_COLOR_CLASSES[key]}
            pressed={key === note.color}
            disabled={!live}
            onClick={() => onStyle({ color: key })}
          />
        ))}
      </SwatchGroup>
    </Section>
  );
}

const ALIGN_ICONS: Record<NoteAlign, ReactNode> = { left: <AlignLeft />, center: <AlignCenter />, right: <AlignRight /> };

/** One part's alignment (the title, or the body), as Chalkline's alignment radio group. */
function AlignGroup({ part, value, live, onChange }: { part: "title" | "body"; value: NoteAlign; live: boolean; onChange: (key: NoteAlign) => void }) {
  const label = part === "title" ? "Title alignment" : "Body alignment";
  return (
    <div className="flex items-center justify-between gap-sm">
      <span className="text-sm font-medium text-fg">{part === "title" ? "Title" : "Body"}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-xs">
        {NOTE_ALIGNS.map((key) => (
          <Button
            key={key}
            variant="ghost"
            size="icon"
            role="radio"
            aria-checked={value === key}
            aria-label={alignLabel(part, key)}
            title={alignLabel(part, key)}
            disabled={!live}
            onClick={() => onChange(key)}
            className={cn(value === key && "bg-accent-subtle text-accent")}
          >
            {ALIGN_ICONS[key]}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ToggleButton({ label, icon, pressed, disabled, onPress }: { label: string; icon: ReactNode; pressed: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
      className="aria-pressed:bg-accent-subtle aria-pressed:text-accent"
    >
      {icon}
    </Button>
  );
}

export function TextSection({ note, live, onStyle }: { note: Note; live: boolean; onStyle: (change: StylePatch) => void }) {
  const sizeId = useId();
  return (
    <Section title="Text">
      <div className="flex flex-col gap-xs">
        <label htmlFor={sizeId} className="text-sm font-medium text-fg">
          Size
        </label>
        <select
          id={sizeId}
          name="fontSize"
          value={note.fontSize}
          disabled={!live}
          onChange={(e) => {
            const key = NOTE_FONT_SIZES.find((k) => k === e.target.value);
            if (key) onStyle({ fontSize: key satisfies NoteFontSize });
          }}
          className={cn(
            "h-touch w-full min-w-0 cursor-pointer rounded-md border border-border-strong bg-surface px-ms text-base text-fg transition-colors focus-visible:border-focus",
            "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-50",
          )}
        >
          {NOTE_FONT_SIZES.map((key) => (
            <option key={key} value={key}>
              {NOTE_FONT_SIZE_NAMES[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-xs">
        <div role="group" aria-label="Text style" className="flex gap-xs">
          <ToggleButton label="Bold" icon={<Bold />} pressed={note.bold} disabled={!live} onPress={() => onStyle({ bold: !note.bold })} />
          <ToggleButton label="Italic" icon={<Italic />} pressed={note.italic} disabled={!live} onPress={() => onStyle({ italic: !note.italic })} />
        </div>
      </div>
      <AlignGroup part="title" value={note.titleAlign} live={live} onChange={(titleAlign) => onStyle({ titleAlign })} />
      <AlignGroup part="body" value={note.align} live={live} onChange={(align) => onStyle({ align })} />
      <SwatchGroup label="Text colour" current={NOTE_TEXT_COLOR_NAMES[note.textColor]}>
        {NOTE_TEXT_COLORS.map((key) => (
          <Swatch
            key={key}
            label={NOTE_TEXT_COLOR_NAMES[key]}
            fill={NOTE_TEXT_COLOR_SWATCHES[key]}
            pressed={key === note.textColor}
            disabled={!live}
            onClick={() => onStyle({ textColor: key })}
          />
        ))}
      </SwatchGroup>
    </Section>
  );
}

/** A number field that only commits valid values, on Enter or blur; anything else is put back. */
function SizeField({
  label,
  name,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  name: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  /** The clamped value, or null to put the field back. */
  onCommit: (raw: string) => number | null;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = onCommit(draft);
    setDraft(String(next ?? value));
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-xs">
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
      </label>
      <Input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commit();
        }}
        className="tabular-nums"
      />
    </div>
  );
}

export function SizeSection({ note, live, onSize }: { note: Note; live: boolean; onSize: (w: number, h: number) => void }) {
  const commit = (axis: "w" | "h") => (raw: string) => {
    const value = sizeFieldValue(raw, axis, note);
    if (value === null) return null;
    if (value !== note[axis]) onSize(axis === "w" ? value : note.w, axis === "h" ? value : note.h);
    return value;
  };
  return (
    <Section title="Size">
      <div className="flex gap-ms">
        <SizeField label="Width" name="width" value={note.w} min={NOTE_MIN_W} max={NOTE_MAX_W} disabled={!live} onCommit={commit("w")} />
        <SizeField label="Height" name="height" value={note.h} min={NOTE_MIN_H} max={NOTE_MAX_H} disabled={!live} onCommit={commit("h")} />
      </div>
      <p className="text-xs text-fg-muted">
        {NOTE_MIN_W} to {NOTE_MAX_W}. Or drag a corner of the selected note; Alt and arrow keys resize it from the keyboard.
      </p>
    </Section>
  );
}
