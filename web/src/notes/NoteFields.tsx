import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { Trash2 } from "lucide-react";
import { MAX_NOTE_TEXT, codePointLength } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { BoardNote, StylePatch } from "./board";
import { confirmDelete } from "./label";
import { ColourSection, PartTextSection, READ_ONLY, Section, SizeSection } from "./StyleFields";
import { joinTitleBody, splitTitleBody } from "./titleBody";

/**
 * A note's fields: Title (its first line) and Body (the rest), a character count, its colour,
 * text style for the title and for the body (size, bold, italic, alignment, text colour each),
 * its size, who added it, and Delete. The Properties panel (md and up) and the phone editor
 * sheet both use these, so they behave the same.
 *
 * The text is one value (title and body joined with a line break). What's typed is a local
 * draft (notes/board.ts keeps it apart from the note, so remote edits never replace it) until
 * it's committed: Enter in either field; Shift+Enter is a line break (in Title it moves the rest
 * of the line into Body). With `commitOnBlur`, leaving the fields commits too. Text over the cap
 * isn't committed. Note text is untrusted: it's only ever a field value, never HTML.
 */
export function NoteFields({
  entry,
  live,
  author,
  onDraft,
  onCommit,
  onStyle,
  onSize,
  onDelete,
  commitOnBlur,
  showDelete = true,
  autoFocus,
  focusRequest,
  onFocused,
}: {
  entry: BoardNote;
  /** Connected: false makes everything read-only. */
  live: boolean;
  author: string;
  onDraft: (text: string) => void;
  /** Saves the draft, if there is one. */
  onCommit: () => void;
  /** Colour and text style: one optimistic edit per change. */
  onStyle: (change: StylePatch) => void;
  /** Width/Height fields: one final resize, already clamped. */
  onSize: (w: number, h: number) => void;
  onDelete: () => void;
  commitOnBlur: boolean;
  /** The Properties panel has Delete in its header instead. */
  showDelete?: boolean;
  /** Marks Title for the sheet's focus trap. */
  autoFocus?: boolean;
  /** Changes to move focus to Title (an edit request from the board). */
  focusRequest?: number | null;
  onFocused?: () => void;
}) {
  const id = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const text = entry.draft ?? entry.note.text;
  const { title, body } = splitTitleBody(text);
  const length = codePointLength(text);
  const tooLong = length > MAX_NOTE_TEXT;
  const focused = useRef(onFocused);
  focused.current = onFocused;

  useEffect(() => {
    if (focusRequest == null || !live) return;
    const el = titleRef.current;
    el?.focus();
    el?.setSelectionRange?.(el.value.length, el.value.length);
    focused.current?.();
  }, [focusRequest, live]);

  const commit = () => {
    if (!tooLong) onCommit();
  };

  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!e.shiftKey) return commit();
    // A line break in the title: the rest of the line starts the body.
    const at = e.currentTarget.selectionStart ?? title.length;
    const rest = title.slice(at);
    onDraft(joinTitleBody(title.slice(0, at), body === "" ? rest : `${rest}\n${body}`));
    requestAnimationFrame(() => {
      bodyRef.current?.focus();
      bodyRef.current?.setSelectionRange?.(0, 0);
    });
  };

  const onBodyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    }
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!commitOnBlur || entry.draft === null) return;
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    commit();
  };

  return (
    <div className="flex flex-col gap-md">
      <div className="flex flex-col gap-sm" onBlur={onBlur}>
        <div className="flex flex-col gap-xs">
          <Label htmlFor={`${id}-title`}>Title</Label>
          <Input
            ref={titleRef}
            id={`${id}-title`}
            name="title"
            data-autofocus={autoFocus || undefined}
            autoComplete="off"
            value={title}
            disabled={!live}
            onChange={(e) => onDraft(joinTitleBody(e.target.value, body))}
            onKeyDown={onTitleKey}
            aria-describedby={`${id}-help ${id}-count`}
            aria-invalid={tooLong || undefined}
          />
        </div>
        <div className="flex flex-col gap-xs">
          <Label htmlFor={`${id}-body`}>Body</Label>
          <Textarea
            ref={bodyRef}
            id={`${id}-body`}
            name="body"
            rows={5}
            value={body}
            disabled={!live}
            onChange={(e) => onDraft(joinTitleBody(title, e.target.value))}
            onKeyDown={onBodyKey}
            aria-describedby={`${id}-help ${id}-count`}
            aria-invalid={tooLong || undefined}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-sm text-sm text-fg-muted">
          <span id={`${id}-help`}>{live ? "Enter saves. Shift+Enter adds a new line." : READ_ONLY}</span>
          <span id={`${id}-count`} aria-live="polite" className="tabular-nums">
            {length} / {MAX_NOTE_TEXT}
          </span>
        </div>
        {tooLong && <FieldError>Notes can be up to {MAX_NOTE_TEXT} characters.</FieldError>}
      </div>

      {!live && <p className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">{READ_ONLY} Colour, text and size can be changed once you rejoin.</p>}
      <ColourSection note={entry.note} live={live} onStyle={onStyle} />
      <PartTextSection part="title" note={entry.note} live={live} onStyle={onStyle} />
      <PartTextSection part="body" note={entry.note} live={live} onStyle={onStyle} />
      <SizeSection note={entry.note} live={live && entry.confirmed !== null} onSize={onSize} />

      <Section title="Details">
        <p className="text-sm">
          <span className="text-fg-muted">Added by </span>
          <span className="break-words">{author}</span>
        </p>
      </Section>

      {showDelete && (
        <div>
          <Button
            disabled={!live}
            onClick={() => {
              if (confirmDelete(text)) onDelete();
            }}
          >
            <Trash2 />
            Delete note
          </Button>
        </div>
      )}
    </div>
  );
}
