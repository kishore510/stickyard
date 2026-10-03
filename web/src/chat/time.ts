/*
 * When a chat message arrived, as this device's clock saw it (the relay doesn't timestamp
 * messages; arrival is within network delay of sending). Shown in the viewer's locale.
 */

export interface ChatTime {
  /** Shown next to the name: the time, plus the date if it isn't today. */
  short: string;
  /** Tooltip: full date and time. */
  full: string;
  /** For <time dateTime>. */
  iso: string;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function chatTime(at: number, now: number = Date.now()): ChatTime {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const short = sameDay(date, new Date(now)) ? time : `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
  return {
    short,
    full: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    iso: date.toISOString(),
  };
}
