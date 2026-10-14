import { CONNECTOR_UPDATE_FIELDS, isBound, type Connector, type ConnectorEnd, type ConnectorStyleField } from "@stickyard/shared";
import { localId, type Board } from "../notes/board";

/*
 * Arrows (connectors, protocol v21; the page since v0.36.0) on the board as this page sees them:
 * the relay's connectors plus optimistic local changes, like shapes (shapes/board.ts). Pure
 * functions on the shared Board, each returning a new Board, or the same one when nothing changed.
 *
 * - `confirmed` is what the relay last sent; `connector` is what's shown. A refusal rolls back.
 * - No message carries a rev from the page: the relay's connectorUpdated is applied by rev (an
 *   older or equal one is stale), and an update for an id this page doesn't know is ignored.
 * - A bound end stores no point: the canvas works it out from the item's live box
 *   (connectors/geometry.ts), so moving an item changes nothing here.
 */

export interface BoardConnector {
  connector: Connector;
  /** The relay's latest version; null while an add hasn't been confirmed. */
  confirmed: Connector | null;
  /** Set while an add is waiting for its server id. */
  clientRef: string | null;
}

/** What a connectorUpdate may carry: either end and any style field. */
export type ConnectorPatch = Partial<Pick<Connector, "start" | "end" | ConnectorStyleField>>;
/** An arrow's full content (what connectorAdd carries besides its clientRef). */
export type ConnectorContent = Pick<Connector, "start" | "end" | ConnectorStyleField>;

export function findConnector(board: Board, id: string): BoardConnector | undefined {
  return board.connectors.find((c) => c.connector.id === id);
}

/** Two ends are the same end (free at the same point, or bound to the same item and anchor). */
export function sameEnd(a: ConnectorEnd, b: ConnectorEnd): boolean {
  if (isBound(a) || isBound(b)) return isBound(a) && isBound(b) && a.item === b.item && a.anchor === b.anchor;
  return a.x === b.x && a.y === b.y;
}

/** The arrow's content without id, rev and author. */
export function connectorContent(c: ConnectorContent): ConnectorContent {
  const { start, end, route, dash, width, ink, startHead, endHead } = c;
  return { start, end, route, dash, width, ink, startHead, endHead };
}

const confirmedEntry = (connector: Connector): BoardConnector => ({ connector, confirmed: connector, clientRef: null });
const isStale = (entry: BoardConnector | undefined, rev: number) => entry?.confirmed != null && rev <= entry.confirmed.rev;

function patch(board: Board, id: string, change: (entry: BoardConnector) => BoardConnector): Board {
  const index = board.connectors.findIndex((c) => c.connector.id === id);
  const entry = board.connectors[index];
  if (!entry) return board;
  const next = change(entry);
  if (next === entry) return board;
  const connectors = [...board.connectors];
  connectors[index] = next;
  return { ...board, connectors };
}

/* ── From the relay ─────────────────────────────────────────────────── */

/** Every join's connectorsSnapshot: it replaces every confirmed arrow (never a merge). Adds still waiting here stay. */
export function applyConnectorsSnapshot(board: Board, connectors: readonly Connector[]): Board {
  const pending = board.connectors.filter((c) => c.clientRef !== null);
  return { ...board, connectors: [...pending, ...connectors.map(confirmedEntry)], connectorsRemoved: [] };
}

/** A new arrow. With my clientRef, it replaces the temporary one in place. */
export function applyConnectorAdded(board: Board, connector: Connector, clientRef?: string): Board {
  if (clientRef !== undefined && findConnector(board, localId(clientRef))) {
    return patch(board, localId(clientRef), () => confirmedEntry(connector));
  }
  if (findConnector(board, connector.id)) return applyConnectorUpdated(board, connector);
  return { ...board, connectors: [...board.connectors, confirmedEntry(connector)] };
}

/** An end or style changed (the whole arrow), by rev. Unknown ids are ignored. */
export function applyConnectorUpdated(board: Board, connector: Connector): Board {
  const removed = board.connectorsRemoved.find((c) => c.connector.id === connector.id);
  if (removed) {
    if (isStale(removed, connector.rev)) return board;
    return { ...board, connectorsRemoved: board.connectorsRemoved.map((c) => (c === removed ? { ...c, confirmed: connector } : c)) };
  }
  const entry = findConnector(board, connector.id);
  if (!entry || isStale(entry, connector.rev)) return board;
  return patch(board, connector.id, () => confirmedEntry(connector));
}

