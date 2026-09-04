import { describe, it, expect, vi } from 'vitest';
import { processEvent, EventWorkerDeps } from '../event-worker';
import { EventStore } from '../event-store';
import { EventPublisher } from '../publishers';
import { EventRecord, NewEventRecord, StepResult } from '../../types';

/** In-memory store for tests. */
function makeStore(seed: EventRecord[] = []): EventStore & { records: EventRecord[] } {
  const records = [...seed];
  return {
    records,
    enqueue: (r: NewEventRecord) => {
      const rec = { ...r, id: records.length + 1 } as EventRecord;
      records.push(rec);
      return rec;
    },
    get: (id) => records.find((e) => e.id === id) || null,
    list: () => [...records],
    update: (id, patch) => {
      const i = records.findIndex((e) => e.id === id);
      if (i < 0) return null;
      records[i] = { ...records[i], ...patch, id } as EventRecord;
      return records[i];
    },
    claimDue: () => records.filter((e) => ['PENDING_READINESS', 'READY', 'PUBLISHING'].includes(e.status)),
  };
}

function baseEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 1,
    executionLogId: 10,
    routeId: 'r1',
    routeName: 'Route 1',
    targetId: 'tgt-1',
    targetType: 'webhook',
    status: 'READY',
    contextSnapshot: {
      inboundRequest: { method: 'GET', path: '/x', headers: {}, query: {}, params: {}, body: null },
      stepResults: { 'step-1': { statusCode: 200, headers: {}, body: { id: 'A1' }, duration: 1 } },
    },
    eventConfig: {
      enabled: true,
      targetId: 'tgt-1',
      payload: { id: '$steps.step-1.body.id' },
    },
    attempts: 0,
    payload: null,
    createdAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    deliveredAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const okPublisher: EventPublisher = { type: 'webhook', publish: vi.fn(async () => ({ ok: true })) };
const failPublisher: EventPublisher = { type: 'webhook', publish: vi.fn(async () => ({ ok: false, error: 'boom' })) };

const target = { id: 'tgt-1', name: 'wh', type: 'webhook' as const, config: { url: 'http://x' } };

function baseDeps(store: EventStore, publisher: EventPublisher, extra: Partial<EventWorkerDeps> = {}): EventWorkerDeps {
  return {
    store,
    getBackends: () => new Map(),
    getEventTarget: () => target,
    resolvePublisher: () => publisher,
    now: () => Date.now(),
    ...extra,
  };
}

describe('event worker — delivery (Req 10.2)', () => {
  it('READY → DELIVERED on successful publish, builds payload', async () => {
    const ev = baseEvent({ status: 'READY' });
    const store = makeStore([ev]);
    const deps = baseDeps(store, okPublisher);
    const result = await processEvent(ev, deps);
    expect(result.status).toBe('DELIVERED');
    expect(result.deliveredAt).toBeTruthy();
    expect(result.attempts).toBe(1);
    expect(okPublisher.publish).toHaveBeenCalledWith(target, { id: 'A1' });
  });

  it('READY → DELIVERY_FAILED on publish error (Req 8.2)', async () => {
    const ev = baseEvent({ status: 'READY' });
    const store = makeStore([ev]);
    const result = await processEvent(ev, baseDeps(store, failPublisher));
    expect(result.status).toBe('DELIVERY_FAILED');
    expect(result.lastError).toBe('boom');
    expect(result.attempts).toBe(1);
  });

  it('READY → DELIVERY_FAILED when target missing', async () => {
    const ev = baseEvent({ status: 'READY' });
    const store = makeStore([ev]);
    const deps = baseDeps(store, okPublisher, { getEventTarget: () => null });
    const result = await processEvent(ev, deps);
    expect(result.status).toBe('DELIVERY_FAILED');
    expect(result.lastError).toContain('not found');
  });
});

describe('event worker — delivery timeout (Req 8.1)', () => {
  it('fails an event that has been READY beyond deliveryTimeoutSeconds', async () => {
    const readyAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    const ev = baseEvent({
      status: 'READY',
      readyAt,
      eventConfig: { enabled: true, targetId: 'tgt-1', payload: { id: '$steps.step-1.body.id' }, deliveryTimeoutSeconds: 60 },
    });
    const store = makeStore([ev]);
    const freshPublisher: EventPublisher = { type: 'webhook', publish: vi.fn(async () => ({ ok: true })) };
    const result = await processEvent(ev, baseDeps(store, freshPublisher));
    expect(result.status).toBe('DELIVERY_FAILED');
    expect(result.lastError).toContain('Not delivered within');
    expect(freshPublisher.publish).not.toHaveBeenCalled();
  });
});

