/** Shared bits of the signed-out forms. Presentational only. */

export function Field({
  label,
  ...input
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        {...input}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent"
      />
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
    >
      {message}
    </p>
  );
}

export function SubmitButton({ pending, children }: { pending: boolean; children: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity disabled:opacity-60"
    >
      {pending ? 'Working…' : children}
    </button>
  );
}
