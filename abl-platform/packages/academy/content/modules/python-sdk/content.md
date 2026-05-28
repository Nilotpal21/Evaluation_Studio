# Python SDK

> **Estimated time**: 40 minutes | **Prerequisites**: Python programming experience, familiarity with REST APIs, basic understanding of Agent Platform concepts

## Learning Objectives

After completing this module, you will be able to:

- Install and configure the Agent Platform Python SDK
- Create sessions and exchange messages with agents programmatically
- Use the management API to manage projects, agents, and deployments
- Implement streaming responses for real-time display in custom applications
- Automate testing and evaluation using the SDK's eval framework integration

## Overview

The Agent Platform Python SDK provides a programmatic interface to the platform's capabilities. While Studio offers a visual interface for building and managing agents, the SDK enables:

- **Custom applications** -- Embed agent conversations in your own web apps, mobile apps, or backend services
- **Automation** -- Deploy agents, run evaluations, and manage projects from CI/CD pipelines
- **Integration** -- Connect agent capabilities to existing business systems and workflows
- **Testing** -- Write automated test suites that validate agent behavior programmatically

### Installation

```bash
pip install agent-platform-sdk
```

### Authentication

The SDK authenticates using project-scoped API keys created in Studio:

```python
from agent_platform import AgentPlatformClient

client = AgentPlatformClient(
    base_url="https://your-platform-instance.com",
    api_key="your-project-api-key"
)
```

> **Key Concept**: API keys are **project-scoped**. Each key grants access to a specific project's agents, sessions, and resources. Create keys in Studio under **Project Settings > API Keys**. Keys can have expiration dates and be revoked at any time. Never embed API keys in client-side code -- they should only be used in server-side applications.

## Conversation API: Sessions & Messages

The conversation API is the core interface for interacting with agents. The workflow follows three steps: create a session, send messages, and receive responses.

### Creating a Session

```python
# Create a new conversation session
session = client.conversations.create_session(
    entry_agent="Supervisor",
    environment="production",
    metadata={
        "user_id": "user-123",
        "channel": "custom-app"
    }
)

print(f"Session created: {session.id}")
```

The `entry_agent` parameter specifies which agent receives the initial message. For multi-agent systems, this is typically the supervisor agent. The `metadata` parameter lets you attach custom data to the session for analytics and debugging.

### Sending Messages

```python
# Send a message and get the response
response = client.conversations.send_message(
    session_id=session.id,
    message="I need to book a flight from SFO to JFK next Friday"
)

print(f"Agent: {response.text}")
print(f"Agent: {response.agent_name}")
print(f"Tokens used: {response.token_usage.total}")
```

The `send_message` method is synchronous -- it sends the user message, waits for the agent to process it (including any tool calls, handoffs, or multi-step reasoning), and returns the complete response.

### Multi-Turn Conversations

```python
# First turn
response1 = client.conversations.send_message(
    session_id=session.id,
    message="I need to book a flight from SFO to JFK"
)
print(f"Agent: {response1.text}")

# Second turn - the agent remembers context from the first message
response2 = client.conversations.send_message(
    session_id=session.id,
    message="Make it next Friday, economy class"
)
print(f"Agent: {response2.text}")

# Third turn
response3 = client.conversations.send_message(
    session_id=session.id,
    message="Yes, confirm the booking"
)
print(f"Agent: {response3.text}")
```

Each message within a session maintains conversational context. The agent remembers previous messages, collected data, and state from earlier turns.

### Session Management

```python
# List active sessions
sessions = client.conversations.list_sessions(
    status="active",
    limit=50
)

# Get session details
session_detail = client.conversations.get_session(session_id="sess-123")
print(f"Turns: {session_detail.turn_count}")
print(f"Status: {session_detail.status}")
print(f"Agent: {session_detail.current_agent}")

# Get conversation history
history = client.conversations.get_history(session_id="sess-123")
for message in history.messages:
    print(f"{message.role}: {message.text}")

# End a session
client.conversations.end_session(session_id="sess-123")
```

