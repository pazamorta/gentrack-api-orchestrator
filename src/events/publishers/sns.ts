import { EventTarget, EventTargetType } from '../../types';
import { EventPublisher, PublishResult } from './index';

/**
 * Delivers events to AWS SNS. The AWS SDK is imported lazily so the dependency is only
 * loaded when an SNS target is actually used.
 *
 * Target config:
 *   { "topicArn": "arn:aws:sns:...", "region"?: string, "subject"?: string }
 */
export class SnsPublisher implements EventPublisher {
  readonly type: EventTargetType = 'sns';

  async publish(target: EventTarget, payload: unknown): Promise<PublishResult> {
    const topicArn = target.config?.topicArn as string | undefined;
    if (!topicArn) {
      return { ok: false, error: 'SNS target is missing "topicArn" in config' };
    }
    const region = (target.config?.region as string) || process.env.AWS_REGION || 'us-east-1';
    const subject = target.config?.subject as string | undefined;

    try {
      const { SNSClient, PublishCommand } = await import('@aws-sdk/client-sns');
      const client = new SNSClient({ region });
      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(payload),
          ...(subject ? { Subject: subject } : {}),
        })
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'SNS publish failed' };
    }
  }
}
