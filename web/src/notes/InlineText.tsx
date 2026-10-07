import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type FocusEvent, type KeyboardEvent } from "react";
import type { Note } from "@stickyard/shared";
import { intoEmojiPicker } from "../emoji/EmojiPicker";
import { EmojiToolbar } from "../emoji/EmojiToolbar";
import { cn } from "../lib/utils";
import { INLINE_PLACEHOLDERS, PLACEHOLDER_CLASS, fitsCap, inlineKeyAction, pasteInto, titleLine, type InlinePart } from "./inlineEdit";
import { partTextClasses } from "./style";
import { joinTitleBody, splitTitleBody } from "./titleBody";

/** Grows a textarea to its content (the note clips anything past its edge). */
function autoSize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * A note's text edited in place (md and up): two plain textareas, never contenteditable, styled
 * exactly like the note's title and body. What's typed is the note's draft (remote edits never
 * replace it) until it's committed: Enter in the body, Escape, or focus leaving the note. Enter
 * (or Shift+Enter, or Tab) in the title moves to the body; Shift+Tab goes back. Input stops at
 * the 280-character cap across both parts; paste is cleaned plain text. The placeholders are
 * helper text only. React Flow's nodrag/nopan/nowheel classes keep text selection from moving
 * the note or the board. The emoji button beside the note inserts into the part last edited, at
 * its caret and within the cap; focus moving into it doesn't end the edit.
 */
export function InlineText({
  note,
  text,
  request,
  readOnly = false,
  onDraft,
  onCommit,
}: {
  note: Note;
  /** The draft, or the note's text. */
  text: string;
  /** Which part to put the caret in; a new `n` asks again. */
  request: { part: InlinePart; n: number };
  /** Disconnected: the text stays (and keeps focus) but can't change until the connection is back. */
  readOnly?: boolean;
  onDraft: (text: string) => void;
  /** `refocus`: give focus back to the note (a key ended it, not a click elsewhere). */
  onCommit: (refocus: boolean) => void;
}) {
  const { title, body } = splitTitleBody(text);
  const refs = { title: useRef<HTMLTextAreaElement>(null), body: useRef<HTMLTextAreaElement>(null) };
  const caret = useRef<{ part: InlinePart; at: number } | null>(null);
  const last = useRef<InlinePart>(request.part);
  const box = useRef<HTMLDivElement>(null);

  const focus = (part: InlinePart) => {
    const el = refs[part].current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  };

  useEffect(() => {
    last.current = request.part;
    focus(request.part);
    // Only when asked again, not on every keystroke.
  }, [request.n, request.part]);

  useLayoutEffect(() => {
    autoSize(refs.title.current);
    autoSize(refs.body.current);
    const c = caret.current;
    if (c) {
      refs[c.part].current?.setSelectionRange(c.at, c.at);
      caret.current = null;
    }
  });

  const change = (part: InlinePart, value: string) => {
    const next = part === "title" ? { title: titleLine(value), body } : { title, body: value };
    // Over the cap: refused, so the field keeps what it had.
    if (!fitsCap(next.title, next.body)) return;
    onDraft(joinTitleBody(next.title, next.body));
  };

  const paste = (part: InlinePart) => (e: ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const out = pasteInto({
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
      pasted: e.clipboardData.getData("text/plain"),
      part,
      other: part === "title" ? body : title,
    });
    caret.current = { part, at: out.caret };
    onDraft(part === "title" ? joinTitleBody(out.value, body) : joinTitleBody(title, out.value));
  };

  const keyDown = (part: InlinePart) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The text's keys: never the note's, the board's or React Flow's.
    e.stopPropagation();
    const action = inlineKeyAction(part, { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing });
    if (action === null) return;
    e.preventDefault();
    if (action === "commit") onCommit(true);
    else if (action !== "stay") focus(action);
  };

  // Focus leaving both parts (a click elsewhere) commits.
  const blur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    if (intoEmojiPicker(e.relatedTarget)) return;
    onCommit(false);
  };

  const insert = (value: string, at: number) => {
    const part = last.current;
    caret.current = { part, at };
    onDraft(part === "title" ? joinTitleBody(value, body) : joinTitleBody(title, value));
  };

  const area = (part: InlinePart, value: string) => (
    <textarea
      ref={refs[part]}
      data-inline={part}
      aria-label={part === "title" ? "Note title" : "Note body"}
      rows={1}
      value={value}
      readOnly={readOnly}
      aria-readonly={readOnly || undefined}
      placeholder={INLINE_PLACEHOLDERS[part]}
      spellCheck
      onChange={(e) => change(part, e.target.value)}
      onPaste={paste(part)}
      onKeyDown={keyDown(part)}
      onFocus={() => {
        last.current = part;
      }}
      className={cn(
        "nodrag nopan nowheel block w-full resize-none overflow-hidden border-0 bg-transparent p-0 break-words whitespace-pre-wrap outline-none",
        partTextClasses(note, part),
        PLACEHOLDER_CLASS,
      )}
    />
  );

  return (
    <>
      <div ref={box} data-note-text className="nodrag nopan nowheel min-h-0 flex-1 overflow-hidden" onBlur={blur}>
        {area("title", title)}
        {area("body", body)}
      </div>
      <EmojiToolbar
        target={() => refs[last.current].current}
        fits={(next) => (last.current === "title" ? fitsCap(next, body) : fitsCap(title, next))}
        onInsert={insert}
        disabled={readOnly}
        onAway={(to) => {
          if (to && box.current?.contains(to)) return;
          onCommit(false);
        }}
      />
    </>
  );
}
