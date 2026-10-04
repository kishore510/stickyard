import type { ReactNode } from "react";
import { BringToFront, SendToBack } from "lucide-react";
import type { OrderAction } from "@stickyard/shared";
import { Button } from "../components/ui/button";
import { Section } from "./StyleFields";

/*
 * Stacking order (protocol v8): Bring to front and Send to back for the selected note or notes.
 * The Properties panel (one or several notes), the phone editor sheet and the board bar
 * share these commands. Disabled while disconnected.
 */

export const ORDER_COMMANDS: readonly { action: OrderAction; label: string; icon: ReactNode }[] = [
  { action: "front", label: "Bring to front", icon: <BringToFront /> },
  { action: "back", label: "Send to back", icon: <SendToBack /> },
];

/** An "Order" section with both commands as labelled buttons (44px targets; they wrap when narrow). */
export function OrderSection({ live, onOrder }: { live: boolean; onOrder: (action: OrderAction) => void }) {
  return (
    <Section title="Order">
      <div className="flex flex-wrap gap-xs">
        {ORDER_COMMANDS.map((c) => (
          <Button key={c.action} disabled={!live} onClick={() => onOrder(c.action)}>
            {c.icon}
            {c.label}
          </Button>
        ))}
      </div>
    </Section>
  );
}
