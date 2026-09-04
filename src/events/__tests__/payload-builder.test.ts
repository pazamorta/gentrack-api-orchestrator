import { describe, it, expect } from 'vitest';
import { contextFromSnapshot, buildEventPayload } from '../payload-builder';
import { EventContextSnapshot } from '../../types';

const snapshot: EventContextSnapshot = {
  inboundRequest: {
    method: 'PUT',
    path: '/api/v1/orders/42',
    headers: {},
    query: { region: 'UK' },
    params: { id: '42' },
    body: { note: 'hello' },
  },
  stepResults: {
    'step-1': { statusCode: 200, headers: {}, body: { id: 'ORD-42', total: 100 }, duration: 5 },
  },
};

describe('buildEventPayload from a snapshot (Req 1.3, 2.3)', () => {
  it('resolves $steps.* and $.inboundRequest.* from the snapshot', () => {
    const ctx = contextFromSnapshot(snapshot);
    const payload = buildEventPayload(
      {
        orderId: '$steps.step-1.body.id',
        total: '$steps.step-1.body.total',
        requestedId: '$.inboundRequest.params.id',
        region: '$.inboundRequest.query.region',
        source: 'orchestrator',
      },
      ctx
    );
    expect(payload).toEqual({
      orderId: 'ORD-42',
      total: 100,
      requestedId: '42',
      region: 'UK',
      source: 'orchestrator',
    });
  });

  it('exposes merged poll results under $steps (Req 4.2)', () => {
    const ctx = contextFromSnapshot(snapshot, {
      poll: { statusCode: 200, headers: {}, body: { status: 'COMPLETE' }, duration: 2 },
    });
    const payload = buildEventPayload(
      { status: '$steps.poll.body.status', orderId: '$steps.step-1.body.id' },
      ctx
    );
    expect(payload).toEqual({ status: 'COMPLETE', orderId: 'ORD-42' });
  });

  it('omits unresolved fields (Req 1.4)', () => {
    const ctx = contextFromSnapshot(snapshot);
    const payload = buildEventPayload({ missing: '$steps.step-1.body.doesNotExist' }, ctx) as Record<string, unknown>;
    // Unresolved expression yields undefined, which JSON serialisation drops
    expect(payload.missing).toBeUndefined();
  });
});
