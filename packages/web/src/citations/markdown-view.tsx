import { type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ClauseLink } from "./clause-link.js";
import { splitMarkers } from "./markers.js";
import { type MarkerCitation, toCitationTarget } from "./types.js";

const KIND_LABEL = {
  statute: "statute",
  context: "market context",
  caveat: "not from your documents",
} as const;

/**
 * Renders one text node, turning its `[[...]]` markers into chips.
 *
 * Applied through `components` rather than by pre-processing the markdown,
 * because rewriting the source before parsing would let a marker inside a code
 * fence or a table cell be mangled by the rewrite.
 */
function withMarkers(
  children: ReactNode,
  citations: readonly MarkerCitation[],
  citationsKnown: boolean,
): ReactNode {
  if (typeof children === "string") return renderText(children, citations, citationsKnown);
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      typeof child === "string" ? (
        <span key={i}>{renderText(child, citations, citationsKnown)}</span>
      ) : (
        (child as ReactNode)
      ),
    );
  }
  return children;
}

function renderText(
  text: string,
  citations: readonly MarkerCitation[],
  citationsKnown: boolean,
): ReactNode {
  const parts = splitMarkers(
    text,
    citations.map((c) => c.serializedClauseId),
  );
  if (parts.length === 1 && parts[0]?.type === "text") return text;

  return parts.map((part, i) =>
    part.type === "text" ? (
      <span key={i}>{part.value}</span>
    ) : part.kind === "clause" ? (
      <ClauseChip
        key={i}
        value={part.value}
        citation={citations[part.citationIndex ?? -1]}
        citationsKnown={citationsKnown}
      />
    ) : (
      <span
        key={i}
        title={KIND_LABEL[part.kind]}
        className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 align-baseline text-[0.7rem] text-slate-600"
      >
        {part.kind === "caveat" ? "not from your documents" : part.value}
      </span>
    ),
  );
}

function ClauseChip({
  value,
  citation,
  citationsKnown,
}: {
  value: string;
  citation: MarkerCitation | undefined;
  citationsKnown: boolean;
}) {
  if (!citation) {
    // Mid-stream the citation list does not exist yet - it arrives with `done` -
    // so a marker being unmatched says nothing at all. Flagging it as unresolved
    // here would paint an entire report amber while it was still being written.
    if (!citationsKnown) {
      return (
        <span
          title="Citation details arrive when the report finishes."
          className="mx-0.5 rounded bg-slate-100 px-1 py-0.5 align-baseline text-[0.7rem] text-slate-400"
        >
          cited
        </span>
      );
    }

    // Once they are known, an unmatched marker is a real defect: the validator
    // passed a citation the report does not carry. Visible, because hiding it
    // would hide the bug.
    return (
      <span
        title="This marker did not match any citation on the report."
        className="mx-0.5 rounded bg-severity-amber-surface px-1 py-0.5 align-baseline text-[0.7rem] text-severity-amber"
      >
        unresolved
      </span>
    );
  }

  return (
    <ClauseLink
      target={toCitationTarget(citation)}
      title={value}
      className="mx-0.5 px-1 py-0.5 align-baseline text-[0.7rem]"
    >
      p{citation.page}
    </ClauseLink>
  );
}

export function MarkdownView({
  markdown,
  citations,
  citationsKnown,
}: {
  markdown: string;
  citations: readonly MarkerCitation[];
  /** False while streaming: the citation list only arrives with `done`. */
  citationsKnown: boolean;
}) {
  return (
    <div className="prose-slate max-w-none text-sm leading-relaxed text-slate-800 [&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-3 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border-b [&_td]:border-slate-100 [&_td]:py-1.5 [&_td]:pr-3 [&_th]:border-b [&_th]:border-slate-200 [&_th]:py-1.5 [&_th]:pr-3 [&_th]:text-left [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // No rehype-raw: this is model-authored text, and enabling raw HTML in it
        // would turn a prompt injection in an uploaded contract into markup here.
        components={{
          p: ({ children }) => <p>{withMarkers(children, citations, citationsKnown)}</p>,
          li: ({ children }) => <li>{withMarkers(children, citations, citationsKnown)}</li>,
          td: ({ children }) => <td>{withMarkers(children, citations, citationsKnown)}</td>,
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
