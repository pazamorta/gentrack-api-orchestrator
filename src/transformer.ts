import { JSONPath } from 'jsonpath-plus';
import { OrchestrationContext } from './types';

/**
 * Resolve a template string that may contain:
 * - JSONPath expressions: $.inboundRequest.body.userId
 * - Step result references: $steps.stepId.body.fieldName
 * - Built-in variables: $now.date, $now.dateTime, $now.timestamp
 * - Literal values (no $ prefix)
 */
export function resolveValue(expression: string, context: OrchestrationContext): unknown {
  if (!expression || typeof expression !== 'string') {
    return expression;
  }

  // If it doesn't start with $, treat as literal
  if (!expression.startsWith('$')) {
    return expression;
  }

  // Handle built-in date/time variables
  if (expression.startsWith('$now')) {
    return resolveNowVariable(expression);
  }

  // Handle current loop item: $item or $item.field.subfield
  if (expression === '$item') {
    return context.currentItem;
  }
  if (expression.startsWith('$item.')) {
    if (context.currentItem === undefined || context.currentItem === null) return undefined;
    const subPath = expression.slice('$item.'.length);
    const jsonPath = `$.${subPath}`;
    const results = JSONPath({ path: jsonPath, json: context.currentItem as object });
    return results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
  }

  // Handle current loop index
  if (expression === '$index') {
    return context.currentIndex;
  }

  // Handle step result references: $steps.<stepId>.<path>
  if (expression.startsWith('$steps.')) {
    const withoutPrefix = expression.slice('$steps.'.length);
    const dotIndex = withoutPrefix.indexOf('.');
    if (dotIndex === -1) {
      const stepId = withoutPrefix;
      return context.stepResults[stepId];
    }
    const stepId = withoutPrefix.slice(0, dotIndex);
    const subPath = withoutPrefix.slice(dotIndex + 1);
    const stepResult = context.stepResults[stepId];
    if (!stepResult) return undefined;

    // Use JSONPath on the step result
    const results = JSONPath({ path: `$.${subPath}`, json: stepResult as object });
    return results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
  }

  // Standard JSONPath against the full context
  const results = JSONPath({ path: expression, json: context as unknown as object });
  return results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
}

/**
 * Apply a mapping object: { targetField: sourceExpression }
 * Supports nested objects — values within nested objects are resolved recursively.
 * Supports $map for array transformations.
 * Returns a new object with resolved values.
 */
export function applyMapping(
  mapping: Record<string, unknown>,
  context: OrchestrationContext
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [targetKey, sourceExpr] of Object.entries(mapping)) {
    if (typeof sourceExpr === 'string') {
      const value = resolveValue(sourceExpr, context);
      setNestedValue(result, targetKey, value);
    } else if (sourceExpr !== null && typeof sourceExpr === 'object' && !Array.isArray(sourceExpr)) {
      const obj = sourceExpr as Record<string, unknown>;

      // Check for $dateAdd directive at mapping level
      if ('$dateAdd' in obj && '$date' in obj) {
        const dateConfig = obj as { $date: string; $dateAdd: { days?: number; months?: number; years?: number }; $format?: string };
        const dateValue = resolveValue(dateConfig.$date, context);
        const computed = computeDateAdd(dateValue, dateConfig.$dateAdd, dateConfig.$format);
        setNestedValue(result, targetKey, computed);
      }
      // Check for $datePart directive at mapping level
      else if ('$datePart' in obj && '$date' in obj && !('$dateAdd' in obj)) {
        const datePartConfig = obj as { $date: string; $datePart: string };
        const dateValue = resolveValue(datePartConfig.$date, context);
        setNestedValue(result, targetKey, extractDatePart(dateValue, datePartConfig.$datePart));
      }
      // Check for $calc directive at mapping level
      else if ('$calc' in obj) {
        const calcConfig = (obj as any).$calc as { left: unknown; operator: string; right: unknown; $round?: number };
        const computed = computeCalc(calcConfig, null, context);
        setNestedValue(result, targetKey, computed);
      }
      // Check for $concat directive at mapping level
      else if ('$concat' in obj && Array.isArray(obj['$concat'])) {
        const concatConfig = obj as { $concat: string[]; $separator?: string };
        const separator = concatConfig.$separator ?? ' ';
        const parts: string[] = [];
        for (const expr of concatConfig.$concat) {
          if (typeof expr === 'string' && expr.startsWith('$')) {
            const val = resolveValue(expr, context);
            if (val !== undefined && val !== null) {
              parts.push(String(val));
            }
          } else if (typeof expr === 'string') {
            parts.push(expr);
          }
        }
        setNestedValue(result, targetKey, parts.join(separator));
      }
      // Check for $switch directive at mapping level
      else if ('$switch' in obj && '$cases' in obj) {
        const switchConfig = obj as { $switch: string; $cases: Record<string, unknown>; $default?: unknown };
        const switchValue = resolveValue(switchConfig.$switch, context);
        const matched = switchConfig.$cases[String(switchValue)];
        setNestedValue(result, targetKey, matched !== undefined ? matched : (switchConfig.$default ?? null));
      }
      // Check for $filter directive: filter array by condition (optionally sort and pick first)
      else if (typeof obj['$source'] === 'string' && '$filter' in obj && !('$pick' in obj)) {
        const source = resolveValue(obj['$source'] as string, context);
        const filterConfig = obj['$filter'] as { field: string; operator: string; value: unknown };
        const fields = obj['$fields'] as Record<string, string> | undefined;
        const sortBy = obj['$sortBy'] as string | undefined;
        const order = (obj['$order'] as string) || 'desc';
        const first = obj['$first'] as boolean | undefined;

        let items: unknown[] = [];
        if (Array.isArray(source)) {
          items = [...source];
        } else if (source !== null && typeof source === 'object') {
          items = Object.values(source as Record<string, unknown>);
        }

        // Filter items based on condition
        let filtered = items.filter((item) => {
          const results = JSONPath({ path: `$.${filterConfig.field}`, json: item as object });
          const actualValue = results.length > 0 ? results[0] : undefined;

          switch (filterConfig.operator) {
            case 'gt': return Number(actualValue) > Number(filterConfig.value);
            case 'gte': return Number(actualValue) >= Number(filterConfig.value);
            case 'lt': return Number(actualValue) < Number(filterConfig.value);
            case 'lte': return Number(actualValue) <= Number(filterConfig.value);
            case 'eq': return actualValue == filterConfig.value;
            case 'neq': return actualValue != filterConfig.value;
            case 'exists': return actualValue !== undefined && actualValue !== null;
            case 'contains': return typeof actualValue === 'string' && actualValue.includes(String(filterConfig.value));
            default: return true;
          }
        });

        // Sort if specified
        if (sortBy) {
          filtered.sort((a, b) => {
            const aResults = JSONPath({ path: `$.${sortBy}`, json: a as object });
            const bResults = JSONPath({ path: `$.${sortBy}`, json: b as object });
            const aVal = aResults.length > 0 ? String(aResults[0]) : '';
            const bVal = bResults.length > 0 ? String(bResults[0]) : '';
            const cmp = aVal.localeCompare(bVal);
            return order === 'desc' ? -cmp : cmp;
          });
        }

        // If $first is true, return only the first item (not an array)
        if (first) {
          const firstItem = filtered[0] || null;
          if (firstItem && fields) {
            const picked = resolveFieldsForItem(firstItem, fields, context);
            setNestedValue(result, targetKey, picked);
          } else {
            setNestedValue(result, targetKey, firstItem);
          }
        } else if (fields) {
          // Pick specific fields from each filtered item
          const mapped = filtered.map((item) => resolveFieldsForItem(item, fields, context));
          setNestedValue(result, targetKey, mapped);
        } else {
          setNestedValue(result, targetKey, filtered);
        }
      }
      // Check for $first directive: sort array and return first item
      else if (typeof obj['$source'] === 'string' && '$sortBy' in obj && !('$pick' in obj)) {
        const source = resolveValue(obj['$source'] as string, context);
        const sortBy = obj['$sortBy'] as string;
        const order = (obj['$order'] as string) || 'desc';
        const pick = obj['$fields'] as Record<string, string> | undefined;

        let items: unknown[] = [];
        if (Array.isArray(source)) {
          items = [...source];
        } else if (source !== null && typeof source === 'object') {
          items = Object.values(source as Record<string, unknown>);
        }

        // Sort by the specified field
        items.sort((a, b) => {
          const aResults = JSONPath({ path: `$.${sortBy}`, json: a as object });
          const bResults = JSONPath({ path: `$.${sortBy}`, json: b as object });
          const aVal = aResults.length > 0 ? String(aResults[0]) : '';
          const bVal = bResults.length > 0 ? String(bResults[0]) : '';
          const cmp = aVal.localeCompare(bVal);
          return order === 'desc' ? -cmp : cmp;
        });

        const firstItem = items[0] || null;

        if (firstItem && pick) {
          const picked = resolveFieldsForItem(firstItem, pick, context);
          setNestedValue(result, targetKey, picked);
        } else {
          setNestedValue(result, targetKey, firstItem);
        }
      }
      // Check for $map directive: transforms each item in an array
      else if (typeof obj['$source'] === 'string' && obj['$pick'] !== undefined) {
        const mapped = applyArrayMap(obj, context);
        setNestedValue(result, targetKey, mapped);
      } else {
        // Recursively resolve nested mapping objects
        const nested = applyMapping(obj, context);
        setNestedValue(result, targetKey, nested);
      }
    } else {
      // Arrays or other primitives — pass through as-is
      setNestedValue(result, targetKey, sourceExpr);
    }
  }

  return result;
}

