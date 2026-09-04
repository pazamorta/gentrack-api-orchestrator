import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { resolvePublisher } from '../publishers';
import { WebhookPublisher } from '../publishers/webhook';
import { NotImplementedPublisher } from '../publishers/not-implemented';
import { EventTarget } from '../../types';

describe('resolvePublisher factory (Req 10.4)', () => {
  it('resolves functional adapters', () => {
    expect(resolvePublisher('webhook').type).toBe('webhook');
    expect(resolvePublisher('sns').type).toBe('sns');
    expect(resolvePublisher('sqs').type).toBe('sqs');
    expect(resolvePublisher('eventbridge').type).toBe('eventbridge');
  });

  it('resolves unimplemented types to a NotImplementedPublisher (Req 10.3)', () => {
    for (const t of ['kafka', 'rabbitmq', 'azure-servicebus', 'gcp-pubsub'] as const) {
      const p = resolvePublisher(t);
      expect(p).toBeInstanceOf(NotImplementedPublisher);
      expect(p.type).toBe(t);
    }
  });
});

describe('NotImplementedPublisher', () => {
  it('returns a clear, non-throwing failure', async () => {
    const p = new NotImplementedPublisher('kafka');
    const target: EventTarget = { id: 't', name: 'k', type: 'kafka', config: {} };
    const res = await p.publish(target, { any: 'payload' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('kafka');
    expect(res.error).toContain('not implemented');
  });
});

describe('WebhookPublisher (Req 10.2)', () => {
  let server: http.Server;
  let received: { body: string; contentType?: string } | null = null;

  afterEach(() => {
    if (server) server.close();
    received = null;
  });

  function startServer(statusCode: number): Promise<string> {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received = { body, contentType: req.headers['content-type'] };
          res.statusCode = statusCode;
          res.end();
        });
      });
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}/hook`);
      });
    });
  }

  it('POSTs the payload as JSON and succeeds on 2xx', async () => {
    const url = await startServer(200);
    const target: EventTarget = { id: 't', name: 'wh', type: 'webhook', config: { url } };
    const res = await new WebhookPublisher().publish(target, { orderId: 42 });
    expect(res.ok).toBe(true);
    expect(received?.contentType).toContain('application/json');
    expect(JSON.parse(received!.body)).toEqual({ orderId: 42 });
  });

  it('fails on non-2xx', async () => {
    const url = await startServer(500);
    const target: EventTarget = { id: 't', name: 'wh', type: 'webhook', config: { url } };
    const res = await new WebhookPublisher().publish(target, { x: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('500');
  });

  it('fails clearly when url is missing', async () => {
    const target: EventTarget = { id: 't', name: 'wh', type: 'webhook', config: {} };
    const res = await new WebhookPublisher().publish(target, { x: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('url');
  });
});
