import { BookOpen, Info, Sparkles, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AboutPage } from "../about/AboutPage";
import { ChangelogPage } from "../changelog/ChangelogPage";
import { topicById } from "../help/content";
import { HelpHome, HelpTopicPage } from "../help/HelpPages";
import { ParticipantsPage } from "../rooms/ParticipantsPage";
import { sheetHash, type Sheet as SheetRoute } from "../router";
import { canGoBack, closeSheets, goBack } from "./nav";
import { Sheet } from "./Sheet";

function describe(sheet: SheetRoute): { title: string; icon: ReactNode } {
  switch (sheet.kind) {
    case "help":
      return { title: "Help", icon: <BookOpen /> };
    case "help-topic":
      return { title: topicById(sheet.id)?.title ?? "Help", icon: <BookOpen /> };
    case "changelog":
      return { title: "What’s new", icon: <Sparkles /> };
    case "about":
      return { title: "About Stickyard", icon: <Info /> };
    case "participants":
      return { title: "Participants", icon: <Users /> };
  }
}

/** Shows the sheet named by the hash route. One frame stays mounted while moving between sheets. */
export function SheetHost({ sheet }: { sheet: SheetRoute }) {
  // Lives here, not in Help, so Back from a topic returns to the same search results.
  const [query, setQuery] = useState("");
  const { title, icon } = describe(sheet);
  const page = sheetHash(sheet);

  return (
    <Sheet title={title} icon={icon} page={page} onClose={closeSheets} onBack={canGoBack(sheet) ? goBack : undefined}>
      {sheet.kind === "help" && <HelpHome query={query} setQuery={setQuery} />}
      {sheet.kind === "help-topic" && <HelpTopicPage id={sheet.id} />}
      {sheet.kind === "changelog" && <ChangelogPage />}
      {sheet.kind === "about" && <AboutPage />}
      {sheet.kind === "participants" && <ParticipantsPage />}
    </Sheet>
  );
}
