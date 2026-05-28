# Testing & Evaluation

> **Estimated time**: 35 minutes | **Prerequisites**: Basic ABL agent structure, guardrails fundamentals

## Learning Objectives

After completing this module, you will be able to:

- Create test personas with communication styles and behavior traits
- Design test scenarios with expected outcomes and milestones
- Build LLM judge evaluators with scoring rubrics and bias mitigation
- Understand the Cartesian product math behind evaluation matrices
- Configure trajectory evaluators for execution path analysis
- Set up baseline regression detection for CI/CD integration

## Why Testing Matters

An agent that works in a demo may fail in production. Users are unpredictable -- they are impatient, confused, adversarial, or simply use language the LLM does not expect. Testing manually by typing a few messages catches obvious bugs but misses the combinatorial explosion of real-world interactions. Agent Platform's evaluation framework automates this by simulating diverse users across diverse scenarios and having LLM judges score every conversation.

## The Evaluation Framework Overview

Agent Platform's testing framework has four building blocks:

| Component      | What It Is                                             | Purpose                                                   |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| **Personas**   | Simulated users with specific behavior traits          | Test how the agent handles different communication styles |
| **Scenarios**  | Defined conversation situations with expected outcomes | Test specific use cases and edge cases                    |
| **Evaluators** | LLM judges or code scorers that assess conversations   | Measure quality, safety, efficiency, and correctness      |
| **Eval Sets**  | Combinations of personas, scenarios, and evaluators    | Run systematic test suites at scale                       |

## Creating Test Personas

A persona represents a simulated user with a specific communication style, domain knowledge level, and set of behavioral traits. During evaluation, an LLM plays the role of this persona, sending messages according to its defined characteristics.

### Persona Properties

| Field                   | Description                          | Options                                             |
| ----------------------- | ------------------------------------ | --------------------------------------------------- |
| **Name**                | Unique identifier                    | e.g., "Impatient Business Traveler"                 |
| **Communication style** | How the persona phrases messages     | `casual`, `formal`, `technical`, `terse`, `verbose` |
| **Domain knowledge**    | How much the persona knows           | `beginner`, `intermediate`, `expert`                |
| **Behavior traits**     | Specific behaviors exhibited         | Free-text tags                                      |
| **Goals**               | What the persona tries to accomplish | Free text                                           |
| **Constraints**         | Rules the persona follows            | Free text                                           |

> **Key Concept**: The `communicationStyle` field directly influences how the simulated user LLM phrases its messages. A `terse` persona sends short, curt messages that test whether your agent can extract meaning from minimal input. A `verbose` persona rambles and includes irrelevant details, testing whether your agent can filter signal from noise. Choose styles that match your actual user base.

### Example Personas

**Friendly Customer:**

- Communication style: `casual`
- Domain knowledge: `intermediate`
- Behavior traits: "answers directly", "thanks the agent", "provides info upfront"
- Goals: "Complete a booking efficiently"

**Impatient Customer:**

- Communication style: `terse`
- Domain knowledge: `beginner`
- Behavior traits: "gives short responses", "asks 'how much longer'", "expresses frustration"
- Goals: "Get a quick answer about order status"

**Confused Customer:**

- Communication style: `verbose`
- Domain knowledge: `beginner`
- Behavior traits: "gives vague descriptions", "changes mind mid-conversation", "needs steps repeated"
- Goals: "Get help with an unclear problem"

### Adversarial Personas

To test agent safety and robustness, create adversarial personas:

| Adversarial Type     | Tests For                                  |
| -------------------- | ------------------------------------------ |
| `prompt_injection`   | Attempts to override agent instructions    |
| `social_engineering` | Tries to extract sensitive information     |
| `off_topic`          | Steers conversation away from agent's goal |
| `abusive`            | Uses hostile or inappropriate language     |
| `edge_case`          | Sends unusual inputs (empty, very long)    |

## Creating Test Scenarios

A scenario defines a specific conversation situation, including the initial message, expected outcome, and success milestones.

### Scenario Properties

| Field                   | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| **Name**                | Unique identifier                                      |
| **Category**            | Grouping label (e.g., "booking", "returns")            |
| **Difficulty**          | `easy`, `medium`, or `hard`                            |
| **Initial message**     | The first user message that starts the scenario        |
| **Expected outcome**    | Description of what success looks like                 |
| **Max turns**           | Maximum conversation turns before timeout              |
| **Expected milestones** | Key checkpoints the conversation should hit            |
| **Agent path**          | Expected sequence of agents (for multi-agent projects) |

### Example Scenario

