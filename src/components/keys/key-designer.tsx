'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { RawPanel, SchemaProblems, useRawView } from '@/components/designer/raw-view';
import { NotLiveNote, SaveBar, type DesignerEnvironment } from '@/components/designer/save-bar';
import { DiffTable } from '@/components/diff/diff-table';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AccessHelp, ApiChoices } from '@/lib/designer/access';
import { RAW_FORMATS, schemaValidator } from '@/lib/designer/raw';
import { describeFailure, saveDiff } from '@/lib/designer/write';
import { bffClient } from '@/lib/g2/client';
import {
  INITIAL_KEY_METADATA_FORM_STATE,
  isEmptyKeyMetadata,
  parseKeyMetadata,
  type ParsedKeyMetadata,
} from '@/lib/keys/metadata';
import { createKey } from '@/lib/keys/save';
import {
  isKeyShape,
  keyProblems,
  otherKeyFields,
  type KeyHelpKey,
  type KeySession,
} from '@/lib/keys/session';
import { KeyForm, type PolicyChoice } from './key-form';
import {
  EMPTY_KEY_METADATA_DRAFT,
  NewKeyMetadata,
  type KeyMetadataDraft,
  type SaveKeyMetadata,
} from './key-metadata';
import { RawKeyDialog, type MintedKey } from './raw-key-dialog';

type Props = {
  /** The stored session and its hash when editing; `null` when creating. */
  stored: { hash: string; session: KeySession } | null;
  initial: KeySession;
  help: Record<KeyHelpKey, string>;
  schema: { $id: string } & object;
  policies: { ok: true; value: readonly PolicyChoice[] } | { ok: false; error: string };
  /** Whether the role holds `keys:write`; otherwise the designer is read-only. */
  canWrite: boolean;
  environment: DesignerEnvironment;
  /** The environment's APIs for the access matrix (`loadApiChoices`). */
  apis: ApiChoices;
  accessHelp: AccessHelp;
  /** Saves the new key's dashboard metadata once it exists; creating only. */
  saveMetadata?: SaveKeyMetadata;
};

/**
 * The key designer: one draft `KeySession`, edited through the form or as raw
 * JSON/YAML like the other designers. Editing saves through the shared
 * diff-previewed save bar, addressed by hash. Creating shows the diff too, then
 * the raw key, once.
 */
export function KeyDesigner({
  stored,
  initial,
  help,
  schema,
  policies,
  canWrite,
  environment,
  apis,
  accessHelp,
  saveMetadata,
}: Props) {
  const [draft, setDraft] = useState(initial);
  const [metadata, setMetadata] = useState<KeyMetadataDraft>(EMPTY_KEY_METADATA_DRAFT);
  const parsedMetadata = parseKeyMetadata(metadata);
  const { view, text, unapplied, open, edit } = useRawView<KeySession, 'form'>({
    draft,
    setDraft,
    initialView: 'form',
    isShape: isKeyShape,
    shapeError: 'A key session is a JSON object.',
  });
  const validate = useMemo(() => schemaValidator(schema), [schema]);
  const original = stored?.session ?? null;

  const problems = keyProblems(draft);
  const schemaProblems = validate(draft);
  const others = otherKeyFields(draft);
  const blocker =
    unapplied !== null
      ? 'The raw text has errors; fix them or switch back to the form.'
      : Object.keys(problems).length > 0
        ? 'Fix the fields marked in the form first.'
        : stored === null && !parsedMetadata.ok
          ? `Dashboard metadata: ${parsedMetadata.error}.`
          : null;

  return (
    <div className="flex flex-col gap-6">
      {!canWrite && (
        <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm text-muted">
          Read-only: your role can view keys but not change them.
        </p>
      )}
      <Tabs value={view} onValueChange={open}>
        <TabsList>
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
          <TabsTrigger value="yaml">YAML</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="mt-4 flex flex-col gap-6">
          <KeyForm
            draft={draft}
            onChange={setDraft}
            original={original}
            help={help}
            problems={problems}
            policies={policies}
            apis={apis}
            accessHelp={accessHelp}
            readOnly={!canWrite}
          />
          {others.length > 0 && (
            <p className="text-xs text-muted">
              Also set on this key, and kept exactly as they are:{' '}
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
              model="key-session"
              readOnly={!canWrite}
            />
          </TabsContent>
        ))}
      </Tabs>
      <SchemaProblems problems={schemaProblems} />
      {canWrite && stored === null && saveMetadata !== undefined && (
        <NewKeyMetadata value={metadata} onChange={setMetadata} />
      )}
      {canWrite &&
        (stored === null ? (
          <CreateBar
            draft={draft}
            blocker={blocker}
            environment={environment}
            metadata={parsedMetadata}
            saveMetadata={saveMetadata}
          />
        ) : (
          <SaveBar
            kind="key"
            id={stored.hash}
            original={stored.session}
            draft={draft}
            blocker={blocker}
            environment={environment}
          />
        ))}
    </div>
  );
}

