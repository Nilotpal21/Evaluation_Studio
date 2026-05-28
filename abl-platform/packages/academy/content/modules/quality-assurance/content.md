# Quality Assurance

> **Estimated time**: 18 minutes | **Prerequisites**: Platform Configuration

## Learning Objectives

After completing this module, you will be able to:

- Design evaluation sets that systematically test agent quality using personas, scenarios, and evaluators
- Interpret evaluation results including score distributions and standard deviation patterns
- Explain the Cartesian product model for evaluation set execution
- Describe the layered guardrail strategy for protecting agents and users
- Identify when and how to use output guardrails for PII redaction in responses

## Why Systematic Testing Matters

Interactive testing -- chatting with your agent in Studio -- is valuable during development, but it cannot catch the full range of issues that surface in production. Users are unpredictable. They arrive with different communication styles, domain knowledge levels, and intentions. Some are patient and cooperative; others are terse, confused, or adversarial.

The Agent Platform's evaluation framework lets you simulate this diversity at scale, automatically score conversations against quality criteria, and detect regressions before they reach production.

## Evaluation Building Blocks

The evaluation system has three core components that combine to create comprehensive test suites:

### Personas: Simulated Users

A persona represents a simulated user with specific traits. Each persona is essentially a character sheet that tells the simulation LLM how to behave during a test conversation.

| Persona Attribute   | What It Controls                         | Example Values                                       |
| ------------------- | ---------------------------------------- | ---------------------------------------------------- |
| Communication style | How the persona phrases messages         | Casual, formal, technical, terse, verbose            |
| Domain knowledge    | How much the persona knows               | Beginner, intermediate, expert                       |
| Behavior traits     | Specific behaviors exhibited             | "Asks follow-ups," "impatient," "gives partial info" |
| Goals               | What the persona is trying to accomplish | "Complete a flight rebooking"                        |
| Constraints         | Rules the persona follows                | "Never provides information upfront"                 |

You can also create **adversarial personas** to test agent robustness -- personas that attempt prompt injection, social engineering, off-topic steering, or abusive language.

### Scenarios: Conversation Paths

A scenario defines a specific conversation to test, including the starting message, expected outcome, maximum turns, and key milestones the conversation should hit.

For example, a "Flight Rebooking After Cancellation" scenario might specify:

- **Initial message**: "My flight was cancelled and I need to rebook for tomorrow"
- **Expected outcome**: Agent identifies the cancelled booking, offers alternatives, and confirms a new flight
- **Expected milestones**: Identify cancelled flight, present rebooking options, confirm new booking
- **Maximum turns**: 15

### Evaluators: Scoring Judges

Evaluators automatically score the quality of each test conversation. The platform supports several types:

| Evaluator Type   | How It Works                                                    | Best For                                                   |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| **LLM Judge**    | A separate LLM scores conversations against a rubric you define | Response quality, tone, completeness                       |
| **Trajectory**   | Assesses the agent's execution path                             | Handoff correctness, milestone completion, path efficiency |
| **Code Scorer**  | Deterministic checks (regex, keywords, thresholds)              | Response time, keyword presence, format validation         |
| **Human Review** | Flags conversations below a threshold for manual review         | Subjective quality, edge cases                             |

## How Eval Sets Work: The Cartesian Product

> **Key Concept**: An eval set executes the **Cartesian product** of personas, scenarios, and variants. If you have 3 personas, 4 scenarios, and 2 variants, the platform runs 3 x 4 x 2 = **24 independent conversations**. Each conversation is then scored by every evaluator you include. With 2 evaluators, that produces 48 total evaluations. This systematic approach ensures every persona-scenario combination is tested, revealing issues that targeted manual testing would miss.

| Eval Set Component      | Example Count | Purpose                           |
| ----------------------- | ------------- | --------------------------------- |
| Personas                | 3             | Diverse user profiles             |
| Scenarios               | 4             | Different conversation paths      |
| Variants                | 2             | Repeat for statistical confidence |
| **Total conversations** | **24**        | 3 x 4 x 2                         |
| Evaluators              | 2             | Quality and safety scoring        |
| **Total evaluations**   | **48**        | 24 x 2                            |

### Baseline Comparison: Before and After

> **Key Concept**: **Eval set baseline comparison** is your safety net for agent changes. Set a known-good eval run as your baseline, then configure a regression threshold (for example, 10% score drop). When you modify an agent and run the eval set again, the platform automatically compares scores per evaluator and flags regressions -- showing you exactly which persona-scenario combination degraded, the baseline vs. current score, and the delta. This before-and-after comparison catches regressions before they reach production.

For CI/CD integration, enable the **CI Enabled** toggle on your eval set. Your build pipeline can then trigger eval runs via API and fail the deployment if regressions are detected.

## Interpreting Evaluation Results

Understanding score distributions is critical for knowing when to ship and when to investigate further.

### Score Distribution Patterns

| Pattern                               | What It Means                         | Recommended Action                        |
| ------------------------------------- | ------------------------------------- | ----------------------------------------- |
| High average, low standard deviation  | Agent performs **consistently well**  | Ready for production                      |
| High average, high standard deviation | Good on average but **unpredictable** | Investigate low-scoring outliers          |
| Low average, low standard deviation   | **Consistently underperforms**        | Review agent instructions and flow design |
| Low average, high standard deviation  | Performance **varies wildly**         | Check for specific failing scenarios      |

