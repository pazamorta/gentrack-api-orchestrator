# API Orchestrator — Response Mapping Reference

## Overview

Response mappings transform step results into the final API response. They support simple field references, array transformations, conditional logic, date manipulation, arithmetic, and cross-referencing between steps.

## Expression Types

### Simple References

```json
"fieldName": "$steps.step-1.body.name"
"fieldName": "$.inboundRequest.query.param"
"fieldName": "literal string"
"fieldName": 42
"fieldName": true
```

### Built-in Variables

| Expression        | Returns                  | Example              |
|-------------------|--------------------------|----------------------|
| `$now.date`       | Today's date             | `2026-07-23`         |
| `$now.dateTime`   | Current ISO datetime     | `2026-07-23T14:30:00.000Z` |
| `$now.timestamp`  | Unix timestamp (ms)      | `1784819422016`      |
| `$now.year`       | Current year             | `2026`               |
| `$now.month`      | Current month (zero-padded) | `07`              |

### Context References

| Expression                          | Use                                             |
|-------------------------------------|-------------------------------------------------|
| `$steps.stepId.body.field`          | Access step result body                         |
| `$steps.stepId.statusCode`          | Access step response status code                |
| `$.inboundRequest.params.id`        | Inbound URL parameter                           |
| `$.inboundRequest.query.param`      | Inbound query parameter                         |
| `$.inboundRequest.body.field`       | Inbound request body field (use in bodyTemplate)|
| `$context.inboundRequest.body.field` | Full context access (use in $pick values)      |
| `$item.field`                       | Current forEach item                            |
| `$parent.field`                     | Parent item (in nested $source/$pick)           |

### When to Use `$context.` vs `$.`

- In `bodyTemplate` and top-level response mapping `body`, use `$.inboundRequest.body.field` — resolved by `resolveValue` against the full context
- Inside `$pick` values within `$source/$pick` blocks, `$.field` resolves relative to the current item. To access the orchestration context from within a `$pick`, prefix with `$context.`:

```json
"$pick": {
  "itemField": "$.name",
  "requestedBy": "$context.inboundRequest.body.userId"
}
```

### Dot-Notation Keys

Keys with dots create nested objects:

```json
"service.type": "Electricity"
"service.external.id": "1234"
```

Produces:
```json
{
  "service": {
    "type": "Electricity",
    "external": { "id": "1234" }
  }
}
```

## Array Transformations ($source/$pick)

Transform an array of items into a new array shape.

```json
"accounts": {
  "$source": "$steps.step-1.body.results",
  "$pick": {
    "id": "$.number",
    "balance": "$.balance",
    "name": "$.name"
  }
}
```

### $source

Where to get the array. Supports:
- `$steps.stepId.body.results` — From a step result
- `$steps.stepId.body[*].results[*]` — Flattened nested arrays (see Array Wildcards)
- `$.inboundRequest.body.items` — From inbound request
- `$.fieldName` — Relative to current item (in nested contexts)

### $pick

Maps each item to a new shape:
- `"$.field"` — JSONPath relative to the current item
- `"literal"` — Static value
- `"$steps.step-1.body.field"` — Absolute context reference (via resolveValue)
- `"$context.inboundRequest.body.field"` — Full context reference (inside $pick only)
- `"$parent.field"` — Parent item reference (in nested $source/$pick)
- `"$steps.step-2.body[$$].field"` — Cross-reference by aligned index

### $filter

Filter items before mapping:

