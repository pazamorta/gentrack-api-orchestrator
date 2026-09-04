import { EventTarget, EventTargetType } from '../../types';
import { EventPublisher, PublishResult } from './index';

/**
 * Placeholder adapter for broker types not yet implemented in this PoC
 * (kafka, rabbitmq, azure-servicebus, gcp-pubsub). Records a clear, recoverable
 * delivery failure so events can be inspected and re-published later — never crashes.
 */
export class NotImplementedPublisher implements EventPublisher {
  readonly type: EventTargetType;

  constructor(type: EventTargetType) {
    this.type = type;
  }

  async publish(_target: EventTarget, _payload: unknown): Promise<PublishResult> {
    return {
      ok: false,
      error: `Publisher '${this.type}' is not implemented in this build`,
    };
  }
}
