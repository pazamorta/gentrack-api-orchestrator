import { EventTarget, EventTargetType } from '../../types';
import { EventPublisher, PublishResult } from './index';

/**
 * Delivers events to AWS SQS. The AWS SDK is imported lazily so the dependency is only
 * loaded when an SQS target is actually used.
 *
 * Target config:
 *   { "queueUrl": "https://sqs...", "region"?: string, "messageGroupId"?: string }
 * messageGroupId is required for FIFO queues.
 */
export class SqsPublisher implements EventPublisher {
  readonly type: EventTargetType = 'sqs';

  async publish(target: EventTarget, payload: unknown): Promise<PublishResult> {
    const queueUrl = target.config?.queueUrl as string | undefined;
    if (!queueUrl) {
      return { ok: false, error: 'SQS target is missing "queueUrl" in config' };
    }
    const region = (target.config?.region as string) || process.env.AWS_REGION || 'us-east-1';
    const messageGroupId = target.config?.messageGroupId as string | undefined;

    try {
      const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
      const client = new SQSClient({ region });
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(payload),
          ...(messageGroupId ? { MessageGroupId: messageGroupId } : {}),
        })
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'SQS send failed' };
    }
  }
}
