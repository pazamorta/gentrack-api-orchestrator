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

### Literal Dot Keys (Escape Nesting)

If the backend expects a literal dot in the key name (no nesting), wrap the key in square brackets:

```json
"[account.id]": "$steps.get-account.body.id"
```

Produces:
```json
{
  "account.id": 136
}
```

Without brackets, `"account.id"` would create `{"account": {"id": 136}}`. Use `[...]` when the API literally expects a dot in the field name.

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

### $crossFilter (Multi-Rule Filter)

Filter items using complex logic with OR between rules and AND within each rule. Supports cross-step references and array membership checks.

```json
{
  "$source": "$steps.step-1.body.results",
  "$crossFilter": {
    "rules": [
      {
        "conditions": [
          { "field": "statusCode", "operator": "eq", "value": "Failed" }
        ]
      },
      {
        "conditions": [
          { "field": "statusCode", "operator": "eq", "value": "Completed" },
          { "field": "billId", "operator": "in", "source": "$steps.step-2.body.results", "sourceField": "id" }
        ]
      }
    ]
  },
  "$pick": { ... }
}
```

Rules are evaluated with OR logic — an item passes if **any** rule matches. Within each rule, conditions are AND — **all** conditions must be true.

#### Condition Operators

| Operator     | Description                                          |
|--------------|------------------------------------------------------|
| `eq`         | Field equals value                                   |
| `neq`        | Field does not equal value                           |
| `gt` / `lt`  | Greater than / less than                            |
| `exists`     | Field is not null/undefined                          |
| `not-exists` | Field is null/undefined                              |
| `in`         | Field value exists in a source array (see below)     |

#### The `in` Operator

Checks if the current item's field value exists within an array from another step:

```json
{
  "field": "billId",
  "operator": "in",
  "source": "$steps.step-2.body.results",
  "sourceField": "id"
}
```

- `field` — The field on the current item to check
- `source` — Path to the array to search (resolved from context)
- `sourceField` — The field within each source array element to match against (default: `"id"`)

This enables join-like behaviour without needing a forEach: fetch a filtered list in one call, then use `in` to match items by key.

#### Cross-Step Reference in Conditions

Use `"source"` on a condition to check a field from another step's result at the same index:

```json
{
  "field": "status",
  "source": "$steps.step-2.body",
  "operator": "eq",
  "value": "Draft"
}
```

This checks `$steps.step-2.body[currentIndex].status === "Draft"`.

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

### Context Expressions in $fields

`$fields` supports context expressions like `$now.date`, `$steps.*`, and `$item.*`:

```json
"$fields": {
  "billToDate": {
    "$date": "$now.date",
    "$dateAdd": { "days": 0 }
  },
  "stepValue": "$steps.step-1.body.someField"
}
```

Expressions starting with `$` (but not `$.`) are resolved via `resolveValue` against the orchestration context. `$.field` is always resolved relative to the current sorted/filtered item.

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

Works in `$pick`, response mapping body, `bodyTemplate`, and nested contexts.

### $switch in bodyTemplate (Conditional Request Body Fields)

Use `$switch` within `bodyTemplate` to conditionally set values based on forEach item data:

```json
"bodyTemplate": {
  "fromDttm": "$now.date",
  "toDttm": "$item.period.toDate",
  "reason": "$item.reason",
  "suppressDunningFl": {
    "$switch": "$item.suspensionType",
    "$cases": { "debt-management": true },
    "$default": false
  },
  "suppressBillingFl": {
    "$switch": "$item.suspensionType",
    "$cases": { "statement": true },
    "$default": false
  }
}
```

Note: In `bodyTemplate`, use `$item.field` directly (not `{{$item.field}}`) for values that need to be resolved by `applyMapping`. The `{{}}` template syntax is for URL path templates only.

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

## $coalesce (First Non-Null Value)

Try multiple expressions and return the first non-null value. Useful when a field might exist at different paths or have fallback values:

```json
"amount": {
  "$coalesce": ["$.creditAmount", "$.debitAmount"]
}
```

Within a `$pick`, the expressions are resolved relative to the current item:

```json
"$pick": {
  "amount": {
    "$coalesce": ["$.creditAmount", "$.debitAmount"]
  }
}
```

If `$.creditAmount` is null/undefined, falls back to `$.debitAmount`. If all expressions resolve to null, the value is `undefined`.

