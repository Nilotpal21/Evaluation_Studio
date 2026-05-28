// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/rich-content-and-expressions.mdx, abl-reference/data-types-and-utilities.mdx
// Regenerate: pnpm abl:docs:generate

export const CEL_FUNCTIONS_CARD = `## CEL Functions — Built-In Reference

## Expressions & Functions
- ABL expressions are used in conditions (\`WHEN\`, \`CHECK\`, constraint rules), value assignments (\`SET\`), template interpolation (\`{{}}\`), and function calls.
### Expression syntax
#### Comparison operators
| Operator   | Syntax         | Description                                           |
| ---------- | -------------- | ----------------------------------------------------- |
| \`==\`       | \`a == b\`       | Equal to.                                             |
| \`!=\`       | \`a != b\`       | Not equal to.                                         |
| \`>\`        | \`a > b\`        | Greater than.                                         |
| \`<\`        | \`a < b\`        | Less than.                                            |
| \`>=\`       | \`a >= b\`       | Greater than or equal to.                             |
| \`<=\`       | \`a <= b\`       | Less than or equal to.                                |
| \`in\`       | \`a IN [x,y,z]\` | Value is in the list.                                 |
| \`not_in\`   | \`a NOT IN [x]\` | Value is not in the list.                             |
| \`matches\`  | \`a matches r\`  | Value matches a regular expression.                   |
| \`contains\` | \`a contains b\` | String contains substring, or array contains element. |
#### Logical operators
| Operator | Syntax    | Description                   |
| -------- | --------- | ----------------------------- |
| \`AND\`    | \`a AND b\` | Both conditions must be true. |
| \`OR\`     | \`a OR b\`  | At least one must be true.    |
| \`NOT\`    | \`NOT a\`   | Negates the condition.        |
Logical operators are case-insensitive (\`AND\`, \`and\`, \`And\` are equivalent).
#### Unary operators
| Operator     | Syntax           | Description                                       |
| ------------ | ---------------- | ------------------------------------------------- |
| \`NOT\`        | \`NOT condition\`  | Negates a condition.                              |
| \`IS SET\`     | \`var IS SET\`     | True if the variable is not null/undefined.       |
| \`IS NOT SET\` | \`var IS NOT SET\` | True if the variable is null or undefined.        |
| \`exists\`     | \`EXISTS var\`     | True if the variable exists in context.           |
| \`empty\`      | \`EMPTY var\`      | True if the variable is empty (null, "", [], {}). |
#### Operator precedence
1. Parentheses \`()\`
2. Unary operators (\`NOT\`, \`IS SET\`, \`IS NOT SET\`)
3. Comparison operators (\`==\`, \`!=\`, \`>\`, \`<\`, \`>=\`, \`<=\`, \`contains\`, \`matches\`)
4. \`AND\`
5. \`OR\`
Use parentheses to override default precedence:
\`\`\`abl
WHEN: (status == "active" OR status == "pending") AND amount > 0
\`\`\`
### Variable paths and dot notation

### Usage in Different Constructs

\`\`\`yaml
# In CONSTRAINTS:
REQUIRE: "kyc_status == 'verified'"

# In GATHER VALIDATION:
VALIDATION: "size(account_number) >= 8 && size(account_number) <= 12"

# In FLOW ON_INPUT:
IF: "input contains 'yes' || input contains 'confirm'"

# In COMPLETE:
COMPLETE:
  - WHEN: has(order_id) && payment_status == 'confirmed'
    RESPOND: ""

# In TRANSFORM MAP:
display_amount: FORMAT_CURRENCY(ABS(txn.amount), "USD")
\`\`\``;
