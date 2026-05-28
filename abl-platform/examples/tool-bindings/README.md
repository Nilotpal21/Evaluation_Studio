# Tool Bindings Example

Demonstrates all ABL tool binding types in a single project.

## Agents

| Agent          | Tool Types Used                   |
| -------------- | --------------------------------- |
| HotelSearch    | HTTP (shared file), MCP, contract |
| DocProcessor   | Lambda (Node.js, Python)          |
| EmailVerifier  | HTTP (inline)                     |
| RiskCalculator | Sandbox (JavaScript, Python)      |

## Tool Types

- **HTTP** -- REST API calls with auth, retry, and timeout (`hotels-api.tools.abl`, `email_verifier`)
- **Lambda** -- Serverless function invocations (`doc_processor`)
- **Sandbox** -- Isolated code execution with memory limits (`risk_calculator`)
- **MCP** -- Model Context Protocol server tools (`hotel_search` weather tool)
- **Shared tool files** -- `FROM "./tools/hotels-api.tools.abl" USE: search_hotels, get_hotel`

## Structure

```
tool-bindings/
  project.json
  agents/
    doc_processor.agent.abl
    email_verifier.agent.abl
    hotel_search.agent.abl
    risk_calculator.agent.abl
  tools/
    hotels-api.tools.abl
  config/
    project-settings.json
  environment/
    env-vars.json
  locales/
    en/
      doc_processor.json
      email_verifier.json
      hotel_search.json
      risk_calculator.json
```

## Usage

Import this project via `project.json` or create agents individually in Studio.
