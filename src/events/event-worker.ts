import { BackendApp, EventRecord, StepResult } from '../types';
import { EventStore } from './event-store';
import { EventPublisher, resolvePublisher } from './publishers';
import { contextFromSnapshot, buildEventPayload } from './payload-builder';
import { evaluateCondition, runPollCall } from '../orchestrator';

/**
 * Worker seam. The PoC uses an interval-driven in-process loop; this interface lets an
 * external queue consumer (e.g. SQS) replace it later without changing the lifecycle logic.
 */
export interface EventWorker {
  start(): void;
  stop(): void;
}

/** Dependencies injected into the worker (enables isolated unit testing). */
export interface EventWorkerDeps {
  store: EventStore;
  /** Provide the current backends map (for readiness poll calls). */
  getBackends: () => Map<string, BackendApp>;
  /** Resolve the event target by id (returns config incl. type). */
  getEventTarget: (id: string) => { id: string; name: string; type: EventRecord['targetType']; config: Record<string, unknown> } | null;
  /** Resolve a publisher for a target type (defaults to the real factory). */
  resolvePublisher?: (type: EventRecord['targetType']) => EventPublisher;
  /** Run a single poll backend call (defaults to the orchestrator's runPollCall). */
  runPoll?: typeof runPollCall;
  /** Clock (ms). Injectable for tests. Defaults to Date.now. */
  now?: () => number;
  /** Tick interval in ms (default 1000). */
  intervalMs?: number;
}

/**
 * Advance a single event one step through its lifecycle. Exposed for unit testing so each
 * transition can be exercised with a mock store/publisher and an injected clock.
 * Returns the (possibly updated) record.
 */
export async function processEvent(event: EventRecord, deps: EventWorkerDeps): Promise<EventRecord> {
  const now = deps.now || Date.now;
  const resolve = deps.resolvePublisher || resolvePublisher;
  const runPoll = deps.runPoll || runPollCall;

  switch (event.status) {
    case 'PENDING_READINESS':
      return advanceReadiness(event, deps, now, runPoll);
    case 'READY':
    case 'PUBLISHING':
      return deliver(event, deps, now, resolve);
    default:
      return event; // terminal / not worker-driven
  }
}

/** Readiness polling + timeout (Req 4, Req 6). */
async function advanceReadiness(
  event: EventRecord,
  deps: EventWorkerDeps,
  now: () => number,
  runPoll: typeof runPollCall
): Promise<EventRecord> {
  const cfg = event.eventConfig.readiness;
  const readiness = event.readiness;
  // No readiness config → should already be READY, but be defensive.
  if (!cfg || !readiness) {
    return deps.store.update(event.id, { status: 'READY', readyAt: new Date().toISOString() }) || event;
  }

  const startedMs = new Date(readiness.startedAt).getTime();
  const elapsedSec = (now() - startedMs) / 1000;

  // Readiness timeout (Req 6.1, 6.2, 6.3)
  if (elapsedSec > cfg.timeoutSeconds) {
    const timeoutStatus = (cfg.onTimeoutStatus as EventRecord['status']) || 'TIMED_OUT';
    return deps.store.update(event.id, {
      status: timeoutStatus,
      lastError: `Readiness timed out after ${cfg.timeoutSeconds}s`,
    }) || event;
  }

  // Respect the poll interval — skip if not yet due.
  if (readiness.lastPollAt) {
    const sinceLastPoll = (now() - new Date(readiness.lastPollAt).getTime()) / 1000;
    if (sinceLastPoll < cfg.intervalSeconds) {
      return event;
    }
  }

  // Run the poll call, merge its result into stepResults under the poll stepId (Req 4.2).
  const ctxBefore = contextFromSnapshot(event.contextSnapshot);
  let pollResult: StepResult;
  try {
    pollResult = await runPoll(cfg.poll, deps.getBackends(), ctxBefore);
  } catch (err) {
    // Treat a failed poll as "not ready yet" and record the attempt.
    const nowIso = new Date().toISOString();
    return deps.store.update(event.id, {
      readiness: {
        ...readiness,
        pollCount: readiness.pollCount + 1,
        lastPollAt: nowIso,
        pollHistory: [
          ...readiness.pollHistory,
          { at: nowIso, statusCode: 0, passed: false },
        ].slice(-50),
      },
    }) || event;
  }

  // Persist the poll result into the snapshot so later polls/payload can reference it.
  const mergedStepResults = { ...event.contextSnapshot.stepResults, [cfg.poll.stepId]: pollResult };
  const ctxAfter = contextFromSnapshot({ ...event.contextSnapshot, stepResults: mergedStepResults });

  // Evaluate all readiness conditions (AND) (Req 4.4, 4.5).
  const passed = cfg.until.every((cond) => evaluateCondition(cond, ctxAfter));
  const nowIso = new Date().toISOString();
  const updatedReadiness = {
    ...readiness,
    pollCount: readiness.pollCount + 1,
    lastPollAt: nowIso,
    pollHistory: [
      ...readiness.pollHistory,
      { at: nowIso, statusCode: pollResult.statusCode, passed },
    ].slice(-50),
  };

  if (passed) {
    // Build payload from the merged context and mark READY (Req 4.4).
    const payload = buildEventPayload(event.eventConfig.payload, ctxAfter);
    return deps.store.update(event.id, {
      status: 'READY',
      readyAt: nowIso,
      contextSnapshot: { ...event.contextSnapshot, stepResults: mergedStepResults },
      readiness: updatedReadiness,
      payload,
    }) || event;
  }

  return deps.store.update(event.id, {
    contextSnapshot: { ...event.contextSnapshot, stepResults: mergedStepResults },
    readiness: updatedReadiness,
  }) || event;
}