/**
 * Apply an array map transformation.
 * Config format:
 * {
 *   "$source": "$steps.get-meters.body",   // expression resolving to an array
 *   "$pick": {                              // fields to extract from each item
 *     "id": "$.id",
 *     "name": "$.name",
 *     "nested.field": "$.deep.value"
 *   }
 * }
 *
 * Each item in the source array is mapped through $pick using JSONPath relative to the item.
 */
export function applyArrayMap(config: Record<string, unknown>, context: OrchestrationContext): unknown[] {
  const sourceExpr = config['$source'] as string;
  const pickMapping = config['$pick'] as Record<string, string>;
  const filterConfig = config['$filter'] as { field: string; operator: string; value?: unknown } | undefined;
  const limit = config['$limit'] as number | undefined;

  if (!sourceExpr || !pickMapping) return [];

  // Resolve the source array
  const source = resolveValue(sourceExpr, context);
  let items: { key: string | number; value: unknown }[];

  if (Array.isArray(source)) {
    items = source.map((value, index) => ({ key: index, value }));
  } else if (source !== null && typeof source === 'object') {
    items = Object.entries(source as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  } else {
    return [];
  }

  // Apply filter if specified
  if (filterConfig) {
    items = items.filter(({ value: filterItem }) => {
      const results = JSONPath({ path: `$.${filterConfig.field}`, json: filterItem as object });
      const actualValue = results.length > 0 ? results[0] : undefined;

      switch (filterConfig.operator) {
        case 'gt': return Number(actualValue) > Number(filterConfig.value);
        case 'gte': return Number(actualValue) >= Number(filterConfig.value);
        case 'lt': return Number(actualValue) < Number(filterConfig.value);
        case 'lte': return Number(actualValue) <= Number(filterConfig.value);
        case 'eq': return actualValue == filterConfig.value;
        case 'neq': return actualValue != filterConfig.value;
        case 'exists': return actualValue !== undefined && actualValue !== null;
        case 'not-exists': return actualValue === undefined || actualValue === null;
        case 'contains': return typeof actualValue === 'string' && actualValue.includes(String(filterConfig.value));
        case 'in-past': return actualValue ? new Date(String(actualValue)).getTime() < Date.now() : false;
        case 'in-future': return actualValue ? new Date(String(actualValue)).getTime() > Date.now() : false;
        default: return true;
      }
    });
  }

  // Apply cross-step filter if specified (filters based on aligned data from another step)
  const crossFilter = config['$crossFilter'] as { source: string; field: string; operator: string; value?: unknown } | { rules: Array<{ conditions: Array<{ field: string; source?: string; operator: string; value?: unknown }>}> } | undefined;
  if (crossFilter) {
    const crossSource = resolveValue((crossFilter as any).source, context);
    
    // Check if it's a multi-rule filter (OR logic between rules, AND within each rule)
    if ('rules' in crossFilter) {
      const rules = (crossFilter as any).rules as Array<{ conditions: Array<{ field: string; source?: string; operator: string; value?: unknown }> }>;
      items = items.filter(({ value: filterItem, key }, idx) => {
        try {
          const originalIdx = typeof key === 'number' ? key : idx;
          // OR between rules — first matching rule passes the item
          return rules.some((rule) => {
            // AND between conditions within a rule
            return rule.conditions.every((cond) => {
              let actualValue: unknown;
              if (cond.source) {
                // Cross-step reference
                const crossSrc = resolveValue(cond.source, context);
                const crossItem = Array.isArray(crossSrc) ? crossSrc[originalIdx] : crossSrc;
                if (!crossItem || typeof crossItem !== 'object') return false;
                const results = JSONPath({ path: `$.${cond.field}`, json: crossItem as object });
                actualValue = results.length > 0 ? results[0] : undefined;
              } else {
                // Field on the source item itself
                const results = JSONPath({ path: `$.${cond.field}`, json: filterItem as object });
                actualValue = results.length > 0 ? results[0] : undefined;
              }

              switch (cond.operator) {
                case 'eq': return actualValue == cond.value;
                case 'neq': return actualValue != cond.value;
                case 'gt': return Number(actualValue) > Number(cond.value);
                case 'lt': return Number(actualValue) < Number(cond.value);
                case 'exists': return actualValue !== undefined && actualValue !== null;
                case 'not-exists': return actualValue === undefined || actualValue === null;
                default: return true;
              }
            });
          });
        } catch (err) {
          console.error(`[$crossFilter] Error at idx ${idx}:`, err);
          return true;
        }
      });
      console.log(`[$crossFilter] After multi-rule filter: ${items.length} items remain`);
    } else if (Array.isArray(crossSource)) {
      // Simple single-condition cross filter
      items = items.filter(({ key }, idx) => {
        try {
          const originalIdx = typeof key === 'number' ? key : idx;
          const crossItem = crossSource[originalIdx];
          if (!crossItem || typeof crossItem !== 'object') return true;

          const results = JSONPath({ path: `$.${(crossFilter as any).field}`, json: crossItem as object });
          const actualValue = results.length > 0 ? results[0] : undefined;

          switch ((crossFilter as any).operator) {
            case 'eq': return actualValue == (crossFilter as any).value;
            case 'neq': return actualValue != (crossFilter as any).value;
            case 'gt': return Number(actualValue) > Number((crossFilter as any).value);
            case 'lt': return Number(actualValue) < Number((crossFilter as any).value);
            case 'exists': return actualValue !== undefined && actualValue !== null;
            case 'not-exists': return actualValue === undefined || actualValue === null;
            default: return true;
          }
        } catch (err) {
          console.error(`[$crossFilter] Error at idx ${idx}:`, err);
          return true;
        }
      });
      console.log(`[$crossFilter] After filter: ${items.length} items remain`);
    }
  }

  // Apply limit if specified
  if (limit !== undefined && limit > 0) {
    items = items.slice(0, limit);
  }

  // Map each item through the pick fields
  return items.map(({ key, value: item }, index) => {
    const mapped: Record<string, unknown> = {};
    for (const [targetField, itemExpr] of Object.entries(pickMapping)) {
      if (itemExpr === '$key') {
        // Special: return the object key name (e.g. "Gas", "Electricity")
        setNestedValue(mapped, targetField, key);
      } else if (itemExpr === '$index') {
        // Special: return the current index
        setNestedValue(mapped, targetField, index);
      } else if (typeof itemExpr === 'string' && itemExpr.startsWith('$keyOf:')) {
        // Special: return the first key name of an object at the given path
        const objPath = itemExpr.slice('$keyOf:'.length).trim();
        let targetObj: unknown;
        if (objPath === '$') {
          targetObj = item;
        } else if (objPath.startsWith('$.')) {
          const results = JSONPath({ path: objPath, json: item as object });
          targetObj = results.length > 0 ? results[0] : undefined;
        } else {
          targetObj = item;
        }
        if (targetObj && typeof targetObj === 'object' && !Array.isArray(targetObj)) {
          const keys = Object.keys(targetObj as Record<string, unknown>);
          setNestedValue(mapped, targetField, keys[0] || null);
        } else {
          setNestedValue(mapped, targetField, null);
        }
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$coalesce' in (itemExpr as Record<string, unknown>)) {
        // Special: try multiple expressions, return first non-null value
        const coalesceConfig = itemExpr as { $coalesce: string[] };
        let resolvedValue: unknown = undefined;
        for (const expr of coalesceConfig.$coalesce) {
          if (typeof expr === 'string' && expr.startsWith('$.')) {
            const results = JSONPath({ path: expr, json: item as object });
            if (results.length > 0 && results[0] !== undefined && results[0] !== null) {
              resolvedValue = results[0];
              break;
            }
          } else if (typeof expr === 'string') {
            const val = resolveValue(expr, context);
            if (val !== undefined && val !== null) {
              resolvedValue = val;
              break;
            }
          }
        }
        if (resolvedValue !== undefined) {
          setNestedValue(mapped, targetField, resolvedValue);
        }
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$concat' in (itemExpr as Record<string, unknown>)) {
        // Special: concatenate multiple values with a separator
        const concatConfig = itemExpr as { $concat: string[]; $separator?: string };
        const separator = concatConfig.$separator ?? ' ';
        const parts: string[] = [];
        for (const expr of concatConfig.$concat) {
          if (typeof expr === 'string' && expr.startsWith('$.')) {
            const results = JSONPath({ path: expr, json: item as object });
            if (results.length > 0 && results[0] !== undefined && results[0] !== null) {
              parts.push(String(results[0]));
            }
          } else if (typeof expr === 'string') {
            // Could be a literal or a context expression
            if (expr.startsWith('$')) {
              const val = resolveValue(expr, context);
              if (val !== undefined && val !== null) {
                parts.push(String(val));
              }
            } else {
              parts.push(expr);
            }
          }
        }
        setNestedValue(mapped, targetField, parts.join(separator));
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$derive' in (itemExpr as Record<string, unknown>)) {
        // Special: derive a value based on multiple conditions (rules evaluated in order, first match wins)
        const deriveConfig = itemExpr as { $derive: { conditions: { field: string; operator: string; value?: unknown }[]; result: unknown }[]; $default?: unknown };
        let derivedValue: unknown = deriveConfig.$default ?? null;

        for (const rule of deriveConfig.$derive) {
          // All conditions in a rule must be true (AND logic)
          const allConditionsMet = rule.conditions.every((cond) => {
            const results = JSONPath({ path: `$.${cond.field}`, json: item as object });
            const actualValue = results.length > 0 ? results[0] : undefined;

            switch (cond.operator) {
              case 'eq': return actualValue == cond.value;
              case 'neq': return actualValue != cond.value;
              case 'gt': return Number(actualValue) > Number(cond.value);
              case 'lt': return Number(actualValue) < Number(cond.value);
              case 'exists': return actualValue !== undefined && actualValue !== null;
              case 'not-exists': return actualValue === undefined || actualValue === null;
              case 'in-past': {
                if (!actualValue) return false;
                return new Date(String(actualValue)).getTime() < Date.now();
              }
              case 'in-future': {
                if (!actualValue) return false;
                return new Date(String(actualValue)).getTime() > Date.now();
              }
              default: return false;
            }
          });

          if (allConditionsMet) {
            derivedValue = resolveDerivResult(rule.result, item, key, index, context);
            break;
          }
        }

        setNestedValue(mapped, targetField, derivedValue);
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$dateAdd' in (itemExpr as Record<string, unknown>) && '$date' in (itemExpr as Record<string, unknown>)) {
        // Date arithmetic
        const dateConfig = itemExpr as { $date: string; $dateAdd: { days?: number; months?: number; years?: number }; $format?: string };
        let dateValue: unknown;
        if (dateConfig.$date.startsWith('$.')) {
          const results = JSONPath({ path: dateConfig.$date, json: item as object });
          dateValue = results.length > 0 ? results[0] : undefined;
        } else {
          dateValue = resolveValue(dateConfig.$date, context);
        }
        setNestedValue(mapped, targetField, computeDateAdd(dateValue, dateConfig.$dateAdd, dateConfig.$format));
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$datePart' in (itemExpr as Record<string, unknown>) && '$date' in (itemExpr as Record<string, unknown>)) {
        // Extract a part of a date (day, month, year, etc.)
        const datePartConfig = itemExpr as { $date: string; $datePart: string };
        let dateValue: unknown;
        if (datePartConfig.$date.startsWith('$.')) {
          const results = JSONPath({ path: datePartConfig.$date, json: item as object });
          dateValue = results.length > 0 ? results[0] : undefined;
        } else {
          dateValue = resolveValue(datePartConfig.$date, context);
        }
        setNestedValue(mapped, targetField, extractDatePart(dateValue, datePartConfig.$datePart));
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$calc' in (itemExpr as Record<string, unknown>)) {
        // Arithmetic calculation
        const calcConfig = (itemExpr as any).$calc as { left: unknown; operator: string; right: unknown; $round?: number };
        setNestedValue(mapped, targetField, computeCalc(calcConfig, item, context));
      } else if (typeof itemExpr === 'string' && itemExpr.startsWith('$context.')) {
        // Full context reference — resolves against the entire orchestration context
        const contextPath = `$.${itemExpr.slice('$context.'.length)}`;
        const results = JSONPath({ path: contextPath, json: context as unknown as object });
        const value = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
        setNestedValue(mapped, targetField, value);
      } else if (typeof itemExpr === 'string' && itemExpr.startsWith('$.')) {
        // JSONPath relative to the current item
        const results = JSONPath({ path: itemExpr, json: item as object });
        const value = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
        setNestedValue(mapped, targetField, value);
      } else if (typeof itemExpr === 'string' && itemExpr.includes('[$$]')) {
        // Special: replace [$$] with original key/index for cross-referencing other steps
        const originalIdx = typeof key === 'number' ? key : index;
        const resolvedExpr = itemExpr.replace(/\[\$\$\]/g, `[${originalIdx}]`);
        const value = resolveValue(resolvedExpr, context);
        // If the cross-referenced value is null (filtered/skipped item), omit the field
        if (value === null || value === undefined) {
          continue;
        }
        setNestedValue(mapped, targetField, value);
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$source' in (itemExpr as Record<string, unknown>) && '$sortBy' in (itemExpr as Record<string, unknown>) && !('$pick' in (itemExpr as Record<string, unknown>))) {
        // Nested $source/$sortBy/$fields for sorting and picking first item from a cross-referenced array
        const nestedConfig = itemExpr as Record<string, unknown>;
        const nestedOriginalIdx = typeof key === 'number' ? key : index;
        let nestedSourceExpr = nestedConfig['$source'] as string;
        if (nestedSourceExpr.includes('[$$]')) {
          nestedSourceExpr = nestedSourceExpr.replace(/\[\$\$\]/g, `[${nestedOriginalIdx}]`);
        }
        let nestedSource: unknown;
        if (nestedSourceExpr.startsWith('$.')) {
          const results = JSONPath({ path: nestedSourceExpr, json: item as object });
          nestedSource = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
        } else {
          nestedSource = resolveValue(nestedSourceExpr, context);
        }
        let nestedItems: unknown[] = [];
        if (Array.isArray(nestedSource)) {
          nestedItems = [...nestedSource];
        } else if (nestedSource !== null && typeof nestedSource === 'object') {
          nestedItems = Object.values(nestedSource as Record<string, unknown>);
        }
        const sortBy = nestedConfig['$sortBy'] as string;
        const order = (nestedConfig['$order'] as string) || 'desc';
        const fields = nestedConfig['$fields'] as Record<string, unknown> | undefined;
        // Sort
        nestedItems.sort((a, b) => {
          const aResults = JSONPath({ path: `$.${sortBy}`, json: a as object });
          const bResults = JSONPath({ path: `$.${sortBy}`, json: b as object });
          const aVal = aResults.length > 0 ? String(aResults[0]) : '';
          const bVal = bResults.length > 0 ? String(bResults[0]) : '';
          const cmp = aVal.localeCompare(bVal);
          return order === 'desc' ? -cmp : cmp;
        });
        const firstItem = nestedItems[0] || null;
        if (firstItem && fields) {
          const picked: Record<string, unknown> = {};
          for (const [fKey, fExpr] of Object.entries(fields)) {
            if (typeof fExpr === 'string' && fExpr.startsWith('$.')) {
              const r = JSONPath({ path: fExpr, json: firstItem as object });
              picked[fKey] = r.length === 1 ? r[0] : undefined;
            } else if (typeof fExpr === 'object' && fExpr !== null && '$date' in (fExpr as Record<string, unknown>) && '$datePart' in (fExpr as Record<string, unknown>)) {
              // Support $datePart inside $fields
              const dateConfig = fExpr as { $date: string; $datePart: string };
              let dateValue: unknown;
              if (dateConfig.$date.startsWith('$.')) {
                const r = JSONPath({ path: dateConfig.$date, json: firstItem as object });
                dateValue = r.length > 0 ? r[0] : undefined;
              } else {
                dateValue = dateConfig.$date;
              }
              picked[fKey] = extractDatePart(dateValue, dateConfig.$datePart);
            } else {
              picked[fKey] = fExpr;
            }
          }
          setNestedValue(mapped, targetField, picked);
        } else {
          setNestedValue(mapped, targetField, firstItem);
        }
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$source' in (itemExpr as Record<string, unknown>) && '$pick' in (itemExpr as Record<string, unknown>)) {
        // Nested $source/$pick for sub-arrays within each item
        const nestedConfig = itemExpr as Record<string, unknown>;
        // Replace [$$] in nested $source with the original key/index
        const nestedOriginalIdx = typeof key === 'number' ? key : index;
        let nestedSourceExpr = nestedConfig['$source'] as string;
        if (nestedSourceExpr.includes('[$$]')) {
          nestedSourceExpr = nestedSourceExpr.replace(/\[\$\$\]/g, `[${nestedOriginalIdx}]`);
        }
        // Resolve the nested source — could be relative to item ($.) or absolute ($steps.)
        let nestedSource: unknown;
        if (nestedSourceExpr.startsWith('$.')) {
          const results = JSONPath({ path: nestedSourceExpr, json: item as object });
          nestedSource = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
        } else {
          nestedSource = resolveValue(nestedSourceExpr, context);
        }
        // Build nested items array
        let nestedItems: { key: string | number; value: unknown }[];
        if (Array.isArray(nestedSource)) {
          nestedItems = nestedSource.map((v, i) => ({ key: i, value: v }));
        } else if (nestedSource !== null && typeof nestedSource === 'object') {
          nestedItems = Object.entries(nestedSource as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v }));
        } else {
          nestedItems = [];
        }
        const nestedPick = nestedConfig['$pick'] as Record<string, unknown>;
        const nestedResult = nestedItems.map(({ key: nKey, value: nItem }, nIndex) => {
          const nMapped: Record<string, unknown> = {};
          for (const [nTarget, nExpr] of Object.entries(nestedPick)) {
            if (nExpr === '$key') {
              setNestedValue(nMapped, nTarget, nKey);
            } else if (nExpr === '$parentKey') {
              setNestedValue(nMapped, nTarget, key);
            } else if (nExpr === '$index') {
              setNestedValue(nMapped, nTarget, nIndex);
            } else if (typeof nExpr === 'string' && (nExpr as string).startsWith('$keyOf:')) {
              // Return the first key name of the parent item (the object this nested pick is inside)
              const objPath = (nExpr as string).slice('$keyOf:'.length).trim();
              let targetObj: unknown;
              if (objPath === '$' || objPath === '$parent') {
                targetObj = item;
              } else if (objPath.startsWith('$.')) {
                const results = JSONPath({ path: objPath, json: nItem as object });
                targetObj = results.length > 0 ? results[0] : undefined;
              } else if (objPath.startsWith('$parent.')) {
                const parentPath = `$.${objPath.slice('$parent.'.length)}`;
                const results = JSONPath({ path: parentPath, json: item as object });
                targetObj = results.length > 0 ? results[0] : undefined;
              } else {
                targetObj = item;
              }
              if (targetObj && typeof targetObj === 'object' && !Array.isArray(targetObj)) {
                const keys = Object.keys(targetObj as Record<string, unknown>);
                setNestedValue(nMapped, nTarget, keys[0] || null);
              } else {
                setNestedValue(nMapped, nTarget, null);
              }
            } else if (typeof nExpr === 'string' && nExpr.startsWith('$.')) {
              const results = JSONPath({ path: nExpr, json: nItem as object });
              const val = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
              setNestedValue(nMapped, nTarget, val);
            } else if (typeof nExpr === 'string' && nExpr.includes('[$$]')) {
              // Cross-reference other steps using parent's original index
              const nOriginalIdx = typeof key === 'number' ? key : index;
              const resolvedExpr = nExpr.replace(/\[\$\$\]/g, `[${nOriginalIdx}]`);
              const val = resolveValue(resolvedExpr, context);
              if (val !== null && val !== undefined) {
                setNestedValue(nMapped, nTarget, val);
              }
            } else if (typeof nExpr === 'object' && nExpr !== null && '$switch' in (nExpr as Record<string, unknown>)) {
              const sw = nExpr as { $switch: string; $cases: Record<string, unknown>; $default?: unknown };
              let swVal: unknown;
              if (sw.$switch === '$key') swVal = nKey;
              else if (sw.$switch === '$parentKey') swVal = key;
              else if (sw.$switch.startsWith('$.')) {
                const r = JSONPath({ path: sw.$switch, json: nItem as object });
                swVal = r.length === 1 ? r[0] : undefined;
              } else {
                swVal = resolveValue(sw.$switch, context);
              }
              const matched = sw.$cases[String(swVal)];
              setNestedValue(nMapped, nTarget, matched !== undefined ? matched : (sw.$default ?? null));
            } else if (typeof nExpr === 'object' && nExpr !== null && '$concat' in (nExpr as Record<string, unknown>)) {
              const concatConfig = nExpr as { $concat: string[]; $separator?: string };
              const separator = concatConfig.$separator ?? ' ';
              const parts: string[] = [];
              for (const expr of concatConfig.$concat) {
                if (typeof expr === 'string' && expr.startsWith('$parent.')) {
                  // Access parent item fields
                  const parentPath = `$.${expr.slice('$parent.'.length)}`;
                  const results = JSONPath({ path: parentPath, json: item as object });
                  if (results.length > 0 && results[0] !== undefined && results[0] !== null) {
                    parts.push(String(results[0]));
                  }
                } else if (typeof expr === 'string' && expr.startsWith('$.')) {
                  const results = JSONPath({ path: expr, json: nItem as object });
                  if (results.length > 0 && results[0] !== undefined && results[0] !== null) {
                    parts.push(String(results[0]));
                  }
                } else if (typeof expr === 'string') {
                  if (expr.startsWith('$')) {
                    const val = resolveValue(expr, context);
                    if (val !== undefined && val !== null) parts.push(String(val));
                  } else {
                    parts.push(expr);
                  }
                }
              }
              setNestedValue(nMapped, nTarget, parts.join(separator));
            } else if (typeof nExpr === 'string' && nExpr.startsWith('$parent.')) {
              // Access parent item fields directly
              const parentPath = `$.${nExpr.slice('$parent.'.length)}`;
              const results = JSONPath({ path: parentPath, json: item as object });
              const val = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
              setNestedValue(nMapped, nTarget, val);
            } else if (typeof nExpr === 'object' && nExpr !== null && '$source' in (nExpr as Record<string, unknown>) && '$pick' in (nExpr as Record<string, unknown>)) {
              // Third-level nested $source/$pick (with optional $expand)
              const deepConfig = nExpr as Record<string, unknown>;
              let deepSourceExpr = deepConfig['$source'] as string;
              const expandExpr = deepConfig['$expand'] as string | undefined;
              const deepPick = deepConfig['$pick'] as Record<string, string>;

              // Resolve source — $parent. references parent item, $. references current nested item
              let deepSource: unknown;
              if (deepSourceExpr.startsWith('$parent.')) {
                const parentPath = `$.${deepSourceExpr.slice('$parent.'.length)}`;
                const results = JSONPath({ path: parentPath, json: item as object });
                deepSource = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
              } else if (deepSourceExpr.startsWith('$.')) {
                const results = JSONPath({ path: deepSourceExpr, json: nItem as object });
                deepSource = results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
              } else {
                deepSource = resolveValue(deepSourceExpr, context);
              }
              // Build array from source
              let deepItems: unknown[];
              if (Array.isArray(deepSource)) {
                deepItems = deepSource;
              } else if (deepSource !== null && typeof deepSource === 'object') {
                deepItems = Object.values(deepSource as Record<string, unknown>);
              } else {
                deepItems = [];
              }

              // If $expand is specified, flatten items that have the expand array
              let expandedItems: { sourceItem: unknown; expandItem: unknown }[];
              if (expandExpr) {
                expandedItems = [];
                for (const dItem of deepItems) {
                  const expandResults = JSONPath({ path: expandExpr, json: dItem as object });
                  const expandArray = expandResults.length > 0 ? expandResults[0] : undefined;
                  if (Array.isArray(expandArray) && expandArray.length > 0) {
                    // One output per expand item
                    for (const eItem of expandArray) {
                      expandedItems.push({ sourceItem: dItem, expandItem: eItem });
                    }
                  } else {
                    // No expand array — produce single output with expandItem = sourceItem
                    expandedItems.push({ sourceItem: dItem, expandItem: dItem });
                  }
                }
              } else {
                expandedItems = deepItems.map((dItem) => ({ sourceItem: dItem, expandItem: dItem }));
              }

              const deepResult = expandedItems.map(({ sourceItem, expandItem }) => {
                const dMapped: Record<string, unknown> = {};
                for (const [dTarget, dExpr] of Object.entries(deepPick)) {
                  if (typeof dExpr === 'string' && dExpr.startsWith('$.')) {
                    // $. resolves against expandItem (the inner item when expanded)
                    const results = JSONPath({ path: dExpr, json: expandItem as object });
                    dMapped[dTarget] = results.length === 1 ? results[0] : undefined;
                  } else if (typeof dExpr === 'string' && dExpr.startsWith('$item.')) {
                    // $item. resolves against the source item (the product)
                    const itemPath = `$.${dExpr.slice('$item.'.length)}`;
                    const results = JSONPath({ path: itemPath, json: sourceItem as object });
                    dMapped[dTarget] = results.length === 1 ? results[0] : undefined;
                  } else if (typeof dExpr === 'string' && dExpr.startsWith('$parent.')) {
                    const parentPath = `$.${dExpr.slice('$parent.'.length)}`;
                    const results = JSONPath({ path: parentPath, json: item as object });
                    dMapped[dTarget] = results.length === 1 ? results[0] : undefined;
                  } else if (typeof dExpr === 'object' && dExpr !== null && '$coalesce' in (dExpr as Record<string, unknown>)) {
                    const coalesceConfig = dExpr as { $coalesce: string[] };
                    let resolved: unknown = undefined;
                    for (const expr of coalesceConfig.$coalesce) {
                      if (typeof expr === 'string' && expr.startsWith('$.')) {
                        const r = JSONPath({ path: expr, json: expandItem as object });
                        if (r.length > 0 && r[0] !== undefined && r[0] !== null) { resolved = r[0]; break; }
                      } else if (typeof expr === 'string' && expr.startsWith('$item.')) {
                        const p = `$.${expr.slice('$item.'.length)}`;
                        const r = JSONPath({ path: p, json: sourceItem as object });
                        if (r.length > 0 && r[0] !== undefined && r[0] !== null) { resolved = r[0]; break; }
                      }
                    }
                    if (resolved !== undefined) dMapped[dTarget] = resolved;
                  } else if (typeof dExpr === 'object' && dExpr !== null && '$switch' in (dExpr as Record<string, unknown>)) {
                    const sw = dExpr as { $switch: string; $cases: Record<string, unknown>; $default?: unknown };
                    let swVal: unknown;
                    if (sw.$switch.startsWith('$.')) {
                      const r = JSONPath({ path: sw.$switch, json: expandItem as object });
                      swVal = r.length === 1 ? r[0] : undefined;
                    } else if (sw.$switch.startsWith('$item.')) {
                      const p = `$.${sw.$switch.slice('$item.'.length)}`;
                      const r = JSONPath({ path: p, json: sourceItem as object });
                      swVal = r.length === 1 ? r[0] : undefined;
                    } else if (sw.$switch.startsWith('$parent.')) {
                      const p = `$.${sw.$switch.slice('$parent.'.length)}`;
                      const r = JSONPath({ path: p, json: item as object });
                      swVal = r.length === 1 ? r[0] : undefined;
                    } else {
                      swVal = resolveValue(sw.$switch, context);
                    }
                    const matched = sw.$cases[String(swVal)];
                    dMapped[dTarget] = matched !== undefined ? matched : (sw.$default ?? null);
                  } else {
                    // Try to resolve as a $steps expression or literal
                    if (typeof dExpr === 'string' && dExpr.startsWith('$steps.')) {
                      const val = resolveValue(dExpr, context);
                      dMapped[dTarget] = val !== undefined ? val : dExpr;
                    } else {
                      dMapped[dTarget] = dExpr;
                    }
                  }
                }
                return dMapped;
              });
              setNestedValue(nMapped, nTarget, deepResult);
            } else {
              const val = typeof nExpr === 'string' ? resolveValue(nExpr, context) : nExpr;
              setNestedValue(nMapped, nTarget, val);
            }
          }
          return nMapped;
        });
        setNestedValue(mapped, targetField, nestedResult);
      } else if (typeof itemExpr === 'object' && itemExpr !== null && '$switch' in (itemExpr as Record<string, unknown>)) {
        // Special: conditional value mapping based on another field
        const switchConfig = itemExpr as { $switch: string; $cases: Record<string, unknown>; $default?: unknown };
        let switchValue: unknown;
        if (switchConfig.$switch === '$key') {
          switchValue = key;
        } else if (switchConfig.$switch === '$index') {
          switchValue = index;
        } else if (switchConfig.$switch.startsWith('$.')) {
          const results = JSONPath({ path: switchConfig.$switch, json: item as object });
          switchValue = results.length === 1 ? results[0] : undefined;
        } else {
          switchValue = resolveValue(switchConfig.$switch, context);
        }
        const matchedValue = switchConfig.$cases[String(switchValue)];
        const finalValue = matchedValue !== undefined ? matchedValue : (switchConfig.$default ?? null);
        setNestedValue(mapped, targetField, finalValue);
      } else {
        // Literal or full context expression
        const value = typeof itemExpr === 'string' ? resolveValue(itemExpr, context) : itemExpr;
        setNestedValue(mapped, targetField, value);
      }
    }
    return mapped;
  });
}

