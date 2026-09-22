'use client';

import { useState } from 'react';
import { Field, Toggle, useSyncedText } from '@/components/designer/fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  addApi,
  addTypeFields,
  danglingApis,
  describeQueryDepth,
  entryOf,
  formatFieldList,
  grantedApis,
  isRestricted,
  parseFieldList,
  parseQueryDepth,
  removeApi,
  removeTypeFields,
  typeListOf,
  ungrantedApis,
  withAccessField,
  withApiEntry,
  withTypeFields,
  withTypeList,
  type AccessHelp,
  type AccessMap,
  type ApiAccess,
  type ApiChoice,
  type ApiChoices,
  type TypeFields,
} from '@/lib/designer/access';

type Props = {
  /** Prefix for element ids, unique on the page. */
  id: string;
  access: AccessMap | undefined;
  /** `undefined` drops the field: g2way's default `{}`, every API. */
  onChange: (access: AccessMap | undefined) => void;
  /** The environment's APIs (`loadApiChoices`), or why they could not be listed. */
  apis: ApiChoices;
  /** `accessFieldHelp()`: g2way's rustdoc for `access`, `ApiAccess` and `TypeFields`. */
  help: AccessHelp;
  /** Who the grant applies to, for the "every API" warning: "this key", "keys applying this policy". */
  subject: string;
  /** How a policy replaces this map, said plainly for this designer. */
  replaceNote: string;
  problem?: string;
  /**
   * A policy id when a key applies one: the key's own `access` is then ignored
   * at auth time, so the matrix is shown read-only and marked as not in use.
   */
  overriddenBy?: string | null;
};

/**
 * The per-API access matrix, shared by the policy and key designers: one row
 * per granted `api_id`, with its GraphQL restrictions (`ApiAccess`). Every edit
 * goes through the pure helpers in `lib/designer/access`, which keep fields the
 * matrix does not show, so the form and the raw view round-trip.
 */
export function AccessMatrix({
  id,
  access,
  onChange,
  apis,
  help,
  subject,
  replaceNote,
  problem,
  overriddenBy = null,
}: Props) {
  const granted = grantedApis(access);
  const known = apis.ok ? apis.value : [];
  const dangling = new Set(apis.ok ? danglingApis(access, known) : []);
  const byId = new Map(known.map((api) => [api.id, api]));
  const overridden = overriddenBy !== null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="text-sm font-semibold uppercase tracking-wide text-muted">
        API access
      </h2>
      {overridden && (
        <p
          role="status"
          className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning"
        >
          Not in use: the policy <span className="font-mono">{overriddenBy}</span> is applied, and
          its access replaces this key&apos;s own entirely at auth time. The key&apos;s own access
          is kept as it is, read-only here, and used again only if the policy is removed.
        </p>
      )}
      <fieldset
        disabled={overridden}
        className={overridden ? 'flex flex-col gap-3 opacity-60' : 'flex flex-col gap-3'}
      >
        {granted.length === 0 ? (
          <p
            role="status"
            className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-warning"
          >
            No access entries: {subject} may call <strong>every API in the organisation</strong>. An
            empty <span className="font-mono">access</span> map is not &quot;no access&quot;. Add an
            API to limit the grant to the APIs listed.
          </p>
        ) : (
          <p className="text-sm">
            {granted.length} API{granted.length === 1 ? '' : 's'} granted; every other API is
            refused.
          </p>
        )}
        <p className="text-xs text-muted">
          {help.access} {replaceNote}
        </p>
        {problem && (
          <p role="alert" className="text-xs text-danger">
            {problem}
          </p>
        )}
        {!apis.ok && (
          <p role="alert" className="text-xs text-danger">
            Could not list APIs: <span className="font-mono">{apis.error}</span>. Granted ids are
            shown as they are; add one by its id.
          </p>
        )}

        {granted.map((apiId) => (
          <AccessRow
            key={apiId}
            id={`${id}.${apiId}`}
            apiId={apiId}
            api={byId.get(apiId) ?? null}
            dangling={dangling.has(apiId)}
            entry={entryOf(access, apiId)}
            help={help}
            onChange={(entry) => onChange(withApiEntry(access, apiId, entry))}
            onRemove={() => onChange(removeApi(access, apiId))}
          />
        ))}

        <AddApi
          id={id}
          choices={ungrantedApis(access, known)}
          granted={granted}
          onAdd={(apiId) => onChange(addApi(access, apiId))}
        />
      </fieldset>
    </section>
  );
}