```
Name: Flight rebooking after cancellation
Category: booking
Difficulty: medium
Initial message: "My flight was cancelled and I need to rebook for tomorrow"
Expected outcome: "Agent identifies the cancelled booking, offers alternatives,
  and confirms a new flight"
Max turns: 15
Expected milestones:
  - "Identify cancelled flight"
  - "Present rebooking options"
  - "Confirm new booking"
Agent path: ["Supervisor", "Booking_Manager"]
```

## The Cartesian Product: Understanding the Evaluation Matrix

When you create an eval set, the platform executes the **Cartesian product** of personas, scenarios, and variants. Every persona talks through every scenario, and every evaluator scores each conversation.

> **Key Concept**: For an eval set with P personas, S scenarios, V variants, and E evaluators, the math is: **Total conversations = P x S x V** and **Total evaluations = P x S x V x E**. For example, with 3 personas, 4 scenarios, 2 variants, and 2 evaluators: 3 x 4 x 2 = 24 conversations, scored by 2 evaluators each = 48 total evaluations. The `variants` parameter repeats each combination multiple times for statistical confidence.

```
Example:
  3 personas x 4 scenarios x 2 variants = 24 conversations
  24 conversations x 2 evaluators = 48 evaluations
```

This is why persona and scenario design matters so much. Each additional persona or scenario multiplies the total test surface. Start focused -- 3 personas and 3-5 scenarios -- and expand as you identify gaps.

### Controlling Costs

The Cartesian product means costs grow multiplicatively. Strategies to manage this:

- **Start with 1 variant** during development; increase to 3+ for release candidates
- **Use smaller models** for persona simulation (the persona LLM just plays a user role)
- **Tag scenarios** and create separate eval sets: a small "smoke test" set for every commit and a comprehensive "regression" set for releases
- **Limit max concurrency** to control spend rate

## Building LLM Judge Evaluators

Evaluators are the scoring engine. An LLM judge evaluates the full conversation transcript and assigns scores based on a rubric you define.

### LLM Judge Configuration

| Field                | Description                                                                |
| -------------------- | -------------------------------------------------------------------------- |
| **Name**             | Unique identifier                                                          |
| **Category**         | `quality`, `safety`, `efficiency`, `empathy`, `tool_correctness`, `custom` |
| **Judge model**      | LLM used as the judge (e.g., `gpt-4o`)                                     |
| **Judge prompt**     | Instructions telling the judge what to evaluate                            |
| **Chain of thought** | Whether the judge explains reasoning before scoring                        |
| **Temperature**      | Lower = more consistent scores (try `0.1`)                                 |

### Scoring Rubrics

Define clear criteria for each score level:

**1-5 Scale:**

```
5 - Excellent: Fully addresses the request with accurate, complete information
4 - Good: Addresses the request with minor omissions
3 - Adequate: Partially addresses the request but misses key details
2 - Poor: Mostly misses the request or provides inaccurate information
1 - Failing: Completely fails to address the request
```

**Pass-Fail:**

```
1 - Pass: Agent completes the task within the expected flow
0 - Fail: Agent fails to complete the task or deviates from expected behavior
```

### Evidence-First Mode for LLM Judges

> **Key Concept**: When **evidence-first mode** is enabled, the LLM judge must cite specific evidence from the conversation transcript before assigning a score. Instead of "Score: 4 - the agent did well," the judge produces "Evidence: the agent correctly identified the cancelled flight (turn 3) and presented two rebooking options (turn 5), but did not mention fare differences. Score: 4." This dramatically improves scoring reliability and makes results actionable.

| Bias Mitigation Setting | What It Does                                               | Default |
| ----------------------- | ---------------------------------------------------------- | ------- |
| **Position swap**       | Evaluates conversation in both original and reversed order | On      |
| **Blind evaluation**    | Removes agent identity before judging                      | On      |
| **Cross-model judge**   | Uses a different model family than the agent               | Off     |
| **Evidence-first mode** | Requires citing evidence before scoring                    | On      |

## Trajectory Evaluators

Standard LLM judges evaluate response content -- what the agent said. Trajectory evaluators assess the agent's **execution path** -- what the agent did.

> **Key Concept**: Trajectory evaluators analyze the sequence of actions (tool calls, handoffs, flow steps) rather than response text. They verify milestone completion (did the conversation hit expected checkpoints?), handoff correctness (did the supervisor route to the right agent?), path efficiency (how many unnecessary steps?), and tool sequence (were tools called in the right order?).

Use trajectory evaluators when:

- Your agent has a specific expected flow (e.g., verify identity, then check balance, then process transfer)
- Multi-agent routing correctness matters
- You want to measure efficiency (conversation turns, tool call count)
- The order of operations matters for compliance

## Running Evaluation Batches

### Creating an Eval Set

An eval set combines personas, scenarios, and evaluators into a runnable suite:

