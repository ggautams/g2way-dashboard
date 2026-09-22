import { describe, expect, it } from 'vitest';
import { createTargetFromBody } from './audit-trail';

describe('createTargetFromBody', () => {
  it('reads each collection’s own id field from a create body', () => {
    expect(createTargetFromBody('apis', { api_id: 'httpbin', name: 'x' })).toBe('httpbin');
    expect(createTargetFromBody('policies', { policy_id: 'gold', name: 'Gold' })).toBe('gold');
  });

  it('ignores a field another collection uses, and anything but an object with a string id', () => {
    expect(createTargetFromBody('policies', { id: 'gold', name: 'Gold' })).toBeNull();
    expect(createTargetFromBody('apis', { policy_id: 'gold' })).toBeNull();
    expect(createTargetFromBody('keys', { policy_id: 'gold' })).toBeNull();
    expect(createTargetFromBody('policies', { policy_id: 7 })).toBeNull();
    expect(createTargetFromBody('policies', [{ policy_id: 'gold' }])).toBeNull();
    expect(createTargetFromBody(null, { api_id: 'a' })).toBeNull();
  });
});
