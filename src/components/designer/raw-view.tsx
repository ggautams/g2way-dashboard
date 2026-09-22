'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import {
  RAW_FORMATS,
  parseRaw,
  serialize,
  type RawFormat,
  type SchemaProblem,
} from '@/lib/designer/raw';

// Monaco is large and browser-only: load it on first use, never on the server.
const RawEditor = dynamic(() => import('./raw-editor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted">Loading the editor…</p>,
});

/**
 * A designer's view state: its tab, and the raw text of the JSON/YAML view.
 * Raw text is applied to the draft whenever it parses into something the form
 * can show (`isShape`), and re-rendered from the draft whenever a raw view is
 * opened; `unapplied` says why the current text is not in the draft.
 */
export function useRawView<T extends object, V extends string>(options: {
  draft: T;
  setDraft: (draft: T) => void;
  initialView: V;
  isShape: (value: unknown) => value is T;
  /** Why a parsed value is not a draft, when `isShape` refuses it. */
  shapeError: string;
}) {
  const { draft, setDraft, isShape, shapeError } = options;
  const [view, setView] = useState<V | RawFormat>(options.initialView);
  const [text, setText] = useState('');
  const [unapplied, setUnapplied] = useState<string | null>(null);

  const open = (next: string) => {
    const format = RAW_FORMATS.find((f) => f === next);
    if (format !== undefined) setText(serialize(draft, format));
    setUnapplied(null);
    setView(next as V | RawFormat);
  };

  const edit = (format: RawFormat, value: string) => {
    setText(value);
    const parsed = parseRaw(value, format);
    if (!parsed.ok) return setUnapplied(parsed.error);
    if (!isShape(parsed.value)) return setUnapplied(shapeError);
    setUnapplied(null);
    setDraft(parsed.value);
  };

  return { view, setView, text, unapplied, open, edit };
}

/** The raw editor for one format, with why the text is not applied, if it is not. */
export function RawPanel({
  format,
  shown,
  text,
  unapplied,
  onEdit,
  schema,
  model,
  readOnly,
}: {
  format: RawFormat;
  /** Whether this format's tab is open: Monaco mounts only then. */
  shown: boolean;
  text: string;
  unapplied: string | null;
  onEdit: (format: RawFormat, text: string) => void;
  schema: { $id: string } & object;
  model: string;
  readOnly: boolean;
}) {
  return (
    <>
      {shown && (
        <RawEditor
          format={format}
          value={text}
          onChange={(value) => onEdit(format, value)}
          schema={schema}
          model={model}
          readOnly={readOnly}
        />
      )}
      {unapplied !== null && (
        <p role="alert" className="text-xs text-danger">
          Not applied to the draft: {unapplied}
        </p>
      )}
    </>
  );
}

/** Schema problems under the editor, for both views. */
export function SchemaProblems({ problems }: { problems: readonly SchemaProblem[] }) {
  if (problems.length === 0) {
    return <p className="text-xs text-success">Valid against g2way&apos;s schema.</p>;
  }
  return (
    <section aria-label="Schema problems" className="rounded-md border border-warning/40 p-3">
      <p className="text-sm font-medium text-warning">
        {problems.length} schema problem{problems.length === 1 ? '' : 's'} (the gateway will refuse
        this as it stands)
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
        {problems.map(({ path, message }) => (
          <li key={path}>
            {path}: {message}
          </li>
        ))}
      </ul>
    </section>
  );
}
