# Tools & Integrations

> **Estimated time**: 30 minutes | **Prerequisites**: Basic ABL agent structure (AGENT, GOAL, PERSONA)

## Learning Objectives

After completing this module, you will be able to:

- Define HTTP, MCP, and code (sandbox) tools with proper type signatures
- Use `{{secrets.SECRET_NAME}}` placeholders to keep credentials out of ABL files
- Configure the `on_result` set block to map tool results into session variables
- Understand the tenant-level `codeToolsEnabled` feature flag and its security implications
- Connect agents to MCP servers using logical server names

## Why Tools Matter

An agent without tools is limited to conversation. Tools give your agent hands -- the ability to look up data, process payments, check inventory, run calculations, and interact with external systems. ABL supports four tool types, each suited to a different integration pattern.

| Tool Type      | Best For                             | Execution Environment            |
| -------------- | ------------------------------------ | -------------------------------- |
| HTTP           | REST API calls                       | Platform runtime (outbound HTTP) |
| MCP            | Model Context Protocol servers       | External MCP server process      |
| Sandbox (Code) | Custom calculations, data transforms | Isolated gVisor container        |
| Lambda         | Cloud serverless functions           | AWS Lambda / cloud function      |

## Defining Tools: The Basics

Every tool starts with a typed signature that declares its name, parameters, and return type. This signature tells the LLM what the tool does, what inputs it needs, and what data it returns.

```abl
TOOLS:
  get_order(order_id: string) -> {status: string, total: number}
    description: "Retrieve order details by ID"
    type: http
    endpoint: "https://api.example.com/orders/{order_id}"
    method: GET
    auth: bearer
```

> **Key Concept**: The `description` field is not just documentation -- it is the primary signal the LLM uses to decide when and how to call a tool. Write descriptions that clearly state what the tool does, when it should be called, and what it returns.

Parameters without default values are required. Add a default to make a parameter optional:

```abl
TOOLS:
  search_products(query: string, limit: number = 10) -> {products: object[]}
    description: "Search product catalog"
    type: http
    endpoint: "/api/products/search"
    method: POST
```

## HTTP Tools

HTTP tools are the most common type. They call REST API endpoints with configurable authentication, retries, timeouts, and rate limiting.

### Authentication and the `{{secrets.SECRET_NAME}}` Syntax

Credentials never belong in ABL files. Instead, use **secret placeholders** that the runtime resolves from your project's secret store at execution time:

```abl
TOOLS:
  create_ticket(subject: string, body: string) -> {ticket_id: string}
    description: "Create a support ticket"
    type: http
    endpoint: "https://api.helpdesk.com/v2/tickets"
    method: POST
    auth: api_key
    headers:
      X-API-Key: "{{secrets.HELPDESK_API_KEY}}"
```

The `{{secrets.HELPDESK_API_KEY}}` placeholder tells the runtime to look up `HELPDESK_API_KEY` in the project's secret store. This keeps your ABL definitions safe to commit to version control.

ABL supports seven authentication types: `none`, `bearer`, `api_key`, `oauth2_client`, `oauth2_user`, `saml`, and `custom`. For OAuth flows, use `auth_config` to specify the token URL, client credentials, and scopes:

```abl
TOOLS:
  get_contacts(query: string) -> {contacts: object[]}
    description: "Search CRM contacts"
    type: http
    endpoint: "https://api.crm.com/v2/contacts/search"
    method: POST
    auth: oauth2_client
    auth_config:
      token_url: "https://auth.crm.com/oauth/token"
      client_id: "{{secrets.CRM_CLIENT_ID}}"
      client_secret: "{{secrets.CRM_CLIENT_SECRET}}"
      scopes: "contacts.read"
```

### Reliability: Retries, Timeouts, and Circuit Breakers

Production APIs fail. Configure your tools to handle failures gracefully:

```abl
TOOLS:
  get_inventory(sku: string) -> {quantity: number, warehouse: string}
    description: "Check inventory levels"
    type: http
    endpoint: "https://api.warehouse.com/inventory/{sku}"
    method: GET
    timeout: 3000
    retry: 2
    circuit_breaker:
      threshold: 5
      reset_ms: 60000
```

The circuit breaker opens after 5 consecutive failures and stops making requests for 60 seconds, preventing cascading failures to a struggling service.

### Mapping Results with `on_result`

The `on_result` set block automatically maps fields from a tool's response into session variables. This is powerful because it makes tool results available to subsequent flow steps, templates, and conditions without writing extra code:

```abl
TOOLS:
  lookup_customer(email: string) -> {customer_id: string, name: string, tier: string}
    description: "Look up customer by email"
    type: http
    endpoint: "https://api.crm.com/v1/customers/search"
    method: POST
    auth: bearer
    on_result:
      set:
        customer_id: "result.customer_id"
        customer_name: "result.name"
        customer_tier: "result.tier"
    on_error:
      set:
        lookup_failed: "true"
```

> **Key Concept**: The `on_result` set block maps tool result fields to session variables automatically. After this tool executes, `{{customer_name}}` and `{{customer_tier}}` are available in templates, conditions, and downstream tool calls throughout the session.

## MCP Server Tools

MCP (Model Context Protocol) tools connect your agent to external MCP-compatible servers. The `server` field is a **logical name** -- it references a server configured in the runtime, not a URL in the ABL file.

