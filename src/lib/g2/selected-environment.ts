import 'server-only';

import { cookies } from 'next/headers';
import { getRegistry, type Registry } from './environments';

/**
 * Which gateway environment the signed-in user is working in. It is a view
 * preference, not a secret: the cookie holds only a public environment id
 * (`PublicEnvironment.id`), and every page and BFF call still resolves it
 * against the server-side registry, which alone holds URLs and secrets.
 */

export const ENVIRONMENT_COOKIE = 'g2-environment';

/**
 * The environment to use: an explicit `override` (a `?env=` deep link) as
 * given, so an unknown one still fails loudly where it is resolved; otherwise
 * the remembered choice if it is still configured; otherwise the default. A
 * stale cookie (an environment since removed) falls back quietly.
 */
export function pickEnvironmentId(
  registry: Registry,
  { override, remembered }: { override?: string; remembered?: string },
): string {
  if (override !== undefined) return override;
  if (remembered !== undefined && registry.environments.some(({ id }) => id === remembered)) {
    return remembered;
  }
  return registry.defaultId;
}

/** {@link pickEnvironmentId} for this request, reading the remembered choice from its cookie. */
export async function selectedEnvironmentId(
  override?: string,
  registry: Registry = getRegistry(),
): Promise<string> {
  const remembered = (await cookies()).get(ENVIRONMENT_COOKIE)?.value;
  return pickEnvironmentId(registry, { override, remembered });
}