export function applyConnectorDeleted(board: Board, id: string): Board {
  if (!findConnector(board, id) && !board.connectorsRemoved.some((c) => c.connector.id === id)) return board;
  return {
    ...board,
    connectors: board.connectors.filter((c) => c.connector.id !== id),
    connectorsRemoved: board.connectorsRemoved.filter((c) => c.connector.id !== id),
  };
}

/** The relay refused an add: the temporary arrow goes. */
export function rejectConnectorAdd(board: Board, clientRef: string): Board {
  const id = localId(clientRef);
  if (!findConnector(board, id)) return board;
  return { ...board, connectors: board.connectors.filter((c) => c.connector.id !== id) };
}

/** The relay refused a change to `id`: back to what it last confirmed (a refused delete comes back in its place). */
export function rollbackConnector(board: Board, id: string): Board {
  const removed = board.connectorsRemoved.find((c) => c.connector.id === id);
  if (removed) {
    const { index, ...entry } = removed;
    const connectors = [...board.connectors];
    connectors.splice(Math.min(index, connectors.length), 0, entry.confirmed ? { ...entry, connector: entry.confirmed } : entry);
    return { ...board, connectors, connectorsRemoved: board.connectorsRemoved.filter((c) => c !== removed) };
  }
  return patch(board, id, (e) => (e.confirmed && e.connector !== e.confirmed ? { ...e, connector: e.confirmed } : e));
}

/* ── Local, optimistic ─────────────────────────────────────────────── */

/** A new arrow with its full content, waiting for its server id (its clientRef names it until then). */
export function addConnectorLocal(board: Board, add: { clientRef: string; content: ConnectorContent; authorId: string }): Board {
  const connector: Connector = { id: localId(add.clientRef), ...connectorContent(add.content), rev: 1, authorId: add.authorId };
  return { ...board, connectors: [...board.connectors, { connector, confirmed: null, clientRef: add.clientRef }] };
}

/** The fields of `after` that differ from `before` (ends by value): what a connectorUpdate should carry. */
export function connectorChanges(before: ConnectorContent, after: ConnectorContent): ConnectorPatch {
  const out: Record<string, unknown> = {};
  for (const field of CONNECTOR_UPDATE_FIELDS) {
    const a = before[field];
    const b = after[field];
    const same = field === "start" || field === "end" ? sameEnd(a as ConnectorEnd, b as ConnectorEnd) : a === b;
    if (!same) out[field] = b;
  }
  return out as ConnectorPatch;
}

/** Ends or style shown at once. The same board when nothing changes. */
export function updateConnectorLocal(board: Board, id: string, change: ConnectorPatch): Board {
  return patch(board, id, (e) => {
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as ConnectorPatch;
    const next = { ...e.connector, ...defined };
    return Object.keys(connectorChanges(e.connector, next)).length === 0 ? e : { ...e, connector: next };
  });
}

export function deleteConnectorLocal(board: Board, id: string): Board {
  const index = board.connectors.findIndex((c) => c.connector.id === id);
  const entry = board.connectors[index];
  if (!entry) return board;
  return { ...board, connectors: board.connectors.filter((c) => c !== entry), connectorsRemoved: [...board.connectorsRemoved, { ...entry, index }] };
}

/** An item got its server id: arrows still waiting here that name its local id follow it. */
export function renameItemInConnectors(board: Board, from: string, to: string): Board {
  const rename = (end: ConnectorEnd): ConnectorEnd => (isBound(end) && end.item === from ? { item: to, anchor: end.anchor } : end);
  let changed = false;
  const connectors = board.connectors.map((e) => {
    if (e.confirmed !== null) return e;
    const start = rename(e.connector.start);
    const end = rename(e.connector.end);
    if (start === e.connector.start && end === e.connector.end) return e;
    changed = true;
    return { ...e, connector: { ...e.connector, start, end } };
  });
  return changed ? { ...board, connectors } : board;
}

/** Back to what the relay last confirmed (a dropped connection): adds go, deletes come back, local changes undone. */
export function discardUnconfirmedConnectors(board: Board): Board {
  let next = board;
  for (const removed of [...board.connectorsRemoved].reverse()) next = rollbackConnector(next, removed.connector.id);
  const connectors = next.connectors.flatMap((e): BoardConnector[] => {
    if (e.confirmed === null) return [];
    return e.connector === e.confirmed ? [e] : [{ ...e, connector: e.confirmed }];
  });
  return { ...next, connectors, connectorsRemoved: [] };
}
