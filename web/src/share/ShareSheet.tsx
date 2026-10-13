import { Maximize2, Minimize2, QrCode as QrIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { CopyLink } from "../rooms/CopyLink";
import { joinLink } from "../rooms/link";
import { useRoomUi } from "../rooms/roomStore";
import { Sheet } from "../shell/Sheet";
import { QrCode } from "./QrCode";
import { useShare } from "./shareStore";

/*
 * Share session (v0.32.0, web only): the join link Copy link copies, as a QR code made on this
 * device, as text, and with Copy link. Scanning it opens the link, so the join screen shows exactly
 * as when the link is pasted. Large makes the code fill the sheet (and the sheet the screen from md
 * up) for a projector or a shared screen. Only the room code and this page's address go into it:
 * never names or board content.
 */

export function ShareBody({ link, large = false, onLarge }: { link: string; large?: boolean; onLarge?: (on: boolean) => void }) {
  return (
    <div className={cn("flex flex-col gap-md pb-md", large && "h-full")}>
      {!large && <p className="text-sm text-fg-muted">Scan the code with a phone’s camera to join this session. Anyone with the link can join.</p>}
      <div className={cn("flex justify-center", large && "min-h-0 flex-1")}>
        <QrCode text={link} large={large} />
      </div>
      <p data-share-link="" className="text-sm break-all select-all">
        {link}
      </p>
      <div className="flex flex-wrap items-start gap-sm">
        <CopyLink link={link} />
        {onLarge && (
          <Button variant="ghost" aria-pressed={large} onClick={() => onLarge(!large)} className={cn(large && "bg-surface-muted")}>
            {large ? <Minimize2 /> : <Maximize2 />}
            Large
          </Button>
        )}
      </div>
    </div>
  );
}

/** The sheet itself, over whatever is open, while in a session and asked for (shareStore). */
export function ShareSheetHost() {
  const code = useRoomUi((s) => s.room?.code ?? null);
  const open = useShare((s) => s.open);
  const hide = useShare((s) => s.hide);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    if (code === null) hide();
  }, [code, hide]);
  if (!open || code === null) return null;
  const close = () => {
    setLarge(false);
    hide();
  };
  return (
    <Sheet title="Share session" icon={<QrIcon />} page="share" onClose={close} large={large}>
      <ShareBody link={joinLink(code)} large={large} onLarge={setLarge} />
    </Sheet>
  );
}
