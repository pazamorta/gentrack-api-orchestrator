import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { FileReceivedWebhookStore } from '../received-store';

const WEBHOOKS_PATH = path.resolve(process.cwd(), 'data', 'received-webhooks.json');

/**
 * Tests the file-backed received-webhook store. Cleans up the data file before/after so it
 * doesn't interfere with a running instance's data.
 */
describe('FileReceivedWebhookStore', () => {
  const backup = fs.existsSync(WEBHOOKS_PATH) ? fs.readFileSync(WEBHOOKS_PATH, 'utf-8') : null;

  beforeEach(() => {
    if (fs.existsSync(WEBHOOKS_PATH)) fs.rmSync(WEBHOOKS_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(WEBHOOKS_PATH)) fs.rmSync(WEBHOOKS_PATH);
    if (backup !== null) fs.writeFileSync(WEBHOOKS_PATH, backup, 'utf-8');
  });

  const sample = {
    name: 'orders/created',
    method: 'POST',
    path: '/orders/created',
    headers: { 'content-type': 'application/json' },
    query: {},
    body: { orderId: 1 },
  };

  it('adds records with id + timestamp and persists to disk', () => {
    const store = new FileReceivedWebhookStore();
    const rec = store.add(sample);
    expect(rec.id).toBe(1);
    expect(rec.receivedAt).toBeTruthy();
    expect(fs.existsSync(WEBHOOKS_PATH)).toBe(true);
  });

  it('lists newest first and applies limit', () => {
    const store = new FileReceivedWebhookStore();
    store.add({ ...sample, body: { n: 1 } });
    store.add({ ...sample, body: { n: 2 } });
    store.add({ ...sample, body: { n: 3 } });
    const all = store.list();
    expect(all.map((w) => w.id)).toEqual([3, 2, 1]);
    expect(store.list(2).map((w) => w.id)).toEqual([3, 2]);
  });

  it('gets by id and clears', () => {
    const store = new FileReceivedWebhookStore();
    const rec = store.add(sample);
    expect(store.get(rec.id)?.body).toEqual({ orderId: 1 });
    store.clear();
    expect(store.list()).toHaveLength(0);
    expect(store.get(rec.id)).toBeNull();
  });

  it('persists across instances (reload from disk)', () => {
    const s1 = new FileReceivedWebhookStore();
    s1.add(sample);
    const s2 = new FileReceivedWebhookStore();
    expect(s2.list()).toHaveLength(1);
    // Next id continues from the loaded max.
    const rec = s2.add(sample);
    expect(rec.id).toBe(2);
  });
});