/**
 * Review-and-create for a new key. After the gateway answers, the raw key is
 * held in state only until its dialog is closed, then dropped, and the page
 * moves to the key's view by hash.
 */
function CreateBar({
  draft,
  blocker,
  environment,
  metadata,
  saveMetadata,
}: {
  draft: KeySession;
  blocker: string | null;
  environment: DesignerEnvironment;
  metadata: ParsedKeyMetadata;
  saveMetadata?: SaveKeyMetadata;
}) {
  const router = useRouter();
  const [reviewing, setReviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [metadataProblem, setMetadataProblem] = useState<string | null>(null);

  /**
   * The dashboard's label, owner and notes, saved by the new key's hash (never
   * the raw key) once the gateway has created it. A failure here does not undo
   * the key: it is reported in the one-time dialog, and the key view can retry.
   */
  const saveMetadataFor = async (hash: string): Promise<string | null> => {
    if (saveMetadata === undefined || !metadata.ok || isEmptyKeyMetadata(metadata.value)) {
      return null;
    }
    const form = new FormData();
    form.set('environment', environment.id);
    form.set('hash', hash);
    form.set('label', metadata.value.label ?? '');
    form.set('owner', metadata.value.owner ?? '');
    form.set('notes', metadata.value.notes ?? '');
    try {
      return (await saveMetadata(INITIAL_KEY_METADATA_FORM_STATE, form)).error;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const create = async () => {
    setCreating(true);
    setError(null);
    const result = await createKey(bffClient(environment.id), draft);
    if (!result.ok) {
      setCreating(false);
      return setError(describeFailure(result));
    }
    setMetadataProblem(await saveMetadataFor(result.key_hash));
    setCreating(false);
    setReviewing(false);
    setMinted({ key: result.key, hash: result.key_hash });
  };

  const done = () => {
    const hash = minted?.hash;
    setMinted(null);
    setMetadataProblem(null);
    if (hash !== undefined) {
      router.replace(`/keys/view/${encodeURIComponent(hash)}?created=1`);
      router.refresh();
    }
  };

  return (
    <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
      {blocker ? (
        <p className="text-xs text-danger">{blocker}</p>
      ) : (
        <NotLiveNote kind="key" environment={environment} />
      )}
      <Button onClick={() => setReviewing(true)} disabled={blocker !== null}>
        Review and create
      </Button>

      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Create a key</DialogTitle>
            <DialogDescription>
              In {environment.label}. The gateway generates the key, validates the session, and
              returns the key once. It works as soon as it is created.
            </DialogDescription>
          </DialogHeader>
          <DiffTable changes={saveDiff(null, draft)} />
          {metadata.ok && !isEmptyKeyMetadata(metadata.value) && (
            <p className="text-xs text-muted">
              Then saved in the dashboard, not the gateway: label{' '}
              <span className="text-foreground">{metadata.value.label ?? '—'}</span>, owner{' '}
              <span className="text-foreground">{metadata.value.owner ?? '—'}</span>
              {metadata.value.notes !== null && ', and notes'}.
            </p>
          )}
          {error && (
            <p role="alert" className="font-mono text-xs break-all text-danger">
              The gateway refused the key: {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(false)}>
              Keep editing
            </Button>
            <Button onClick={create} disabled={creating}>
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RawKeyDialog minted={minted} title="Key created" onDone={done}>
        {metadataProblem !== null && (
          <p role="alert" className="font-mono text-xs break-all text-danger">
            The key exists, but its dashboard metadata was not saved: {metadataProblem}. Add it
            again on the key&apos;s page.
          </p>
        )}
      </RawKeyDialog>
    </div>
  );
}