/**
 * Resolve a URL path template: /users/:id or /users/{{$.inboundRequest.params.id}}
 */
export function resolvePath(pathTemplate: string, context: OrchestrationContext): string {
  // Replace :param style with values from inbound params
  let resolved = pathTemplate.replace(/:([a-zA-Z_]\w*)/g, (_match, paramName) => {
    const value = context.inboundRequest.params[paramName];
    return value !== undefined ? encodeURIComponent(String(value)) : `:${paramName}`;
  });

  // Replace {{expression}} style templates
  resolved = resolved.replace(/\{\{(.+?)\}\}/g, (_match, expr) => {
    const value = resolveValue(expr.trim(), context);
    if (value === undefined) return '';
    const strValue = String(value);
    // Don't encode if the value is a full URL (used for absolute URL pass-through)
    if (strValue.startsWith('http://') || strValue.startsWith('https://')) {
      return strValue;
    }
    return encodeURIComponent(strValue);
  });

  return resolved;
}

/**
 * Build the final response body from a response mapping.
 */
export function buildResponse(
  mapping: Record<string, unknown>,
  context: OrchestrationContext
): Record<string, unknown> {
  return applyMapping(mapping, context);
}

/**
 * Resolve $fields for a single item, supporting:
 * - "$.field" — JSONPath relative to item
 * - { "$daysSince": "$.dateField" } — days between a date field and today
 * - literal strings
 */
