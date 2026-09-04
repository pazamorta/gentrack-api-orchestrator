import { EventContextSnapshot, EventTargetType, RouteConfig, NewEventRecord } from '../types';
import { getEventStore } from './event-store';
import { getEventTarget } from '../db';
import { resolveValue } from '../transformer';
import { contextFromSnapshot } from './payload-builder';

/**
 * Enqueue event(s) for a completed route, if the route has an enabled event config.
 * Safe to call after the API response has been sent — any failure is logged and swallowed
 * so it can never affect the response the caller already received (Req 2.1, 2.2).
 *
 * If the event config has a `forEach` expression, ONE event is enqueued per resolved array
 * item, with that item stored in the event's snapshot (exposed as `$item`). Otherwise a single
 * event is enqueued.
 *
 * Each event starts in PENDING_READINESS when readiness polling is configured, otherwise READY.
 */
export function enqueueRouteEvent(params: {
  route: RouteConfig;
  executionLogId: number | null;
  snapshot: EventContextSnapshot;
}): void {
  const { route, executionLogId, snapshot } = params;
  const eventConfig = route.event;
  if (!eventConfig || !eventConfig.enabled) return;

  try {
    const target = getEventTarget(eventConfig.targetId);
    const targetType: EventTargetType = target?.type || 'webhook';
    const status: NewEventRecord['status'] = eventConfig.readiness ? 'PENDING_READINESS' : 'READY';
    const store = getEventStore();

    const enqueueOne = (itemSnapshot: EventContextSnapshot) => {
      store.enqueue({
        executionLogId,
        routeId: route.id,
        routeName: route.name,
        targetId: eventConfig.targetId,
        targetType,
        status,
        contextSnapshot: itemSnapshot,
        eventConfig,
      });
    };

    if (eventConfig.forEach) {
      // Resolve the fan-out array against the completed context, enqueue one event per item.
      const ctx = contextFromSnapshot(snapshot);
      const resolved = resolveValue(eventConfig.forEach, ctx);
      const items = Array.isArray(resolved) ? resolved : (resolved !== undefined && resolved !== null ? [resolved] : []);
      if (items.length === 0) {
        console.warn(`[events] route "${route.name}" forEach resolved to no items — no events enqueued`);
        return;
      }
      for (const item of items) {
        enqueueOne({ ...snapshot, currentItem: item });
      }
    } else {
      enqueueOne(snapshot);
    }
  } catch (err) {
    console.error(`[events] enqueue failed for route "${route.name}" (response already sent):`, err);
  }
}
