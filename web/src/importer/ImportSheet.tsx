import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { FileJson, FileText, Upload } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Sheet } from "../shell/Sheet";
import { IMPORT_TEXT, importCounts, importRoomFails, parseBoardFile, parseTextImport, readImportFile, type ImportContent, type ImportCounts, type ImportResult } from "./parse";
import { useImport } from "./importStore";

/*
 * Import (v0.40.0, part 2 of Export on phones and Import): the sheet the menu's Import (every
 * width) and Properties' Import (md and up) open. Two sources: a board file (.json from Export
 * board file) or text (typed, pasted or a .txt file: one note per line). Reading and checking
 * happen here (importer/parse.ts); nothing is sent until Place, after a preview with the counts.
 * Place is off, with the reason as text, when import can't run (`reason`) or the board hasn't room
 * for all of it. Add-only: nothing on the board is replaced or cleared.
 */

const ROWS: { kind: keyof ImportCounts; label: string }[] = [
  { kind: "notes", label: "Notes" },
  { kind: "frames", label: "Frames" },
  { kind: "shapes", label: "Shapes and labels" },
  { kind: "arrows", label: "Arrows" },
  { kind: "groups", label: "Groups" },
];

export function ImportSheet({
  reason,
  used,
  place,
}: {
  /** Why import can't run now (not connected, locked, silent round, busy), or null. */
  reason: string | null;
  /** What's on the board now, for the room check (notes: every note, the hidden ones too). */
  used: ImportCounts;
  /** Places the content in the middle of the view; false if the board refused it. */
  place: (content: ImportContent) => boolean;
}) {
  const open = useImport((s) => s.open);
  const hide = useImport((s) => s.hide);
  useEffect(() => hide, [hide]);
  if (!open) return null;
  return <ImportBody reason={reason} used={used} place={place} close={hide} />;
}

function ImportBody({ reason, used, place, close }: { reason: string | null; used: ImportCounts; place: (content: ImportContent) => boolean; close: () => void }) {
  const ids = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const txtRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [content, setContent] = useState<ImportContent | null>(null);
  const [status, setStatus] = useState("");
  const reading = useRef(false);

  const take = (result: ImportResult) => {
    if (result.ok) {
      setContent(result.content);
      setStatus("");
    } else {
      setContent(null);
      setStatus(result.reason);
    }
  };

  const readFile = (parse: (text: string) => ImportResult) => async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Cleared, so choosing the same file again reads it again.
    input.value = "";
    if (!file || reading.current) return;
    reading.current = true;
    try {
      const read = await readImportFile(file);
      take(read.ok ? parse(read.text) : { ok: false, reason: read.reason });
    } finally {
      reading.current = false;
    }
  };

  const counts = content ? importCounts(content) : null;
  const fails = content ? importRoomFails(content, used) : [];
  const placeReason = reason ?? (fails.length > 0 ? IMPORT_TEXT.noRoom(fails) : null);

  const onPlace = () => {
    if (!content || !counts || placeReason !== null) return;
    if (place(content)) {
      useImport.getState().announce(IMPORT_TEXT.placed(counts));
      close();
    } else {
      setStatus(IMPORT_TEXT.notPlaced);
    }
  };

  return (
    <Sheet title="Import" icon={<Upload />} page={content ? "import-preview" : "import"} onClose={close}>
      <div data-import-sheet="" className="flex flex-col gap-md pb-md">
        {reason && (
          <p id={`${ids}-reason`} data-import-reason="" className="text-sm text-fg-muted">
            {reason}
          </p>
        )}
        {content && counts ? (
          <section data-import-preview="" aria-labelledby={`${ids}-preview`} className="flex flex-col gap-sm">
            <h3 id={`${ids}-preview`} className="text-sm font-semibold">
              Preview
            </h3>
            <p className="text-sm">{IMPORT_TEXT.preview(counts)}</p>
            <dl className="grid grid-cols-2 gap-x-md gap-y-xs text-sm tabular-nums">
              {ROWS.map(({ kind, label }) => (
                <div key={kind} className="contents">
                  <dt className="text-fg-muted">{label}</dt>
                  <dd>{counts[kind]}</dd>
                </div>
              ))}
            </dl>
            {content.cut > 0 && <p className="text-xs text-fg-muted">{IMPORT_TEXT.cut(content.cut)}</p>}
            <p className="text-xs text-fg-muted">Import only adds: nothing on the board is replaced or cleared. One Undo removes all of it.</p>
            {placeReason && placeReason !== reason && (
              <p id={`${ids}-place`} className="text-xs text-fg-muted">
                {placeReason}
              </p>
            )}
            <div className="flex flex-wrap gap-xs">
              <Button data-import-place="" variant="primary" disabled={placeReason !== null} aria-describedby={placeReason ? (placeReason === reason ? `${ids}-reason` : `${ids}-place`) : undefined} onClick={onPlace}>
                Place
              </Button>
              <Button
                data-import-cancel=""
                onClick={() => {
                  setContent(null);
                  setStatus("");
                }}
              >
                Cancel
              </Button>
            </div>
          </section>
        ) : (
          <>
            <p className="text-sm text-fg-muted">Adds to the board in the middle of your view; nothing is replaced or cleared. Files are read in this browser.</p>
            <section aria-labelledby={`${ids}-file`} className="flex flex-col gap-xs">
              <h3 id={`${ids}-file`} className="text-sm font-semibold">
                Board file
              </h3>
              <p className="text-sm text-fg-muted">A .json file from Export board file.</p>
              <input ref={fileRef} data-import-file="" type="file" accept=".json,application/json" hidden tabIndex={-1} onChange={(e) => void readFile(parseBoardFile)(e)} />
              <Button className="self-start" disabled={reason !== null} aria-describedby={reason ? `${ids}-reason` : undefined} onClick={() => fileRef.current?.click()}>
                <FileJson />
                Choose board file
              </Button>
            </section>
            <section aria-labelledby={`${ids}-text`} className="flex flex-col gap-xs border-t border-border pt-md">
              <h3 id={`${ids}-text`} className="text-sm font-semibold">
                Text
              </h3>
              <label htmlFor={`${ids}-box`} className="text-sm text-fg-muted">
                One note per line (blank lines are skipped)
              </label>
              <Textarea id={`${ids}-box`} data-import-text="" rows={6} value={text} onChange={(e) => setText(e.currentTarget.value)} />
              <div className="flex flex-wrap gap-xs">
                <Button
                  data-import-preview-text=""
                  variant="primary"
                  disabled={reason !== null || text.trim() === ""}
                  aria-describedby={reason ? `${ids}-reason` : undefined}
                  onClick={() => take(parseTextImport(text))}
                >
                  Preview
                </Button>
                <input ref={txtRef} data-import-txt="" type="file" accept=".txt,text/plain" hidden tabIndex={-1} onChange={(e) => void readFile(parseTextImport)(e)} />
                <Button disabled={reason !== null} aria-describedby={reason ? `${ids}-reason` : undefined} onClick={() => txtRef.current?.click()}>
                  <FileText />
                  Choose text file
                </Button>
              </div>
            </section>
          </>
        )}
        <p data-import-status="" role="status" aria-live="polite" className="text-sm text-fg-muted">
          {status}
        </p>
      </div>
    </Sheet>
  );
}

/** The board's polite line for a placed import (said once the sheet has closed). */
export function ImportAnnouncer() {
  const text = useImport((s) => s.announcement);
  return (
    <p data-import-announcer="" role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  );
}
