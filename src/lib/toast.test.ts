import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayError, GatewayUnreachableError } from './g2/errors';
import { MAX_TOASTS, createToastStore, describeError } from './toast';

describe('createToastStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('notifies subscribers and hands out a fresh snapshot per change', () => {
    const store = createToastStore(1000);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.push({ kind: 'info', title: 'hi' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toEqual([{ id: 1, kind: 'info', title: 'hi' }]);
  });

  it('times out non-error toasts but keeps errors until dismissed', () => {
    const store = createToastStore(1000);
    store.push({ kind: 'success', title: 'saved' });
    const errorId = store.push({ kind: 'error', title: 'failed' });
    vi.advanceTimersByTime(1000);
    expect(store.getSnapshot().map((t) => t.title)).toEqual(['failed']);
    store.dismiss(errorId);
    expect(store.getSnapshot()).toEqual([]);
  });

  it('drops the oldest beyond the cap', () => {
    const store = createToastStore();
    for (let i = 0; i < MAX_TOASTS + 2; i++) store.push({ kind: 'error', title: `t${i}` });
    expect(store.getSnapshot()).toHaveLength(MAX_TOASTS);
    expect(store.getSnapshot()[0].title).toBe('t2');
  });

  it('ignores dismissing an unknown id without notifying', () => {
    const store = createToastStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dismiss(42);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const store = createToastStore();
    const listener = vi.fn();
    store.subscribe(listener)();
    store.push({ kind: 'error', title: 'x' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('describeError', () => {
  it("keeps the gateway's message verbatim", () => {
    expect(describeError(new GatewayError(409, 'api `x` already exists', 'staging'))).toEqual({
      kind: 'error',
      title: 'Gateway returned 409 (staging)',
      description: 'api `x` already exists',
    });
  });

  it('describes an unreachable gateway with its cause', () => {
    const err = new GatewayUnreachableError('prod', new Error('ECONNREFUSED'));
    expect(describeError(err)).toMatchObject({
      title: 'Gateway unreachable',
      description: err.message,
    });
  });

  it('falls back to any error message', () => {
    expect(describeError(new Error('boom')).description).toBe('boom');
    expect(describeError('plain').description).toBe('plain');
  });
});