function resolveFieldsForItem(item: unknown, fields: Record<string, unknown>, context?: OrchestrationContext): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(fields)) {
    if (typeof expr === 'string' && expr.startsWith('$.')) {
      const results = JSONPath({ path: expr, json: item as object });
      picked[field] = results.length === 1 ? results[0] : undefined;
    } else if (typeof expr === 'object' && expr !== null && '$daysSince' in (expr as Record<string, unknown>)) {
      // Calculate days between a date field and today
      const config = expr as { $daysSince: string };
      const dateExpr = config.$daysSince;
      let dateValue: string | undefined;
      if (dateExpr.startsWith('$.')) {
        const results = JSONPath({ path: dateExpr, json: item as object });
        dateValue = results.length > 0 ? String(results[0]) : undefined;
      }
      if (dateValue) {
        const then = new Date(dateValue).getTime();
        const now = Date.now();
        const daysDiff = Math.floor((now - then) / (1000 * 60 * 60 * 24));
        picked[field] = daysDiff;
      } else {
        picked[field] = undefined;
      }
    } else if (typeof expr === 'object' && expr !== null && '$dateAdd' in (expr as Record<string, unknown>) && '$date' in (expr as Record<string, unknown>)) {
      // Date arithmetic
      const dateConfig = expr as { $date: string; $dateAdd: { days?: number; months?: number; years?: number }; $format?: string };
      let dateValue: unknown;
      if (dateConfig.$date.startsWith('$.')) {
        const results = JSONPath({ path: dateConfig.$date, json: item as object });
        dateValue = results.length > 0 ? results[0] : undefined;
      } else {
        dateValue = dateConfig.$date;
      }
      picked[field] = computeDateAdd(dateValue, dateConfig.$dateAdd, dateConfig.$format);
    } else if (typeof expr === 'object' && expr !== null && '$calc' in (expr as Record<string, unknown>)) {
      // Arithmetic calculation
      const calcConfig = (expr as any).$calc as { left: unknown; operator: string; right: unknown; $round?: number };
      picked[field] = computeCalc(calcConfig, item, context!);
    } else if (typeof expr === 'string') {
      picked[field] = expr;
    } else {
      picked[field] = expr;
    }
  }
  return picked;
}