> **Key Concept**: A **high average score combined with high standard deviation** is a particularly important pattern to diagnose. It means your agent usually does well, but occasionally fails badly. The fix is to drill into the low-scoring individual conversations, review the evaluator's chain-of-thought reasoning, and identify which specific personas or scenarios expose the weakness. Often the issue is a missing edge case in the agent's instructions or flow logic.

### Statistical Confidence

To get reliable results:

- Use at least **2-3 variants** per persona-scenario combination for statistical significance
- Lower the judge temperature (try 0.1) for more consistent scoring
- Enable **evidence-first mode** on LLM judges to require specific evidence citations before scoring

## Guardrails: Layered Safety

Guardrails protect your agents and users by filtering content at multiple points in the conversation. They are distinct from business constraints (which enforce rules like booking limits or eligibility checks) -- guardrails focus on **content safety and policy compliance**.

### The Layered Guardrail Strategy

> **Key Concept**: A **layered guardrail approach** applies protections at multiple points in the conversation flow -- input, output, and external provider evaluation. Input guardrails catch unsafe or off-topic messages before they reach the LLM. Output guardrails filter the agent's responses before they reach the user. External providers like **Lakera Guard** add specialized detection for prompt injection and jailbreak attempts. This defense-in-depth strategy ensures no single point of failure can let harmful content through.

| Layer                  | When It Runs                                                | What It Catches                                                                                           | Example Actions     |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------- |
| **Input guardrails**   | Before the user's message reaches the LLM                   | Profanity, PII in user messages, prompt injection, off-topic content                                      | Block, warn, redact |
| **Output guardrails**  | After the LLM generates a response, before delivery to user | PII in agent responses, toxic content, policy violations                                                  | Block, redact, fix  |
| **External providers** | Integrated into the guardrail evaluation pipeline           | Specialized threat detection (Lakera Guard for prompt injection, OpenAI Moderation, Azure Content Safety) | Block, warn, log    |

### Output Guardrails for PII Redaction

> **Key Concept**: **Output guardrails for PII redaction** ensure that even if an LLM accidentally includes sensitive information (Social Security numbers, credit card numbers, phone numbers) in its response, that information is **automatically detected and redacted before it reaches the end user**. The platform supports pattern-based detection (regex), built-in PII detection (email, SSN, credit card with Luhn validation, phone numbers, IP addresses), and custom recognizers for domain-specific patterns.

How PII output redaction works in practice:

1. The agent generates a response using the LLM
2. Before delivery, the output guardrail evaluates the response against configured patterns
3. If a pattern matches (for example, a Social Security number format), the configured action executes
4. With the `redact` action, the matched content is replaced with a safe placeholder
5. With the `block` action, the entire response is replaced with a fallback message

### Guardrail Priority and Ordering

Guardrails execute in priority order (lower numbers run first). This lets you create a structured evaluation pipeline:

| Priority | Guardrail                        | Action   | Rationale                                          |
| -------- | -------------------------------- | -------- | -------------------------------------------------- |
| 0        | Harmful content detection        | Escalate | Most critical -- catch dangerous content first     |
| 0        | PII redaction (SSN, credit card) | Redact   | Compliance requirement -- cannot wait              |
| 1        | Profanity filter                 | Block    | Important but less critical than safety            |
| 2        | Topic relevance check            | Block    | Lowest priority -- only matters if content is safe |

### Workspace vs. Project Guardrails

- **Workspace guardrails** enforce organization-wide policies (hate speech, PII) across all projects
- **Project guardrails** add domain-specific rules (financial advice disclaimers, competitor mention filtering)
- When both exist, workspace policies evaluate first, and the most restrictive action wins

## Practical Testing Workflow

For business analysts managing agent quality, here is a recommended workflow:

1. **Create diverse personas** -- Include at least one beginner, one expert, one terse communicator, and one adversarial persona
2. **Design scenarios by category** -- Cover the happy path, common edge cases, and known pain points
3. **Build eval sets** -- Combine personas and scenarios with at least 2 variants for statistical confidence
4. **Establish a baseline** -- Run the eval set against your current agent version and mark it as the baseline
5. **Test changes** -- After modifying agents, rerun the eval set and compare against the baseline
6. **Investigate regressions** -- Drill into individual conversations that regressed, review judge reasoning, and iterate
7. **Configure guardrails** -- Start in log-only mode, review what gets flagged, then enable blocking as confidence grows

## Key Takeaways

- Eval sets execute the Cartesian product of personas, scenarios, and variants, ensuring systematic coverage across diverse user profiles and conversation paths
- Baseline comparison (before/after) is your safety net for catching regressions when modifying agents -- set a known-good run as the baseline and configure regression thresholds
- A high average score combined with high standard deviation signals inconsistency that requires investigating specific low-scoring outlier conversations
- Layered guardrails (input, output, and external providers like Lakera Guard) provide defense-in-depth for content safety
- Output guardrails with PII redaction automatically detect and remove sensitive information from agent responses before they reach users

## What's Next

Continue to **Publishing & Monitoring** to learn how to deploy agents through environments, set up rollback procedures, and monitor performance with the Insights dashboard.