/** Pick an API of the environment, or type an id (file-loaded APIs are not listed). */
function AddApi({
  id,
  choices,
  granted,
  onAdd,
}: {
  id: string;
  choices: readonly ApiChoice[];
  granted: readonly string[];
  onAdd: (apiId: string) => void;
}) {
  const [picked, setPicked] = useState('');
  const [typed, setTyped] = useState('');
  const pick = choices.some((api) => api.id === picked) ? picked : (choices[0]?.id ?? '');
  const typedId = typed.trim();
  const typedTaken = granted.includes(typedId);

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-md border border-dashed border-border p-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-add`} className="text-sm font-medium">
          Grant an API
        </label>
        <div className="flex gap-2">
          <select
            id={`${id}-add`}
            value={pick}
            onChange={(event) => setPicked(event.target.value)}
            disabled={choices.length === 0}
            className="h-9 min-w-56 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-accent"
          >
            {choices.length === 0 && <option value="">Every listed API is granted</option>}
            {choices.map((api) => (
              <option key={api.id} value={api.id}>
                {api.name} ({api.id}){api.graphql ? ' · GraphQL' : ''}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            disabled={pick === ''}
            onClick={() => {
              onAdd(pick);
              setPicked('');
            }}
          >
            Add
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-add-id`} className="text-sm font-medium">
          Or by api_id
        </label>
        <div className="flex gap-2">
          <Input
            id={`${id}-add-id`}
            className="w-48 font-mono"
            value={typed}
            placeholder="api_id"
            onChange={(event) => setTyped(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={typedId === '' || typedTaken}
            title={typedTaken ? 'Already granted.' : undefined}
            onClick={() => {
              onAdd(typedId);
              setTyped('');
            }}
          >
            Add
          </Button>
        </div>
      </div>
      <p className="basis-full text-xs text-muted">
        The list shows this environment&apos;s stored APIs. An API loaded from a file (
        <span className="font-mono">--apps-dir</span>) is not listed by the admin API: add it by its
        id.
      </p>
    </div>
  );
}

function AccessRow({
  id,
  apiId,
  api,
  dangling,
  entry,
  help,
  onChange,
  onRemove,
}: {
  id: string;
  apiId: string;
  api: ApiChoice | null;
  dangling: boolean;
  entry: ApiAccess;
  help: AccessHelp;
  onChange: (entry: ApiAccess) => void;
  onRemove: () => void;
}) {
  const restricted = isRestricted(entry);
  const allowed = typeListOf(entry, 'allowed_types');
  const blocked = typeListOf(entry, 'restricted_types');
  const depth = entry.max_query_depth ?? null;

  return (
    <div
      className={
        dangling
          ? 'flex flex-col gap-3 rounded-md border border-danger/40 bg-danger/5 p-3'
          : 'flex flex-col gap-3 rounded-md border border-border p-3'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {api && <span className="font-medium">{api.name}</span>}
          <span className="font-mono text-xs">{apiId}</span>
          {api?.graphql && <Badge variant="secondary">GraphQL</Badge>}
          {dangling && <Badge variant="destructive">not found</Badge>}
          <Badge variant="outline">{restricted ? 'restricted' : 'unrestricted'}</Badge>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {dangling && (
        <p role="status" className="text-xs text-danger">
          No stored API has this id in this environment. It was deleted, or it is loaded from a
          file, which the admin API does not list. Remove the entry unless it is a file-loaded API.
        </p>
      )}

      <details open={restricted || api?.graphql === true}>
        <summary className="cursor-pointer text-sm font-medium">GraphQL restrictions</summary>
        <div className="mt-3 flex flex-col gap-4">
          <p className="text-xs text-muted">
            {help.entry}
            {api !== null && !api.graphql && (
              <>
                {' '}
                <strong>This API has no GraphQL config</strong>, so g2way ignores these fields on
                it.
              </>
            )}
          </p>
          <div className="grid gap-5 md:grid-cols-2">
            <Toggle
              id={`${id}.disable_introspection`}
              label="Disable introspection"
              help={help.disable_introspection}
              checked={entry.disable_introspection === true}
              onChange={(on) =>
                onChange(withAccessField(entry, 'disable_introspection', on ? true : undefined))
              }
            />
            <DepthField
              id={`${id}.max_query_depth`}
              help={help.max_query_depth}
              value={depth}
              onChange={(value) => onChange(withAccessField(entry, 'max_query_depth', value))}
            />
          </div>
          <TypeListEditor
            id={`${id}.allowed_types`}
            label="Allowed types (allow list)"
            help={help.allowed_types}
            rowHelp={help}
            list={allowed}
            onChange={(list) => onChange(withTypeList(entry, 'allowed_types', list))}
          />
          <TypeListEditor
            id={`${id}.restricted_types`}
            label="Restricted types (block list)"
            help={help.restricted_types}
            rowHelp={help}
            list={blocked}
            ignored={allowed.length > 0}
            onChange={(list) => onChange(withTypeList(entry, 'restricted_types', list))}
          />
        </div>
      </details>
    </div>
  );
}

/** The per-grant depth override: blank inherits, a positive number replaces, -1 lifts. */
function DepthField({
  id,
  help,
  value,
  onChange,
}: {
  id: string;
  help: string;
  value: number | null;
  onChange: (value: number | undefined) => void;
}) {
  const toValue = (text: string) => {
    const parsed = parseQueryDepth(text);
    return parsed.ok ? (parsed.value ?? null) : value;
  };
  const [text, setText] = useSyncedText(value, (v) => (v === null ? '' : String(v)), toValue);
  const parsed = parseQueryDepth(text);
  return (
    <Field
      id={id}
      label="Max query depth"
      help={`${describeQueryDepth(parsed.ok ? parsed.value : value)} ${help}`}
      problem={parsed.ok ? undefined : `${parsed.problem} Not applied until it is.`}
    >
      <Input
        id={id}
        inputMode="numeric"
        className="w-40 font-mono"
        placeholder="inherit"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const next = parseQueryDepth(event.target.value);
          if (next.ok) onChange(next.value);
        }}
      />
    </Field>
  );
}

