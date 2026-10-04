import type { Participant } from "@stickyard/shared";
import { Crown } from "lucide-react";
import { cn } from "../lib/utils";
import { participantBorderClass } from "../rooms/colours";
import { avatarStack, initials } from "./avatars";

/*
 * The faces in the top bar's Participants button (md and up): initials in the participant's colour
 * ring, you first (with a thicker ring), then "+N". Each face is named (role img: "Alex", or
 * "Alex, host" with a small crown mark, so a host isn't shown by colour alone); the button's own
 * accessible name says how many people there are, and the Participants sheet names everyone.
 * Names are untrusted: text only.
 */
export const avatarName = (p: Participant) => (p.host ? `${p.name}, host` : p.name);

export function AvatarStack({ participants, youId }: { participants: readonly Participant[]; youId: string | null }) {
  const { shown, overflow } = avatarStack(participants, youId);
  const face = "flex size-avatar shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-surface-muted text-xs leading-none font-semibold text-fg";
  return (
    <span data-avatar-stack="" className="flex items-center">
      {shown.map(({ participant, you }) => (
        <span key={participant.id} className="relative -ml-xs shrink-0 first:ml-0">
          <span
            data-avatar=""
            data-you={you || undefined}
            data-host={participant.host || undefined}
            role="img"
            aria-label={avatarName(participant)}
            title={avatarName(participant)}
            className={cn(face, participantBorderClass(participant.colourIndex), you && "ring-2 ring-fg-muted")}
          >
            <span aria-hidden="true">{initials(participant.name)}</span>
          </span>
          {participant.host && (
            <Crown aria-hidden="true" data-host-mark="" className="absolute -top-xs -right-xs size-icon-sm rounded-full bg-surface p-px text-fg" />
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span data-avatar-more="" aria-hidden="true" className={cn(face, "-ml-xs border-border tabular-nums")}>
          +{overflow}
        </span>
      )}
    </span>
  );
}
