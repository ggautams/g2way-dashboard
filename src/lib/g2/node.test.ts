import { describe, expect, it } from 'vitest';
import {
  PayloadShapeError,
  parseHealthInfo,
  parseNodeInfo,
  parseVersionInfo,
  targetsWithHealth,
} from './node';
import { nodeBody } from './node.fixture';

describe('parseNodeInfo', () => {
  it('accepts the gateway payload unchanged', () => {
    expect(parseNodeInfo(nodeBody())).toEqual(nodeBody());
  });

  it('accepts a bare process with no node id', () => {
    const body = { ...nodeBody(), node_id: null, apis: [], routes: 0 };
    expect(parseNodeInfo(body).node_id).toBeNull();
  });

  it('names the endpoint and the exact field that moved', () => {
    const body = nodeBody();
    (body.apis[1] as Record<string, unknown>).circuit_breaker = 'tripped';
    expect(() => parseNodeInfo(body)).toThrow(
      new PayloadShapeError(
        'GET /g2/node',
        'apis[1].circuit_breaker',
        'one of closed/open/half_open',
        'tripped',
      ),
    );
    expect(() => parseNodeInfo({ ...nodeBody(), uptime_secs: '12' })).toThrow(
      'GET /g2/node: expected uptime_secs to be a non-negative integer, got "12"',
    );
    expect(() => parseNodeInfo({ ...nodeBody(), apis: {} })).toThrow(
      'expected apis to be an array, got object',
    );
    expect(() => parseNodeInfo([])).toThrow('expected body to be an object, got an array');
  });

  it('rejects a health flag that is not a boolean', () => {
    const body = nodeBody();
    (body.apis[0].target_health as unknown[])[1] = 'down';
    expect(() => parseNodeInfo(body)).toThrow('apis[0].target_health[1] to be a boolean');
  });
});

describe('parseVersionInfo / parseHealthInfo', () => {
  it('reads the documented bodies', () => {
    expect(parseVersionInfo({ version: '0.9.0' })).toEqual({ version: '0.9.0' });
    expect(parseHealthInfo({ status: 'pass' })).toEqual({ status: 'pass' });
  });

  it('fails with the endpoint named', () => {
    expect(() => parseVersionInfo({})).toThrow('GET /g2/version: expected version to be a string');
    expect(() => parseHealthInfo(null)).toThrow('GET /g2/health: expected body to be an object');
  });
});

describe('targetsWithHealth', () => {
  it('pairs each live target with its flag, null when not probed', () => {
    expect(targetsWithHealth({ live_targets: ['a', 'b'], target_health: [true, false] })).toEqual([
      { address: 'a', healthy: true },
      { address: 'b', healthy: false },
    ]);
    expect(targetsWithHealth({ live_targets: ['a'], target_health: null })).toEqual([
      { address: 'a', healthy: null },
    ]);
  });
});
