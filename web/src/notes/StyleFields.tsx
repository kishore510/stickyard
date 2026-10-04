import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
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
  type NoteTextColor,
} from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import type { StylePatch } from "./board";
import { NOTE_COLOR_CLASSES, NOTE_COLOR_NAMES } from "./colours";
import { sizeFieldValue } from "./size";
import { NOTE_FONT_SIZE_NAMES, NOTE_TEXT_COLOR_NAMES, NOTE_TEXT_COLOR_SWATCHES, PART_FIELDS, alignLabel, partStyle, type NotePart, type PartStyle } from "./style";

/*
 * A note's colour, text style and size fields, laid out like Chalkline's Properties sections
 * (src/editor/fields.tsx and TextControls.tsx there): an uppercase section heading, swatches
 * (the chosen one ringed and pressed), and for the title and the body each a native select for
 * the size (best on touch), icon toggle buttons for Bold and Italic, an alignment radio group
 * and text colour swatches, then Width/Height number fields that
 * commit on Enter or blur. Every control is a 44px target and is disabled (and looks it) while
 * disconnected. Each change is one optimistic edit (see RoomSession.styleNote / setNoteSize).
 */

export const READ_ONLY = "Read only while disconnected.";
/** Shown for a value that differs between the selected notes. */
export const MIXED = "Mixed";

/** Fields whose values differ between the selected notes (several selected: read-only). */
export type MixedFields = ReadonlySet<string>;
const NONE: MixedFields = new Set();

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

export function Swatch({
  label,
  fill,
  fillStyle,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  fill: string;
  /** Token var() colours (frames), alongside or instead of `fill` classes. */
  fillStyle?: CSSProperties;
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
        style={fillStyle}
      />
    </button>
  );
}

/** A labelled group of swatches, with the current choice named beside the label (as in Chalkline). */
export function SwatchGroup({ label, groupLabel = label, current, children }: { label: string; groupLabel?: string; current: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-label={groupLabel} className="flex flex-col gap-xs">
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

export function ColourSection({
  note,
  live,
  onStyle,
  mixed = NONE,
}: {
  note: Note;
  live: boolean;
  onStyle: (change: StylePatch) => void;
  mixed?: MixedFields;
}) {
  const isMixed = mixed.has("color");
  return (
    <Section title="Colour">
      <SwatchGroup label="Note colour" current={isMixed ? MIXED : NOTE_COLOR_NAMES[note.color]}>
        {NOTE_COLORS.map((key) => (
          <Swatch
            key={key}
            label={NOTE_COLOR_NAMES[key]}
            fill={NOTE_COLOR_CLASSES[key]}
            pressed={!isMixed && key === note.color}
            disabled={!live}
            onClick={() => onStyle({ color: key })}
          />
        ))}
      </SwatchGroup>
    </Section>
  );
}

const ALIGN_ICONS: Record<NoteAlign, ReactNode> = { left: <AlignLeft />, center: <AlignCenter />, right: <AlignRight /> };

const PART_NAMES: Record<NotePart, string> = { title: "Title", body: "Body" };

/** A label on the left, controls on the right: fits the narrowest Properties panel on one line. */
function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-sm">
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
    </div>
  );
}

/** One part's alignment, as Chalkline's alignment radio group. */
function AlignGroup({ part, value, live, onChange }: { part: NotePart; value: NoteAlign | null; live: boolean; onChange: (key: NoteAlign) => void }) {
  return (
    <FieldRow label="Align">
      <div role="radiogroup" aria-label={`${PART_NAMES[part]} alignment`} className="flex gap-xs">
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
    </FieldRow>
  );
}

function ToggleButton({
  label,
  icon,
  pressed,
  disabled,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  pressed: boolean | "mixed";
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onPress}
      className={cn("aria-pressed:bg-accent-subtle aria-pressed:text-accent", pressed === "mixed" && "border border-dashed border-accent")}
    >
      {icon}
    </Button>
  );
}

/** One part's text style values that differ between the selected notes (several selected). */
type Differs = (key: keyof PartStyle) => boolean;
const SAME: Differs = () => false;

/**
 * A text style section (the note title's or body's, or a frame title's): Size, Bold and Italic,
 * Alignment and text colour, as Chalkline's Text section. Every part uses the same fields,
 * labels and one-row-per-control layout, so they look alike and nothing wraps at the 232px
 * panel minimum. `swatch` gives each ink's fill (note inks, or frame inks for frames).
 */
