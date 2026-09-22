import { Badge } from '@/components/ui/badge';
import {
  chainAnchor,
  chainFor,
  EDITOR_SLOTS,
  editorAnchor,
  FORWARDER_ID,
  type ForwarderStatus,
  type SlotState,
  type SlotStatus,
} from '@/lib/apis/chain';
import type { ApiDefinition } from '@/lib/apis/list';

/** A link to the form section editing `slotId`, when there is one (`EDITOR_SLOTS`). */
function EditLink({ slotId }: { slotId: string }) {
  if (!EDITOR_SLOTS.includes(slotId)) return null;
  return (
    <a href={`#${editorAnchor(slotId)}`} className="ml-auto text-xs text-accent hover:underline">
      Edit
    </a>
  );
}

const STATE_LABEL: Record<SlotState, string> = {
  on: 'on',
  off: 'off',
  gateway: 'gateway flag',
  unreached: 'not reached',
};

function Slot({ status, version }: { status: SlotStatus; version?: string }) {
  const { slot, state, reason } = status;
  const dim = state === 'off' || state === 'unreached';
  return (
    <li
      id={chainAnchor(slot.id, version)}
      data-slot-id={slot.id}
      data-state={state}
      className={`rounded-md border border-border px-3 py-2 ${dim ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 text-right font-mono text-xs text-muted">{slot.position}</span>
        <span className="text-sm font-medium">{slot.title}</span>
        <Badge variant={state === 'on' ? 'default' : state === 'gateway' ? 'outline' : 'secondary'}>
          {STATE_LABEL[state]}
        </Badge>
        <span className="font-mono text-xs text-muted">{slot.layer}</span>
        <EditLink slotId={slot.id} />
      </div>
      <p className="mt-1 pl-8 text-xs text-muted">
        {reason} {slot.summary}
      </p>
    </li>
  );
}

function Forwarder({ forwarder, version }: { forwarder: ForwarderStatus; version?: string }) {
  return (
    <li
      id={chainAnchor(FORWARDER_ID, version)}
      className="rounded-md border border-dashed border-border px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium">
          Forwarder{' '}
          <span className="text-xs font-normal text-muted">
            (not a slot: proxies to the upstream once every slot above has passed)
          </span>
        </p>
        <EditLink slotId={FORWARDER_ID} />
      </div>
      <p className="mt-1 text-xs text-muted">
        {forwarder.target === null ? 'Forwards nothing.' : `Upstream: ${forwarder.target}.`}{' '}
        {forwarder.notes.join(' ')}
      </p>
    </li>
  );
}

/**
 * The middleware chain g2way builds for the draft, in its real slot order
 * (`src/lib/apis/chain.ts` mirrors chain.rs). A versioned API shows the shared
 * outer slots once, then each version's inner chain. Every slot carries the
 * `chainAnchor()` id, so editors and the explain panel can link to it.
 */
export function ChainView({ draft }: { draft: ApiDefinition }) {
  const chain = chainFor(draft);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Requests pass these slots from top to bottom; responses come back up. Rendered from the
        draft, so it shows unsaved changes, and like any change it is not live until saved and
        reloaded.
      </p>
      {draft.active === false && (
        <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm">
          This API is inactive: it is loaded but never routed to, so no request reaches this chain.
        </p>
      )}
      {chain.versioned ? (
        <>
          <section aria-label="Shared slots" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Shared by every version</h3>
            <ol className="flex flex-col gap-2">
              {chain.outer.map((s) => (
                <Slot key={s.slot.id} status={s} />
              ))}
              <li
                id={chainAnchor('dispatcher')}
                className="rounded-md border border-dashed border-border px-3 py-2 text-sm"
              >
                Version dispatcher: reads the version from the{' '}
                {chain.selector.location === 'query_param' ? 'query parameter' : 'header'}{' '}
                <span className="font-mono">{chain.selector.key}</span>.{' '}
                {chain.selector.defaultVersion === null
                  ? 'No default version: requests naming none get 403.'
                  : `Requests naming none use ${chain.selector.defaultVersion}.`}{' '}
                Unknown or expired versions get 403.
              </li>
            </ol>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            {chain.versions.map((v) => (
              <section
                key={v.name}
                aria-label={`Version ${v.name}`}
                className="flex flex-col gap-2 rounded-lg border border-border p-3"
              >
                <h3 className="text-sm font-medium">
                  Version <span className="font-mono">{v.name}</span>
                  {v.isDefault && <span className="ml-1 text-xs text-muted">(default)</span>}
                </h3>
                <p className="text-xs text-muted">
                  {v.overrides.length === 0
                    ? 'Overrides nothing: every field comes from the base definition.'
                    : `Overrides: ${v.overrides.join(', ')}. Everything else, including auth and the size limit, comes from the base.`}
                  {v.expiresAt !== null &&
                    ` Expires ${new Date(v.expiresAt * 1000).toISOString()}.`}
                </p>
                <ol className="flex flex-col gap-2">
                  {v.inner.map((s) => (
                    <Slot key={s.slot.id} status={s} version={v.name} />
                  ))}
                  <Forwarder forwarder={v.forwarder} version={v.name} />
                </ol>
              </section>
            ))}
          </div>
        </>
      ) : (
        <ol className="flex flex-col gap-2">
          {chain.slots.map((s) => (
            <Slot key={s.slot.id} status={s} />
          ))}
          <Forwarder forwarder={chain.forwarder} />
        </ol>
      )}
    </div>
  );
}
