import { Timer as TimerIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import { FieldError, Label } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { TIMER_PRESETS_MIN, TIMER_TEXT, durationLabel, parseMinutes } from "./timer";

/*
 * The host's timer form: presets (1, 3, 5, 10, 15, 30 minutes) and a custom minutes field, held
 * to the relay's bounds (1 second to 3 hours) with a clear message. Used in the picker sheet (md
 * and up, from the palette's Timer tile) and inline in the Participants sheet's Session section
 * (phones). Says so when a running timer would be replaced; off with the reason while disconnected.
 */
export function TimerForm({ running, reason, onStart }: { running: boolean; reason: string | null; onStart: (durationMs: number) => void }) {
  const id = useId();
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason) return;
    const parsed = parseMinutes(minutes);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    onStart(parsed.ms);
  };
  return (
    <div className="flex flex-col gap-md">
      {running && <p className="rounded-md bg-surface-muted p-ms text-sm">{TIMER_TEXT.replaces}</p>}
      {reason && (
        <p id={`${id}-reason`} className="text-sm text-status-warn">
          {reason}
        </p>
      )}
      <div role="group" aria-label="Presets" className="grid grid-cols-3 gap-sm">
        {TIMER_PRESETS_MIN.map((m) => (
          <Button key={m} aria-describedby={reason ? `${id}-reason` : undefined} aria-disabled={reason !== null || undefined} onClick={() => !reason && onStart(m * 60_000)}>
            {durationLabel(m * 60_000)}
          </Button>
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-sm" noValidate>
        <Label htmlFor={`${id}-minutes`}>Minutes</Label>
        <div className="flex items-start gap-sm">
          <Input
            id={`${id}-minutes`}
            inputMode="decimal"
            autoComplete="off"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            aria-invalid={error !== null || undefined}
            aria-describedby={error ? `${id}-error` : `${id}-help`}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary" aria-disabled={reason !== null || undefined}>
            <TimerIcon />
            Start
          </Button>
        </div>
        {error ? (
          <FieldError id={`${id}-error`}>{error}</FieldError>
        ) : (
          <p id={`${id}-help`} className="text-sm text-fg-muted">
            From 1 second to 3 hours. Decimals work: 2.5 is two and a half minutes.
          </p>
        )}
      </form>
    </div>
  );
}
