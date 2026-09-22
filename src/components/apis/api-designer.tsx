'use client';

import { useMemo, useState } from 'react';
import { RawPanel, SchemaProblems, useRawView } from '@/components/designer/raw-view';
import { SaveBar, type DesignerEnvironment } from '@/components/designer/save-bar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { draftProblems, otherFields, type FormField } from '@/lib/apis/draft';
import type { ApiDefinition } from '@/lib/apis/list';
import { isDraftShape } from '@/lib/apis/raw';
import { saveBlocker } from '@/lib/apis/save';
import { RAW_FORMATS, schemaValidator } from '@/lib/designer/raw';
import { ApiForm } from './api-form';
import { HistoryPanel, type HistoryEntry } from './history-panel';

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
  /** Its stored versions, newest first (ADR-0008); absent when creating. */
  history?: readonly HistoryEntry[];
};

/**
 * The API designer: one draft `ApiDefinition`, edited through the structured
 * form or as raw JSON/YAML. Both views edit the same draft: raw text is
 * applied to it whenever it parses into something the form can show, and is
 * re-rendered from it whenever a raw view is opened. Everything the form does
 * not cover is carried along untouched.
 */
export function ApiDesigner({
  original,
  initial,
  help,
  schema,
  canWrite,
  environment,
  history,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const { view, setView, text, unapplied, open, edit } = useRawView<
    ApiDefinition,
    'form' | 'history'
  >({
    draft,
    setDraft,
    initialView: 'form',
    isShape: isDraftShape,
    shapeError: 'api_id, name, listen_path and target_url must all be strings.',
  });
  const [restored, setRestored] = useState<string | null>(null);
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
          {history !== undefined && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        {restored !== null && view === 'form' && (
          <p role="status" className="mt-3 text-sm text-warning">
            Loaded the version from {restored} into the draft. Review and save it to roll back.
          </p>
        )}
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
        {RAW_FORMATS.map((format) => (
          <TabsContent key={format} value={format} className="mt-4 flex flex-col gap-2">
            <RawPanel
              format={format}
              shown={view === format}
              text={text}
              unapplied={unapplied}
              onEdit={edit}
              schema={schema}
              model="api-definition"
              readOnly={!canWrite}
            />
          </TabsContent>
        ))}
        {history !== undefined && (
          <TabsContent value="history" className="mt-4">
            <HistoryPanel
              entries={history}
              canWrite={canWrite}
              onRestore={(entry) => {
                setDraft(entry.definition as ApiDefinition);
                setRestored(new Date(entry.createdAt).toLocaleString());
                setView('form');
              }}
            />
          </TabsContent>
        )}
      </Tabs>
      <SchemaProblems problems={schemaProblems} />
      {canWrite && (
        <SaveBar
          kind="api"
          original={original}
          draft={draft}
          blocker={blocker}
          environment={environment}
        />
      )}
    </div>
  );
}
