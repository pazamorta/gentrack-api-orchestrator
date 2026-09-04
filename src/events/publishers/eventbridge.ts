import { EventTarget, EventTargetType } from '../../types';
import { EventPublisher, PublishResult } from './index';

/**
 * Delivers events to AWS EventBridge. The AWS SDK is imported lazily so the dependency
 * is only loaded when an EventBridge target is actually used.
 *
 * Target config:
 *   {
 *     "eventBusName"?: string,   // defaults to "default"
 *     "source": "my.app",
 *     "detailType": "OrchestrationCompleted",
 *     "region"?: string
 *   }
 */
export class EventBridgePublisher implements EventPublisher {
  readonly type: EventTargetType = 'eventbridge';

  async publish(target: EventTarget, payload: unknown): Promise<PublishResult> {
    const source = target.config?.source as string | undefined;
    const detailType = target.config?.detailType as string | undefined;
    if (!source || !detailType) {
      return { ok: false, error: 'EventBridge target requires "source" and "detailType" in config' };
    }
    const eventBusName = (target.config?.eventBusName as string) || 'default';
    const region = (target.config?.region as string) || process.env.AWS_REGION || 'us-east-1';

    try {
      const { EventBridgeClient, PutEventsCommand } = await import('@aws-sdk/client-eventbridge');
      const client = new EventBridgeClient({ region });
      const res = await client.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: eventBusName,
              Source: source,
              DetailType: detailType,
              Detail: JSON.stringify(payload),
            },
          ],
        })
      );
      if ((res.FailedEntryCount || 0) > 0) {
        const reason = res.Entries?.[0]?.ErrorMessage || 'EventBridge rejected the entry';
        return { ok: false, error: reason };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'EventBridge put failed' };
    }
  }
}
