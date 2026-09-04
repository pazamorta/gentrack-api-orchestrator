# API Orchestrator — Event Publishing

## Overview

A route can publish an **event** to an external message broker after its orchestration completes.
Event processing is fully asynchronous and happens **after the API response has been sent** — it
never blocks or slows the caller. A background worker advances each event through a lifecycle:
optional readiness polling (wait until backend data reaches a desired state), then delivery to a
configured target (webhook, AWS SNS/SQS/EventBridge, etc.).

Events are tracked separately from execution logs, so you can see that an API call completed even
if its event has not yet been delivered. Operators can restart timed-out events and re-publish
failed ones.

> This is a proof of concept. Event state is stored in `data/events.json` and processed by a
> single in-process worker. The storage and worker are isolated behind interfaces so they can be
> replaced with a durable datastore/queue (e.g. DynamoDB + SQS) in production.

## How it works

```
Inbound request → orchestration runs → API response sent
                                            │
                                            ▼  (async, after response)
                                   event enqueued with a context snapshot
                                            │
                                    ┌────────┴─────────┐
                     readiness configured?         no readiness
                            │                          │
                            ▼                          ▼
                   PENDING_READINESS ──ready──►      READY ──► PUBLISHING ──► DELIVERED
                            │                                        │
                    readiness timeout                        delivery error /
                            │                                delivery timeout
                            ▼                                        ▼
                        TIMED_OUT                            DELIVERY_FAILED
```

## Configuring a route event

Add an `event` block to a route. The `payload` is built with the same expression/mapping engine
used for response mapping — it can reference `$steps.*`, `$.inboundRequest.*`, `$source`/`$pick`,
`$switch`, and other directives.

```json
{
  "name": "Create Order",
  "method": "POST",
  "path": "v1/orders",
  "steps": [ ... ],
  "responseMapping": { ... },
  "event": {
    "enabled": true,
    "targetId": "sns-orders",
    "payload": {
      "orderId": "$steps.step-1.body.id",
      "status": "$steps.poll.body.status",
      "requestedBy": "$.inboundRequest.headers.x-user"
    },
    "readiness": {
      "poll": {
        "stepId": "poll",
        "backendId": "gtcx-gcis",
        "method": "GET",
        "path": "/orders/{{$steps.step-1.body.id}}"
      },
      "until": [
        { "expression": "$steps.poll.statusCode", "operator": "eq", "value": 200 },
        { "expression": "$steps.poll.body.status", "operator": "eq", "value": "COMPLETE" }
      ],
      "intervalSeconds": 5,
      "timeoutSeconds": 300,
      "onTimeoutStatus": "TIMED_OUT"
    },
    "deliveryTimeoutSeconds": 60
  }
}
```

### Event fields

| Field                    | Type    | Description                                                        |
|--------------------------|---------|--------------------------------------------------------------------|
| `enabled`                | boolean | Whether the event trigger is active for this route                 |
| `targetId`               | string  | The event target (broker connection) to publish to                 |
| `payload`                | object  | Payload mapping, built with the response-mapping engine            |
| `forEach`                | string  | Optional fan-out expression (see below)                            |
| `readiness`              | object  | Optional readiness polling (see below)                             |
| `deliveryTimeoutSeconds` | number  | If not delivered within this many seconds of becoming ready, the event is flagged `DELIVERY_FAILED` |

If `readiness` is omitted, the event becomes `READY` immediately and delivers on the next worker
tick.

### Fan-out: one event per item (`forEach`)

By default a route produces a single event. When a step produces an array and you need a separate
event for **each** element — each with its own readiness poll, payload, and delivery — set
`forEach` to an expression that resolves to that array. One event is enqueued per item, and the
item is exposed as `$item` in the poll path, readiness conditions, and payload.

```json
"event": {
  "enabled": true,
  "targetId": "orders-webhook",
  "forEach": "$steps.step-2.body",
  "payload": {
    "forecastRequestId": "$item.forecastRequestId",
    "status": "$steps.forecast-status.body.status",
    "forecast": "$steps.forecast-status.body"
  },
  "readiness": {
    "poll": {
      "stepId": "forecast-status",
      "backendId": "factor",
      "method": "GET",
      "path": "/forecast/forecastRequests/{{$item.forecastRequestId}}"
    },
    "until": [ { "expression": "$steps.forecast-status.body.status", "operator": "eq", "value": "COMPLETED" } ],
    "intervalSeconds": 10,
    "timeoutSeconds": 600
  }
}
```

In this example, a `forEach` step produced an array of forecast responses under `$steps.step-2.body`.
The event fans out to one event per forecast; each polls its own forecast id via `$item.forecastRequestId`
and publishes independently when that forecast reaches `COMPLETED`. If the array is empty, no events
are enqueued.

## Readiness polling

