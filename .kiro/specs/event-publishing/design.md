# Event Publishing on Orchestration Completion — Design

## Overview

This design adds an asynchronous event pipeline to the orchestrator. When an event-enabled route
finishes, the proxy handler enqueues an **event record** (after the API response is sent). A single
in-process **worker loop** advances each event through a status lifecycle: optional readiness
polling, then delivery via a pluggable **publisher adapter** to a configured **event target**.
Event state is persisted in a separate log file and surfaced through admin endpoints and a
dashboard tab, with operator actions to restart timed-out events and re-publish failed ones.

All new moving parts (event store, worker, publishers) sit behind interfaces so the file-based
PoC can later be swapped for DynamoDB + SQS without touching the orchestration engine.

### Design principles

- **Reuse the existing engine.** Payload building uses `buildResponse`/`applyMapping`. Readiness
  poll calls use `executeBackendCall`. Conditions reuse the existing `evaluateCondition` operators.
- **Never block the request.** Event work happens strictly after `res.send`, on the worker loop.
- **Swappable storage & delivery.** `EventStore`, `EventQueueWorker`, and `EventPublisher`
  interfaces isolate the PoC implementations.
- **Fail visibly, not fatally.** Unimplemented brokers and delivery errors produce a recorded
  failure status, never a crash.

## Architecture

```
                Inbound request
                       │
                       ▼
        ┌──────────────────────────────┐
        │  proxy.ts  (request handler)  │
        │  1. executeOrchestration      │
        │  2. res.send(response)   ◄──── API response issued (Req 2)
        │  3. if route.event.enabled:   │
        │       eventStore.enqueue(...)  (snapshot context)
        └──────────────┬───────────────┘
                       │ (async, decoupled)
                       ▼
        ┌──────────────────────────────┐
        │  EventWorker (setInterval)    │
        │  tick():                      │
        │   • PENDING_READINESS → poll  │  ── executeBackendCall + evaluateCondition (Req 4)
        │   • READY → publish           │  ── EventPublisher.publish (Req 10)
        │   • enforce timeouts          │  ── readiness + delivery (Req 6, 8)
        └──────────────┬───────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  EventPublisher adapters      │
        │  webhook | sns | sqs |         │
        │  eventbridge | (placeholders)  │
        └──────────────────────────────┘

  Persistence:  data/events.json  (via EventStore)   ← separate from logs.json (Req 5)
```

## Event lifecycle (state machine)

```
                      no readiness config
   (enqueue) ─────────────────────────────────► READY
        │                                          │
        │ has readiness config                     │ publish attempt
        ▼                                          ▼
  PENDING_READINESS ──conditions pass──► READY ──► PUBLISHING ──ok──► DELIVERED
        │                                          │
        │ elapsed > timeoutSeconds                 │ error OR not delivered
        ▼                                          │ within deliveryTimeoutSeconds
     TIMED_OUT                                     ▼
        │                                     DELIVERY_FAILED
        │ operator restart (Req 7)                 │
        └──────────► PENDING_READINESS             │ operator re-publish (Req 9)
                                                   └──────────► READY
   DELIVERED ── operator re-publish (Req 9) ──────────────────► READY
```

Statuses: `PENDING_READINESS`, `READY`, `PUBLISHING`, `DELIVERED`, `TIMED_OUT`, `DELIVERY_FAILED`.
Terminal-until-action states are `DELIVERED`, `TIMED_OUT`, `DELIVERY_FAILED` (each with an operator
action to re-enter the pipeline). `PENDING_READINESS`, `READY`, and `PUBLISHING` are worker-driven.

## Configuration schema

### Route event block (added to `RouteConfig`)

```ts
interface RouteEventConfig {
  enabled: boolean;
  /** Target connection to publish to (references an EventTarget by id) */
  targetId: string;
  /** Payload built with the response-mapping engine (supports $steps.*, $source/$pick, etc.) */
  payload: Record<string, unknown>;
  /** Optional readiness polling before publish */
  readiness?: {
    /** A backend call re-executed each interval; its result merges into $steps.<stepId> (Req 4.2) */
    poll: BackendCall;
    /** Conditions that must ALL be true to become READY (Req 4.5) */
    until: Condition[];
    /** Seconds between poll attempts */
    intervalSeconds: number;
    /** Max total polling time before moving to timeout status (Req 6) */
    timeoutSeconds: number;
    /** Status to set on readiness timeout (default "TIMED_OUT") (Req 6.3) */
    onTimeoutStatus?: string;
  };
  /** Seconds after becoming READY within which delivery must succeed, else DELIVERY_FAILED (Req 8) */
  deliveryTimeoutSeconds?: number;
}
```

