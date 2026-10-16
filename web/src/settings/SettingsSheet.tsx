import { Settings as SettingsIcon } from "lucide-react";
import { Sheet } from "../shell/Sheet";
import { AiSection } from "./AiSection";
import { useSettings } from "./settingsStore";

/*
 * Settings (v0.42.0): the menu's Settings item on every screen, with or without a room. The usual
 * sheet frame (a bottom sheet on phones, the side panel from md up), store-driven like Share session,
 * so it stacks over any other sheet. One section for now: AI (your own key). Nothing in it touches
 * the room, the board or the WebSocket.
 */
export function SettingsSheetHost() {
  const open = useSettings((s) => s.open);
  const hide = useSettings((s) => s.hide);
  if (!open) return null;
  return (
    <Sheet title="Settings" icon={<SettingsIcon />} page="settings" onClose={hide}>
      <div data-settings-sheet="" className="pb-md">
        <AiSection />
      </div>
    </Sheet>
  );
}