/** Delivery + delivery timeout (Req 8, Req 10). */
async function deliver(
  event: EventRecord,
  deps: EventWorkerDeps,
  now: () => number,
  resolve: (type: EventRecord['targetType']) => EventPublisher
): Promise<EventRecord> {
  // Delivery timeout (Req 8.1): if READY too long without delivery, fail it.
  const deliveryTimeout = event.eventConfig.deliveryTimeoutSeconds;
  if (deliveryTimeout && event.readyAt) {
    const readyMs = new Date(event.readyAt).getTime();
    if ((now() - readyMs) / 1000 > deliveryTimeout) {
      return deps.store.update(event.id, {
        status: 'DELIVERY_FAILED',
        lastError: `Not delivered within ${deliveryTimeout}s of becoming ready`,
      }) || event;
    }
  }

  // Ensure payload is built (it normally is when readiness passed; build now if it wasn't).
  let payload = event.payload;
  if (payload === null || payload === undefined) {
    const ctx = contextFromSnapshot(event.contextSnapshot);
    payload = buildEventPayload(event.eventConfig.payload, ctx);
  }

  // Resolve target + publisher.
  const target = deps.getEventTarget(event.targetId);
  if (!target) {
    return deps.store.update(event.id, {
      status: 'DELIVERY_FAILED',
      payload,
      attempts: event.attempts + 1,
      lastError: `Event target "${event.targetId}" not found`,
    }) || event;
  }

  // Mark publishing, then attempt.
  deps.store.update(event.id, { status: 'PUBLISHING', payload });
  const publisher = resolve(target.type);
  const result = await publisher.publish(target, payload);

  if (result.ok) {
    return deps.store.update(event.id, {
      status: 'DELIVERED',
      deliveredAt: new Date().toISOString(),
      attempts: event.attempts + 1,
      lastError: null,
    }) || event;
  }

  return deps.store.update(event.id, {
    status: 'DELIVERY_FAILED',
    attempts: event.attempts + 1,
    lastError: result.error || 'Delivery failed',
  }) || event;
}

/** In-process interval-driven worker. */
export class IntervalEventWorker implements EventWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly deps: EventWorkerDeps;
  private readonly intervalMs: number;

  constructor(deps: EventWorkerDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs || 1000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    console.log(`[events] worker started (tick ${this.intervalMs}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[events] worker stopped');
    }
  }

  /** Process all due events once. Guarded against overlapping runs. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.deps.now || Date.now)();
      const due = this.deps.store.claimDue(now);
      for (const event of due) {
        try {
          await processEvent(event, this.deps);
        } catch (err) {
          console.error(`[events] error processing event ${event.id}:`, err);
          this.deps.store.update(event.id, {
            status: 'DELIVERY_FAILED',
            lastError: err instanceof Error ? err.message : 'Worker error',
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