/**
/**
 * Resolve expressions within a $derive result value.
 * Handles strings, arrays, and objects recursively.
 */
function resolveDerivResult(
  result: unknown,
  item: unknown,
  key: string | number,
  index: number,
  context: OrchestrationContext
): unknown {
  if (typeof result === 'string') {
    if (result.startsWith('$.')) {
      const results = JSONPath({ path: result, json: item as object });
      return results.length === 1 ? results[0] : results.length === 0 ? undefined : results;
    } else if (result.includes('[$$]')) {
      const originalIdx = typeof key === 'number' ? key : index;
      const resolvedExpr = result.replace(/\[\$\$\]/g, `[${originalIdx}]`);
      return resolveValue(resolvedExpr, context);
    } else if (result.startsWith('$')) {
      return resolveValue(result, context);
    }
    return result;
  } else if (Array.isArray(result)) {
    return result.map((item2) => resolveDerivResult(item2, item, key, index, context));
  } else if (result !== null && typeof result === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      resolved[k] = resolveDerivResult(v, item, key, index, context);
    }
    return resolved;
  }
  return result;
}

/**
 * Extract a part from a date value.
 * Supported parts: day, month, year, hour, minute, second, dayOfWeek, dayName, monthName, ordinal
 */
function extractDatePart(dateValue: unknown, part: string): string | number | null {
  if (!dateValue) return null;
  const date = new Date(String(dateValue));
  if (isNaN(date.getTime())) return null;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  switch (part) {
    case 'day': return date.getDate();
    case 'month': return date.getMonth() + 1;
    case 'year': return date.getFullYear();
    case 'hour': return date.getHours();
    case 'minute': return date.getMinutes();
    case 'second': return date.getSeconds();
    case 'dayOfWeek': return date.getDay();
    case 'dayName': return dayNames[date.getDay()];
    case 'monthName': return monthNames[date.getMonth()];
    case 'ordinal': {
      const d = date.getDate();
      const suffix = (d === 1 || d === 21 || d === 31) ? 'st' : (d === 2 || d === 22) ? 'nd' : (d === 3 || d === 23) ? 'rd' : 'th';
      return `${d}${suffix}`;
    }
    default: return null;
  }
}

