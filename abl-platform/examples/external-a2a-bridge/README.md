# External A2A Bridge Demo

This example shows a real external-hosted agent talking to platform-hosted agents over A2A in both directions:

- Platform -> external: the platform entry agent hands normal user turns to an externally hosted A2A agent.
- External -> platform: the hosted agent calls back into a platform A2A connection for research help and for file delivery.
- Multi-turn context: the platform forwards bounded conversation history and a stable `contextId`, so the external service can stay stateless and still handle long conversations.
- File exchange: the hosted agent sends an inline A2A `file` part back into the platform. This matches the runtime's current proven ingestion path.

## Why this shape

The platform's planned "External Agent Host" feature is not the runnable path today. What works today is:

1. Host an external service that speaks A2A.
2. Point a platform `HANDOFF ... LOCATION: REMOTE PROTOCOL: A2A` rule at that service.
3. Give the external service a platform A2A connection URL so it can call a platform-hosted agent back.

This demo uses:

- Platform side: one project whose entry supervisor is `Platform_Bridge_Desk`
- External side: a Next.js service deployable to Vercel
- Agent framework: Vercel AI SDK with Anthropic, OpenAI, or Gemini providers

## Architecture

```mermaid
flowchart LR
    U["User in Studio or SDK"] --> P["Platform_Bridge_Desk<br/>platform-hosted supervisor"]
    P -->|remote handoff over A2A| E["Hosted Vercel Agent<br/>Next.js + AI SDK"]
    E -->|A2A callback with "platform research"| P
    E -->|A2A callback with "platform file" + inline file part| P
    P --> R["Platform_Research_Local"]
    P --> F["Platform_File_Local"]
```

## Current file-exchange reality

Today the cleanest file path is **external -> platform** via inline A2A file parts. The runtime already ingests those into `attachmentIds`.

This demo does **not** rely on platform -> external file parts, because the outbound handoff path is currently text/history-first and does not have the same proven file-part wiring.

## Platform project contents

- `Platform_Bridge_Desk`
  - Entry supervisor for users
  - Routes `platform research` and `platform file` messages to local platform agents
  - Routes all normal user traffic to the external hosted A2A service
- `Platform_Research_Local`
  - Handles callback research requests from the hosted service
- `Platform_File_Local`
  - Handles callback file-delivery messages from the hosted service
- `Hosted_Vercel_Agent`
  - Compile-time placeholder alias for platform builds that still validate remote handoff targets against project-local agent names
  - Keep this placeholder out of the active deployment manifest when you want runtime execution to stay on the remote A2A endpoint

## External service contents

The `external-vercel-agent/` app:

- Exposes `/.well-known/agent-card.json`
- Exposes `/api/a2a`
- Uses Vercel AI SDK multi-step tool execution
- Calls the platform back through a single platform A2A connection URL
- Generates a Markdown transcript and sends it as an inline A2A file part

## Setup

### 1. Import or create the platform project

Use the files in this folder as your platform project:

- Entry agent: `Platform_Bridge_Desk`
- Required config var: `EXTERNAL_AGENT_URL`

Current import caveat: the runtime project import path does not yet materialize arbitrary project config variables from `environment/config-vars.json`. After import, create or update `EXTERNAL_AGENT_URL` in the project config-variable UI or API.

For local development, set:

```text
EXTERNAL_AGENT_URL=http://localhost:4010/api/a2a
```

For staging or a deployed Vercel app, set it to the external service base URL, for example:

```text
EXTERNAL_AGENT_URL=https://your-hosted-bridge.vercel.app/api/a2a
```

### 2. Create one platform A2A connection

Create a channel connection on the same project, pointed at the project's active deployment or environment. The connection serves the project's entry agent, which is why this demo keeps `Platform_Bridge_Desk` as the single entry point.

Example runtime API call:

```bash
curl -X POST "$RUNTIME_BASE_URL/api/projects/$PROJECT_ID/channel-connections" \
  -H "Authorization: Bearer $PLATFORM_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_type": "a2a",
    "display_name": "external-a2a-bridge",
    "external_identifier": "external-a2a-bridge-main",
    "environment": "dev",
    "config": {
      "a2aApiKey": "replace-me-with-a-strong-token"
    }
  }'
```

