import { useId, useRef, useState, type ReactNode } from "react";
import { FileImage, FileJson, FileText, Share2 } from "lucide-react";
import { Button } from "../components/ui/button";
import type { Board } from "../notes/board";
import type { ResultRow } from "../voting/voting";
import { boardToMarkdown, exportFileName, type ExportBoard } from "./markdown";
import { EXPORT_NOTICES, exportBounds, exportItems, renderPng } from "./png";
import { BOARD_FILE_TYPE, boardFileText, buildBoardFile } from "./boardFile";
import { deliverFile } from "./deliver";
import { SILENT_TEXT } from "../silent/silent";

/*
 * Export (v0.22.0): Properties with nothing selected (md and up), for hosts and guests, on a
 * locked board, connected or not: it only reads what this page shows. v0.40.0 adds the board file
 * (JSON, boardFile.ts) and the same section in the Export sheet (ExportSheet.tsx: the menu's Export
 * board, on phones too), where `share` sends each file to the system share sheet when the browser
 * can share it (deliver.ts). Every file is made here; nothing is sent or stored. One polite status
 * line says when an export starts and how it ended.
 */

/** The board as shown, for the Markdown file: confirmed text (not drafts), no authors or colours. */
export function exportBoardOf(board: Board, results: readonly ResultRow[] | null): ExportBoard {
  return {
    notes: board.notes.map((e) => e.note),
    frames: board.frames.map((e) => e.frame),
    shapes: board.shapes.map((e) => e.shape),
    results,
    connectors: board.connectors.map((e) => ({ start: e.connector.start, end: e.connector.end })),
    groups: board.groups.map((e) => ({ label: e.group.label, members: e.group.members })),
  };
}

type Kind = "png" | "md" | "json";

const KIND_NAME: Record<Kind, string> = { png: "PNG", md: "Markdown", json: "board file" };
const START: Record<Kind, string> = { png: EXPORT_NOTICES.pngStart, md: EXPORT_NOTICES.mdStart, json: EXPORT_NOTICES.jsonStart };
const DOWNLOADED: Record<Kind, string> = { png: EXPORT_NOTICES.pngDone, md: EXPORT_NOTICES.mdDone, json: EXPORT_NOTICES.jsonDone };
const SHARED: Record<Kind, string> = { png: EXPORT_NOTICES.pngShared, md: EXPORT_NOTICES.mdShared, json: EXPORT_NOTICES.jsonShared };

/** A made file waiting for the tap the share sheet needs. */
interface Pending {
  kind: Kind;
  blob: Blob;
  name: string;
}

export function ExportSection({
  board,
  results,
  viewport,
  silent = false,
  hidden,
  share = false,
  heading = true,
}: {
  board: Board;
  /** Revealed totals (voting closed), else null: no vote information is exported. */
  results: readonly ResultRow[] | null;
  /** React Flow's viewport element (the PNG draws it); null when there's no canvas. */
  viewport: () => HTMLElement | null;
  /** A silent round is running (v0.27.0): nothing is exported until the reveal. */
  silent?: boolean;
  /** Notes never put in the board file (my sealed ones). */
  hidden?: ReadonlySet<string>;
  /** Offer each file to the share sheet where the browser can share it (the phone sheet). */
  share?: boolean;
  /** Its own "Export" heading (Properties); the sheet has its title instead. */
  heading?: boolean;
}) {
  const hintId = useId();
  const Region = heading ? "section" : "div";
  const [busy, setBusy] = useState<Kind | null>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const running = useRef(false);
  const items = [...board.notes.map((e) => e.note), ...board.frames.map((e) => e.frame), ...board.shapes.map((e) => e.shape)];
  const empty = items.length === 0;
  const reason = silent ? SILENT_TEXT.export : empty ? EXPORT_NOTICES.empty : null;

  /** Delivers a made file and says how it went. */
  const deliver = async (file: Pending) => {
    const how = await deliverFile(file.blob, file.name, { share });
    setPending(how === "needsTap" ? file : null);
    setStatus(how === "shared" ? SHARED[file.kind] : how === "downloaded" ? DOWNLOADED[file.kind] : how === "cancelled" ? EXPORT_NOTICES.cancelled : EXPORT_NOTICES.ready(KIND_NAME[file.kind]));
  };

  const make = async (kind: Kind, now: Date): Promise<Pending> => {
    if (kind === "md") {
      const text = boardToMarkdown(exportBoardOf(board, results), now);
      return { kind, blob: new Blob([text], { type: "text/markdown;charset=utf-8" }), name: exportFileName("md", now) };
    }
    if (kind === "json") {
      const file = buildBoardFile(board, hidden);
      if (!file) throw new Error("nothing to export");
      return { kind, blob: new Blob([boardFileText(file)], { type: BOARD_FILE_TYPE }), name: exportFileName("json", now) };
    }
    const bounds = exportBounds(exportItems(board));
    const element = viewport();
    if (!bounds || !element) throw new Error("nothing to draw");
    return { kind, blob: await renderPng(element, bounds), name: exportFileName("png", now) };
  };

  const run = async (kind: Kind) => {
    if (running.current || reason !== null) return;
    running.current = true;
    setBusy(kind);
    setFailed(false);
    setPending(null);
    setStatus(START[kind]);
    try {
      await deliver(await make(kind, new Date()));
    } catch {
      // Never a thrown error on screen: a plain message (the cause isn't logged; it could hold room
      // text). A PNG that can't be drawn points to the text exports, which still work.
      setFailed(true);
      setStatus(kind === "png" ? EXPORT_NOTICES.pngFailed : EXPORT_NOTICES.failedDetail);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  // The tap the share sheet asked for: a fresh user gesture, straight to the share.
  const again = async () => {
    if (!pending || running.current) return;
    running.current = true;
    try {
      await deliver(pending);
    } finally {
      running.current = false;
    }
  };

  const button = (kind: Kind, icon: ReactNode, label: string) => (
    <Button
      data-export={kind}
      aria-describedby={reason ? hintId : undefined}
      aria-busy={busy === kind || undefined}
      disabled={reason !== null || busy !== null}
      onClick={() => void run(kind)}
    >
      {icon}
      {busy === kind ? "Exporting…" : label}
    </Button>
  );

  return (
    // In the sheet it's the dialog's whole content (named by the sheet's title), so not a region of its own.
    <Region data-export-section="" aria-labelledby={heading ? `${hintId}-h` : undefined} className={heading ? "flex flex-col gap-xs border-t border-border pt-md" : "flex flex-col gap-xs"}>
      {heading && (
        <h4 id={`${hintId}-h`} className="text-sm font-semibold">
          Export
        </h4>
      )}
      <p className="text-sm text-fg-muted">Made in this browser from the board you see; nothing is uploaded.</p>
      <div className="flex flex-wrap gap-xs">
        {button("png", <FileImage />, "Export PNG")}
        {button("md", <FileText />, "Export Markdown")}
        {button("json", <FileJson />, "Export board file")}
      </div>
      {reason && (
        <p id={hintId} className="text-xs text-fg-muted">
          {reason}
        </p>
      )}
      {pending && (
        <Button data-export-again="" variant="primary" onClick={() => void again()} className="self-start">
          <Share2 />
          {`Share ${KIND_NAME[pending.kind]}`}
        </Button>
      )}
      <p data-export-status="" role="status" aria-live="polite" className={failed ? "text-xs text-status-error" : "text-xs text-fg-muted"}>
        {status}
      </p>
    </Region>
  );
}