export function TextStyleSection({
  part,
  style,
  live,
  onChange,
  differs = SAME,
  swatch,
}: {
  part: NotePart;
  style: PartStyle;
  live: boolean;
  onChange: (change: Partial<PartStyle>) => void;
  differs?: Differs;
  swatch: (key: NoteTextColor) => { fill: string; fillStyle?: CSSProperties };
}) {
  const sizeId = useId();
  const name = PART_NAMES[part];
  const lower = name.toLowerCase();
  return (
    <Section title={`${name} text`}>
      <div className="flex flex-col gap-xs">
        <label htmlFor={sizeId} className="text-sm font-medium text-fg">
          Size
        </label>
        <select
          id={sizeId}
          name={PART_FIELDS[part].fontSize}
          value={differs("fontSize") ? "mixed" : style.fontSize}
          disabled={!live}
          onChange={(e) => {
            const key = NOTE_FONT_SIZES.find((k) => k === e.target.value);
            if (key) onChange({ fontSize: key satisfies NoteFontSize });
          }}
          className={cn(
            "h-touch w-full min-w-0 cursor-pointer rounded-md border border-border-strong bg-surface px-ms text-base text-fg transition-colors focus-visible:border-focus",
            "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-50",
          )}
        >
          {differs("fontSize") && (
            <option value="mixed" disabled>
              {MIXED}
            </option>
          )}
          {NOTE_FONT_SIZES.map((key) => (
            <option key={key} value={key}>
              {NOTE_FONT_SIZE_NAMES[key]}
            </option>
          ))}
        </select>
      </div>
      <FieldRow label="Style">
        <div role="group" aria-label={`${name} text style`} className="flex gap-xs">
          <ToggleButton
            label={`Bold ${lower}`}
            icon={<Bold />}
            pressed={differs("bold") ? "mixed" : style.bold}
            disabled={!live}
            onPress={() => onChange({ bold: !style.bold })}
          />
          <ToggleButton
            label={`Italic ${lower}`}
            icon={<Italic />}
            pressed={differs("italic") ? "mixed" : style.italic}
            disabled={!live}
            onPress={() => onChange({ italic: !style.italic })}
          />
        </div>
      </FieldRow>
      <AlignGroup part={part} value={differs("align") ? null : style.align} live={live} onChange={(key) => onChange({ align: key })} />
      <SwatchGroup label="Text colour" groupLabel={`${name} text colour`} current={differs("textColor") ? MIXED : NOTE_TEXT_COLOR_NAMES[style.textColor]}>
        {NOTE_TEXT_COLORS.map((key) => (
          <Swatch
            key={key}
            label={NOTE_TEXT_COLOR_NAMES[key]}
            {...swatch(key)}
            pressed={!differs("textColor") && key === style.textColor}
            disabled={!live}
            onClick={() => onChange({ textColor: key })}
          />
        ))}
      </SwatchGroup>
    </Section>
  );
}

const noteSwatch = (key: NoteTextColor) => ({ fill: NOTE_TEXT_COLOR_SWATCHES[key] });

/** One note part's text style (the title's or the body's), mapped onto that part's note fields. */
export function PartTextSection({
  part,
  note,
  live,
  onStyle,
  mixed = NONE,
}: {
  part: NotePart;
  note: Note;
  live: boolean;
  onStyle: (change: StylePatch) => void;
  mixed?: MixedFields;
}) {
  const fields = PART_FIELDS[part];
  return (
    <TextStyleSection
      part={part}
      style={partStyle(note, part)}
      live={live}
      differs={(key) => mixed.has(fields[key])}
      swatch={noteSwatch}
      onChange={(change) => onStyle(Object.fromEntries(Object.entries(change).map(([key, value]) => [fields[key as keyof PartStyle], value])) as StylePatch)}
    />
  );
}

/** A number field that only commits valid values, on Enter or blur; anything else is put back. */
export function SizeField({
  label,
  name,
  value,
  min,
  max,
  disabled,
  onCommit,
  mixed = false,
}: {
  label: string;
  name: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  /** Differs between the selected notes: empty, with "Mixed" as its placeholder. */
  mixed?: boolean;
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
        value={mixed ? "" : draft}
        placeholder={mixed ? MIXED : undefined}
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

export function SizeSection({
  note,
  live,
  onSize,
  mixed = NONE,
}: {
  note: Note;
  live: boolean;
  onSize: (w: number, h: number) => void;
  mixed?: MixedFields;
}) {
  const commit = (axis: "w" | "h") => (raw: string) => {
    const value = sizeFieldValue(raw, axis, note);
    if (value === null) return null;
    if (value !== note[axis]) onSize(axis === "w" ? value : note.w, axis === "h" ? value : note.h);
    return value;
  };
  return (
    <Section title="Size">
      <div className="flex gap-ms">
        <SizeField label="Width" name="width" value={note.w} min={NOTE_MIN_W} max={NOTE_MAX_W} disabled={!live} mixed={mixed.has("w")} onCommit={commit("w")} />
        <SizeField label="Height" name="height" value={note.h} min={NOTE_MIN_H} max={NOTE_MAX_H} disabled={!live} mixed={mixed.has("h")} onCommit={commit("h")} />
      </div>
      <p className="text-xs text-fg-muted">
        {mixed === NONE
          ? `${NOTE_MIN_W} to ${NOTE_MAX_W}. Or drag a corner of the selected note; Alt and arrow keys resize it from the keyboard.`
          : "To give several notes the same size, use Match size under Arrange in the top bar."}
      </p>
    </Section>
  );
}
