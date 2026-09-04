import { buildResponse } from '../transformer';
import { EventContextSnapshot, OrchestrationContext, StepResult } from '../types';

/**
 * Reconstruct a minimal OrchestrationContext from an event's captured snapshot, optionally
 * merging in additional step results (e.g. readiness poll results keyed by the poll's stepId).
 * This lets payload/condition expressions reference $steps.* and $.inboundRequest.* exactly as
 * they do during route execution.
 */
export function contextFromSnapshot(
  snapshot: EventContextSnapshot,
  extraStepResults?: Record<string, StepResult>
): OrchestrationContext {
  return {
    inboundRequest: snapshot.inboundRequest,
    stepResults: { ...snapshot.stepResults, ...(extraStepResults || {}) },
    // Expose the fanned-out array item as $item for poll path / conditions / payload.
    currentItem: snapshot.currentItem,
    logLevel: 'none',
  };
}

/**
 * Build an event payload from a payload mapping and an orchestration context, reusing the
 * same mapping engine as response building (supports $steps.*, $.inboundRequest.*, $source/$pick,
 * $switch, and other existing directives).
 */
export function buildEventPayload(
  payloadMapping: Record<string, unknown>,
  context: OrchestrationContext
): unknown {
  return buildResponse(payloadMapping, context);
}
