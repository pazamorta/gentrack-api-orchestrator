import { describe, it, expect } from 'vitest';
import { evaluateCondition } from '../../orchestrator';
import { Condition, OrchestrationContext } from '../../types';

/**
 * Tests for the readiness-condition evaluator, covering every operator case called out in
 * Requirement 4.3 of the event-publishing spec. Conditions are evaluated against a poll
 * result that has been merged into $steps.poll, exactly as the event worker will do.
 */

function ctxWithPollResult(body: unknown, statusCode = 200): OrchestrationContext {
  return {
    inboundRequest: { method: 'GET', path: '/x', headers: {}, query: {}, params: {}, body: null },
    stepResults: {
      poll: { statusCode, headers: {}, body, duration: 1 },
    },
    logLevel: 'none',
  };
}

const evalC = (condition: Condition, ctx: OrchestrationContext) => evaluateCondition(condition, ctx);

describe('evaluateCondition — readiness operators (Req 4.3)', () => {
  it('HTTP status equals a value', () => {
    const ctx = ctxWithPollResult({ any: 'thing' }, 200);
    expect(evalC({ expression: '$steps.poll.statusCode', operator: 'eq', value: 200 }, ctx)).toBe(true);
    expect(evalC({ expression: '$steps.poll.statusCode', operator: 'eq', value: 404 }, ctx)).toBe(false);
  });

  it('a field equals a value', () => {
    const ctx = ctxWithPollResult({ status: 'COMPLETE' });
    expect(evalC({ expression: '$steps.poll.body.status', operator: 'eq', value: 'COMPLETE' }, ctx)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.status', operator: 'eq', value: 'PENDING' }, ctx)).toBe(false);
  });

  it('a field exists / does not exist', () => {
    const present = ctxWithPollResult({ ref: 'abc' });
    const absent = ctxWithPollResult({ other: 1 });
    expect(evalC({ expression: '$steps.poll.body.ref', operator: 'exists' }, present)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.ref', operator: 'exists' }, absent)).toBe(false);
    expect(evalC({ expression: '$steps.poll.body.ref', operator: 'not-exists' }, absent)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.ref', operator: 'not-exists' }, present)).toBe(false);
  });

  it('an object exists / does not exist', () => {
    const present = ctxWithPollResult({ result: { code: 'OK' } });
    const absent = ctxWithPollResult({});
    expect(evalC({ expression: '$steps.poll.body.result', operator: 'exists' }, present)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.result', operator: 'not-exists' }, absent)).toBe(true);
  });

  it('an array exists / does not exist', () => {
    const present = ctxWithPollResult({ items: [1, 2, 3] });
    const absent = ctxWithPollResult({ items: undefined });
    expect(evalC({ expression: '$steps.poll.body.items', operator: 'exists' }, present)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.items', operator: 'not-exists' }, absent)).toBe(true);
  });

  it('a field within an object equals a value', () => {
    const ctx = ctxWithPollResult({ result: { outcome: 'Success' } });
    expect(evalC({ expression: '$steps.poll.body.result.outcome', operator: 'eq', value: 'Success' }, ctx)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.result.outcome', operator: 'eq', value: 'Failure' }, ctx)).toBe(false);
  });

  it('a field within an object exists / does not exist', () => {
    const present = ctxWithPollResult({ result: { id: 'r1' } });
    const absent = ctxWithPollResult({ result: {} });
    expect(evalC({ expression: '$steps.poll.body.result.id', operator: 'exists' }, present)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.result.id', operator: 'not-exists' }, absent)).toBe(true);
  });
});

describe('evaluateCondition — comparison + membership operators', () => {
  it('neq', () => {
    const ctx = ctxWithPollResult({ state: 'A' });
    expect(evalC({ expression: '$steps.poll.body.state', operator: 'neq', value: 'B' }, ctx)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.state', operator: 'neq', value: 'A' }, ctx)).toBe(false);
  });

  it('gt / gte / lt / lte', () => {
    const ctx = ctxWithPollResult({ count: 5 });
    expect(evalC({ expression: '$steps.poll.body.count', operator: 'gt', value: 4 }, ctx)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.count', operator: 'gte', value: 5 }, ctx)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.count', operator: 'lt', value: 5 }, ctx)).toBe(false);
    expect(evalC({ expression: '$steps.poll.body.count', operator: 'lte', value: 5 }, ctx)).toBe(true);
  });

  it('contains (string and array)', () => {
    const str = ctxWithPollResult({ msg: 'all done here' });
    const arr = ctxWithPollResult({ tags: ['a', 'b'] });
    expect(evalC({ expression: '$steps.poll.body.msg', operator: 'contains', value: 'done' }, str)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.tags', operator: 'contains', value: 'b' }, arr)).toBe(true);
    expect(evalC({ expression: '$steps.poll.body.tags', operator: 'contains', value: 'z' }, arr)).toBe(false);
  });
});
