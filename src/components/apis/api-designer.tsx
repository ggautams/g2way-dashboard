'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { draftProblems, otherFields, type FormField } from '@/lib/apis/draft';
import type { ApiDefinition } from '@/lib/apis/list';
import { isDraftShape, parseRaw, schemaValidator, serialize, type RawFormat } from '@/lib/apis/raw';
import { saveBlocker } from '@/lib/apis/save';
import { ApiForm } from './api-form';
import { SaveBar, type DesignerEnvironment } from './save-bar';

// Monaco is large and browser-only: load it on first use, never on the server.
const RawEditor = dynamic(() => import('./raw-editor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-muted">Loading the editor…</p>,
});

type Props = {
  /** The stored definition when editing; `null` when creating. */
  original: ApiDefinition | null;
  /** Where the draft starts: the stored definition, or a new one. */
  initial: ApiDefinition;
  help: Record<FormField, string>;
  /** `apiDefinitionSchema()`: g2way's JSON Schema for the definition. */
  schema: { $id: string } & object;
  /** Whether the role holds `apis:write`; otherwise the designer is read-only. */
  canWrite: boolean;
  /** The environment the definition was loaded from, and is saved back to. */
  environment: DesignerEnvironment;
};

type View = 'form' | RawFormat;

/**
 * The API designer: one draft `ApiDefinition`, edited through the structured
 * form or as raw JSON/YAML. Both views edit the same draft: raw text is
 * applied to it whenever it parses into something the form can show, and is
 * re-rendered from it whenever a raw view is opened. Everything the form does
 * not cover is carried along untouched.
 */
export function ApiDesigner({ original, initial, help, schema, canWrite, environment }: Props) {
  const [draft, setDraft] = useState(initial);
  const [view, setView] = useState<View>('form');
  const [text, setText] = useState('');
  const [unapplied, setUnapplied] = useState<string | null>(null);
  const validate = useMemo(() => schemaValidator(schema), [schema]);

  const problems = draftProblems(draft);
  const schemaProblems = validate(draft);
  const others = otherFields(draft);
  const blocker =
    saveBlocker(original, draft) ??
    (unapplied !== null
      ? 'The raw text has errors; fix them or switch back to the form.'
      : Object.keys(problems).length > 0
        ? 'Fix the fields marked in the form first.'
        : null);

  const open = (next: string) => {
    const nextView = next as View;
    if (nextView !== 'form') setText(serialize(draft, nextView));
    setUnapplied(null);
    setView(nextView);
  };

  const editRaw = (format: RawFormat, value: string) => {
    setText(value);
    const parsed = parseRaw(value, format);
    if (!parsed.ok) return setUnapplied(parsed.error);
    if (!isDraftShape(parsed.value)) {
      return setUnapplied('api_id, name, listen_path and target_url must all be strings.');
    }
    setUnapplied(null);
    setDraft(parsed.value);
  };

  return (
    <div className="flex flex-col gap-6">
      {!canWrite && (
        <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm text-muted">
          Read-only: your role can view API definitions but not change them.
        </p>
      )}
      <Tabs value={view} onValueChange={open}>
        <TabsList>
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="mt-4 flex flex-col gap-6">
          <ApiForm
            draft={draft}
            onChange={setDraft}
            original={original}
            help={help}
            problems={problems}
            readOnly={!canWrite}
          />
          {others.length > 0 && (
            <p className="text-xs text-muted">
              Also set on this definition, and kept exactly as they are:{' '}
              <span className="font-mono">{others.join(', ')}</span>. Edit them in the JSON or YAML
              view.
            </p>
          )}
        </TabsContent>
        {(['json', 'yaml'] as const).map((format) => (
          <TabsContent key={format} value={format} className="mt-4 flex flex-col gap-2">
            {view === format && (
              <RawEditor
                format={format}
                value={text}
                onChange={(value) => editRaw(format, value)}
                schema={schema}
                readOnly={!canWrite}
              />
            )}
            {unapplied !== null && (
              <p role="alert" className="text-xs text-danger">
                Not applied to the draft: {unapplied}
              </p>
            )}
          </TabsContent>
        ))}
      </Tabs>
      <SchemaProblems problems={schemaProblems} />
      {canWrite && (
        <SaveBar original={original} draft={draft} blocker={blocker} environment={environment} />
      )}
    </div>
  );
}

function SchemaProblems({ problems }: { problems: { path: string; message: string }[] }) {
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
