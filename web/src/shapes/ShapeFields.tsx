import { useId } from "react";
import {
  MAX_SHAPE_TEXT,
  SHAPE_FILLS,
  SHAPE_FONT_SIZES,
  SHAPE_MAX_H,
  SHAPE_MAX_W,
  SHAPE_MIN_H,
  SHAPE_MIN_W,
  SHAPE_STROKES,
  SHAPE_STROKE_STYLES,
  SHAPE_STROKE_WIDTHS,
  codePointLength,
  type OrderAction,
  type Shape,
} from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/field";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import { OrderSection } from "../notes/OrderFields";
import { sizeFieldValue } from "../notes/size";
import { READ_ONLY, Section, SizeField, Swatch, SwatchGroup, TextStyleSection, type TextStyleValues } from "../notes/StyleFields";
import type { BoardShape, ShapeEdit } from "./board";
import { SHAPE_LIMITS } from "./ShapeNode";
import {
  SHAPE_FILL_NAMES,
  SHAPE_FONT_SIZE_NAMES,
  SHAPE_INK_SWATCHES,
  SHAPE_KIND_NAMES,
  SHAPE_STROKE_STYLE_NAMES,
  SHAPE_STROKE_WIDTH_NAMES,
  shapeFillSwatch,
  shapeStrokeSwatch,
} from "./style";
import { FRAME_COLOR_NAMES } from "../frames/style";

const SHAPE_SIZES = { keys: SHAPE_FONT_SIZES, names: SHAPE_FONT_SIZE_NAMES as Readonly<Record<string, string>> };

/** A shape's text style as the shared text style section shows it. */
export function shapeTextValues(shape: Shape): TextStyleValues {
  const { fontSize, bold, italic, underline, textColor, align, valign } = shape;
  return { fontSize, bold, italic, underline, textColor, align, valign };
}