That gives you a connection id. The external app will use:

- Platform A2A URL: `https://<runtime-base>/a2a/<connectionId>`
- Optional Bearer token: the `a2aApiKey` you set above

### 3. Configure the platform callback target

On `agents-dev`, the remote handoff endpoint must be compile-time-resolved, so this demo uses a project config variable instead of `{{env.X}}` for the remote A2A URL. The checked-in `environment/config-vars.json` is the canonical value to copy, but today you should still create or update the actual project config variable after import.

### 4. Configure the external app

Copy `external-vercel-agent/.env.example` to `.env.local` and fill in:

```text
PUBLIC_BASE_URL=http://localhost:4010
HOSTED_AGENT_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
PLATFORM_A2A_URL=http://localhost:3112/a2a/<connectionId>
PLATFORM_A2A_BEARER_TOKEN=replace-me-with-a-strong-token
```

For staging, use your deployed runtime base URL instead of `localhost:3112`.

The external app supports three providers:

- Anthropic via `ANTHROPIC_API_KEY` and optional `ANTHROPIC_MODEL`
- OpenAI via `OPENAI_API_KEY` and optional `OPENAI_MODEL`
- Gemini via `GOOGLE_GENERATIVE_AI_API_KEY` and optional `GOOGLE_MODEL`

If `HOSTED_AGENT_PROVIDER` is unset, the app tries providers in this order: Anthropic, OpenAI, then Google. For `agents-dev`, pinning `HOSTED_AGENT_PROVIDER=openai` is a good default when Anthropic billing is unavailable.

### 5. Run locally

```bash
cd examples/external-a2a-bridge/external-vercel-agent
pnpm install
pnpm dev
```

The external agent card will be available at:

```text
http://localhost:4010/.well-known/agent-card.json
```

### 6. Deploy to Vercel

This is a standard Next.js app, so either:

- connect the folder to a Vercel project, or
- run `vercel` from `examples/external-a2a-bridge/external-vercel-agent`

Then set:

- `PUBLIC_BASE_URL`
- `HOSTED_AGENT_PROVIDER`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `GOOGLE_MODEL`
- `PLATFORM_A2A_URL`
- `PLATFORM_A2A_BEARER_TOKEN`

## Demo conversation

Try this from Studio against `Platform_Bridge_Desk`:

1. `Help me prepare a release-readiness brief for the search team. Asha owns PM, Ravi owns QA, and Mei owns docs.`
2. `Turn that into a detailed checklist and ask the platform for any dev-vs-staging cautions.`
3. `Now send the current brief into the platform as a file package.`

Expected behavior:

1. The platform hands the turn to the external hosted agent.
2. The hosted agent keeps context using forwarded `history` and the stable `contextId`.
3. The hosted agent calls back into the platform with `platform research ...` and receives a platform-local answer.
4. The hosted agent generates a Markdown transcript and sends it back into the same platform A2A connection with `platform file ...` plus an inline `file` part.
5. The platform runtime stores the file as an attachment and the local file agent acknowledges receipt.

## Direct A2A test against the external app

```bash
curl -X POST http://localhost:4010/api/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "demo-1",
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "messageId": "msg-1",
        "role": "user",
        "contextId": "bridge-demo-ctx",
        "parts": [
          { "kind": "text", "text": "Help me draft a release brief for Asha and Ravi." }
        ],
        "metadata": {
          "history": [
            { "role": "user", "content": "We are planning a release." },
            { "role": "agent", "content": "I can help structure the brief." }
          ]
        }
      },
      "metadata": {
        "context": {
          "summary": "Platform handoff into the external hosted agent"
        }
      }
    }
  }'
```

## Notes

- The external app is intentionally stateless. That makes it safe to host on Vercel and still preserve long conversations, because the platform already forwards transcript history on each remote handoff turn.
- The same platform A2A connection is used for both research callbacks and file delivery. Prefix-based routing keeps those callback turns on-platform and prevents them from bouncing back out to the external service.
