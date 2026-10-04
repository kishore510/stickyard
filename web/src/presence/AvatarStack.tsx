import type { Participant } from "@stickyard/shared";
import { cn } from "../lib/utils";
import { participantBorderClass } from "../rooms/colours";
import { avatarStack, initials } from "./avatars";

/*
 * The faces in the top bar's Participants button (md and up): initials in the participant's colour
 * ring, you first (with a thicker ring), then "+N". Decorative: the button's accessible name says
 * how many people there are, and the Participants sheet names everyone. Names are text only.
 */
export function AvatarStack({ participants, youId }: { participants: readonly Participant[]; youId: string | null }) {
  const { shown, overflow } = avatarStack(participants, youId);
  const face = "-ml-xs flex size-avatar shrink-0 items-center justify-center overflow-hidden rounded-full border-2 bg-surface-muted text-xs leading-none font-semibold text-fg first:ml-0";
  return (
    <span data-avatar-stack="" aria-hidden="true" className="flex items-center">
      {shown.map(({ participant, you }) => (
        <span
          key={participant.id}
          data-avatar=""
          data-you={you || undefined}
          className={cn(face, participantBorderClass(participant.colourIndex), you && "ring-2 ring-fg-muted")}
        >
          {initials(participant.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span data-avatar-more="" className={cn(face, "border-border tabular-nums")}>
          +{overflow}
        </span>
      )}
    </span>
  );
}
