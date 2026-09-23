'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { RawPanel, SchemaProblems, useRawView } from '@/components/designer/raw-view';
import { HistoryPanel, RestoredNote } from '@/components/designer/history-panel';
import { SaveBar, type DesignerEnvironment } from '@/components/designer/save-bar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { SlotExplanations } from '@/lib/apis/chain';
import { draftProblems, otherFields, type ApiHelp } from '@/lib/apis/draft';
import type { ApiDefinition } from '@/lib/apis/list';
import { isDraftShape } from '@/lib/apis/raw';
import { saveBlocker } from '@/lib/apis/save';
import type { HistoryEntry } from '@/lib/designer/history';
import { RAW_FORMATS, schemaValidator } from '@/lib/designer/raw';
import { ApiForm } from './api-form';
import { ChainView } from './chain-view';
import { RequestConsole, type ConsoleAccess } from './request-console';

type Props = {
  /** The stored definition when editing; `null` when creating. */
  original: ApiDefinition | null;
  /** Where the draft starts: the stored definition, or a new one. */
  initial: ApiDefinition;
  help: ApiHelp;
  /**
   * `slotExplanations()`: each chain slot's explain panel, already rendered on
   * the server from g2way's vendored docs.
   */
  explain: SlotExplanations;
  /** `apiDefinitionSchema()`: g2way's JSON Schema for the definition. */
  schema: { $id: string } & object;
  /** Whether the role holds `apis:write`; otherwise the designer is read-only. */
  canWrite: boolean;
  /** The environment the definition was loaded from, and is saved back to. */
  environment: DesignerEnvironment;
  /** Its stored versions, newest first (ADR-0008); absent when creating. */
  history?: readonly HistoryEntry[];
  /** The request console's access (ADR-0011); absent when creating, which hides the tab. */
  console?: ConsoleAccess;
};

/**
 * The API designer: one draft `ApiDefinition`, edited through the structured
 * form or as raw JSON/YAML. Both views edit the same draft: raw text is
 * applied to it whenever it parses into something the form can show, and is
 * re-rendered from it whenever a raw view is opened. Everything the form does
 * not cover is carried along untouched. The Chain tab shows the middleware
 * chain g2way would build for the draft; the Console tab sends a test request
 * through the gateway to the stored definition, with an inferred trace that
 * links back to the Chain tab.
 */
export function ApiDesigner({
  original,
  initial,
  help,
  explain,
  schema,
  canWrite,
  environment,
  history,
  console: consoleAccess,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const { view, setView, text, unapplied, open, edit } = useRawView<
    ApiDefinition,
    'form' | 'chain' | 'history' | 'console'
  >({
    draft,
    setDraft,
    initialView: 'form',
    isShape: isDraftShape,
    shapeError: 'api_id, name, listen_path and target_url must all be strings.',
  });
  const [restored, setRestored] = useState<string | null>(null);
  const pendingAnchor = useRef<string | null>(null);
  // In-page links between tabs (the Chain tab's "Edit" links, EDITOR_SLOTS in
  // chain.ts): switch to the tab holding the target, then scroll to it once
  // that tab has rendered.
  useEffect(() => {
    const id = pendingAnchor.current;
    if (id === null) return;
    pendingAnchor.current = null;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [view]);
  const followAnchor = (event: React.MouseEvent) => {
    const link = (event.target as Element).closest('a[href^="#"]');
    const id = link?.getAttribute('href')?.slice(1) ?? '';
    const target = id.startsWith('edit-') ? 'form' : id.startsWith('chain-') ? 'chain' : null;
    if (target === null) return;
    event.preventDefault();
    if (view === target) {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      pendingAnchor.current = id;
      open(target);
    }
  };
  const validate = useMemo(() => schemaValidator(schema), [schema]);
  const showConsole = original !== null && consoleAccess !== undefined;

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
    <div className="flex flex-col gap-6" onClickCapture={followAnchor}>
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
          <TabsTrigger value="chain">Chain</TabsTrigger>
          {history !== undefined && <TabsTrigger value="history">History</TabsTrigger>}
          {showConsole && <TabsTrigger value="console">Console</TabsTrigger>}
        </TabsList>
        {restored !== null && view === 'form' && <RestoredNote from={restored} />}
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
        <TabsContent value="chain" className="mt-4">
          <ChainView draft={draft} explain={explain} />
        </TabsContent>
        {showConsole && original !== null && (
          <TabsContent value="console" className="mt-4">
            <RequestConsole
              apiId={original.api_id}
              listenPath={original.listen_path}
              versions={original.versioning ? Object.keys(original.versioning.versions) : null}
              environment={environment}
              access={consoleAccess}
              dirty={JSON.stringify(draft) !== JSON.stringify(original)}
            />
          </TabsContent>
        )}
        {history !== undefined && (
          <TabsContent value="history" className="mt-4">
            <HistoryPanel
              entries={history}
              canWrite={canWrite}
              isShape={isDraftShape}
              onRestore={(version, entry) => {
                setDraft(version);
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