```json
{
  "$source": "$steps.step-1.body.results",
  "$filter": { "field": "status", "operator": "eq", "value": "Active" },
  "$pick": { "id": "$.id" }
}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `exists`, `not-exists`, `contains`, `in-past`, `in-future`

### $limit

Limit number of results:

```json
{
  "$source": "$steps.step-1.body.results",
  "$limit": 5,
  "$pick": { "id": "$.id" }
}
```

## Array Wildcards [*]

Use `[*]` in expressions to flatten nested arrays:

```json
"$source": "$steps.get-meterpoints.body[*].results[*]"
```

This traverses all items in `body`, collects all `results` arrays, and flattens them into a single array. Key behaviours:

- Always returns an array, even if only one match is found
- Prevents forEach from treating a single object as a dictionary of keys
- Can be chained: `body[*].items[*].children[*]`
- Works in `iterateOver`, `$source`, and general `resolveValue` calls

## Cross-Referencing with [$$]

When iterating over an array with `$source`/`$pick`, use `[$$]` to reference aligned data from a forEach step:

```json
"accounts": {
  "$source": "$steps.step-1.body.results",
  "$pick": {
    "globalId": "$.number",
    "lastBill": "$steps.step-2.body[$$].results[0].grossAmount"
  }
}
```

`[$$]` is replaced with the current iteration index, allowing you to cross-reference forEach results that are aligned with the source array.

This works because forEach steps produce arrays of results in the same order as the iterated source array.

## Nested $source/$pick

Nest array transformations within a $pick:

```json
"$pick": {
  "id": "$.id",
  "devices": {
    "$source": "$.meters",
    "$pick": {
      "serialNumber": "$.identifier",
      "parentType": "$parent.type"
    }
  }
}
```

### Reference Scoping in Nested Contexts

| Expression        | Resolves against                         |
|-------------------|------------------------------------------|
| `$.field`         | Current nested item (the meter)          |
| `$parent.field`   | Parent item (the account/meter point)    |
| `$item.field`     | Source item (in deeply nested contexts)  |
| `$context.field`  | Full orchestration context               |
| `$steps.x.body`   | Step results (absolute)                  |

### $parent References

In a nested `$source/$pick`, use `$parent.field` to access fields from the parent item that contains the nested array:

```json
"services": {
  "$source": "$steps.get-meterpoints-structure.body",
  "$pick": {
    "type": "$.type",
    "servicePoints": {
      "$source": "$.meters",
      "$pick": {
        "globalReference": "$parent.id",
        "connectionStatus": "$parent.supplyStatus",
        "serialNumber": "$.identifier"
      }
    }
  }
}
```

Here, `$parent.id` refers to the meter point structure item (the outer `$source` item), while `$.identifier` refers to the current meter (the inner `$source` item).

## $sortBy / $fields (First Item from Sorted Array)

Sort an array and return the first item with selected fields:

```json
"lastBill": {
  "$source": "$steps.step-2.body[$$].results",
  "$sortBy": "acceptedDttm",
  "$order": "desc",
  "$fields": {
    "billId": "$.id",
    "issueDate": "$.issueDt",
    "amount": "$.grossAmount"
  }
}
```

- `$sortBy` — Field to sort by
- `$order` — `"asc"` or `"desc"` (default: `"desc"`)
- `$fields` — Fields to pick from the first item after sorting
- Supports `[$$]` in `$source` for cross-referencing

### Nested $sortBy/$fields

Can be used inside a `$pick` with `[$$]` references for per-item sorted lookups:

```json
"$pick": {
  "accountId": "$.number",
  "latestBill": {
    "$source": "$steps.get-bills.body[$$].results",
    "$sortBy": "acceptedDttm",
    "$order": "desc",
    "$fields": {
      "billId": "$.id",
      "issueDate": {
        "$date": "$.issueDt",
        "$datePart": "date"
      },
      "amount": "$.grossAmount"
    }
  }
}
```

### $datePart in $fields

Strip time from date values within `$fields`:

```json
"$fields": {
  "dueDate": {
    "$date": "$.dueDt",
    "$datePart": "date"
  }
}
```

## $switch (Conditional Values)

Map a value to different outputs:

```json
"serviceType": {
  "$switch": "$.type",
  "$cases": {
    "MPAN": "Electricity",
    "MPRN": "Gas"
  },
  "$default": "Unknown"
}
```

Works in `$pick`, response mapping body, and nested contexts.

## Date Directives

### $dateAdd

Add/subtract time from a date:

```json
"reviewDate": {
  "$date": "$steps.step-1.body.fromDt",
  "$dateAdd": { "years": 1 },
  "$format": "date"
}
```

Supports: `days`, `months`, `years`
Formats: `"date"` (YYYY-MM-DD), `"dateTime"` (ISO), `"localDateTime"` (no timezone)

### $datePart

Extract part of a date:

```json
"billDate": {
  "$date": "$steps.step-1.body.issueDt",
  "$datePart": "date"
}
```

Parts: `"date"` (YYYY-MM-DD), `"year"`, `"month"`, `"day"`

## $calc (Arithmetic)

Perform calculations:

```json
"annualCost": {
  "$calc": {
    "left": "$steps.step-1.body.monthlyAmount",
    "operator": "*",
    "right": 12
  }
}
```

Operators: `+`, `-`, `*`, `/`
Optional: `$round` (decimal places)

## $concat (String Concatenation)

Join multiple values:

```json
"fullName": {
  "$concat": ["$steps.step-1.body.firstName", "$steps.step-1.body.lastName"],
  "$separator": " "
}
```

## Conditional Status Code

Return different status codes based on backend response:

```json
"statusCode": {
  "$source": "$steps.step-1.statusCode",
  "$when": [200, 204, 400],
  "$override": 200
}
```

If the backend returns a status in `$when`, the response returns `$override`. Otherwise, the actual status passes through.

Common use case: validation endpoints where backend returns 400 with error details, but you want to return 200 with transformed error data to the consumer.

## suppressErrorPassthrough

By default, if any step returns 4xx/5xx, the orchestrator short-circuits and returns the error directly. Set `suppressErrorPassthrough: true` on the route to always run response mapping:

```json
{
  "name": "Post Validate Meter Reads",
  "suppressErrorPassthrough": true,
  "steps": [...],
  "responseMapping": {
    "statusCode": { "$source": "$steps.step-1.statusCode", "$when": [200, 204, 400], "$override": 200 },
    "body": {
      "validationResponse": {
        "$source": "$steps.step-1.body.errors",
        "$pick": {
          "field": "$.field",
          "message": "$.message"
        }
      }
    }
  }
}
```

Useful for validation endpoints where 400 from the backend contains data you want to reshape for the caller.

## Raw Pass-Through

Skip JSON transformation and pass backend response directly:

```json
"responseMapping": {
  "rawPassthrough": "$steps.step-1"
}
```

Preserves original content-type (useful for binary/PDF responses).

## stripNulls

Remove null/undefined values from the response:

```json
"responseMapping": {
  "stripNulls": true,
  "body": { ... }
}
```

## Complete Example

```json
{
  "responseMapping": {
    "statusCode": 200,
    "stripNulls": true,
    "body": {
      "serviceSupplies": {
        "$source": "$steps.get-meterpoints-structure.body",
        "$pick": {
          "globalId": "$.identifier",
          "period.fromDateTime": "$.supplyStartDate",
          "service.serviceType": {
            "$switch": "$.type",
            "$cases": { "MPAN": "Electricity", "MPRN": "Gas" },
            "$default": "Unknown"
          },
          "service.servicePoints": {
            "$source": "$.meters",
            "$pick": {
              "globalReference": "$parent.id",
              "connectionStatus": "$parent.supplyStatus"
            }
          },
          "devices.deviceExternal.id": "$.meters[0].identifier",
          "devices.registers": {
            "$source": "$.meters[0].registers",
            "$pick": {
              "id": "$.id",
              "label": "$.identifier",
              "unitOfMeasure": "$.unit"
            }
          }
        }
      }
    }
  }
}
```

## Expression Resolution Summary

| Context                     | `$.field` resolves to        | Use `$context.` for full context |
|-----------------------------|------------------------------|----------------------------------|
| Top-level `body`            | Full orchestration context   | Not needed                       |
| Inside `$pick`              | Current array item           | Yes — `$context.inboundRequest.body.x` |
| Inside nested `$pick`       | Current nested item          | Yes — `$context.inboundRequest.body.x` |
| Inside `$fields`            | First sorted item            | Not needed (use `$steps.` directly) |
| `bodyTemplate` (outbound)   | Full orchestration context   | Not needed                       |
