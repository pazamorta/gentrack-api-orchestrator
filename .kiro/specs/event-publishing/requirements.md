# Event Publishing on Orchestration Completion — Requirements

## Introduction

This feature adds the ability for a configured route to publish an event to an external
message broker after its API response has been issued. Event processing is asynchronous and
managed by an in-process background worker. Events may optionally poll a backend until the
response data reaches a desired state before publishing. Event lifecycle (readiness, delivery,
timeouts, failures) is tracked in a separate log so operators can observe and act on events
independently of the originating API call.

This is a proof of concept. Storage is file-based and the worker is a single in-process loop,
both isolated behind interfaces so they can later be replaced with DynamoDB/SQS without
reworking the orchestration engine.

## Glossary

- **Event**: A record produced when an event-enabled route completes, carrying a payload and a
  target, moving through a status lifecycle until delivered or failed.
- **Readiness polling**: Optionally re-calling a backend on an interval and evaluating conditions
  against the accumulated results until they pass (event becomes ready) or a timeout elapses.
- **Event target**: A configured connection to a broker (webhook, SNS, SQS, EventBridge, etc.).
- **Publisher adapter**: A pluggable implementation that delivers a payload to one broker type.

## Requirements

### Requirement 1 — Configure a route to trigger an event on completion

**User Story:** As a route author, I want to configure a route so that completing it triggers an
event with a payload I define, so that downstream systems are notified.

#### Acceptance Criteria

1. WHEN a route has an enabled event configuration THEN the system SHALL create an event record
   upon completion of that route's orchestration.
2. WHEN a route has no event configuration OR it is disabled THEN the system SHALL NOT create an
   event record.
3. WHERE an event configuration defines a payload THE system SHALL build the payload using the
   same expression/mapping engine used for response mapping (supporting `$steps.*`,
   `$.inboundRequest.*`, `$source`/`$pick`, `$switch`, and other existing directives).
4. IF the payload configuration references data that does not resolve THEN the system SHALL still
   produce an event record with the unresolved fields omitted or null, consistent with existing
   response-mapping behaviour.

### Requirement 2 — Events triggered after the API response is issued

**User Story:** As an API consumer, I want the response returned without waiting on event
processing, so that event handling never slows or blocks my request.

#### Acceptance Criteria

1. WHEN an event-enabled route completes THEN the system SHALL send the API response before any
   event readiness polling or publishing occurs.
2. WHEN event record creation fails for any reason THEN the system SHALL NOT affect the API
   response that was already sent.
3. THE system SHALL capture a snapshot of the orchestration context (step results and inbound
   request) at completion time so that later asynchronous processing can build the payload and
   poll templates.

### Requirement 3 — Asynchronous event processing

**User Story:** As an operator, I want events processed by a background worker, so that readiness
polling and delivery happen independently of request handling.

#### Acceptance Criteria

1. THE system SHALL process events using a single in-process background worker loop.
2. WHILE the server is running THE worker SHALL periodically advance pending events through their
   lifecycle.
3. THE worker SHALL be isolated behind an interface so that it can be replaced by an external
   queue consumer (e.g. SQS) without changing the orchestration engine.
4. WHEN the server restarts THEN the worker SHALL resume processing of persisted events that are
   not in a terminal state.

### Requirement 4 — Readiness polling until data reaches a desired state

**User Story:** As a route author, I want to repeatedly call an API until one or more data items
in the response reach a certain state before the event publishes, so that events only fire when
downstream data is ready.

#### Acceptance Criteria

1. WHERE an event defines readiness polling THE system SHALL repeatedly execute the configured
   poll call on a configurable interval.
2. THE system SHALL merge each poll result into the accumulated step results so that conditions,
   subsequent polls, and the payload can reference it via `$steps.*`.
3. THE system SHALL support readiness conditions using the existing condition operators, covering
   at least:
   - HTTP status equals a value
   - a field equals a value
   - a field exists / does not exist
   - an object exists / does not exist
   - an array exists / does not exist
   - a field within an object equals a value
   - a field within an object exists / does not exist
