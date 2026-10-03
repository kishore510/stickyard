import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { Trash2 } from "lucide-react";
import { MAX_NOTE_TEXT, NOTE_COLORS, codePointLength } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import type { BoardNote } from "./board";
import { NOTE_COLOR_CLASSES, NOTE_COLOR_NAMES } from "./colours";
import { confirmDelete } from "./label";
import { joinTitleBody, splitTitleBody } from "./titleBody";

export const COLOUR_LATER = "Changing colour arrives in a later update.";

/**
 * A note's fields: Title (its first line) and Body (the rest), a character count, its colour
 * (read-only for now), who added it, and Delete. The Properties panel (md and up) and the phone
 * editor sheet both use these, so they behave the same.
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
          <span id={`${id}-help`}>{live ? "Enter saves. Shift+Enter adds a new line." : "Read only while disconnected."}</span>
          <span id={`${id}-count`} aria-live="polite" className="tabular-nums">
            {length} / {MAX_NOTE_TEXT}
          </span>
        </div>
        {tooLong && <FieldError>Notes can be up to {MAX_NOTE_TEXT} characters.</FieldError>}
      </div>

      <section className="flex flex-col gap-ms border-t border-border pt-md">
        <h3 id={`${id}-colour`} className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Colour
        </h3>
        <div role="radiogroup" aria-labelledby={`${id}-colour`} aria-describedby={`${id}-colour-later`} aria-disabled="true" className="flex flex-wrap gap-2xs">
          {NOTE_COLORS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={key === entry.note.color}
              aria-label={NOTE_COLOR_NAMES[key]}
              title={`${NOTE_COLOR_NAMES[key]}: ${COLOUR_LATER}`}
              disabled
              className="flex size-touch items-center justify-center rounded-md"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-swatch rounded-full border border-border-strong",
                  NOTE_COLOR_CLASSES[key],
                  key === entry.note.color ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : "opacity-50",
                )}
              />
            </button>
          ))}
        </div>
        <p id={`${id}-colour-later`} className="text-sm text-fg-muted">
          {COLOUR_LATER}
        </p>
      </section>

      <section className="flex flex-col gap-ms border-t border-border pt-md">
        <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Details</h3>
        <p className="text-sm">
          <span className="text-fg-muted">Added by </span>
          <span className="break-words">{author}</span>
        </p>
      </section>

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
