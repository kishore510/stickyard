import { useConnectorUi } from "./connectorUi";
import { CONNECTOR_TEXT } from "./rules";

/** Says my own arrow adds and deletes politely (never anyone else's). Always in the page, so the live region is ready. */
export function ConnectorAnnouncer() {
  const announce = useConnectorUi((s) => s.announce);
  return (
    <span data-connector-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announce?.text ?? ""}
    </span>
  );
}

/** While a Connectors tile is armed: how to draw, in the board's notice stack (out of the way of the drawing). */
export function ConnectorDrawHint() {
  const armed = useConnectorUi((s) => s.draw !== null);
  if (!armed) return null;
  return (
    <p data-connector-drawing="" role="status" className="pointer-events-auto max-w-content rounded-md bg-surface px-ms py-xs text-sm shadow-md">
      {CONNECTOR_TEXT.drawHint}
    </p>
  );
}
