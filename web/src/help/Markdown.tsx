import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { HELP_LINK, type Block, type Inline } from "./markdown";

/*
 * Renders parsed Markdown as React elements. No HTML strings are ever injected;
 * links are either help topics or https pages in a new tab.
 */

type OnTopic = (id: string) => void;
const noTopic: OnTopic = () => {};

export function InlineView({ nodes, onTopic = noTopic }: { nodes: Inline[]; onTopic?: OnTopic }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return (
          <strong key={i} className="font-semibold text-fg">
            <InlineView nodes={node.children} onTopic={onTopic} />
          </strong>
        );
      case "em":
        return (
          <em key={i}>
            <InlineView nodes={node.children} onTopic={onTopic} />
          </em>
        );
      case "code":
        return (
          <code key={i} className="rounded-sm border border-border bg-surface-muted px-2xs font-mono text-xs whitespace-nowrap text-fg">
            {node.text}
          </code>
        );
      case "link": {
        const topic = HELP_LINK.exec(node.href)?.[1];
        const children = <InlineView nodes={node.children} onTopic={onTopic} />;
        return topic ? (
          <button key={i} type="button" onClick={() => onTopic(topic)} className="cursor-pointer font-medium text-accent underline underline-offset-2">
            {children}
          </button>
        ) : (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline underline-offset-2">
            {children}
            <ExternalLink aria-label="(opens in a new tab)" className="ml-2xs inline size-icon-sm align-baseline" />
          </a>
        );
      }
    }
  });
}

export function Markdown({ blocks, onTopic = noTopic }: { blocks: Block[]; onTopic?: OnTopic }) {
  return (
    <div className="flex flex-col gap-ms text-sm text-fg">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return block.level === 2 ? (
              <h3 key={i} className="pt-sm text-base font-semibold">
                <InlineView nodes={block.children} onTopic={onTopic} />
              </h3>
            ) : (
              <h4 key={i} className="pt-xs text-sm font-semibold">
                <InlineView nodes={block.children} onTopic={onTopic} />
              </h4>
            );
          case "paragraph":
            return (
              <p key={i}>
                <InlineView nodes={block.children} onTopic={onTopic} />
              </p>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={i} className={`flex flex-col gap-xs pl-lg ${block.ordered ? "list-decimal" : "list-disc"}`}>
                {block.items.map((item, j) => (
                  <li key={j} className="pl-xs">
                    <InlineView nodes={item} onTopic={onTopic} />
                  </li>
                ))}
              </List>
            );
          }
          case "tip":
            return (
              <aside key={i} className="rounded-md border border-border bg-accent-subtle px-ms py-sm">
                <InlineView nodes={block.children} onTopic={onTopic} />
              </aside>
            );
        }
      })}
    </div>
  );
}