Notes:
- `until` uses the existing `Condition` type. Requirement 4.3's cases are all expressible as a
  JSONPath `expression` + `operator`:
  - HTTP status = xx → `{ expression: "$steps.poll.statusCode", operator: "eq", value: 200 }`
  - field exists → `{ expression: "$steps.poll.body.field", operator: "exists" }`
  - object/array exists → same, pointing at the object/array path
  - field in object = xxx → `{ expression: "$steps.poll.body.obj.field", operator: "eq", value: "x" }`
- The poll call's `stepId` determines where its result lands in `$steps` (Req 4.2), so `until`
  conditions and the payload can reference the freshest poll data.

### Event target (new `eventTargets` array in `store.json`)

```ts
type EventTargetType =
  | 'webhook' | 'sns' | 'sqs' | 'eventbridge'          // functional in PoC
  | 'kafka' | 'rabbitmq' | 'azure-servicebus' | 'gcp-pubsub'; // placeholders

interface EventTarget {
  id: string;
  name: string;
  type: EventTargetType;
  config: Record<string, unknown>; // type-specific (url/topicArn/queueUrl/eventBusName/region/etc.)
}
```

Managed via admin CRUD like backends/databases (Req 10.1).

## Data model — persisted event record

Stored in `data/events.json` via `EventStore`. Kept separate from `logs.json` so the API
execution log is unaffected by event state (Req 5.1).

```ts
interface EventRecord {
  id: number;
  executionLogId: number | null; // link to originating execution log entry (Req 5.3)
  routeId: string;
  routeName: string;
  targetId: string;
  targetType: EventTargetType;
  status: EventStatus;
  attempts: number;
  /** Snapshot of orchestration context taken at completion (Req 2.3) */
  contextSnapshot: {
    inboundRequest: OrchestrationContext['inboundRequest'];
    stepResults: Record<string, unknown>;
  };
  /** Built lazily/at-ready-time from payload config + snapshot + poll results */
  payload: unknown | null;
  /** Readiness bookkeeping */
  readiness?: {
    startedAt: string;
    pollCount: number;
    lastPollAt: string | null;
    pollHistory: { at: string; statusCode: number; passed: boolean }[];
  };
  createdAt: string;
  readyAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  updatedAt: string;
}
```

## Component interfaces

### EventStore (storage seam → DynamoDB later)

```ts
interface EventStore {
  enqueue(record: NewEventRecord): EventRecord;
  get(id: number): EventRecord | null;
  list(filter?: { status?: EventStatus; routeId?: string; limit?: number }): EventRecord[];
  update(id: number, patch: Partial<EventRecord>): EventRecord | null;
  /** Events the worker should act on now (non-terminal, or due for a poll) */
  claimDue(now: number): EventRecord[];
}
```

PoC implementation: `FileEventStore` backed by `data/events.json`, using the same atomic
temp-file-then-rename write already added to `db.ts`.

### EventWorker (worker seam → SQS consumer later)

```ts
interface EventWorker {
  start(): void;
  stop(): void;
}
```

PoC implementation: `IntervalEventWorker` runs `tick()` on a `setInterval` (default 1s). Each
`tick()`:
1. `claimDue(now)` from the store.
2. For `PENDING_READINESS`: if elapsed > `timeoutSeconds` → set `onTimeoutStatus` (default
   `TIMED_OUT`). Else, if due for next poll, run the poll via `executeBackendCall`, merge its
   result into the snapshot's `stepResults` under the poll `stepId`, evaluate `until` with
   `evaluateCondition`; if all pass → build payload, set `READY`, `readyAt`.
3. For `READY`: set `PUBLISHING`, resolve the target + adapter, call `publish`. On success →
   `DELIVERED`; on error → `DELIVERY_FAILED` with `lastError`. If a `READY`/`PUBLISHING` event has
   exceeded `deliveryTimeoutSeconds` since `readyAt` → `DELIVERY_FAILED` (Req 8).

The worker resumes naturally on restart because it reads persisted non-terminal events (Req 3.4).

### EventPublisher (delivery seam)

```ts
interface EventPublisher {
  readonly type: EventTargetType;
  publish(target: EventTarget, payload: unknown): Promise<{ ok: boolean; error?: string }>;
}
```