Also works in nested `$source/$pick` and `$expand` contexts with `$item.` and `$.` references.

## $derive (Rule-Based Value Derivation)

Derive a value based on multiple conditions evaluated in order (first match wins). Each rule has conditions with AND logic — all conditions in a rule must be true.

```json
"contractState": {
  "$derive": [
    {
      "conditions": [
        { "field": "cancelled", "operator": "eq", "value": true }
      ],
      "result": "Cancelled"
    },
    {
      "conditions": [
        { "field": "cancelled", "operator": "not-exists" },
        { "field": "toDt", "operator": "in-past" }
      ],
      "result": "Expired"
    },
    {
      "conditions": [
        { "field": "cancelled", "operator": "not-exists" },
        { "field": "fromDt", "operator": "in-future" }
      ],
      "result": "Future"
    },
    {
      "conditions": [
        { "field": "cancelled", "operator": "not-exists" },
        { "field": "toDt", "operator": "not-exists" },
        { "field": "fromDt", "operator": "in-past" }
      ],
      "result": "Current"
    }
  ],
  "$default": "Unknown"
}
```

### Condition Operators for $derive

| Operator      | Description                             |
|---------------|-----------------------------------------|
| `eq`          | Field equals value                      |
| `neq`         | Field does not equal value              |
| `gt` / `lt`   | Greater than / less than               |
| `gte` / `lte` | Greater or equal / less or equal       |
| `exists`      | Field is not null/undefined             |
| `not-exists`  | Field is null/undefined                 |
| `in-past`     | Date field is before today              |
| `in-future`   | Date field is after today               |

### Result Values

The `result` in each rule can be:
- A literal string or number
- An expression (`$steps.step-1.body.field`)
- An array of expressions (resolved and returned as array)

`$default` is returned when no rule matches.

## $keyOf (Object Key Name)

Return the first key name of an object at a given path. Useful when the backend returns data keyed by a dynamic name (like fuel type):

```json
"$pick": {
  "serviceType": "$keyOf:$parent"
}
```

- `$keyOf:$` — Returns the first key of the current item
- `$keyOf:$parent` — Returns the first key of the parent item
- `$keyOf:$.path.to.object` — Returns the first key of the object at the given JSONPath

This is particularly useful in nested `$source/$pick` where the parent object's key is the data you need (e.g., `"electricity": {...}` where the key "electricity" is the service type).

## $expand (Array Flattening in Nested $pick)

Flatten a nested array within a `$source/$pick` to produce one output row per expanded item. Works in third-level nested contexts.

```json
"chargeItems": {
  "$source": "$parent.*.*.products",
  "$expand": "$.rates",
  "$pick": {
    "chargeCode": "$item.name",
    "description": "$.name",
    "chargeType": "$item.productItemClass",
    "rate": {
      "$coalesce": ["$.rate", "$item.rate"]
    },
    "unitOfBilling": "$item.metricUnit"
  }
}
```

### How $expand Works

1. The `$source` array is resolved normally
2. For each source item, the `$expand` expression is evaluated to find a nested array
3. Each element in the expanded array produces one output row
4. In the `$pick`:
   - `$.field` — resolves against the expanded item (the rate)
   - `$item.field` — resolves against the source item (the product)
   - `$parent.field` — resolves against the parent context

If the expand expression doesn't resolve to an array (or is empty), the source item itself is used as both the source and expanded item (producing one row).

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

## $when (Conditional Field Inclusion)

Conditionally include or exclude a field from the response based on an expression. If the expression resolves to a falsy value (`false`, `"false"`, `"0"`, `""`, `null`, `undefined`), the field is omitted entirely from the response.

```json
"body": {
  "balance": {
    "$when": "$.inboundRequest.query.includeBalance",
    "$value": {
      "accountBalance": "$steps.balance.body.accountBalance",
      "currency": "$steps.balance.body.currencyISO"
    }
  },
  "refundInfo": {
    "$when": "$.inboundRequest.query.includeRefundInfo",
    "$value": {
      "$source": "$steps.transactions.body.results",
      "$filter": { "field": "type", "operator": "eq", "value": "Repayment" }
    }
  }
}
```

