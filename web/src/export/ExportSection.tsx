import { useId, useRef, useState } from "react";
import { FileImage, FileText } from "lucide-react";
import { Button } from "../components/ui/button";
import type { Board } from "../notes/board";
import type { ResultRow } from "../voting/voting";
import { boardToMarkdown, exportFileName, type ExportBoard } from "./markdown";
import { EXPORT_NOTICES, downloadBlob, exportBounds, renderPng } from "./png";

/*
 * Export (v0.22.0): Properties with nothing selected (md and up), for hosts and guests, on a
 * locked board, connected or not: it only reads what this page shows. Both files are made here
 * and downloaded through a temporary link; nothing is sent or stored. One polite status line
 * says when an export starts and how it ended.
 */

/** The board as shown, for the Markdown file: confirmed text (not drafts), no authors or colours. */
export function exportBoardOf(board: Board, results: readonly ResultRow[] | null): ExportBoard {
  return {
    notes: board.notes.map((e) => e.note),
    frames: board.frames.map((e) => e.frame),
    shapes: board.shapes.map((e) => e.shape),
    results,
  };
}

type Busy = "png" | "md" | null;

export function ExportSection({
  board,
  results,
  viewport,
}: {
  board: Board;
  /** Revealed totals (voting closed), else null: no vote information is exported. */
  results: readonly ResultRow[] | null;
  /** React Flow's viewport element (the PNG draws it); null when there's no canvas. */
  viewport: () => HTMLElement | null;
}) {
  const hintId = useId();
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const items = [...board.notes.map((e) => e.note), ...board.frames.map((e) => e.frame), ...board.shapes.map((e) => e.shape)];
  const empty = items.length === 0;
  const reason = empty ? EXPORT_NOTICES.empty : null;

  const run = async (kind: "png" | "md") => {
    if (running.current || empty) return;
    running.current = true;
    setBusy(kind);
    setFailed(false);
    setStatus(kind === "png" ? EXPORT_NOTICES.pngStart : EXPORT_NOTICES.mdStart);
    const now = new Date();
    try {
      if (kind === "md") {
        const text = boardToMarkdown(exportBoardOf(board, results), now);
        downloadBlob(new Blob([text], { type: "text/markdown;charset=utf-8" }), exportFileName("md", now));
      } else {
        const bounds = exportBounds(items);
        const element = viewport();
        if (!bounds || !element) throw new Error("nothing to draw");
        downloadBlob(await renderPng(element, bounds), exportFileName("png", now));
      }
      setStatus(kind === "png" ? EXPORT_NOTICES.pngDone : EXPORT_NOTICES.mdDone);
    } catch {
      // Never a thrown error on screen: a plain message (the cause isn't logged; it could hold room text).
      setFailed(true);
      setStatus(EXPORT_NOTICES.failed);
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  return (
    <section data-export-section="" aria-labelledby={`${hintId}-h`} className="flex flex-col gap-xs border-t border-border pt-md">
      <h4 id={`${hintId}-h`} className="text-sm font-semibold">
        Export
      </h4>
      <p className="text-sm text-fg-muted">Made in this browser from the board you see; nothing is uploaded.</p>
      <div className="flex flex-wrap gap-xs">
        <Button
          data-export="png"
          aria-describedby={reason ? hintId : undefined}
          aria-busy={busy === "png" || undefined}
          disabled={reason !== null || busy !== null}
          onClick={() => void run("png")}
        >
          <FileImage />
          {busy === "png" ? "Exporting…" : "Export PNG"}
        </Button>
        <Button
          data-export="md"
          aria-describedby={reason ? hintId : undefined}
          aria-busy={busy === "md" || undefined}
          disabled={reason !== null || busy !== null}
          onClick={() => void run("md")}
        >
          <FileText />
          {busy === "md" ? "Exporting…" : "Export Markdown"}
        </Button>
      </div>
      {reason && (
        <p id={hintId} className="text-xs text-fg-muted">
          {reason}
        </p>
      )}
      <p data-export-status="" role="status" aria-live="polite" className={failed ? "text-xs text-status-error" : "text-xs text-fg-muted"}>
        {failed ? EXPORT_NOTICES.failedDetail : status}
      </p>
    </section>
  );
}