describe('event worker — readiness polling (Req 4)', () => {
  const readinessConfig = {
    poll: { stepId: 'poll', backendId: 'b1', method: 'GET' as const, path: '/status' },
    until: [{ expression: '$steps.poll.body.status', operator: 'eq' as const, value: 'COMPLETE' }],
    intervalSeconds: 5,
    timeoutSeconds: 300,
  };

  function readinessEvent(): EventRecord {
    return baseEvent({
      status: 'PENDING_READINESS',
      readyAt: null,
      eventConfig: {
        enabled: true,
        targetId: 'tgt-1',
        payload: { id: '$steps.step-1.body.id', status: '$steps.poll.body.status' },
        readiness: readinessConfig,
      },
      readiness: { startedAt: new Date().toISOString(), pollCount: 0, lastPollAt: null, pollHistory: [] },
    });
  }

  it('stays PENDING when conditions not met', async () => {
    const ev = readinessEvent();
    const store = makeStore([ev]);
    const runPoll = vi.fn(async (): Promise<StepResult> => ({ statusCode: 200, headers: {}, body: { status: 'PENDING' }, duration: 1 }));
    const result = await processEvent(ev, baseDeps(store, okPublisher, { runPoll }));
    expect(result.status).toBe('PENDING_READINESS');
    expect(result.readiness?.pollCount).toBe(1);
    expect(result.readiness?.pollHistory[0].passed).toBe(false);
  });

  it('becomes READY when conditions met, merges poll result and builds payload (Req 4.2, 4.4)', async () => {
    const ev = readinessEvent();
    const store = makeStore([ev]);
    const runPoll = vi.fn(async (): Promise<StepResult> => ({ statusCode: 200, headers: {}, body: { status: 'COMPLETE' }, duration: 1 }));
    const result = await processEvent(ev, baseDeps(store, okPublisher, { runPoll }));
    expect(result.status).toBe('READY');
    expect(result.readyAt).toBeTruthy();
    expect(result.payload).toEqual({ id: 'A1', status: 'COMPLETE' });
    expect(result.contextSnapshot.stepResults.poll).toBeTruthy();
  });

  it('respects the poll interval (skips if not due)', async () => {
    const ev = readinessEvent();
    ev.readiness!.lastPollAt = new Date().toISOString(); // just polled
    const store = makeStore([ev]);
    const runPoll = vi.fn(async (): Promise<StepResult> => ({ statusCode: 200, headers: {}, body: { status: 'COMPLETE' }, duration: 1 }));
    const result = await processEvent(ev, baseDeps(store, okPublisher, { runPoll }));
    expect(runPoll).not.toHaveBeenCalled();
    expect(result.status).toBe('PENDING_READINESS');
  });
});

describe('event worker — readiness timeout (Req 6)', () => {
  it('moves to TIMED_OUT after timeoutSeconds', async () => {
    const ev = baseEvent({
      status: 'PENDING_READINESS',
      readyAt: null,
      eventConfig: {
        enabled: true,
        targetId: 'tgt-1',
        payload: { id: '$steps.step-1.body.id' },
        readiness: {
          poll: { stepId: 'poll', backendId: 'b1', method: 'GET', path: '/s' },
          until: [{ expression: '$steps.poll.body.status', operator: 'eq', value: 'COMPLETE' }],
          intervalSeconds: 5,
          timeoutSeconds: 60,
        },
      },
      readiness: { startedAt: new Date(Date.now() - 120_000).toISOString(), pollCount: 3, lastPollAt: null, pollHistory: [] },
    });
    const store = makeStore([ev]);
    const runPoll = vi.fn();
    const result = await processEvent(ev, baseDeps(store, okPublisher, { runPoll }));
    expect(result.status).toBe('TIMED_OUT');
    expect(runPoll).not.toHaveBeenCalled();
  });

  it('uses a configured onTimeoutStatus', async () => {
    const ev = baseEvent({
      status: 'PENDING_READINESS',
      readyAt: null,
      eventConfig: {
        enabled: true,
        targetId: 'tgt-1',
        payload: {},
        readiness: {
          poll: { stepId: 'poll', backendId: 'b1', method: 'GET', path: '/s' },
          until: [{ expression: '$steps.poll.body.x', operator: 'exists' }],
          intervalSeconds: 5,
          timeoutSeconds: 30,
          onTimeoutStatus: 'DELIVERY_FAILED',
        },
      },
      readiness: { startedAt: new Date(Date.now() - 60_000).toISOString(), pollCount: 1, lastPollAt: null, pollHistory: [] },
    });
    const store = makeStore([ev]);
    const result = await processEvent(ev, baseDeps(store, okPublisher, { runPoll: vi.fn() }));
    expect(result.status).toBe('DELIVERY_FAILED');
  });
});

describe('event worker — immediate ready (no readiness config, Req 4.6)', () => {
  it('a READY event with no readiness delivers straight away', async () => {
    const ev = baseEvent({ status: 'READY' }); // no readiness in eventConfig
    const store = makeStore([ev]);
    const result = await processEvent(ev, baseDeps(store, okPublisher));
    expect(result.status).toBe('DELIVERED');
  });
});