## Management API: Agents, Projects & Deployments

The management API provides programmatic access to all administrative operations -- the same capabilities available in Studio's UI.

### Agent Management

```python
# List agents in the project
agents = client.agents.list()
for agent in agents:
    print(f"{agent.name} - {agent.status}")

# Get agent details
agent = client.agents.get(name="Flight_Search")
print(f"Version: {agent.active_version}")
print(f"Model: {agent.model}")

# Create an agent version
version = client.agents.create_version(
    name="Flight_Search",
    label="v2.1 - Added hotel search"
)
print(f"Version created: {version.id}")
```

### Deployment Management

```python
# Create a deployment
deployment = client.projects.create_deployment(
    environment="production",
    entry_agent="Supervisor",
    agent_version_manifest={
        "Supervisor": "2.0.0",
        "Flight_Search": "2.1.0",
        "Hotel_Search": "1.0.0"
    },
    label="v2.1 - Hotel search feature"
)
print(f"Deployment: {deployment.id}")
print(f"Status: {deployment.status}")

# List deployments
deployments = client.projects.list_deployments(
    environment="production"
)

# Rollback a deployment
client.projects.rollback_deployment(
    deployment_id=deployment.id
)
```

> **Key Concept**: The management API enables **infrastructure-as-code workflows** for agent systems. Instead of clicking through Studio to deploy, you can script the entire deployment pipeline: validate agent definitions, create versioned snapshots, deploy to staging, run evaluations, and promote to production -- all programmatically.

### Project Operations

```python
# Export project
export_data = client.projects.export()
# Save to file for backup or migration
with open("project-export.json", "w") as f:
    json.dump(export_data, f)

# Import agents into a project
with open("agents-export.json", "r") as f:
    import_data = json.load(f)
result = client.projects.import_agents(data=import_data)
print(f"Imported: {result.agents_imported}")
print(f"Conflicts: {result.conflicts}")
```

## Streaming Responses

For applications that need real-time response display (like chat interfaces), the SDK provides streaming methods that yield response chunks as they are generated.

### Basic Streaming

```python
# Stream a response token-by-token
stream = client.conversations.send_message_stream(
    session_id=session.id,
    message="Tell me about your flight options to JFK"
)

for chunk in stream:
    if chunk.type == "text_delta":
        print(chunk.text, end="", flush=True)
    elif chunk.type == "tool_call":
        print(f"\n[Calling tool: {chunk.tool_name}]")
    elif chunk.type == "done":
        print(f"\n[Complete - {chunk.token_usage.total} tokens]")
```

### Event Types in Streams

| Event Type     | Description                                       |
| -------------- | ------------------------------------------------- |
| `text_delta`   | A chunk of the agent's text response              |
| `tool_call`    | The agent is invoking a tool                      |
| `tool_result`  | A tool has returned its result                    |
| `handoff`      | The conversation is being handed to another agent |
| `state_update` | A session variable has changed                    |
| `done`         | The response is complete                          |

> **Key Concept**: Streaming is implemented via **Server-Sent Events (SSE)** over HTTP. The SDK handles the SSE protocol transparently, yielding Python objects for each event. This is the same transport mechanism that powers Studio's chat preview -- so streaming behavior in your custom app matches what you see in Studio.

### Building a Chat Interface

```python
import asyncio

async def chat_loop():
    session = client.conversations.create_session(
        entry_agent="Supervisor",
        environment="production"
    )

    while True:
        user_input = input("You: ")
        if user_input.lower() in ("quit", "exit"):
            client.conversations.end_session(session.id)
            break

        print("Agent: ", end="")
        stream = client.conversations.send_message_stream(
            session_id=session.id,
            message=user_input
        )
        for chunk in stream:
            if chunk.type == "text_delta":
                print(chunk.text, end="", flush=True)
        print()  # newline after response
```

