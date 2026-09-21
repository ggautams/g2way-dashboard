/** The signed-out pages (`/login`, `/setup`): no shell, no gateway probes. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded bg-accent text-xs text-accent-foreground">
            g2
          </span>
          g2way
        </div>
        <div className="rounded-lg border border-border bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}
