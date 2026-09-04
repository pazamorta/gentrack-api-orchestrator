import { describe, it, expect } from 'vitest';
import { contextFromSnapshot, buildEventPayload } from '../payload-builder';
import { resolveValue, resolvePath } from '../../transformer';
import { EventContextSnapshot } from '../../types';

/**
 * Tests for event fan-out ($item exposure). When a route event has a `forEach`, one event is
 * enqueued per array item with that item stored in the snapshot. These tests verify that the
 * reconstructed context exposes the item as $item for the poll path, conditions, and payload.
 */

const baseSnapshot: EventContextSnapshot = {
  inboundRequest: { method: 'PUT', path: '/api/x/OFR-1', headers: {}, query: {}, params: { productOfferId: 'OFR-1' }, body: null },
  stepResults: {
    'step-2': {
      statusCode: 200,
      headers: {},
      body: [
        { forecastRequestId: 'F-AAA', identifier: 'Standing Charge' },
        { forecastRequestId: 'F-BBB', identifier: 'Consumption Charge' },
      ],
      duration: 5,
    },
  },
};

describe('event fan-out — $item exposure', () => {
  it('resolves the forEach array from the completed context', () => {
    const ctx = contextFromSnapshot(baseSnapshot);
    const items = resolveValue('$steps.step-2.body', ctx);
    expect(Array.isArray(items)).toBe(true);
    expect((items as unknown[]).length).toBe(2);
  });

  it('per-item snapshot exposes $item in the poll path', () => {
    const item = { forecastRequestId: 'F-BBB', identifier: 'Consumption Charge' };
    const ctx = contextFromSnapshot({ ...baseSnapshot, currentItem: item });
    const path = resolvePath('/forecast/forecastRequests/{{$item.forecastRequestId}}', ctx);
    expect(path).toBe('/forecast/forecastRequests/F-BBB');
  });

  it('per-item snapshot exposes $item and merged poll result in the payload', () => {
    const item = { forecastRequestId: 'F-AAA', identifier: 'Standing Charge' };
    const ctx = contextFromSnapshot(
      { ...baseSnapshot, currentItem: item },
      { 'forecast-status': { statusCode: 200, headers: {}, body: { status: 'COMPLETED', total: 42 }, duration: 1 } }
    );
    const payload = buildEventPayload(
      {
        productOfferId: '$.inboundRequest.params.productOfferId',
        forecastRequestId: '$item.forecastRequestId',
        status: '$steps.forecast-status.body.status',
      },
      ctx
    );
    expect(payload).toEqual({
      productOfferId: 'OFR-1',
      forecastRequestId: 'F-AAA',
      status: 'COMPLETED',
    });
  });
});
