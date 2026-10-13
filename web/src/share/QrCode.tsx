import { useMemo } from "react";
import { cn } from "../lib/utils";
import { QR_QUIET_ZONE, encodeQr, qrPath } from "./qr";

/** Shown in place of the code when the link doesn't fit in one. */
export const QR_TOO_LONG = "This link is too long to show as a QR code. Copy the link instead.";

/*
 * The join link's QR code as an inline SVG built from React elements: one light rect (the panel,
 * quiet zone included) and one path of dark modules. No HTML strings, images or references. Dark
 * modules on a light panel in both themes (--sy-note-fg is a dark ink in both, --sy-brand-ink is
 * white in both; a test checks the contrast), so it scans in dark mode too. Large fills the space
 * it's given (the viewBox keeps it square and centred).
 */
export function QrCode({ text, large = false }: { text: string; large?: boolean }) {
  const matrix = useMemo(() => encodeQr(text), [text]);
  if (!matrix) {
    return (
      <p data-qr-fallback="" className="rounded-md bg-surface-muted p-ms text-sm">
        {QR_TOO_LONG}
      </p>
    );
  }
  const span = matrix.size + 2 * QR_QUIET_ZONE;
  return (
    <svg
      data-qr=""
      data-large={large ? "true" : undefined}
      role="img"
      aria-label="QR code for the join link"
      viewBox={`${-QR_QUIET_ZONE} ${-QR_QUIET_ZONE} ${span} ${span}`}
      shapeRendering="crispEdges"
      className={cn("block rounded-md", large ? "size-full" : "aspect-square w-menu max-w-full")}
    >
      <rect x={-QR_QUIET_ZONE} y={-QR_QUIET_ZONE} width={span} height={span} style={{ fill: "var(--sy-brand-ink)" }} />
      <path d={qrPath(matrix)} style={{ fill: "var(--sy-note-fg)" }} />
    </svg>
  );
}
