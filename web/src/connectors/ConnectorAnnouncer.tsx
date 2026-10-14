import { useConnectorUi } from "./connectorUi";

/** Says my own arrow adds and deletes politely (never anyone else's). Always in the page, so the live region is ready. */
export function ConnectorAnnouncer() {
  const announce = useConnectorUi((s) => s.announce);
  return (
    <span data-connector-announcer="" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announce?.text ?? ""}
    </span>
  );
}