```abl
TOOLS:
  get_weather(location: string) -> {temp: number, conditions: string}
    type: mcp
    server: "weather-service"
    tool: "get_current_weather"
    description: "Get current weather for a location"
```

> **Key Concept**: The MCP `server` field is a logical name that maps to an MCP server configuration in your project's runtime settings. Server connection details (transport type, URL, authentication) are managed at the project level, not in the ABL file. This separation means you can change MCP server endpoints without modifying agent definitions.

You can bind multiple tools from the same MCP server. The runtime maintains a single connection:

```abl
TOOLS:
  navigate(url: string) -> {success: boolean, title: string}
    type: mcp
    server: "crawler"
    tool: "navigate"
    description: "Navigate to a URL"

  extract_links(filter: string = "") -> {links: object[], count: number}
    type: mcp
    server: "crawler"
    tool: "extract_links"
    description: "Extract links from the current page"
```

If the MCP server's tool name differs from your ABL tool name, use the `tool` (or `server_tool`) property to specify the server-side name explicitly.

## Code Tools (Sandbox)

Code tools execute JavaScript or Python in an isolated sandbox -- perfect for calculations, data transformations, or logic that does not map to a REST API.

```abl
TOOLS:
  calculate_discount(price: number, tier: string) -> {discount_pct: number, final_price: number}
    description: "Calculate discount based on customer tier"
    type: sandbox
    runtime: "javascript"
    timeout: 3000
    code: |
      function main({ price, tier }) {
        const rates = { bronze: 0.05, silver: 0.10, gold: 0.15, platinum: 0.20 };
        const discount = rates[tier] || 0;
        return {
          discount_pct: discount * 100,
          final_price: price * (1 - discount)
        };
      }
```

### Sandbox Isolation and Security

Each sandbox tool runs in a gVisor-isolated environment with strict restrictions: no network access, no filesystem access beyond the sandbox directory, enforced CPU, memory, and execution time limits, and a fresh environment for every invocation.

> **Key Concept**: Code tool execution is gated by a **tenant-level feature flag** called `codeToolsEnabled`. This flag defaults to `false` and must be explicitly enabled by a platform administrator before any sandbox tool will execute. When disabled, the runtime silently skips sandbox-type tools. This exists to prevent untrusted code execution in environments where it has not been approved.

You can configure the flag via the admin API:

```bash
curl -X PATCH https://your-platform/api/admin/tenants/$TENANT_ID/features \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"codeToolsEnabled": true}'
```

Python sandboxes work the same way -- just change the runtime:

```abl
TOOLS:
  parse_csv(csv_text: string) -> {rows: object[], row_count: number}
    description: "Parse CSV text into structured data"
    type: sandbox
    runtime: "python"
    timeout: 10000
    memory_mb: 256
    code: |
      import csv, io
      def main(params):
          reader = csv.DictReader(io.StringIO(params["csv_text"]))
          rows = list(reader)
          return {"rows": rows, "row_count": len(rows)}
```

## Reusable Tool Files

When multiple agents need the same tools, define them in a `.tools.abl` file with shared defaults:

```abl
TOOLS:
  base_url: "https://api.hotels.com/v1"
  auth: bearer
  timeout: 5000
  retry: 3

  search_hotels(destination: string, checkin: date) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST
    description: "Search available hotels"

  get_hotel(hotel_id: string) -> Hotel
    type: http
    endpoint: "/hotels/{hotel_id}"
    method: GET
    description: "Get hotel details"
```

Then import specific tools into any agent:

```abl
AGENT: HotelSearch
GOAL: "Help users find hotels"

TOOLS:
  FROM "./tools/hotels-api.tools.abl" USE: search_hotels, get_hotel
```

Shared defaults (`base_url`, `auth`, `timeout`, `retry`) apply to all tools in the file. Individual tools can override any default.

## Error Handling

Configure error handlers to recover gracefully when tools fail:

```abl
ON_ERROR:
  tool_timeout:
    RESPOND: "Our system is taking longer than usual. Let me try again."
    RETRY: 2
    THEN: CONTINUE

  tool_error:
    RESPOND: "Something went wrong. Let me try another approach."
    RETRY: 1
    THEN: ESCALATE
```

In flow steps, use `ON_SUCCESS` and `ON_FAIL` for fine-grained control:

```abl
lookup:
  REASONING: false
  CALL: lookup_order(order_id)
  ON_SUCCESS:
    SET: tracking_number = result.tracking_number
    THEN: show_status
  ON_FAIL:
    RESPOND: "I could not find that order."
    THEN: ask_order_id
```

## Key Takeaways

- Tools give agents the ability to interact with external systems via HTTP, MCP, sandbox, and Lambda bindings
- Always use `{{secrets.SECRET_NAME}}` placeholders for credentials -- never embed secrets in ABL files
- The `on_result` set block maps tool response fields to session variables for use throughout the conversation
- Code (sandbox) tools run in isolated environments and require the `codeToolsEnabled` tenant-level feature flag to be explicitly enabled
- The MCP `server` field is a logical name resolved from runtime configuration, not a URL

## What's Next

With tools connected, your agent can take action. Next, learn how to collect structured data from users with GATHER in the **Data Collection** module, or how to orchestrate tool calls in deterministic sequences with the **Flow Control** module.