| Field               | Description                                    |
| ------------------- | ---------------------------------------------- |
| **Personas**        | Select one or more simulated users             |
| **Scenarios**       | Select one or more test situations             |
| **Evaluators**      | Select one or more scoring judges              |
| **Variants**        | Repetitions per combination (for confidence)   |
| **Max concurrency** | Parallel conversation limit                    |
| **Persona model**   | LLM for persona simulation (optional override) |

### Run Statuses

| Status      | Meaning                                   |
| ----------- | ----------------------------------------- |
| `pending`   | Queued and waiting to start               |
| `running`   | Conversations and evaluations in progress |
| `completed` | All finished                              |
| `failed`    | Unrecoverable error                       |
| `cancelled` | Manually stopped                          |

### Running via API for CI/CD

Trigger eval runs programmatically:

```bash
curl -X POST /api/projects/:projectId/evals/runs \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "evalSetId": "your-eval-set-id",
    "name": "CI Run #42",
    "triggerSource": "ci"
  }'
```

## Baseline Regression Detection for CI/CD

Regression detection compares new eval runs against a baseline to catch performance drops before they reach production.

> **Key Concept**: To enable regression detection, set a **baseline run** (typically your last known-good evaluation) and a **regression threshold** (e.g., `0.1` for a 10% score drop). When a new run completes, the platform compares scores per-evaluator and per-scenario. If any score drops below the threshold, it flags the regression with the evaluator name, persona/scenario combination, baseline vs. current score, and delta.

### CI Pipeline Integration

```bash
# Trigger eval run
RUN_ID=$(curl -s -X POST .../evals/runs -d '...' | jq -r '.id')

# Poll for completion and check for regressions
RESULT=$(curl -s /api/projects/:projectId/evals/runs/$RUN_ID)
REGRESSION=$(echo $RESULT | jq '.regressionDetected')

if [ "$REGRESSION" = "true" ]; then
  echo "Regression detected -- blocking deployment"
  exit 1
fi
```

This creates a quality gate: agent changes that degrade performance are caught before deployment. The workflow is: develop changes, run eval suite in CI, compare against baseline, block deployment if regressions are detected.

### Setting Up Regression Detection

1. Run an initial evaluation and verify the scores look correct
2. Set that run as the **baseline** in the eval set settings
3. Set the **regression threshold** (0.05-0.10 is typical)
4. Enable **CI integration** on the eval set
5. Add the eval run API call to your CI pipeline

## Interpreting Results

### Score Distributions

| Pattern               | Meaning                           | Action                       |
| --------------------- | --------------------------------- | ---------------------------- |
| High avg, low stdDev  | Consistently good                 | Ship it                      |
| High avg, high stdDev | Good on average but unpredictable | Investigate outliers         |
| Low avg, low stdDev   | Consistently poor                 | Review instructions and flow |
| Low avg, high stdDev  | Wildly variable                   | Check failing scenarios      |

### Evaluator Reasoning

When chain-of-thought is enabled, each score includes the judge's analysis:

```
Score: 3/5
Reasoning: The agent correctly identified the customer's intent to rebook
a cancelled flight. However, it failed to check for available alternatives
before asking the customer for date preferences, adding an unnecessary
conversation turn. The information provided was accurate but incomplete --
no mention of rebooking fees or fare differences.
```

Use this reasoning to pinpoint specific improvements: refine `GOAL` and `PERSONA`, add `LIMITATIONS`, adjust flow step transitions, or improve tool configurations.

## Debugging with Traces

Every agent execution produces a tree of trace events. Use traces to understand why a conversation went wrong:

| Event Type       | What It Captures               |
| ---------------- | ------------------------------ |
| `llm_call`       | Model, tokens, latency, prompt |
| `tool_call`      | Parameters and result          |
| `decision`       | Routing logic and reasoning    |
| `handoff`        | Agent transfer with context    |
| `guardrail_eval` | Pass/fail and action taken     |
| `state_change`   | Session variable updates       |

For agent path issues, filter traces to `eventType=decision` to see what conditions were evaluated. For tool failures, check `eventType=tool_call` for parameters and error messages.

## Key Takeaways

- The Cartesian product (personas x scenarios x variants x evaluators) defines the evaluation matrix -- design carefully because each addition multiplies total tests
- Trajectory evaluators assess execution paths (tool calls, handoffs, flow steps) rather than just response content
- Baseline regression detection compares new runs against a known-good baseline, enabling quality gates in CI/CD pipelines
- Evidence-first mode requires LLM judges to cite specific transcript evidence before scoring, dramatically improving reliability
- The `communicationStyle` persona field directly controls how the simulated user LLM phrases messages, testing different interaction patterns

## What's Next

With evaluation mastered, you have the complete picture: build agents with tools and flows, collect data with GATHER, manage state with memory, protect with guardrails, and measure with evals. Explore any module you want to deepen, or start building your own evaluation suites for your agents.
