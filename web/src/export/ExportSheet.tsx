import { useEffect } from "react";
import { Download } from "lucide-react";
import type { Board } from "../notes/board";
import { Sheet } from "../shell/Sheet";
import type { ResultRow } from "../voting/voting";
import { ExportSection } from "./ExportSection";
import { useExport } from "./exportStore";

/*
 * Export on phones (v0.40.0): the menu's Export board opens this sheet (a bottom sheet on phones,
 * the side panel from md up) with the same Export section Properties has, the same gating (hosts
 * and guests, locked or not, connected or not; off during a silent round with the same reason).
 * On a phone (`share`) each file goes to the share sheet where the browser can share it, else it
 * downloads. Mounted by the board, which has the canvas the PNG draws; closed when the board goes.
 */
export function ExportSheet({
  board,
  results,
  viewport,
  silent,
  hidden,
  share,
}: {
  board: Board;
  results: readonly ResultRow[] | null;
  viewport: () => HTMLElement | null;
  silent: boolean;
  hidden: ReadonlySet<string>;
  share: boolean;
}) {
  const open = useExport((s) => s.open);
  const hide = useExport((s) => s.hide);
  useEffect(() => hide, [hide]);
  if (!open) return null;
  return (
    <Sheet title="Export board" icon={<Download />} page="export" onClose={hide}>
      <div data-export-sheet="" className="pb-md">
        <ExportSection board={board} results={results} viewport={viewport} silent={silent} hidden={hidden} share={share} heading={false} />
      </div>
    </Sheet>
  );
}
