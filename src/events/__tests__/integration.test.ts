import { describe, it, expect } from 'vitest';
import * as http from 'http';
import { IntervalEventWorker } from '../event-worker';
import { EventStore } from '../event-store';
import { resolvePublisher } from '../publishers';
import { EventRecord, NewEventRecord, StepResult } from '../../types';

/**
 * End-to-end style integration test wiring together the REAL worker, the REAL webhook
 * publisher (delivering to a live local HTTP server), a readiness poll whose result flips a
 * field, plus the timeout / failure / re-publish paths.
 *
 * Uses an in-memory store (same interface as FileEventStore) so tests stay isolated from
 * data/events.json, and drives the worker via tick() with an injected clock where needed.
 */

function makeStore(seed: EventRecord[] = []): EventStore {
  const records = [...seed];
  let nextId = seed.length + 1;
  return {
    enqueue: (r: NewEventRecord) => {
      const now = new Date().toISOString();
      const rec: EventRecord = {
        ...r,
        id: nextId++,
        attempts: 0,
        payload: null,
        readiness: r.eventConfig.readiness
          ? { startedAt: now, pollCount: 0, lastPollAt: null, pollHistory: [] }
          : undefined,
        createdAt: now,
        readyAt: r.status === 'READY' ? now : null,
        deliveredAt: null,
        lastError: null,
        updatedAt: now,
      };
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

const snapshot = {
  inboundRequest: { method: 'POST', path: '/api/orders', headers: {}, query: {}, params: { id: '42' }, body: null },
  stepResults: { 'step-1': { statusCode: 200, headers: {}, body: { id: 'ORD-42' }, duration: 3 } },
};

/** A webhook target pointing at a live stub server. */
function target(url: string) {
  return { id: 'wh-1', name: 'Test Webhook', type: 'webhook' as const, config: { url } };
}

/** A local webhook stub. Each test owns its own instance for isolation. */
interface WebhookStub {
  url: string;
  deliveries: unknown[];
  close: () => Promise<void>;
}

function startWebhook(statusCode = 200): Promise<WebhookStub> {
  return new Promise((resolve) => {
    const deliveries: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        deliveries.push(JSON.parse(body || '{}'));
        res.statusCode = statusCode;
        res.end();
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        deliveries,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('event publishing — end to end', () => {

  it('readiness polls until a field flips, then delivers the built payload to the webhook', async () => {
    const stub = await startWebhook(200);
    const store = makeStore();

    // A poll that returns PENDING the first time, COMPLETE the second time.
    let pollCall = 0;
    const runPoll = async (): Promise<StepResult> => {
      pollCall++;
      return { statusCode: 200, headers: {}, body: { status: pollCall >= 2 ? 'COMPLETE' : 'PENDING' }, duration: 1 };
    };

    const ev = store.enqueue({
      executionLogId: 1,
      routeId: 'r1',
      routeName: 'Create Order',
      targetId: 'wh-1',
      targetType: 'webhook',
      status: 'PENDING_READINESS',
      contextSnapshot: snapshot,
      eventConfig: {
        enabled: true,
        targetId: 'wh-1',
        payload: { orderId: '$steps.step-1.body.id', status: '$steps.poll.body.status' },
        readiness: {
          poll: { stepId: 'poll', backendId: 'b1', method: 'GET', path: '/status' },
          until: [{ expression: '$steps.poll.body.status', operator: 'eq', value: 'COMPLETE' }],
          intervalSeconds: 0, // no wait between polls for the test
          timeoutSeconds: 60,
        },
      },
    });

    const worker = new IntervalEventWorker({
      store,
      getBackends: () => new Map(),
      getEventTarget: () => target(stub.url),
      resolvePublisher, // real factory → real WebhookPublisher
      runPoll,
      intervalMs: 10,
    });

    // Tick 1: poll returns PENDING → stays pending.
    await worker.tick();
    expect(store.get(ev.id)!.status).toBe('PENDING_READINESS');
    expect(stub.deliveries).toHaveLength(0);

    // Tick 2: poll returns COMPLETE → READY (payload built).
    await worker.tick();
    let cur = store.get(ev.id)!;
    expect(cur.status).toBe('READY');
    expect(cur.payload).toEqual({ orderId: 'ORD-42', status: 'COMPLETE' });

    // Tick 3: READY → delivered to the webhook.
    await worker.tick();
    cur = store.get(ev.id)!;
    expect(cur.status).toBe('DELIVERED');
    expect(cur.deliveredAt).toBeTruthy();
    expect(stub.deliveries).toEqual([{ orderId: 'ORD-42', status: 'COMPLETE' }]);
    await stub.close();
  });

  it('an event with no readiness delivers immediately', async () => {
    const stub = await startWebhook(200);
    const store = makeStore();
    const ev = store.enqueue({
      executionLogId: 2,
      routeId: 'r2',
      routeName: 'Simple',
      targetId: 'wh-1',
      targetType: 'webhook',
      status: 'READY',
      contextSnapshot: snapshot,
      eventConfig: { enabled: true, targetId: 'wh-1', payload: { orderId: '$steps.step-1.body.id' } },
    });
    const worker = new IntervalEventWorker({
      store, getBackends: () => new Map(), getEventTarget: () => target(stub.url), resolvePublisher, intervalMs: 10,
    });
    await worker.tick();
    expect(store.get(ev.id)!.status).toBe('DELIVERED');
    expect(stub.deliveries).toEqual([{ orderId: 'ORD-42' }]);
    await stub.close();
  });

  it('a failing webhook marks DELIVERY_FAILED, and re-publish (after fixing) delivers', async () => {
    // Start with a server that returns 500.
    const badStub = await startWebhook(500);
    const store = makeStore();
    const ev = store.enqueue({
      executionLogId: 3,
      routeId: 'r3',
      routeName: 'Fails',
      targetId: 'wh-1',
      targetType: 'webhook',
      status: 'READY',
      contextSnapshot: snapshot,
      eventConfig: { enabled: true, targetId: 'wh-1', payload: { orderId: '$steps.step-1.body.id' } },
    });
    const worker = new IntervalEventWorker({
      store, getBackends: () => new Map(), getEventTarget: () => target(badStub.url), resolvePublisher, intervalMs: 10,
    });

    await worker.tick();
    expect(store.get(ev.id)!.status).toBe('DELIVERY_FAILED');
    expect(store.get(ev.id)!.lastError).toContain('500');
    await badStub.close();

    // Fix the endpoint: swap to a 200 server, simulate operator re-publish.
    const goodStub = await startWebhook(200);
    store.update(ev.id, { status: 'READY', readyAt: new Date().toISOString(), lastError: null });

    const worker2 = new IntervalEventWorker({
      store, getBackends: () => new Map(), getEventTarget: () => target(goodStub.url), resolvePublisher, intervalMs: 10,
    });
    await worker2.tick();
    expect(store.get(ev.id)!.status).toBe('DELIVERED');
    expect(goodStub.deliveries).toEqual([{ orderId: 'ORD-42' }]);
    await goodStub.close();
  });

  it('readiness times out, then a restart resumes polling to delivery', async () => {
    const stub = await startWebhook(200);
    const store = makeStore();

    const ev = store.enqueue({
      executionLogId: 4,
      routeId: 'r4',
      routeName: 'Times Out',
      targetId: 'wh-1',
      targetType: 'webhook',
      status: 'PENDING_READINESS',
      contextSnapshot: snapshot,
      eventConfig: {
        enabled: true,
        targetId: 'wh-1',
        payload: { orderId: '$steps.step-1.body.id' },
        readiness: {
          poll: { stepId: 'poll', backendId: 'b1', method: 'GET', path: '/status' },
          until: [{ expression: '$steps.poll.body.status', operator: 'eq', value: 'COMPLETE' }],
          intervalSeconds: 0,
          timeoutSeconds: 30,
        },
      },
    });
    // Backdate readiness start so the next tick sees it as timed out.
    store.update(ev.id, { readiness: { startedAt: new Date(Date.now() - 60_000).toISOString(), pollCount: 5, lastPollAt: null, pollHistory: [] } });

    const runPollPending = async (): Promise<StepResult> => ({ statusCode: 200, headers: {}, body: { status: 'PENDING' }, duration: 1 });
    const worker = new IntervalEventWorker({
      store, getBackends: () => new Map(), getEventTarget: () => target(stub.url), resolvePublisher, runPoll: runPollPending, intervalMs: 10,
    });

    await worker.tick();
    expect(store.get(ev.id)!.status).toBe('TIMED_OUT');
    expect(stub.deliveries).toHaveLength(0);

    // Operator restarts: reset to PENDING_READINESS with fresh readiness window,
    // and this time the poll satisfies the condition.
    store.update(ev.id, {
      status: 'PENDING_READINESS',
      lastError: null,
      readiness: { startedAt: new Date().toISOString(), pollCount: 0, lastPollAt: null, pollHistory: [] },
    });
    const runPollComplete = async (): Promise<StepResult> => ({ statusCode: 200, headers: {}, body: { status: 'COMPLETE' }, duration: 1 });
    const worker2 = new IntervalEventWorker({
      store, getBackends: () => new Map(), getEventTarget: () => target(stub.url), resolvePublisher, runPoll: runPollComplete, intervalMs: 10,
    });
    await worker2.tick(); // → READY
    expect(store.get(ev.id)!.status).toBe('READY');
    await worker2.tick(); // → DELIVERED
    expect(store.get(ev.id)!.status).toBe('DELIVERED');
    expect(stub.deliveries).toEqual([{ orderId: 'ORD-42' }]);
    await stub.close();
  });
});
