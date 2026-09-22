'use client';

import { useMemo, useState } from 'react';
import { RawPanel, SchemaProblems, useRawView } from '@/components/designer/raw-view';
import { HistoryPanel, RestoredNote } from '@/components/designer/history-panel';
import { SaveBar, type DesignerEnvironment } from '@/components/designer/save-bar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AccessHelp, ApiChoices } from '@/lib/designer/access';
import type { HistoryEntry } from '@/lib/designer/history';
import { RAW_FORMATS, schemaValidator } from '@/lib/designer/raw';
import {
  isPolicyShape,
  otherPolicyFields,
  policyProblems,
  type PolicyHelpKey,
} from '@/lib/policies/draft';
import type { Policy } from '@/lib/policies/list';
import { policySaveBlocker } from '@/lib/policies/save';
import { PolicyForm } from './policy-form';

type Props = {
  /** The stored policy when editing; `null` when creating. */
  original: Policy | null;
  /** Where the draft starts: the stored policy, or a new one. */
  initial: Policy;
  help: Record<PolicyHelpKey, string>;
  /** `policySchema()`: g2way's JSON Schema for a policy. */
  schema: { $id: string } & object;
  /** Whether the role holds `policies:write`; otherwise the designer is read-only. */
  canWrite: boolean;
  /** The environment the policy was loaded from, and is saved back to. */
  environment: DesignerEnvironment;
  /** The environment's APIs for the access matrix (`loadApiChoices`). */
  apis: ApiChoices;
  accessHelp: AccessHelp;
  /** Its stored versions, newest first (ADR-0008); absent when creating. */
  history?: readonly HistoryEntry[];
};

/**
 * The policy designer: one draft `Policy`, edited through the structured form
 * or as raw JSON/YAML, exactly as the API designer works, with the same History
 * tab (ADR-0008): loading a version into the draft is the rollback.
 */
export function PolicyDesigner({
  original,
  initial,
  help,
  schema,
  canWrite,
  environment,
  apis,
  accessHelp,
  history,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const { view, setView, text, unapplied, open, edit } = useRawView<Policy, 'form' | 'history'>({
    draft,
    setDraft,
    initialView: 'form',
    isShape: isPolicyShape,
    shapeError: 'policy_id and name must both be strings.',
  });
  const [restored, setRestored] = useState<string | null>(null);
  const validate = useMemo(() => schemaValidator(schema), [schema]);

  const problems = policyProblems(draft);
  const schemaProblems = validate(draft);
  const others = otherPolicyFields(draft);
  const blocker =
    policySaveBlocker(original, draft) ??
    (unapplied !== null
      ? 'The raw text has errors; fix them or switch back to the form.'
      : Object.keys(problems).length > 0
        ? 'Fix the fields marked in the form first.'
        : null);

  return (
    <div className="flex flex-col gap-6">
      {!canWrite && (
        <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm text-muted">
          Read-only: your role can view policies but not change them.
        </p>
      )}
      <Tabs value={view} onValueChange={open}>
        <TabsList>
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
          {history !== undefined && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>
        {restored !== null && view === 'form' && <RestoredNote from={restored} />}
        <TabsContent value="form" className="mt-4 flex flex-col gap-6">
          <PolicyForm
            draft={draft}
            onChange={setDraft}
            original={original}
            help={help}
            problems={problems}
            apis={apis}
            accessHelp={accessHelp}
            readOnly={!canWrite}
          />
          {others.length > 0 && (
            <p className="text-xs text-muted">
              Also set on this policy, and kept exactly as they are:{' '}
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
              model="policy"
              readOnly={!canWrite}
            />
          </TabsContent>
        ))}
        {history !== undefined && (
          <TabsContent value="history" className="mt-4">
            <HistoryPanel
              entries={history}
              canWrite={canWrite}
              isShape={isPolicyShape}
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
          kind="policy"
          original={original}
          draft={draft}
          blocker={blocker}
          environment={environment}
        />
      )}
    </div>
  );
}
