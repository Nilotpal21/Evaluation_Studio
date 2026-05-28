// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/tools.mdx, guides/tools-and-integrations.mdx
// Regenerate: pnpm abl:docs:generate

export const TOOL_BINDING_AUTH_CARD = `## Tool Binding & Auth — Types, Declaration, Authentication

# Tools
- The \`TOOLS:\` section defines the external capabilities available to an agent.
## Tool declaration syntax
A tool is declared with a function-style signature followed by indented properties:
\`\`\`abl
TOOLS:
  tool_name(param1: type1, param2: type2 = default) -> ReturnType
    description: "What this tool does"
    type: http
    endpoint: "/api/path"
    method: POST
\`\`\`
### Signature format
\`\`\`
name(parameters) -> return_type
\`\`\`
- **name** -- a lowercase identifier using \`snake_case\`
- **parameters** -- comma-separated list of typed parameters
- **return_type** -- the type of data the tool returns
### Parameter syntax
Each parameter follows the format \`name: type\` with an optional default value:
\`\`\`
param_name: type
param_name: type = default_value
\`\`\`
| Component   | Description                              | Examples                              |
| ----------- | ---------------------------------------- | ------------------------------------- |
| \`name\`      | Parameter identifier (snake_case)        | \`account_id\`, \`query\`, \`limit\`        |
| \`type\`      | Data type                                | \`string\`, \`number\`, \`boolean\`, \`date\` |
| \`= default\` | Default value (makes parameter optional) | \`= 10\`, \`= "USD"\`, \`= true\`           |
Parameters without a default value are required. Parameters with a default value are optional.
### Parameter types
| Type      | Description                                              | Examples               |
| --------- | -------------------------------------------------------- | ---------------------- |
| \`string\`  | Text value                                               | \`"hello"\`              |
| \`number\`  | Numeric value (integer or float)                         | \`42\`, \`3.14\`           |
| \`boolean\` | True or false                                            | \`true\`, \`false\`        |
| \`date\`    | Date value                                               | \`"2026-03-01"\`         |
| \`object\`  | Nested object (specify fields with nested \`parameters:\`) | --                     |
| \`type[]\`  | Array of the given type                                  | \`string[]\`, \`number[]\` |
#### Object parameters
- When a parameter has type \`object\`, you can define nested fields using a \`parameters:\` block under t
\`\`\`abl
TOOLS:
  create_order(customer: object, items: object[]) -> {order_id: string}
    description: "Create a new order"
    parameters:
      customer:
        name: string
        email: string
      items:
        product_id: string
        quantity: number
\`\`\`

### 7 Auth Error Codes
| Code | When |
|---|---|
| AUTH_PROFILE_NOT_FOUND | Profile lookup miss |
| AUTH_PROFILE_TOKEN_REQUIRED | OAuth grant missing — user hasn't connected |
| AUTH_PROFILE_CONFIG_VAR_NOT_FOUND | Template config var unresolvable |
| AUTH_PROFILE_USER_CONTEXT_REQUIRED | User-scoped OAuth but no userId on session |
| AUTH_PROFILE_TOKEN_URL_MISSING | Client credentials without tokenUrl |
| AUTH_PROFILE_TOKEN_URL_BLOCKED | Token URL fails SSRF validator |
| AUTH_PROFILE_CLIENT_CREDENTIALS_INVALID | Missing clientId/clientSecret |`;
