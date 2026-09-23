import 'server-only';

import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ExplainEntry, SlotExplanations } from '@/lib/apis/chain';
import { linkHref, slotDocs, type SlotSource } from '@/lib/apis/slot-docs';

/**
 * Markdown elements, styled for a small panel. Headings inside a passage
 * drop to bold paragraphs (the panel has its own), links are kept only when
 * absolute (`linkHref`), and images show their alt text.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <p className="font-medium">{children}</p>,
  h2: ({ children }) => <p className="font-medium">{children}</p>,
  h3: ({ children }) => <p className="font-medium">{children}</p>,
  h4: ({ children }) => <p className="font-medium">{children}</p>,
  h5: ({ children }) => <p className="font-medium">{children}</p>,
  h6: ({ children }) => <p className="font-medium">{children}</p>,
  a: ({ href, children }) => {
    const target = linkHref(href);
    return target === null ? (
      <span>{children}</span>
    ) : (
      <a href={target} target="_blank" rel="noreferrer" className="text-accent hover:underline">
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span>{alt}</span>,
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-subtle p-2 text-xs">{children}</pre>
  ),
  code: ({ children }) => <code className="font-mono text-xs">{children}</code>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 align-top font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

function render({ source, markdown, authMode }: SlotSource): ExplainEntry {
  return {
    source,
    authMode,
    body: (
      <div className="flex flex-col gap-2">
        <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
          {markdown}
        </Markdown>
      </div>
    ),
  };
}

/**
 * Every chain slot's explain panel, rendered here on the server from
 * `slotDocs()` and handed to the designer (a client component) as props: the
 * markdown renderer and the doc-reading code never reach the browser.
 */
export function slotExplanations(): SlotExplanations {
  return Object.fromEntries(
    Object.entries(slotDocs()).map(([id, doc]) => [
      id,
      { docs: doc.docs.map(render), rustdoc: doc.rustdoc.map(render), adrs: doc.adrs },
    ]),
  );
}
