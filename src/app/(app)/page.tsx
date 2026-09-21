import { connection } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import {
  RegistryConfigError,
  listEnvironments,
  type PublicEnvironment,
} from '@/lib/g2/environments';

export default async function OverviewPage() {
  // The registry reads the runtime environment, never the build's.
  await connection();
  await requireUser();

  let environments: PublicEnvironment[] = [];
  let problems: readonly string[] = [];
  try {
    environments = listEnvironments();
  } catch (error) {
    if (!(error instanceof RegistryConfigError)) throw error;
    problems = error.problems;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted">Gateways this dashboard is configured to manage.</p>
      </header>

      {problems.length > 0 && (
        <section
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm"
        >
          <p className="font-medium text-danger">Gateway configuration is invalid</p>
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <p className="mt-2 text-muted">
            See <code>.env.example</code> for every variable.
          </p>
        </section>
      )}

      {environments.length > 0 && (
        <section aria-label="Environments" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {environments.map((environment) => (
            <article
              key={environment.id}
              className="rounded-lg border border-border bg-surface p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-medium">{environment.label}</h2>
                {environment.isDefault && (
                  <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">
                    default
                  </span>
                )}
              </div>
              <p className="mt-1 font-mono text-xs text-muted">{environment.id}</p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
