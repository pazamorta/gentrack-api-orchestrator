# Event Publishing on Orchestration Completion — Implementation Plan

Each task is incremental, builds on the previous, and ends in a compiling, testable state.
Requirement references map back to `requirements.md`.

- [ ] 1. Add core event types and config schema
  - Add `EventStatus`, `EventTargetType`, `EventTarget`, `RouteEventConfig`, `EventRecord`,
    and `NewEventRecord` to `src/types.ts`.
  - Add optional `event?: RouteEventConfig` to `RouteConfig`.
  - Add `eventTargets?: EventTarget[]` to the store shape.
  - Verify: `tsc --noEmit` passes with no other code changed.
  - _Requirements: 1.1, 1.3, 4.1, 6.1, 8.1, 10.1_

- [ ] 2. Add event + event-target persistence to the store
  - [ ] 2.1 Event target CRUD in `db.ts`
    - Load/persist `eventTargets` within the existing `store.json` (atomic write, resilient load).
    - Add `getAllEventTargets`, `getEventTarget`, `upsertEventTarget`, `deleteEventTarget`.
    - _Requirements: 10.1_
  - [ ] 2.2 File-backed event store (`data/events.json`)
    - Create `src/events/event-store.ts` with the `EventStore` interface and `FileEventStore`.
    - Implement `enqueue`, `get`, `list`, `update`, `claimDue` with atomic temp-file writes and
      safe corrupt-file handling (back up + start empty, matching `store.json` behaviour).
    - Load on startup via an `initEventStore()` mirroring `initDb`.
    - _Requirements: 3.4, 5.1, 5.2, 5.5_

- [ ] 3. Make execution logging linkable
  - Change `logExecution` in `db.ts` to return the new entry's id (additive; existing callers
    ignore it).
  - _Requirements: 5.3_

- [ ] 4. Expose the condition evaluator for reuse
  - Export `evaluateCondition` from `src/orchestrator.ts` (no behaviour change).
  - Add a unit test covering each Requirement 4.3 operator case (status eq, field eq, field
    exists/not-exists, object exists/not-exists, array exists/not-exists, nested field eq,
    nested field exists/not-exists).
  - _Requirements: 4.3_

- [ ] 5. Publisher adapters behind a common interface
  - [ ] 5.1 Interface + factory
    - Create `src/events/publishers/index.ts` with the `EventPublisher` interface and
      `resolvePublisher(type)` factory.
    - _Requirements: 10.4_
  - [ ] 5.2 Webhook publisher (functional)
    - Implement `WebhookPublisher` (HTTP POST via axios). Unit test against a local stub server.
    - _Requirements: 10.2_
  - [ ] 5.3 AWS publishers (functional, lazy-loaded)
    - Implement `SnsPublisher`, `SqsPublisher`, `EventBridgePublisher` using AWS SDK v3, imported
      lazily inside `publish`. Add the SDK deps.
    - _Requirements: 10.2, 10.5_
  - [ ] 5.4 Not-implemented placeholder
    - Implement `NotImplementedPublisher` returning a clear failure for kafka/rabbitmq/
      azure-servicebus/gcp-pubsub; wire into the factory.
    - _Requirements: 10.3_

- [ ] 6. Payload builder from a context snapshot
  - Add a helper that reconstructs a minimal `OrchestrationContext` from an `EventRecord`
    snapshot (plus merged poll results) and calls `buildResponse(payload, ctx)`.
  - Unit test: payload resolves `$steps.*` and `$.inboundRequest.*` from a snapshot.
  - _Requirements: 1.3, 1.4, 2.3_

- [ ] 7. Event worker (lifecycle engine)
  - [ ] 7.1 Worker scaffold
    - Create `src/events/event-worker.ts` with the `EventWorker` interface and
      `IntervalEventWorker` (configurable tick interval, `start`/`stop`).
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 7.2 Readiness polling + condition evaluation
    - On `PENDING_READINESS`: run the poll via `executeBackendCall`, merge result into snapshot
      `stepResults` under the poll `stepId`, evaluate all `until` conditions; all-true → build
      payload, set `READY` + `readyAt`. Record each attempt in `pollHistory`.
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6_
  - [ ] 7.3 Readiness timeout
    - If elapsed since `readiness.startedAt` exceeds `timeoutSeconds`, set `onTimeoutStatus`
      (default `TIMED_OUT`).
    - _Requirements: 6.1, 6.2, 6.3_
  - [ ] 7.4 Delivery
    - On `READY`: set `PUBLISHING`, resolve publisher, `publish`. Success → `DELIVERED` +
      `deliveredAt`; error → `DELIVERY_FAILED` + `lastError`; increment `attempts`.
    - _Requirements: 10.2, 10.3, 10.4_
  - [ ] 7.5 Delivery timeout
    - If a `READY`/`PUBLISHING` event exceeds `deliveryTimeoutSeconds` since `readyAt`, set
      `DELIVERY_FAILED` with a timeout reason.
    - _Requirements: 8.1, 8.2, 8.3_
  - [ ] 7.6 Unit tests for the state machine
    - Drive `tick()` with a mock store, mock publisher, and injected clock to cover: immediate
      ready (no readiness), poll-until-ready, readiness timeout, delivery success, delivery
      failure, delivery timeout.
    - _Requirements: 3.2, 4.4, 6.2, 8.1_

- [ ] 8. Enqueue on route completion (after response)
  - In `proxy.ts`, after the response is sent, if `matchedRoute.event?.enabled`, enqueue an event
    with the context snapshot and initial status (`PENDING_READINESS` if readiness configured,
    else `READY`), linking `executionLogId`. Wrap in try/catch so failures never affect the
    already-sent response.
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 5.3_

- [ ] 9. Start the worker
  - In `index.ts` `start()`, after init, construct `FileEventStore` + `IntervalEventWorker`,
    call `start()`, and stop cleanly on `SIGINT`/`SIGTERM`.
  - _Requirements: 3.1, 3.4_

- [ ] 10. Admin API
  - [ ] 10.1 Event endpoints
    - `GET /admin/events` (filters: status, routeId, limit), `GET /admin/events/:id`.
    - _Requirements: 5.4_
  - [ ] 10.2 Operator actions
    - `POST /admin/events/:id/restart` (timed-out → pending-readiness, reset elapsed);
      `POST /admin/events/:id/republish` (failed/delivered → ready).
    - _Requirements: 7.1, 7.2, 7.3, 9.1, 9.2, 9.3_
  - [ ] 10.3 Event target endpoints
    - `GET/POST/PUT/DELETE /admin/event-targets`.
    - _Requirements: 10.1_

- [ ] 11. Dashboard
  - [ ] 11.1 Events tab
    - New tab listing events (time, route, target, status badge, attempts, last error) with
      View / Restart / Re-publish actions; detail modal shows poll history and payload.
    - _Requirements: 5.4, 7.3, 9.3_
  - [ ] 11.2 Event Targets management
    - Section to CRUD event targets (mirroring Backends/Databases), including the placeholder
      broker types.
    - _Requirements: 10.1, 10.3_

- [ ] 12. End-to-end integration test
  - Configure an event-enabled route + a mock backend + a webhook target. Assert: API response
    returns before delivery; readiness polls flip a field then event becomes ready; webhook
    receives the built payload; verify readiness-timeout, delivery-failure, and re-publish paths.
  - _Requirements: 2.1, 4.4, 6.2, 8.1, 9.1, 10.2_

- [ ] 13. Documentation
  - Add an event-publishing section to the docs (config schema, condition operators for readiness,
    target types, lifecycle statuses, operator actions).
  - _Requirements: all (operator-facing reference)_
