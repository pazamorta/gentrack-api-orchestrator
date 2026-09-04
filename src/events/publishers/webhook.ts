import axios from 'axios';
import { EventTarget, EventTargetType } from '../../types';
import { EventPublisher, PublishResult } from './index';

/**
 * Delivers events by HTTP POST to a configured URL. Reuses axios (no new dependency).
 *
 * Target config:
 *   { "url": "https://...", "headers"?: { ... }, "timeoutMs"?: number }
 */
export class WebhookPublisher implements EventPublisher {
  readonly type: EventTargetType = 'webhook';

  async publish(target: EventTarget, payload: unknown): Promise<PublishResult> {
    const url = target.config?.url as string | undefined;
    if (!url) {
      return { ok: false, error: 'Webhook target is missing "url" in config' };
    }
    const headers = (target.config?.headers as Record<string, string>) || {};
    const timeout = (target.config?.timeoutMs as number) || 10_000;

    try {
      const res = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) {
        return { ok: true };
      }
      return { ok: false, error: `Webhook returned ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Webhook request failed' };
    }
  }
}
