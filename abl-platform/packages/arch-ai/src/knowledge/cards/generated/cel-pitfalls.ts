// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/data-types-and-utilities.mdx
// Regenerate: pnpm abl:docs:generate

export const CEL_PITFALLS_CARD = `## CEL Pitfalls — What Silently Bites

# Data Types & Utilities
- This page documents the ABL type system, lookup tables for reference-based validation, and attachment handling for file and media uploads.
---
## Data Types
- ABL has a type system used for variable declarations, gather field types, tool parameter signatures, and runtime validation.
### Primitive types
Primitive types represent single scalar values.
| Type       | Description                               | Example values           |
| ---------- | ----------------------------------------- | ------------------------ |
| \`string\`   | Unicode text of arbitrary length.         | \`"hello"\`, \`"USD"\`, \`""\` |
| \`number\`   | IEEE 754 double-precision floating point. | \`42\`, \`3.14\`, \`-1\`, \`0\`  |
| \`boolean\`  | True or false.                            | \`true\`, \`false\`          |
| \`date\`     | Calendar date without time.               | \`"2024-03-15"\`           |
| \`datetime\` | Date with time and timezone.              | \`"2024-03-15T10:30:00Z"\` |
#### String
- Strings are the most common type in ABL.
\`\`\`abl
GATHER:
  customer_name:
    prompt: "What is your name?"
    type: string
    required: true
\`\`\`
#### Number
- Numbers represent all numeric values, including integers and floating-point numbers.
\`\`\`abl
GATHER:
  amount:
    prompt: "How much would you like to transfer?"
    type: number
    required: true
    validate: min(1)
\`\`\`
#### Boolean
- Booleans represent true/false values.
\`\`\`abl
MEMORY:
  session:
    - customer_verified
      TYPE: boolean
      INITIAL: false
\`\`\`
#### Date
- Dates represent calendar dates without a time component.
\`\`\`abl
GATHER:
  departure_date:
    prompt: "When would you like to depart?"
    type: date
    required: true
\`\`\`
#### Datetime
- Datetimes include both date and time with timezone information.
\`\`\`abl
MEMORY:
  session:
    - session_start_time
      TYPE: datetime
      INITIAL: NOW()
\`\`\`
### Complex types
Complex types represent structured or composite values.
#### array\\<T\\>
An ordered collection of elements, optionally typed by item type.
\`\`\`abl
# In type definitions
type: array<string>          # Array of strings
type: array<number>          # Array of numbers
type: array<object>          # Array of objects
\`\`\`
In memory declarations:
\`\`\`abl
MEMORY:
  session:
    - cart_items
      TYPE: array
      INITIAL: []
\`\`\`
##### Array type definition (IR)
\`\`\`
{ kind: 'array', itemType: TypeDefinition }
\`\`\`
| Property   | Type             | Description                        |
| ---------- | ---------------- | ---------------------------------- |
| \`kind\`     | \`'array'\`        | Discriminant for array type.       |
| \`itemType\` | \`TypeDefinition\` | Type of each element in the array. |
#### object\\<{...}\\>
A structured record with named, typed fields.
\`\`\`abl
# In type definitions
type: object<{name: string, age: number, active: boolean}>
\`\`\`
In tool return types:
\`\`\`abl
TOOLS:
  get_user(id: string) -> {name: string, email: string, role: string}
\`\`\`
##### Object type definition (IR)
\`\`\`
{ kind: 'object', properties: Record<string, TypeDefinition> }
\`\`\``;
