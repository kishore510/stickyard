import { useEffect, useState } from "react";
import { PROTOCOL_VERSION } from "@stickyard/shared";
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
    detail: "The relay answered the handshake.",
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

const buttonClass =
  "min-h-touch min-w-touch rounded-card bg-accent px-lg text-base font-semibold text-accent-fg cursor-pointer";

export function ConnectionCheckScreen() {
  const status = useConnectionCheck((s) => s.status);
  const start = useConnectionCheck((s) => s.start);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => start(), [start, attempt]);

  const copy = COPY[status];
  const relayHost = new URL(WORKER_URL).host;

  return (
    <main className="mx-auto flex min-h-(--sy-viewport-h) max-w-content flex-col justify-center gap-lg p-md">
      <header className="flex flex-col gap-xs">
        <h1 className="text-xl font-bold">Stickyard</h1>
        <p className="text-fg-muted">Real-time sticky notes. Nothing to see here yet.</p>
      </header>

      <section
        aria-labelledby="check-heading"
        className="flex flex-col gap-md rounded-card border border-border bg-surface p-lg"
      >
        <h2 id="check-heading" className="text-lg font-semibold">
          Connection check
        </h2>

        <div role="status" aria-live="polite" aria-atomic="true" className="flex flex-col gap-xs">
          <p className="flex items-center gap-sm text-lg font-semibold">
            <span aria-hidden="true" className={`inline-block size-dot shrink-0 rounded-full ${copy.dot}`} />
            {copy.label}
          </p>
          <p className="text-fg-muted">{copy.detail}</p>
        </div>

        {status === "reload" && (
          <button type="button" className={buttonClass} onClick={() => window.location.reload()}>
            Reload page
          </button>
        )}
        {status === "unreachable" && (
          <button type="button" className={buttonClass} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}

        <p className="text-sm text-fg-muted">Relay: {relayHost}</p>
      </section>
    </main>
  );
}
