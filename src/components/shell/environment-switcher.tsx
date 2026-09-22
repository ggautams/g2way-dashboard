'use client';

/** `PublicEnvironment`, restated: its module is server-only, even for a type import. */
type Environment = { id: string; label: string; isDefault: boolean };

type Props = {
  environments: readonly Environment[];
  current: string;
  /** `selectEnvironmentAction`, passed in so this module imports nothing server-side. */
  action: (formData: FormData) => Promise<void>;
};

/**
 * Picks the gateway environment every page reads from and writes to. Submits
 * on change; the button is there for keyboard and no-JS users.
 */
export function EnvironmentSwitcher({ environments, current, action }: Props) {
  return (
    <form action={action} className="flex items-center gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
        <span className="shrink-0 uppercase tracking-wide">Env</span>
        <select
          name="environment"
          defaultValue={current}
          key={current}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          aria-label="Gateway environment"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
        >
          {environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.label}
              {environment.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit" className="text-xs underline">
          Switch
        </button>
      </noscript>
    </form>
  );
}