4. WHEN all configured readiness conditions evaluate true THEN the system SHALL mark the event
   ready for publishing.
5. WHERE multiple conditions are configured THE system SHALL require all of them to be true before
   marking the event ready.
6. WHERE no readiness polling is configured THE system SHALL mark the event ready for publishing
   immediately after creation.

### Requirement 5 — Separate event logging within execution logs

**User Story:** As an operator, I want events logged separately from execution logs, so that I can
see the API call completed even when its event has not yet triggered.

#### Acceptance Criteria

1. THE system SHALL record the API call's execution log entry independently of event state.
2. THE system SHALL record each event as a separate log entry with its own lifecycle status.
3. THE system SHALL link an event log entry to its originating execution log entry.
4. THE system SHALL expose event log entries via an admin endpoint and a dashboard view.
5. WHEN an event's status changes THEN the system SHALL persist the updated status and relevant
   timestamps (created, ready, delivered) and last error if any.

### Requirement 6 — Readiness timeout with configurable status

**User Story:** As a route author, I want a timeout on readiness polling that moves the event to a
specific status, so that events waiting indefinitely are surfaced.

#### Acceptance Criteria

1. WHERE an event defines a readiness timeout THE system SHALL stop polling once the elapsed
   polling time exceeds the configured timeout.
2. WHEN a readiness timeout is reached THEN the system SHALL move the event to a timed-out status.
3. WHERE a timeout status is configurable THE system SHALL use the configured status value.

### Requirement 7 — Restart timed-out event triggers

**User Story:** As an operator, I want to restart a timed-out event, so that polling resumes after
I have addressed the underlying issue.

#### Acceptance Criteria

1. WHEN an operator restarts a timed-out event THEN the system SHALL reset it to the
   pending-readiness status and resume polling.
2. THE system SHALL reset the elapsed-time accounting so the timeout window starts again.
3. THE system SHALL expose restart via an admin endpoint and the dashboard.

### Requirement 8 — Flag undelivered events after a configurable time

**User Story:** As an operator, I want events that are not delivered within a configurable number
of seconds to be flagged, so that delivery problems are visible.

#### Acceptance Criteria

1. WHERE an event defines a delivery timeout THE system SHALL flag the event with a delivery-failed
   status if it is not delivered within the configured number of seconds after becoming ready.
2. WHEN a publish attempt returns an error THEN the system SHALL record the error and set a
   delivery-failed status.
3. THE system SHALL record the delivery failure reason on the event log entry.

### Requirement 9 — Re-publish undelivered events

**User Story:** As an operator, I want to re-publish an event that was not delivered, so that I can
retry delivery after resolving the cause.

#### Acceptance Criteria

1. WHEN an operator re-publishes an event THEN the system SHALL re-queue it for delivery using the
   stored payload and target.
2. THE system SHALL allow re-publishing of events in a delivery-failed or delivered status.
3. THE system SHALL expose re-publish via an admin endpoint and the dashboard.

### Requirement 10 — Configurable delivery targets

**User Story:** As a route author, I want to deliver events to a range of brokers, so that events
integrate with whatever messaging platform the downstream uses.

#### Acceptance Criteria

1. THE system SHALL support configuring event targets for: AWS SNS, AWS SQS, AWS EventBridge,
   Kafka, RabbitMQ, a webhook, Azure Service Bus, and Google Pub/Sub.
2. THE system SHALL implement functional delivery for webhook and AWS (SNS, SQS, EventBridge) in
   this proof of concept.
3. WHERE a target type is not yet implemented THE system SHALL expose it as a selectable
   placeholder that records a clear "not implemented" delivery failure rather than crashing.
4. THE system SHALL resolve each publisher adapter through a common interface so that additional
   broker types can be added without changing the worker or event lifecycle.
5. WHERE a broker requires a heavy SDK dependency THE system SHALL load it only when a target of
   that type is used.
