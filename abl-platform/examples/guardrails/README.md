# Guardrails Example

Demonstrates ABL guardrail patterns for protecting conversations with input/output safety checks.

## Agents

### PII Protection Agent

Protects sensitive personal information using built-in CEL helper guardrails:

- **PII input redaction** (input) - automatically redacts detected personal information
- **PII output prevention** (output) - blocks responses containing personal information
- **PII handling notice** (both) - warns when personal information is detected in either direction

### Content Safety Agent

Maintains safe conversations using content moderation guardrails:

- **Profanity filter** (input, priority 1) - blocks disrespectful messages
- **Toxicity check** (output, priority 1) - blocks potentially harmful responses
- **Harmful content** (both, priority 0) - escalates to human review
- **Length limit** (output, priority 2) - warns on excessively long responses

## Guardrail Actions

| Action     | Behavior                                  |
| ---------- | ----------------------------------------- |
| `warn`     | Allow message through, show warning       |
| `redact`   | Remove sensitive content, continue        |
| `block`    | Prevent message from being sent/displayed |
| `escalate` | Route to human review                     |

## Project Structure

```
guardrails/
  project.json              # v2 export manifest
  agents/
    pii_protection.agent.abl
    content_safety.agent.abl
  config/
    project-settings.json
  environment/
    env-vars.json
  locales/
    en/
      pii_protection.json
      content_safety.json
```

## Running

Import this project using the ABL project import:

```bash
abl project import ./examples/guardrails/
```
