import { useEffect } from "react";
import { parseInline } from "../help/markdown";
import { InlineView } from "../help/Markdown";
import { cn } from "../lib/utils";
import { VERSION_INFO } from "../version";
import { CHANGELOG, CHANGELOG_TEXT } from "./content";
import { useWhatsNew } from "./whatsNew";

const formatDate = (iso: string) => {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

/** What's new: CHANGELOG.md as version cards. Opening it clears the menu dot. */
export function ChangelogPage() {
  const markSeen = useWhatsNew((s) => s.markSeen);
  useEffect(() => markSeen(), [markSeen]);

  if (!CHANGELOG) {
    // Couldn't parse the file: show it as it is rather than nothing.
    return <pre className="pb-md font-sans text-sm whitespace-pre-wrap text-fg">{CHANGELOG_TEXT}</pre>;
  }
  return (
    <ol className="flex flex-col gap-lg pb-md">
      {CHANGELOG.map((release) => {
        const current = release.version === VERSION_INFO.version;
        return (
          <li
            key={release.version}
            aria-current={current ? "true" : undefined}
            aria-labelledby={`release-${release.version}`}
            className={cn("flex flex-col gap-sm", current && "rounded-lg border border-accent p-ms")}
          >
            <div className="flex flex-wrap items-baseline gap-x-sm gap-y-xs">
              <h3 id={`release-${release.version}`} className="text-base font-semibold text-fg">
                {release.version}
              </h3>
              {release.date && <span className="text-xs text-fg-muted">{formatDate(release.date)}</span>}
              {current && <span className="rounded-full bg-accent px-sm text-xs font-semibold text-accent-fg">This version</span>}
            </div>
            {release.sections.map((section) => (
              <section key={section.title} aria-label={`${release.version} ${section.title}`} className="flex flex-col gap-xs">
                <h4 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{section.title}</h4>
                <ul className="flex list-disc flex-col gap-xs pl-lg text-sm text-fg">
                  {section.items.map((item, i) => (
                    <li key={i}>
                      <InlineView nodes={parseInline(item)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </li>
        );
      })}
    </ol>
  );
}
