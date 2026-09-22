'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/** Layout and inputs every designer form shares. */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="grid gap-5 md:grid-cols-2">{children}</div>
    </section>
  );
}

export function Field({
  id,
  label,
  help,
  problem,
  children,
}: {
  id: string;
  label: string;
  help: string;
  problem?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {problem ? (
        <p className="text-xs text-danger" role="alert">
          {problem}
        </p>
      ) : (
        help && <p className="text-xs text-muted">{help}</p>
      )}
    </div>
  );
}

export function Toggle({
  id,
  label,
  help,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        {help && <p className="text-xs text-muted">{help}</p>}
      </div>
    </div>
  );
}

/**
 * Text that edits a draft value but may be invalid while typed. It follows the
 * draft when the draft changes from elsewhere (the raw editor), and otherwise
 * keeps what the user typed, adjusting state during render rather than in an
 * effect.
 */
export function useSyncedText<T>(
  value: T,
  format: (value: T) => string,
  parse: (text: string) => T,
) {
  const [text, setText] = useState(() => format(value));
  const [seen, setSeen] = useState(value);
  if (!Object.is(seen, value)) {
    setSeen(value);
    if (JSON.stringify(parse(text)) !== JSON.stringify(value)) setText(format(value));
  }
  return [text, setText] as const;
}
