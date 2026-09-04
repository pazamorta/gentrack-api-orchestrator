import * as fs from 'fs';
import * as path from 'path';
import { EventRecord, EventStatus, NewEventRecord } from '../types';

/**
 * Storage seam for events. The PoC uses a file-backed implementation; this interface
 * lets a DynamoDB-backed store be dropped in later without changing the worker or engine.
 */
export interface EventStore {
  /** Create and persist a new event record (assigns id + timestamps). */
  enqueue(record: NewEventRecord): EventRecord;
  /** Get a single event by id. */
  get(id: number): EventRecord | null;
  /** List events, optionally filtered by status/route, newest first. */
  list(filter?: { status?: EventStatus; routeId?: string; limit?: number }): EventRecord[];
  /** Apply a partial update to an event and persist. Returns the updated record. */
  update(id: number, patch: Partial<EventRecord>): EventRecord | null;
  /**
   * Return events the worker should act on now: any in a non-terminal, worker-driven
   * status (PENDING_READINESS, READY, PUBLISHING).
   */
  claimDue(now: number): EventRecord[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const EVENTS_PATH = path.join(DATA_DIR, 'events.json');

/** Statuses the worker actively advances (non-terminal). */
const WORKER_DRIVEN: EventStatus[] = ['PENDING_READINESS', 'READY', 'PUBLISHING'];

interface EventsFile {
  events: EventRecord[];
}

/**
 * File-backed event store. Uses atomic temp-file-then-rename writes and resilient loading
 * (a corrupt events.json is backed up rather than silently overwritten), matching the
 * safety patterns used for store.json.
 */
export class FileEventStore implements EventStore {
  private events: EventRecord[] = [];
  private nextId = 1;

  constructor() {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(EVENTS_PATH)) {
      try {
        const raw = fs.readFileSync(EVENTS_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as EventsFile;
        this.events = Array.isArray(parsed.events) ? parsed.events : [];
        if (this.events.length > 0) {
          this.nextId = Math.max(...this.events.map((e) => e.id)) + 1;
        }
      } catch (err) {
        // Back up the unreadable file and start empty rather than destroying it.
        const backupPath = `${EVENTS_PATH}.corrupt-${Date.now()}.bak`;
        try {
          fs.copyFileSync(EVENTS_PATH, backupPath);
          console.error(`[events] FAILED to parse events.json: ${(err as Error).message}`);
          console.error(`[events] Backup of the unreadable file saved to: ${backupPath}`);
        } catch { /* ignore backup failure */ }
        this.events = [];
      }
    }
  }

  private persist(): void {
    const tmpPath = `${EVENTS_PATH}.tmp`;
    const payload: EventsFile = { events: this.events };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, EVENTS_PATH);
  }

  enqueue(record: NewEventRecord): EventRecord {
    const now = new Date().toISOString();
    const full: EventRecord = {
      ...record,
      id: this.nextId++,
      attempts: 0,
      payload: null,
      readiness: record.eventConfig.readiness
        ? { startedAt: now, pollCount: 0, lastPollAt: null, pollHistory: [] }
        : undefined,
      createdAt: now,
      readyAt: record.status === 'READY' ? now : null,
      deliveredAt: null,
      lastError: null,
      updatedAt: now,
    };
    this.events.push(full);
    this.persist();
    return full;
  }

  get(id: number): EventRecord | null {
    return this.events.find((e) => e.id === id) || null;
  }

  list(filter?: { status?: EventStatus; routeId?: string; limit?: number }): EventRecord[] {
    let results = [...this.events];
    if (filter?.status) results = results.filter((e) => e.status === filter.status);
    if (filter?.routeId) results = results.filter((e) => e.routeId === filter.routeId);
    // Newest first
    results.sort((a, b) => b.id - a.id);
    if (filter?.limit && filter.limit > 0) results = results.slice(0, filter.limit);
    return results;
  }

  update(id: number, patch: Partial<EventRecord>): EventRecord | null {
    const index = this.events.findIndex((e) => e.id === id);
    if (index < 0) return null;
    const updated: EventRecord = {
      ...this.events[index],
      ...patch,
      id, // never allow id to change
      updatedAt: new Date().toISOString(),
    };
    this.events[index] = updated;
    this.persist();
    return updated;
  }

  claimDue(_now: number): EventRecord[] {
    return this.events.filter((e) => WORKER_DRIVEN.includes(e.status));
  }
}

let eventStoreInstance: EventStore | null = null;

/** Initialise and return the singleton event store. */
export function initEventStore(): EventStore {
  if (!eventStoreInstance) {
    eventStoreInstance = new FileEventStore();
  }
  return eventStoreInstance;
}

/** Get the initialised event store (throws if not yet initialised). */
export function getEventStore(): EventStore {
  if (!eventStoreInstance) {
    throw new Error('Event store not initialised — call initEventStore() first');
  }
  return eventStoreInstance;
}