Readiness polling repeatedly calls a backend until one or more conditions on the response are met.
Each poll result is **merged into `$steps.<stepId>`** (using the poll's `stepId`), so conditions,
later polls, and the payload can all reference the freshest polled data.

| Field             | Type        | Description                                                     |
|-------------------|-------------|-----------------------------------------------------------------|
| `poll`            | backend call| The call re-executed each interval (same shape as a route step call) |
| `until`           | condition[] | Conditions that must **all** be true for the event to become ready |
| `intervalSeconds` | number      | Seconds between poll attempts                                   |
| `timeoutSeconds`  | number      | Max total polling time before moving to the timeout status      |
| `onTimeoutStatus` | string      | Status to set on timeout (default `TIMED_OUT`)                  |

### Readiness condition operators

Each condition is a JSONPath `expression` plus an `operator`. Because the poll result is available
under `$steps.<stepId>`, the following patterns are all supported:

| Goal                                   | Example condition                                                            |
|----------------------------------------|------------------------------------------------------------------------------|
| HTTP status equals a value             | `{ "expression": "$steps.poll.statusCode", "operator": "eq", "value": 200 }` |
| A field equals a value                 | `{ "expression": "$steps.poll.body.status", "operator": "eq", "value": "COMPLETE" }` |
| A field exists / does not exist        | `{ "expression": "$steps.poll.body.ref", "operator": "exists" }` / `"not-exists"` |
| An object exists / does not exist      | `{ "expression": "$steps.poll.body.result", "operator": "exists" }`          |
| An array exists / does not exist       | `{ "expression": "$steps.poll.body.items", "operator": "exists" }`           |
| A field within an object equals a value| `{ "expression": "$steps.poll.body.result.outcome", "operator": "eq", "value": "Success" }` |
| A field within an object exists        | `{ "expression": "$steps.poll.body.result.id", "operator": "exists" }`       |

Additional operators: `neq`, `gt`, `gte`, `lt`, `lte`, `contains`.

All conditions in `until` must be true (AND) before the event becomes ready.

## Event targets

Event targets are broker connections, managed under the **Event Targets** tab (or the
`/admin/event-targets` API). Each has a `type` and a type-specific `config`.

| Type               | Status          | Config keys                                             |
|--------------------|-----------------|---------------------------------------------------------|
| `webhook`          | Functional      | `url`, `headers?`, `timeoutMs?`                         |
| `sns`              | Functional      | `topicArn`, `region?`, `subject?`                      |
| `sqs`              | Functional      | `queueUrl`, `region?`, `messageGroupId?` (FIFO)        |
| `eventbridge`      | Functional      | `source`, `detailType`, `eventBusName?`, `region?`     |
| `kafka`            | Not implemented | placeholder — records a delivery failure                |
| `rabbitmq`         | Not implemented | placeholder — records a delivery failure                |
| `azure-servicebus` | Not implemented | placeholder — records a delivery failure                |
| `gcp-pubsub`       | Not implemented | placeholder — records a delivery failure                |

Example webhook target:

```json
{
  "name": "Orders Webhook",
  "type": "webhook",
  "config": {
    "url": "https://example.com/hooks/orders",
    "headers": { "X-Signature": "..." },
    "timeoutMs": 10000
  }
}
```

AWS targets use the standard AWS SDK credential chain (environment, shared config, or instance
role). The `region` can be set per target or via the `AWS_REGION` environment variable. The AWS SDK
is loaded only when an AWS target is actually used.

## Event lifecycle statuses

| Status              | Meaning                                                             |
|---------------------|---------------------------------------------------------------------|
| `PENDING_READINESS` | Waiting for readiness conditions to pass                            |
| `READY`             | Conditions met (or none configured); queued for delivery            |
| `PUBLISHING`        | A delivery attempt is in progress                                   |
| `DELIVERED`         | The broker accepted the event                                       |
| `TIMED_OUT`         | Readiness polling exceeded `timeoutSeconds`                         |
| `DELIVERY_FAILED`   | Delivery errored, or was not delivered within `deliveryTimeoutSeconds` |

## Operator actions

From the **Events** tab or the admin API:

- **Restart** (`POST /admin/events/:id/restart`) — only for `TIMED_OUT` events. Resets to
  `PENDING_READINESS` and restarts the readiness window so polling resumes.
- **Re-publish** (`POST /admin/events/:id/republish`) — for `DELIVERY_FAILED` or `DELIVERED`
  events. Re-queues the event for delivery using the stored payload and target.

## Logging

Events are logged separately from execution logs (`data/events.json` vs `data/logs.json`):

- The API call's execution log entry is recorded independently and immediately, regardless of
  event state.
- Each event links back to its originating execution log entry via `executionLogId`.
- The event record tracks status, attempt count, poll history, the built payload, timestamps
  (created / ready / delivered), and the last error.

## Admin API reference

| Method & path                        | Description                                       |
|--------------------------------------|---------------------------------------------------|
| `GET /admin/events`                  | List events (filters: `status`, `routeId`, `limit`) |
| `GET /admin/events/:id`              | Full event detail incl. poll history and payload  |
| `POST /admin/events/:id/restart`     | Restart a timed-out event                         |
| `POST /admin/events/:id/republish`   | Re-queue a failed/delivered event for delivery    |
| `GET /admin/event-targets`           | List event targets                                |
| `POST /admin/event-targets`          | Create an event target                            |
| `PUT /admin/event-targets/:id`       | Update an event target                            |
| `DELETE /admin/event-targets/:id`    | Delete an event target                            |

## Environment variables

| Variable                   | Default | Description                              |
|----------------------------|---------|------------------------------------------|
| `EVENT_WORKER_INTERVAL_MS` | `1000`  | How often the event worker ticks (ms)    |
| `AWS_REGION`               | —       | Default region for AWS event targets     |