/**
 * Compute date arithmetic: add days, months, or years to a date.
 * Returns ISO date string (YYYY-MM-DD) by default, or full ISO datetime if $format is "dateTime".
 */
function computeDateAdd(
  dateValue: unknown,
  add: { days?: number; months?: number; years?: number },
  format?: string
): string | null {
  if (!dateValue) return null;
  const date = new Date(String(dateValue));
  if (isNaN(date.getTime())) return null;

  if (add.days) date.setDate(date.getDate() + add.days);
  if (add.months) date.setMonth(date.getMonth() + add.months);
  if (add.years) date.setFullYear(date.getFullYear() + add.years);

  if (format === 'dateTime') {
    return date.toISOString();
  }
  if (format === 'localDateTime') {
    // Returns datetime without Z suffix: "2026-06-30T23:00:00.000"
    return date.toISOString().replace('Z', '');
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Compute arithmetic operations.
 * Config: { $calc: { left: "$.field" | number, operator: "+"|"-"|"*"|"/", right: "$.field" | number }, $round?: number }
 * Supports chaining: left/right can be nested $calc objects.
 */
function computeCalc(
  config: { left: unknown; operator: string; right: unknown; $round?: number },
  item: unknown,
  context: OrchestrationContext
): number | null {
  const leftVal = resolveCalcOperand(config.left, item, context);
  const rightVal = resolveCalcOperand(config.right, item, context);

  if (leftVal === null || rightVal === null) return null;

  let result: number;
  switch (config.operator) {
    case '+': result = leftVal + rightVal; break;
    case '-': result = leftVal - rightVal; break;
    case '*': result = leftVal * rightVal; break;
    case '/': result = rightVal !== 0 ? leftVal / rightVal : 0; break;
    case '%': result = rightVal !== 0 ? leftVal % rightVal : 0; break;
    default: return null;
  }

  if (config.$round !== undefined) {
    const factor = Math.pow(10, config.$round);
    result = Math.round(result * factor) / factor;
  }

  return result;
}

function resolveCalcOperand(operand: unknown, item: unknown, context: OrchestrationContext): number | null {
  if (typeof operand === 'number') return operand;
  if (typeof operand === 'string') {
    if (operand.startsWith('$.') && item) {
      const results = JSONPath({ path: operand, json: item as object });
      return results.length > 0 ? Number(results[0]) : null;
    } else if (operand.startsWith('$')) {
      const val = resolveValue(operand, context);
      return val !== undefined && val !== null ? Number(val) : null;
    }
    return Number(operand) || null;
  }
  // Nested $calc
  if (typeof operand === 'object' && operand !== null && 'operator' in (operand as Record<string, unknown>)) {
    return computeCalc(operand as any, item, context);
  }
  return null;
}

/**
 * Set a nested value using dot notation: "user.name" -> { user: { name: value } }
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

/**
 * Resolve $now built-in variables for dates and times.
 *
 * Supported:
 *   $now.date        → 2026-06-15
 *   $now.dateTime    → 2026-06-15T14:30:00.000Z
 *   $now.timestamp   → 1750000000000 (Unix ms)
 *   $now.year        → 2026
 *   $now.month       → 06
 *   $now.day         → 15
 *   $now.time        → 14:30:00
 */
function resolveNowVariable(expression: string): string | number {
  const now = new Date();

  switch (expression) {
    case '$now':
    case '$now.dateTime':
      return now.toISOString();
    case '$now.date':
      return now.toISOString().slice(0, 10);
    case '$now.timestamp':
      return now.getTime();
    case '$now.year':
      return String(now.getFullYear());
    case '$now.month':
      return String(now.getMonth() + 1).padStart(2, '0');
    case '$now.day':
      return String(now.getDate()).padStart(2, '0');
    case '$now.time':
      return now.toISOString().slice(11, 19);
    default:
      return now.toISOString();
  }
}