- `WebhookPublisher` — HTTP POST via axios (no new dependency).
- `SnsPublisher`, `SqsPublisher`, `EventBridgePublisher` — AWS SDK v3 clients, **lazily imported**
  inside `publish` so the SDK only loads when used (Req 10.5).
- `NotImplementedPublisher` — used for kafka/rabbitmq/azure-servicebus/gcp-pubsub; returns
  `{ ok: false, error: "Publisher '<type>' is not implemented in this build" }` (Req 10.3).

A `resolvePublisher(type)` factory maps target type → adapter.

## Integration points

### proxy.ts (after response, Req 2)

After the existing `res.status(...).send/json(...)`, add:

```ts
if (matchedRoute.event?.enabled) {
  try {
    eventStore.enqueue({
      executionLogId: loggedEntryId,        // returned from logExecution (small change)
      routeId: matchedRoute.id,
      routeName: matchedRoute.name,
      targetId: matchedRoute.event.targetId,
      status: matchedRoute.event.readiness ? 'PENDING_READINESS' : 'READY',
      contextSnapshot: { inboundRequest: context.inboundRequest, stepResults: context.stepResults },
      // ...timestamps
    });
  } catch (err) {
    console.error('[events] enqueue failed (response already sent):', err);
  }
}
```

`logExecution` gains a return value (the new entry id) so the event can link back (Req 5.3). This
is an additive change — existing callers ignore the return.

### index.ts (worker startup)

In `start()`, after `initDb()`, instantiate `FileEventStore` and `IntervalEventWorker` and call
`worker.start()`. Stop on process signals for clean shutdown.

### db.ts

Add an `events.json` load/persist pair mirroring the existing `logs.json` handling (atomic writes,
resilient load). Expose it via the `FileEventStore`.

### Transformer / orchestrator reuse

- Export `evaluateCondition` from the orchestrator (currently private) so the worker can reuse the
  exact operator semantics. No behavioural change.
- Payload building calls `buildResponse(payload, contextFromSnapshot)` where a lightweight
  `OrchestrationContext` is reconstructed from the snapshot (plus merged poll results).

## Admin API & dashboard

### Endpoints (admin router)

- `GET /admin/events` — list with optional `status`/`routeId`/`limit` filters (Req 5.4)
- `GET /admin/events/:id` — full record incl. poll history (Req 5.4)
- `POST /admin/events/:id/restart` — timed-out → pending-readiness (Req 7)
- `POST /admin/events/:id/republish` — failed/delivered → ready (Req 9)
- `GET/POST/PUT/DELETE /admin/event-targets` — target CRUD (Req 10.1)

### Dashboard

- New **Events** tab: table of events (time, route, target, status badge, attempts, last error) with
  View / Restart / Re-publish actions — mirroring the existing Logs/Audit tabs.
- **Event Targets** management under a new section (like Backends/Databases).
- Route editor: the `event` block is edited as JSON within the existing route modal (no bespoke
  form needed for the PoC).

## Error handling

- Enqueue failures are caught and logged; never affect the sent response (Req 2.2).
- Poll call failures are recorded in `pollHistory` and treated as "conditions not yet met" (polling
  continues until timeout).
- Publish failures set `DELIVERY_FAILED` with `lastError`; the record remains for re-publish.
- Unknown/unimplemented target types resolve to `NotImplementedPublisher` (no crash).
- Corrupt `events.json` on load follows the same safe pattern as `store.json`: back up and start
  with an empty event list rather than overwriting.

## Testing strategy

- **Unit**: `evaluateCondition` cases for each Req 4.3 operator; state-machine transitions in
  `tick()` (mock store + clock); `resolvePublisher` mapping; `WebhookPublisher` against a local
  stub server.
- **Integration**: an event-enabled route end-to-end with a mock backend — response returns first,
  then readiness polls flip a field, then a webhook target receives the payload; timeout and
  re-publish paths.
- **Manual/PoC**: dashboard Events tab shows lifecycle; restart and re-publish actions work.

## Deferred (production notes, out of scope for PoC)

- Replace `FileEventStore` with a DynamoDB-backed store; replace `IntervalEventWorker` with an SQS
  consumer (visibility timeout handles claiming/retries).
- Concurrency: the file store is single-process; DynamoDB + conditional writes / SQS would provide
  safe multi-instance claiming.
- Real Kafka/RabbitMQ/Azure Service Bus/GCP Pub/Sub adapters behind the existing interface.
