import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { WORKER_URL } from "../config";
import { formatDetails, VERSION_INFO } from "../version";
import { BUNDLED, CREDITS } from "./credits";

/** The public source repository. The only link to anything outside the app. */
export const REPO_URL = "https://github.com/kishore510/stickyard";

export const relayHost = () => new URL(WORKER_URL).host;

function formatBuilt(iso: string): string {
  const built = iso ? new Date(iso) : null;
  return built && !Number.isNaN(built.getTime())
    ? built.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "unknown";
}

function CopyDetails() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const details = formatDetails(VERSION_INFO, navigator.userAgent);
  const copy = () => {
    const done = navigator.clipboard?.writeText(details);
    if (!done) return setState("failed");
    done.then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <div className="flex flex-col gap-sm">
      <Button variant="secondary" className="self-start" onClick={copy}>
        {state === "copied" ? <Check /> : <Copy />}
        {state === "copied" ? "Copied" : "Copy details"}
      </Button>
      <p className="text-xs text-fg-muted" role="status" aria-live="polite">
        {state === "failed"
          ? "Couldn’t copy. Select the text below and copy it instead."
          : "For bug reports: version, build, protocol and browser. Nothing else."}
      </p>
      {state === "failed" && (
        <textarea
          readOnly
          aria-label="Details for bug reports"
          value={details}
          rows={4}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-md border border-border-strong bg-surface p-sm font-mono text-xs text-fg"
        />
      )}
    </div>
  );
}

