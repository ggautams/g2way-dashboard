'use client';

import { useState } from 'react';
import { draftProblems, otherFields, type FormField } from '@/lib/apis/draft';
import type { ApiDefinition } from '@/lib/apis/list';
import { ApiForm } from './api-form';

type Props = {
  /** The stored definition when editing; `null` when creating. */
  original: ApiDefinition | null;
  /** Where the draft starts: the stored definition, or a new one. */
  initial: ApiDefinition;
  help: Record<FormField, string>;
  /** Whether the role holds `apis:write`; otherwise the designer is read-only. */
  canWrite: boolean;
};

/**
 * The API designer: one draft `ApiDefinition`, edited through the structured
 * form. Everything the form does not cover is carried along untouched.
 */
export function ApiDesigner({ original, initial, help, canWrite }: Props) {
  const [draft, setDraft] = useState(initial);
  const problems = draftProblems(draft);
  const others = otherFields(draft);

  return (
    <div className="flex flex-col gap-6">
      {!canWrite && (
        <p className="rounded-md border border-border bg-subtle px-3 py-2 text-sm text-muted">
          Read-only: your role can view API definitions but not change them.
        </p>
      )}
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
          <span className="font-mono">{others.join(', ')}</span>.
        </p>
      )}
    </div>
  );
}
