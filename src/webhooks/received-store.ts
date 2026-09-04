import * as fs from 'fs';
import * as path from 'path';
import { NewReceivedWebhook, ReceivedWebhook } from '../types';

/**
 * Storage seam for received (inbound) webhooks. File-backed for the PoC; the interface allows
 * a durable store to be dropped in later without changing the receiver route.
 */
export interface ReceivedWebhookStore {
  /** Record a received webhook (assigns id + timestamp). */
  add(record: NewReceivedWebhook): ReceivedWebhook;
  /** List received webhooks, newest first, optionally limited. */
  list(limit?: number): ReceivedWebhook[];
  /** Get a single received webhook by id. */
  get(id: number): ReceivedWebhook | null;
  /** Remove all received webhooks. */
  clear(): void;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const WEBHOOKS_PATH = path.join(DATA_DIR, 'received-webhooks.json');

/** Max records retained (configurable via WEBHOOK_RETENTION). */
const MAX_RECORDS = parseInt(process.env.WEBHOOK_RETENTION || '5000', 10);

interface WebhooksFile {
  webhooks: ReceivedWebhook[];
}

/**
 * File-backed received-webhook store. Uses atomic temp-file-then-rename writes and resilient
 * loading (a corrupt file is backed up rather than silently overwritten), matching the safety
 * patterns used elsewhere.
 */
export class FileReceivedWebhookStore implements ReceivedWebhookStore {
  private webhooks: ReceivedWebhook[] = [];
  private nextId = 1;

  constructor() {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(WEBHOOKS_PATH)) {
      try {
        const raw = fs.readFileSync(WEBHOOKS_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as WebhooksFile;
        this.webhooks = Array.isArray(parsed.webhooks) ? parsed.webhooks : [];
        if (this.webhooks.length > 0) {
          this.nextId = Math.max(...this.webhooks.map((w) => w.id)) + 1;
        }
      } catch (err) {
        const backupPath = `${WEBHOOKS_PATH}.corrupt-${Date.now()}.bak`;
        try {
          fs.copyFileSync(WEBHOOKS_PATH, backupPath);
          console.error(`[webhooks] FAILED to parse received-webhooks.json: ${(err as Error).message}`);
          console.error(`[webhooks] Backup of the unreadable file saved to: ${backupPath}`);
        } catch { /* ignore backup failure */ }
        this.webhooks = [];
      }
    }
  }

  private persist(): void {
    const tmpPath = `${WEBHOOKS_PATH}.tmp`;
    const payload: WebhooksFile = { webhooks: this.webhooks };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, WEBHOOKS_PATH);
  }

  add(record: NewReceivedWebhook): ReceivedWebhook {
    const full: ReceivedWebhook = {
      ...record,
      id: this.nextId++,
      receivedAt: new Date().toISOString(),
    };
    this.webhooks.push(full);
    // Trim to retention limit (keep newest).
    if (this.webhooks.length > MAX_RECORDS) {
      this.webhooks = this.webhooks.slice(-MAX_RECORDS);
    }
    this.persist();
    return full;
  }

  list(limit?: number): ReceivedWebhook[] {
    const sorted = [...this.webhooks].sort((a, b) => b.id - a.id);
    return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  get(id: number): ReceivedWebhook | null {
    return this.webhooks.find((w) => w.id === id) || null;
  }

  clear(): void {
    this.webhooks = [];
    this.persist();
  }
}

let instance: ReceivedWebhookStore | null = null;

/** Initialise and return the singleton received-webhook store. */
export function initReceivedWebhookStore(): ReceivedWebhookStore {
  if (!instance) {
    instance = new FileReceivedWebhookStore();
  }
  return instance;
}

/** Get the initialised store (throws if not yet initialised). */
export function getReceivedWebhookStore(): ReceivedWebhookStore {
  if (!instance) {
    throw new Error('Received webhook store not initialised — call initReceivedWebhookStore() first');
  }
  return instance;
}