export function AboutPage() {
  const rows: [string, string][] = [
    ["Version", VERSION_INFO.version],
    ["Build", VERSION_INFO.commit],
    ["Built", formatBuilt(VERSION_INFO.buildDate)],
    ["Protocol", `v${VERSION_INFO.protocolVersion}`],
    ["Relay", relayHost()],
  ];
  return (
    <div className="flex flex-col gap-lg pb-md text-sm text-fg">
      <p>
        <span className="font-semibold">Stickyard</span>: real-time sticky notes for workshops and retros.
      </p>

      <dl className="flex flex-col gap-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="flex gap-md">
            <dt className="w-term shrink-0 text-fg-muted">{term}</dt>
            <dd className="min-w-0 break-words tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <CopyDetails />

      {/*
        Privacy: must stay true for the current version. Any slice that changes what is
        stored in the browser or sent to the relay (or anywhere else) must update this text
        in the same change.
      */}
      <section aria-labelledby="about-privacy" className="flex flex-col gap-sm">
        <h3 id="about-privacy" className="text-base font-semibold">
          Privacy
        </h3>
        <ul className="flex list-disc flex-col gap-xs pl-lg">
          <li>No analytics, no tracking and no ads. The font and icons are bundled with the app.</li>
          <li>
            When you join a session, the name you type, the chat messages you send and the notes you add or change are
            visible to everyone in the session. Names are never verified. Chat messages are passed on by the relay and not
            saved; the time shown on each is when it reached your device.
          </li>
          <li>
            Notes are stored by the relay, in that session’s own storage on Cloudflare: each note’s text, colour, text
            style (size, bold, italic, text colour and alignment, for the title and the body separately), size, place on the board, stacking order (which notes are in front), and the random id the relay
            gave the visit that added it (not your name). They stay there until someone in the session deletes them, or until the session
            expires: a session’s notes, frames and shapes are deleted automatically once nobody has been in it for 7 days. After
            that the relay keeps only the time it expired, and the session’s link stops working. Moving or resizing a note is passed on to others while you drag,
            and only where it ends up is stored.
          </li>
          <li>
            Frames are stored with the room in the same way: each frame’s position, size, title, colour and title style, and the random
            id the relay gave the visit that added it. Deleting a frame removes only the frame, never its notes.
          </li>
          <li>
            Shapes and text labels are stored the same way: each one’s kind, text, text style, fill, border, size, place on the board,
            stacking order, and the random id the relay gave the visit that added it. They go with the session’s notes and frames when
            it expires or ends.
          </li>
          <li>
            While you share your cursor (a mouse or pen over the board, on a wider screen), your pointer’s position on the board is passed on live
            to the others in the session, with the relay’s random id for your visit so their page can show your name beside it. It is never stored,
            and nothing is sent while your pointer is still, off the board, in a hidden tab, or when you’re the only one there. Phones never share a
            pointer. You can stop sharing, or stop showing other people’s, in Participants.
          </li>
          <li>
            Undo and redo history is kept only in this tab’s memory: it’s never stored or sent anywhere, and it’s gone when you
            leave or reconnect. Notes, frames and shapes that undo brings back are added again as new ones, recorded as added by your visit.
          </li>
          <li>
            Export PNG and Export Markdown are made in your browser from the board your page shows: nothing is uploaded or sent to the relay, and
            nothing is kept. The files are named by the date only, and contain no room code and no names.
          </li>
          <li>
            The create passcode is sent only to the relay, only when you start a session, and is never stored in your
            browser.
          </li>
          <li>
            The app is served by GitHub Pages and the relay runs on Cloudflare. Cloudflare keeps short-term request logs
            that can include the web address you connect to (which contains the session’s room code), your approximate
            location and possibly your IP address. GitHub receives similar request details.
          </li>
          <li>
            This browser stores your theme choice, the last version whose notes you opened, the last name you joined with,
            how wide the board’s side panels are and whether they’re collapsed, the chat panel’s size if you resized it, and
            whether you show other people’s cursors and share yours: layout preferences only, with no session content and nothing about you, and it stays on this device. Where you
            are on the board, the zoom, the tool you pick and which note is selected stay in the open page: they aren’t
            stored or sent anywhere.
          </li>
          <li>
            When you start a session, this browser also keeps that session’s host key: a random-looking code from the relay
            that makes you the session’s host. It is kept only on the device that started the session, sent only to the
            relay when you join that session, never shown or put in a link, and removed when the session ends or expires
            (or if the relay no longer accepts it). It says nothing about you.
          </li>
          <li>
            For dot voting, this browser keeps a random voting key for each session you join, made on this device. It lets
            the relay count your dots as one voter, even after a reload or in a second tab. It is sent only to the relay,
            never shown or put in a link, and removed when the session ends or expires; clearing this browser’s data resets your dots
            in that session (you’d vote as someone new). The relay stores votes against a scrambled version of that key, not your name
            or your visit, deletes them with the session, and never reveals who voted for what: everyone sees only the
            totals once the host closes the vote.
          </li>
          <li>There are no accounts.</li>
        </ul>
      </section>

      <section aria-labelledby="about-credits" className="flex flex-col gap-sm">
        <h3 id="about-credits" className="text-base font-semibold">
          Credits
        </h3>
        <p>Stickyard is built with these open-source projects. Thank you to their authors.</p>
        <ul className="flex flex-col gap-sm">
          {CREDITS.map((c) => (
            <li key={c.name}>
              <span className="font-medium">{c.title}</span>
              <span className="text-fg-muted"> · {c.license}</span>
              <br />
              <span className="text-fg-muted">{c.role}</span>
            </li>
          ))}
        </ul>
        <details className="rounded-md border border-border">
          <summary className="flex min-h-touch cursor-pointer items-center px-ms font-medium">
            All bundled packages ({BUNDLED.length})
          </summary>
          <ul className="flex flex-col gap-xs px-ms pb-ms text-xs">
            {BUNDLED.map((c) => (
              <li key={c.name} className="flex flex-wrap justify-between gap-x-sm">
                <span className="min-w-0 break-all">
                  {c.name} {c.version}
                </span>
                <span className="text-fg-muted">{c.license}</span>
              </li>
            ))}
          </ul>
        </details>
        <p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-touch items-center gap-xs font-medium text-accent underline underline-offset-2"
          >
            Source code on GitHub
            <ExternalLink aria-label="(opens in a new tab)" className="size-icon-sm" />
          </a>
        </p>
      </section>
    </div>
  );
}
