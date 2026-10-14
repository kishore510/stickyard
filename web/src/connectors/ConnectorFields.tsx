import { ArrowLeftRight } from "lucide-react";
import { CONNECTOR_DASHES, CONNECTOR_INKS, CONNECTOR_ROUTES, CONNECTOR_WIDTHS, type Connector, type ConnectorHead } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { FRAME_COLOR_NAMES } from "../frames/style";
import { ChoiceRow } from "../shapes/ShapeFields";
import { shapeStrokeSwatch } from "../shapes/style";
import { Section, Swatch, SwatchGroup } from "../notes/StyleFields";
import type { ConnectorPatch } from "./board";

/*
 * Properties for one or several arrows (md and up; v0.36.0): route, dash, width, ink, a head at
 * either end, and Reverse. Several arrows show "Mixed" where they differ and change together.
 * Read-only with the reason (locked, a silent round, disconnected): the reason is shown, never
 * hidden. Phones have no Properties (arrows are read-only there).
 */

const ROUTE_NAMES = { straight: "Straight", elbow: "Elbow" } as const;
const DASH_NAMES = { solid: "Solid", dashed: "Dashed", dotted: "Dotted" } as const;
const WIDTH_NAMES = { thin: "Thin", medium: "Medium", thick: "Thick" } as const;
const HEAD_NAMES = { none: "None", arrow: "Arrow" } as const;
const HEADS = ["none", "arrow"] as const satisfies readonly ConnectorHead[];

export function ConnectorFields({
  connectors,
  live,
  reason,
  onEdit,
  onReverse,
}: {
  connectors: readonly Connector[];
  /** Changes can be made now. */
  live: boolean;
  /** Why not (shown under the fields), or null. */
  reason: string | null;
  onEdit: (change: ConnectorPatch) => void;
  onReverse: () => void;
}) {
  const first = connectors[0];
  if (!first) return null;
  const value = <K extends keyof Connector>(key: K): Connector[K] | null => (connectors.every((c) => c[key] === first[key]) ? first[key] : null);
  const ink = value("ink");
  return (
    <div data-connector-fields="" className="flex flex-col gap-md">
      {connectors.length > 1 && <p className="rounded-md bg-surface-muted p-ms text-sm text-fg-muted">These change every selected arrow.</p>}
      <Section title="Line">
        <ChoiceRow label="Route" keys={CONNECTOR_ROUTES} names={ROUTE_NAMES} value={value("route")} live={live} onPick={(route) => onEdit({ route })} />
        <ChoiceRow label="Dash" keys={CONNECTOR_DASHES} names={DASH_NAMES} value={value("dash")} live={live} onPick={(dash) => onEdit({ dash })} />
        <ChoiceRow label="Width" keys={CONNECTOR_WIDTHS} names={WIDTH_NAMES} value={value("width")} live={live} onPick={(width) => onEdit({ width })} />
        <SwatchGroup label="Ink" current={ink === null ? "Mixed" : FRAME_COLOR_NAMES[ink]}>
          {CONNECTOR_INKS.map((key) => (
            <Swatch key={key} label={`${FRAME_COLOR_NAMES[key]} ink`} fill="" fillStyle={shapeStrokeSwatch(key)} pressed={key === ink} disabled={!live} onClick={() => onEdit({ ink: key })} />
          ))}
        </SwatchGroup>
      </Section>
      <Section title="Heads">
        <ChoiceRow label="Start head" keys={HEADS} names={HEAD_NAMES} value={value("startHead")} live={live} onPick={(startHead) => onEdit({ startHead })} />
        <ChoiceRow label="End head" keys={HEADS} names={HEAD_NAMES} value={value("endHead")} live={live} onPick={(endHead) => onEdit({ endHead })} />
        <Button aria-label="Reverse" disabled={!live} onClick={onReverse} className="self-start">
          <ArrowLeftRight />
          Reverse
        </Button>
      </Section>
      {reason && (
        <p data-connector-reason="" className="text-sm text-fg-muted">
          {reason}
        </p>
      )}
    </div>
  );
}