## Testing & Automation with the SDK

The SDK integrates with Agent Platform's evaluation framework, enabling automated quality testing in CI/CD pipelines.

### Running Evaluations Programmatically

```python
# Create test personas
persona = client.evals.create_persona(
    name="Impatient Traveler",
    description="A frequent flyer who wants quick, direct answers",
    traits=["impatient", "experienced", "price-sensitive"]
)

# Create test scenarios
scenario = client.evals.create_scenario(
    name="Flight Rebooking",
    description="User needs to rebook a cancelled flight",
    initial_message="My flight was cancelled, I need to rebook ASAP",
    expected_outcomes=["Agent finds alternative flights", "Booking is confirmed"]
)

# Create an evaluator
evaluator = client.evals.create_evaluator(
    name="Response Quality",
    type="llm_judge",
    criteria="Rate the agent's helpfulness, accuracy, and tone on a 1-5 scale"
)

# Bundle into an eval set and run
eval_set = client.evals.create_eval_set(
    name="Booking Flow Regression",
    persona_ids=[persona.id],
    scenario_ids=[scenario.id],
    evaluator_ids=[evaluator.id]
)

run = client.evals.run_eval_set(eval_set_id=eval_set.id)
print(f"Eval run started: {run.id}")

# Poll for completion
while run.status != "completed":
    run = client.evals.get_run(run.id)
    time.sleep(5)

# Check results
results = client.evals.get_run_results(run.id)
print(f"Average score: {results.average_score}")
print(f"Pass rate: {results.pass_rate}")
for conversation in results.conversations:
    print(f"  Scenario: {conversation.scenario_name}")
    print(f"  Score: {conversation.score}")
```

### CI/CD Integration Pattern

```python
# In your CI/CD pipeline
def test_agent_quality():
    """Run eval set and fail the build if quality drops."""
    run = client.evals.run_eval_set(eval_set_id="eval-set-regression")

    # Wait for completion
    while run.status != "completed":
        run = client.evals.get_run(run.id)
        time.sleep(10)

    results = client.evals.get_run_results(run.id)

    # Quality gates
    assert results.average_score >= 4.0, \
        f"Average score {results.average_score} below threshold 4.0"
    assert results.pass_rate >= 0.9, \
        f"Pass rate {results.pass_rate} below threshold 90%"

    print(f"Quality check passed: score={results.average_score}, pass_rate={results.pass_rate}")
```

> **Key Concept**: The SDK enables **agent quality gates in CI/CD pipelines**. Before promoting a deployment from staging to production, run an eval set programmatically. If scores drop below thresholds, fail the pipeline. This prevents regressions from reaching production -- the same concept as unit tests for traditional software, but applied to AI agent behavior.

## Error Handling

```python
from agent_platform.exceptions import (
    AuthenticationError,
    NotFoundError,
    RateLimitError,
    ValidationError
)

try:
    response = client.conversations.send_message(
        session_id="invalid-session",
        message="Hello"
    )
except AuthenticationError:
    print("Invalid or expired API key")
except NotFoundError:
    print("Session not found -- it may have expired")
except RateLimitError as e:
    print(f"Rate limited -- retry after {e.retry_after} seconds")
except ValidationError as e:
    print(f"Invalid request: {e.message}")
```

## Key Takeaways

- The Python SDK provides both conversation (send messages, receive responses) and management (deploy, configure, evaluate) APIs
- API keys are project-scoped -- create them in Studio under Project Settings > API Keys
- Streaming via SSE yields real-time response chunks, matching Studio's chat preview behavior
- The eval framework integration enables automated quality gates in CI/CD pipelines -- fail builds when agent quality drops
- The management API enables infrastructure-as-code workflows: validate, version, deploy, and promote agents programmatically

## What's Next

Explore the **CLI & Developer Tools** module for command-line workflows, or the **API Fundamentals** module for the full REST API reference including authentication, webhooks, and rate limiting.
