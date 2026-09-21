import { GatewayError, GatewayUnreachableError } from './g2/errors';

/**
 * Toast notifications: a tiny external store the `<Toaster>` subscribes to with
 * `useSyncExternalStore`, so any client code can raise a toast without a context
 * provider. Universal and React-free.
 *
 * Errors stay until dismissed — they usually carry the gateway's own message,
 * which the operator needs time to read. Everything else times out.
 */

export type ToastKind = 'success' | 'error' | 'info';

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  /** Detail line. For gateway failures this is the gateway's message verbatim. */
  description?: string;
};

export type ToastInput = Omit<Toast, 'id'>;

/** How long a non-error toast stays up. */
export const TOAST_TIMEOUT_MS = 5000;

/** Oldest toasts are dropped beyond this many. */
export const MAX_TOASTS = 5;

type Listener = () => void;

export type ToastStore = {
  push(input: ToastInput): number;
  dismiss(id: number): void;
  subscribe(listener: Listener): () => void;
  getSnapshot(): readonly Toast[];
};

export function createToastStore(timeoutMs = TOAST_TIMEOUT_MS): ToastStore {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  const listeners = new Set<Listener>();
  const set = (next: readonly Toast[]) => {
    toasts = next;
    listeners.forEach((listener) => listener());
  };

  const store: ToastStore = {
    push(input) {
      const id = nextId++;
      set([...toasts, { ...input, id }].slice(-MAX_TOASTS));
      if (input.kind !== 'error') setTimeout(() => store.dismiss(id), timeoutMs);
      return id;
    },
    dismiss(id) {
      if (toasts.some((t) => t.id === id)) set(toasts.filter((t) => t.id !== id));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => toasts,
  };
  return store;
}

/** Title and description for a failed call, never rewording what the gateway said. */
export function describeError(error: unknown): ToastInput {
  if (error instanceof GatewayError) {
    const where = error.environment ? ` (${error.environment})` : '';
    return {
      kind: 'error',
      title: `Gateway returned ${error.status}${where}`,
      description: error.message,
    };
  }
  if (error instanceof GatewayUnreachableError) {
    return { kind: 'error', title: 'Gateway unreachable', description: error.message };
  }
  return {
    kind: 'error',
    title: 'Something went wrong',
    description: error instanceof Error ? error.message : String(error),
  };
}

/** The app-wide store the `<Toaster>` renders. */
export const toasts = createToastStore();

export const toast = {
  success: (title: string, description?: string) =>
    toasts.push({ kind: 'success', title, description }),
  info: (title: string, description?: string) => toasts.push({ kind: 'info', title, description }),
  error: (error: unknown) => toasts.push(describeError(error)),
  dismiss: (id: number) => toasts.dismiss(id),
};
