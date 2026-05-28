// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/tools.mdx
// Regenerate: pnpm abl:docs:generate

export const TOOL_RESOLUTION_CARD = `## Tool Resolution — How Names Become Implementations

## MCP tools
- MCP (Model Context Protocol) tools connect to external MCP servers that expose tools dynamically.
\`\`\`abl
TOOLS:
  web_search(query: string) -> {results: {title: string, url: string, snippet: string}[]}
    description: "Search the web"
    type: mcp
    server: "brave-search"
\`\`\`
### MCP binding properties
| Property      | Type     | Required | Default   | Description                                                       |
| ------------- | -------- | -------- | --------- | ----------------------------------------------------------------- |
| \`type\`        | \`"mcp"\`  | Yes      | --        | Declares this as an MCP tool                                      |
| \`server\`      | \`string\` | Yes      | --        | MCP server name (resolved from runtime configuration)             |
| \`server_tool\` | \`string\` | No       | Tool name | Tool name on the MCP server (if different from the ABL tool name) |
### Server configuration
- The \`server\` value is a logical name that maps to an MCP server configuration in the project's runtime settings.
The platform supports these MCP transport types:
| Transport   | Description                                            |
| ----------- | ------------------------------------------------------ |
| \`stdio\`     | Standard input/output (for local MCP server processes) |
| \`http\`      | HTTP-based transport (Streamable HTTP)                 |
| \`websocket\` | WebSocket-based transport                              |
### Dynamic tool discovery
- MCP servers can expose multiple tools.
\`\`\`abl
TOOLS:
  search(query: string) -> {results: object[]}
    description: "Search using Brave"
    type: mcp
    server: "brave-search"
    server_tool: "brave_web_search"
\`\`\`
---`;