- `$when` — Expression to evaluate. Typically an inbound query param like `"$.inboundRequest.query.includeX"`
- `$value` — The actual field content (can be any valid mapping: object, `$source/$pick`, `$sortBy/$fields`, literal, or expression)

When the caller sends `?includeRefundInfo=false`, the `refundInfo` field won't appear in the response at all — not as `null`, just absent. This prevents null dereference errors in consumers that check for field presence.

The `$value` supports all existing mapping features: `$source/$pick`, `$sortBy/$fields`, `$filter`, nested objects, expressions, etc.

## $resolve / $default (Default Values)

Resolve an expression with a fallback value when the result is `null` or `undefined`:

```json
"accountBalance": {
  "$resolve": "$steps.balance.body.accountBalance",
  "$default": 0
}
```

If `$steps.balance.body.accountBalance` doesn't exist or is null, the field returns `0` instead. Useful for numeric fields where the backend omits zero values rather than returning `0` explicitly.

## stripNulls

Remove null/undefined values and empty arrays from the response:

```json
"responseMapping": {
  "stripNulls": true,
  "body": { ... }
}
```

When enabled:
- `null` and `undefined` values are removed from objects
- Empty arrays `[]` are removed from object properties
- Useful for omitting optional fields (like `scheduledPayments`) when they have no data

## Conditional arrayBody ($cases)

Return different array shapes based on conditions. Each case has a `$condition` expression — the first matching case wins:

```json
"responseMapping": {
  "statusCode": 200,
  "stripNulls": true,
  "arrayBody": [
    {
      "$condition": "$steps.step-3.body.results[0]",
      "$requireAlso": "$steps.step-1.body.results[0]",
      "$arrayBody": {
        "$source": "$steps.step-1.body.results",
        "$pick": {
          "arrangementType": "Ongoing and Debt",
          "scheduledPayments": { "$source": "$steps.step-4.body[*].results[*]", "$pick": { ... } }
        }
      }
    },
    {
      "$condition": "$steps.step-1.body.results[0]",
      "$arrayBody": {
        "$source": "$steps.step-1.body.results",
        "$pick": { "arrangementType": "Ongoing" }
      }
    },
    {
      "$condition": "$steps.step-3.body.results[0]",
      "$arrayBody": {
        "$source": "$steps.step-3.body.results",
        "$pick": { "arrangementType": "Debt" }
      }
    }
  ]
}
```

- `$condition` — Expression that must resolve to truthy for the case to match
- `$requireAlso` — Optional AND condition (both `$condition` and `$requireAlso` must be truthy)
- `$arrayBody` — The `$source/$pick` mapping to use when this case matches
- Cases are evaluated in order — first match wins
- If no case matches, an empty array `[]` is returned

This enables conditional response shapes without custom code — useful for routes that need different response structures based on what data exists.

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

## Special $pick Variables

Within a `$source/$pick` block, these special expressions are available:

| Expression    | Returns                                                    |
|---------------|------------------------------------------------------------|
| `$key`        | The object key name when iterating over an object (not array) |
| `$parentKey`  | The parent item's key (in nested `$source/$pick`)          |
| `$index`      | The current iteration index (0-based)                      |
| `$item.field` | Current forEach source item field                          |
| `$parent.field` | Parent item field (in nested `$source/$pick`)            |

### $key Example

When the source is an object (not an array), `$key` returns the property name:

```json
"$source": "$steps.step-1.body.fuelTypes",
"$pick": {
  "fuelType": "$key",
  "details": "$.description"
}
```

If `fuelTypes` is `{"Gas": {"description": "..."}, "Electricity": {"description": "..."}}`, the result includes `"fuelType": "Gas"` etc.

### $index Example

```json
"$pick": {
  "position": "$index",
  "name": "$.name"
}
```

Returns the zero-based position of each item in the source array.

## Expression Resolution Summary

| Context                     | `$.field` resolves to        | Use `$context.` for full context |
|-----------------------------|------------------------------|----------------------------------|
| Top-level `body`            | Full orchestration context   | Not needed                       |
| Inside `$pick`              | Current array item           | Yes — `$context.inboundRequest.body.x` |
| Inside nested `$pick`       | Current nested item          | Yes — `$context.inboundRequest.body.x` |
| Inside `$fields`            | First sorted item            | Not needed (use `$steps.` directly) |
| `bodyTemplate` (outbound)   | Full orchestration context   | Not needed                       |