/** A row of labelled choice buttons (border width and style): a radio group, 44px targets. */
function ChoiceRow<K extends string>({
  label,
  keys,
  names,
  value,
  live,
  onPick,
}: {
  label: string;
  keys: readonly K[];
  names: Record<K, string>;
  value: K | null;
  live: boolean;
  onPick: (key: K) => void;
}) {
  return (
    <div className="flex flex-col gap-xs">
      <span className="text-sm font-medium text-fg">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-xs">
        {keys.map((key) => (
          <Button
            key={key}
            variant="ghost"
            role="radio"
            aria-checked={value === key}
            disabled={!live}
            onClick={() => onPick(key)}
            className={cn("min-w-touch px-sm text-sm", value === key && "bg-accent-subtle text-accent")}
          >
            {names[key]}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Fill, border colour, border width and border style (not shown for a text box). */
export function ShapeLookSection({ shape, live, onEdit, mixed = new Set() }: { shape: Shape; live: boolean; onEdit: (change: ShapeEdit) => void; mixed?: ReadonlySet<string> }) {
  const fillMixed = mixed.has("fill");
  const strokeMixed = mixed.has("stroke");
  return (
    <Section title="Shape">
      <SwatchGroup label="Fill" groupLabel="Fill colour" current={fillMixed ? "Mixed" : SHAPE_FILL_NAMES[shape.fill]}>
        {SHAPE_FILLS.map((key) => (
          <Swatch key={key} label={key === "none" ? SHAPE_FILL_NAMES[key] : `${SHAPE_FILL_NAMES[key]} fill`} fill="" fillStyle={shapeFillSwatch(key)} pressed={!fillMixed && key === shape.fill} disabled={!live} onClick={() => onEdit({ fill: key })} />
        ))}
      </SwatchGroup>
      <SwatchGroup label="Border colour" current={strokeMixed ? "Mixed" : FRAME_COLOR_NAMES[shape.stroke]}>
        {SHAPE_STROKES.map((key) => (
          <Swatch
            key={key}
            label={`${FRAME_COLOR_NAMES[key]} border`}
            fill=""
            fillStyle={shapeStrokeSwatch(key)}
            pressed={!strokeMixed && key === shape.stroke}
            disabled={!live}
            onClick={() => onEdit({ stroke: key })}
          />
        ))}
      </SwatchGroup>
      <ChoiceRow
        label="Border width"
        keys={SHAPE_STROKE_WIDTHS}
        names={SHAPE_STROKE_WIDTH_NAMES}
        value={mixed.has("strokeWidth") ? null : shape.strokeWidth}
        live={live}
        onPick={(strokeWidth) => onEdit({ strokeWidth })}
      />
      <ChoiceRow
        label="Border style"
        keys={SHAPE_STROKE_STYLES}
        names={SHAPE_STROKE_STYLE_NAMES}
        value={mixed.has("strokeStyle") ? null : shape.strokeStyle}
        live={live}
        onPick={(strokeStyle) => onEdit({ strokeStyle })}
      />
    </Section>
  );
}

/**
 * A shape's fields in the Properties panel (md and up, protocol v15): its text (a draft until
 * leaving the field), text style (size, bold, italic, underline, alignment, vertical placement and
 * ink), its look (fill and border; not for a text box), size, stacking order, and who added it.
 * Delete is in the panel's header. Phones show shapes read-only. Read-only while disconnected or
 * locked. Text is untrusted: it's only ever a field value.
 */
export function ShapeFields({
  entry,
  live,
  author,
  onDraft,
  onCommit,
  onEdit,
  onSize,
  onOrder,
}: {
  entry: BoardShape;
  live: boolean;
  author: string;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onEdit: (change: ShapeEdit) => void;
  onSize: (w: number, h: number) => void;
  onOrder: (action: OrderAction) => void;
}) {
  const id = useId();
  const { shape } = entry;
  const text = entry.draft ?? shape.text;
  const length = codePointLength(text);
  const confirmed = entry.confirmed !== null;
  const size = (axis: "w" | "h") => (raw: string) => {
    const value = sizeFieldValue(raw, axis, shape, SHAPE_LIMITS);
    if (value === null) return null;
    if (value !== shape[axis]) onSize(axis === "w" ? value : shape.w, axis === "h" ? value : shape.h);
    return value;
  };
  return (
    <div data-shape-fields="" className="flex flex-col gap-md">
      <div className="flex flex-col gap-xs">
        <Label htmlFor={`${id}-text`}>Text</Label>
        <Textarea
          id={`${id}-text`}
          name="shapeText"
          value={text}
          disabled={!live}
          rows={3}
          placeholder="Type here"
          onChange={(e) => {
            if (codePointLength(e.target.value) <= MAX_SHAPE_TEXT) onDraft(e.target.value);
          }}
          onBlur={onCommit}
          aria-describedby={`${id}-help`}
        />
        <p id={`${id}-help`} className="flex justify-between gap-sm text-sm text-fg-muted">
          <span>{live ? "Saved when you leave the field." : READ_ONLY}</span>
          <span className="tabular-nums">
            {length} / {MAX_SHAPE_TEXT}
          </span>
        </p>
      </div>

      <TextStyleSection
        part="text"
        title="Text style"
        style={shapeTextValues(shape)}
        live={live}
        sizes={SHAPE_SIZES}
        swatch={(key) => ({ fill: "", fillStyle: SHAPE_INK_SWATCHES[key] })}
        onChange={(change) => onEdit(change as ShapeEdit)}
      />

      {shape.kind !== "text" && <ShapeLookSection shape={shape} live={live} onEdit={onEdit} />}

      <Section title="Size">
        <div className="flex gap-ms">
          <SizeField label="Width" name="shapeWidth" value={shape.w} min={SHAPE_MIN_W} max={SHAPE_MAX_W} disabled={!live || !confirmed} onCommit={size("w")} />
          <SizeField label="Height" name="shapeHeight" value={shape.h} min={SHAPE_MIN_H} max={SHAPE_MAX_H} disabled={!live || !confirmed} onCommit={size("h")} />
        </div>
        <p className="text-xs text-fg-muted">
          {SHAPE_MIN_W} to {SHAPE_MAX_W} wide, {SHAPE_MIN_H} to {SHAPE_MAX_H} tall. Or drag a corner of the selected shape; Alt and arrow keys resize it.
        </p>
      </Section>

      <OrderSection live={live && confirmed} onOrder={onOrder} />

      <Section title="Details">
        <p className="text-sm">
          <span className="text-fg-muted">{SHAPE_KIND_NAMES[shape.kind]}, added by </span>
          <span className="break-words">{author}</span>
        </p>
      </Section>
    </div>
  );
}

/** Text for what several shapes can't share. */
export const SHAPES_TEXT = {
  text: "Edit text one shape at a time.",
  size: "Use Match size (Arrange in the top bar) to give them one size.",
} as const;

/**
 * Two or more shapes selected alone (protocol v15, Properties md and up): text style, fill and
 * border apply to every selected shape (RoomSession.editShapes: one shapeEdit each, paced, one
 * undo step). Fields that differ show "Mixed". Text and Width/Height can't be set for several at
 * once: Text shows the shared text or "Mixed", disabled; Width and Height are disabled and point
 * to Match size. Fill and border show when any selected shape isn't a text box. Delete is in the
 * panel's header. Read-only while disconnected or locked out.
 */
export function ShapesFields({ shapes, live, onEdit }: { shapes: readonly Shape[]; live: boolean; onEdit: (change: ShapeEdit) => void }) {
  const id = useId();
  const first = shapes[0];
  if (!first) return null;
  const differs = (key: keyof Shape) => shapes.some((x) => x[key] !== first[key]);
  const mixed = new Set((["fill", "stroke", "strokeWidth", "strokeStyle"] as const).filter((k) => differs(k)));
  const textMixed = differs("text");
  return (
    <div data-shapes-fields="" className="flex flex-col gap-md">
      <p className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">
        Text style, fill and border change every selected shape. Drag one to move them all.
      </p>
      <div className="flex flex-col gap-xs">
        <Label htmlFor={`${id}-text`}>Text</Label>
        <Textarea
          id={`${id}-text`}
          name="shapeText"
          value={textMixed ? "" : first.text}
          placeholder={textMixed ? "Mixed" : ""}
          rows={2}
          disabled
          readOnly
          aria-describedby={`${id}-text-help`}
        />
        <p id={`${id}-text-help`} className="text-sm text-fg-muted">
          {SHAPES_TEXT.text}
        </p>
      </div>
      <TextStyleSection
        part="text"
        title="Text style"
        style={shapeTextValues(first)}
        live={live}
        sizes={SHAPE_SIZES}
        differs={(key) => differs(key as keyof Shape)}
        swatch={(key) => ({ fill: "", fillStyle: SHAPE_INK_SWATCHES[key] })}
        onChange={(change) => onEdit(change as ShapeEdit)}
      />
      {shapes.some((x) => x.kind !== "text") && <ShapeLookSection shape={first} live={live} onEdit={onEdit} mixed={mixed} />}
      <Section title="Size">
        <div className="flex gap-ms">
          <SizeField label="Width" name="shapeWidth" value={first.w} min={SHAPE_MIN_W} max={SHAPE_MAX_W} disabled mixed={differs("w")} onCommit={() => null} />
          <SizeField label="Height" name="shapeHeight" value={first.h} min={SHAPE_MIN_H} max={SHAPE_MAX_H} disabled mixed={differs("h")} onCommit={() => null} />
        </div>
        <p data-shapes-size-hint="" className="text-xs text-fg-muted">
          {SHAPES_TEXT.size}
        </p>
      </Section>
      {!live && <p className="text-sm text-fg-muted">{READ_ONLY}</p>}
    </div>
  );
}