function TypeListEditor({
  id,
  label,
  help,
  rowHelp,
  list,
  ignored = false,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  rowHelp: AccessHelp;
  list: TypeFields[];
  /** The block list while the allow list is non-empty. */
  ignored?: boolean;
  onChange: (list: TypeFields[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-muted">{help}</p>
      {ignored && list.length > 0 && (
        <p role="status" className="text-xs text-warning">
          Ignored: the allow list is not empty, and it wins.
        </p>
      )}
      {list.map((row, index) => (
        <TypeFieldsRow
          key={index}
          id={`${id}.${index}`}
          row={row}
          help={rowHelp}
          onChange={(change) => onChange(withTypeFields(list, index, change))}
          onRemove={() => onChange(removeTypeFields(list, index))}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(addTypeFields(list))}
        >
          Add a type
        </Button>
        {list.length === 0 && <span className="text-xs text-muted">Empty: no restriction.</span>}
      </div>
    </div>
  );
}

function TypeFieldsRow({
  id,
  row,
  help,
  onChange,
  onRemove,
}: {
  id: string;
  row: TypeFields;
  help: AccessHelp;
  onChange: (change: Partial<TypeFields>) => void;
  onRemove: () => void;
}) {
  const fields = Array.isArray(row.fields) ? row.fields : [];
  const [text, setText] = useSyncedText(fields, formatFieldList, parseFieldList);
  const name = typeof row.name === 'string' ? row.name : '';
  return (
    <div className="flex flex-wrap items-start gap-3 pl-4">
      <Field
        id={`${id}.name`}
        label="Type"
        help={help['type_fields.name']}
        problem={name.trim() === '' ? 'Name the GraphQL type.' : undefined}
      >
        <Input
          id={`${id}.name`}
          className="w-40 font-mono"
          value={name}
          placeholder="Query"
          onChange={(event) => onChange({ name: event.target.value.trim() })}
        />
      </Field>
      <div className="min-w-64 flex-1">
        <Field
          id={`${id}.fields`}
          label="Fields"
          help={`Comma separated. ${help['type_fields.fields']} ${help.type_fields}`}
        >
          <Input
            id={`${id}.fields`}
            className="font-mono"
            value={text}
            placeholder="user, orders or *"
            onChange={(event) => {
              setText(event.target.value);
              onChange({ fields: parseFieldList(event.target.value) });
            }}
          />
        </Field>
      </div>
      <Button type="button" variant="ghost" size="sm" className="mt-6" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}
