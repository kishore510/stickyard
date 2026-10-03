import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { PROTOCOL_VERSION } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { WORKER_URL } from "../config";
import type { CheckStatus } from "../connection/connectionCheck";
import { useConnectionCheck } from "../connection/store";

const COPY: Record<CheckStatus, { label: string; detail: string; dot: string }> = {
  connecting: {
    label: "Connecting…",
    detail: "Reaching the Stickyard relay.",
    dot: "bg-status-pending",
  },
  connected: {
    label: `Connected (protocol v${PROTOCOL_VERSION})`,
    detail: "The relay is reachable.",
    dot: "bg-status-ok",
  },
  reload: {
    label: "Please reload",
    detail: "Stickyard has been updated. Reload the page to get the latest version.",
    dot: "bg-status-warn",
  },
  unreachable: {
    label: "Cannot connect",
    detail: "The relay could not be reached. Check your connection and try again.",
    dot: "bg-status-error",
  },
};

/** The start page's status line: GET /health, compared with this page's protocol. */
export function ConnectionStatus() {
  const status = useConnectionCheck((s) => s.status);
  const start = useConnectionCheck((s) => s.start);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => start(), [start, attempt]);

  const copy = COPY[status];
  return (
    <section aria-labelledby="status-heading" className="flex flex-col gap-sm">
      <h2 id="status-heading" className="sr-only">
        Connection
      </h2>
      <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-col gap-2xs">
        <p className="flex items-center gap-sm font-medium">
          <span aria-hidden="true" className={`inline-block size-dot shrink-0 rounded-full ${copy.dot}`} />
          {copy.label}
        </p>
        <p className="text-sm text-fg-muted">
          {copy.detail} Relay: {new URL(WORKER_URL).host}
        </p>
      </div>
      {status === "reload" && (
        <Button variant="primary" className="self-start" onClick={() => window.location.reload()}>
          <RefreshCw />
          Reload page
        </Button>
      )}
      {status === "unreachable" && (
        <Button variant="secondary" className="self-start" onClick={() => setAttempt((n) => n + 1)}>
          <RotateCcw />
          Try again
        </Button>
      )}
    </section>
  );
}
