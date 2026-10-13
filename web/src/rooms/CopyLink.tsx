import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";

/**
 * Copy link: copies the join link and says so politely (role=status). Used by Participants'
 * Invite and the Share session sheet. The link is never logged or stored.
 */
export function CopyLink({ link }: { link: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    const done = navigator.clipboard?.writeText(link);
    if (!done) return setState("failed");
    done.then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <div className="flex flex-col gap-sm">
      <Button onClick={copy} className="self-start">
        {state === "copied" ? <Check /> : <Copy />}
        Copy link
      </Button>
      <p role="status" className="text-sm break-all text-fg-muted">
        {state === "copied" && "Link copied. Anyone with it can join."}
        {state === "failed" && `Couldn’t copy. The link is: ${link}`}
      </p>
    </div>
  );
}
