import type { DiffEntry } from '@/lib/audit/diff';
import type { JsonValue } from '@/lib/db/schema/shared';

const KIND_STYLE: Record<DiffEntry['kind'], string> = {
  added: 'text-success',
  removed: 'text-danger',
  changed: 'text-warning',
};

/**
 * `diffJson()`'s entries as a path / change / before / after table: the audit
 * detail page and the API designer's save preview. Presentational, so it
 * renders on either side of the server/client line.
 */
export function DiffTable({ changes }: { changes: readonly DiffEntry[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Path</th>
            <th className="px-3 py-2 font-medium">Change</th>
            <th className="px-3 py-2 font-medium">Before</th>
            <th className="px-3 py-2 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={`${change.kind}:${change.path}`} className="border-t border-border align-top">
              <td className="px-3 py-2 font-mono text-xs">{change.path || '(whole document)'}</td>
              <td className={`px-3 py-2 font-mono text-xs ${KIND_STYLE[change.kind]}`}>
                {change.kind}
              </td>
              <td className="px-3 py-2">{'before' in change && <Json value={change.before} />}</td>
              <td className="px-3 py-2">{'after' in change && <Json value={change.after} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Json({ value }: { value: JsonValue }) {
  return (
    <pre className="max-w-md overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
