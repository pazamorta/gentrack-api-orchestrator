import { EventTarget, EventTargetType } from '../../types';

/** Result of a publish attempt. */
export interface PublishResult {
  ok: boolean;
  error?: string;
}

/**
 * Delivery seam. Each broker type has one adapter. Adapters that need a heavy SDK
 * load it lazily inside publish() so the dependency is only required when used.
 */
export interface EventPublisher {
  readonly type: EventTargetType;
  publish(target: EventTarget, payload: unknown): Promise<PublishResult>;
}

import { WebhookPublisher } from './webhook';
import { SnsPublisher } from './sns';
import { SqsPublisher } from './sqs';
import { EventBridgePublisher } from './eventbridge';
import { NotImplementedPublisher } from './not-implemented';

// Instantiate the functional adapters once (stateless).
const registry: Partial<Record<EventTargetType, EventPublisher>> = {
  webhook: new WebhookPublisher(),
  sns: new SnsPublisher(),
  sqs: new SqsPublisher(),
  eventbridge: new EventBridgePublisher(),
};

/**
 * Resolve the publisher for a target type. Unimplemented broker types resolve to a
 * NotImplementedPublisher, which records a clear failure rather than crashing.
 */
export function resolvePublisher(type: EventTargetType): EventPublisher {
  return registry[type] || new NotImplementedPublisher(type);
}
