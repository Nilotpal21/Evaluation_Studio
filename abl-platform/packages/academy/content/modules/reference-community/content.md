# Reference and Community

> **Estimated time**: 15 minutes | **Prerequisites**: None

## Learning Objectives

After completing this module, you will be able to:

- Navigate the Agent Platform glossary to find definitions of key terms
- Identify the correct channels for getting help, reporting bugs, and disclosing vulnerabilities
- Understand the platform's security practices, compliance certifications, and data protection model
- Distinguish between platform terminology that is often confused (DELEGATE vs. HANDOFF, workspace vs. tenant)
- Describe the support tiers available and their response time commitments

## Glossary of Key Terms

The Agent Platform uses specific terminology throughout its documentation and tools. This section covers the most important terms you will encounter, organized by concept area rather than alphabetically -- this helps you see how terms relate to each other.

### Agent-Related Terms

| Term                     | Definition                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent**                | An autonomous unit of work defined in ABL that handles a specific domain or task. Each agent has a goal, persona, tools, and optional conversation flow. |
| **Supervisor**           | A coordination layer that manages routing between multiple agents using HANDOFF rules. Supervisors do not handle domain tasks directly.                  |
| **Reasoning mode**       | The default execution mode for every agent. The LLM decides actions dynamically based on goal, persona, tools, and constraints.                          |
| **Flow-based execution** | An execution style where an agent includes a FLOW section for structured, step-by-step conversation control.                                             |
| **Session**              | A stateful conversation between an end user and one or more agents, tracking history, variables, and flow position.                                      |
| **Turn**                 | A single request-response cycle within a session (user sends message, agent produces response).                                                          |

### Multi-Agent Terms

Understanding the distinction between DELEGATE and HANDOFF is critical for designing multi-agent systems:

| Term         | What It Does                                                   | Context Passed                                                             | Control Flow                                |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| **HANDOFF**  | Transfers an active conversation from one agent to another     | Full conversational context (variable state, conversation summary, memory) | One-way or round-trip (with `RETURN: true`) |
| **DELEGATE** | Dispatches a subtask to another agent and waits for the result | Input/output mapping with a specific purpose description                   | Always returns to the delegating agent      |
| **ESCALATE** | Transfers control from an AI agent to a human operator         | Priority level, contextual information, routing config                     | One-way to human agent                      |

> **Key Concept**: DELEGATE and HANDOFF serve fundamentally different purposes. A HANDOFF transfers the entire conversation -- like transferring a phone call. A DELEGATE dispatches a specific subtask and gets results back -- like asking a colleague to look something up while you wait. ESCALATE transfers to a human when the AI agent cannot resolve the issue.

### Infrastructure Terms

| Term             | Definition                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant**       | An isolated environment within the platform containing projects, members, and configuration. Every API request is scoped to a tenant. |
| **Workspace**    | A synonym for tenant. The terms "workspace" and "tenant" are used interchangeably in different parts of the platform.                 |
| **Project**      | A container within a tenant that groups related agents, knowledge bases, tools, and configuration.                                    |
| **Organization** | The top-level entity grouping one or more tenants under a single billing and administrative boundary.                                 |
| **Channel**      | A deployment endpoint (WhatsApp, Slack, web chat, voice, API) through which end users interact with agents.                           |

> **Key Concept**: Workspace and tenant are synonyms -- they refer to the same isolated environment. You may see both terms used in different parts of the platform interface and documentation. Do not confuse them as separate concepts.

### Technical Terms

| Term           | Definition                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| **ABL**        | Agent Behavior Language -- the declarative DSL for defining agent behavior, tools, flows, and orchestration.     |
| **IR**         | Intermediate Representation -- the compiled JSON output of ABL definitions that the Runtime executes.            |
| **GATHER**     | A data collection construct within ABL that defines fields to collect from users during a conversation.          |
| **FLOW**       | An optional construct that adds structured, step-based execution to an agent.                                    |
| **Guardrail**  | A safety mechanism that evaluates agent inputs and outputs against defined policies.                             |
| **Constraint** | A business rule that must be satisfied before an agent proceeds with an action.                                  |
| **RAG**        | Retrieval-Augmented Generation -- enriching LLM prompts with relevant content from knowledge bases.              |
| **MCP**        | Model Context Protocol -- an open protocol for connecting agents to external tools via a standardized interface. |
| **Trace**      | A structured record of events emitted during agent execution (LLM calls, tool invocations, state transitions).   |

## Getting Help

### Documentation

The full documentation is available at [docs.ablplatform.com](https://docs.ablplatform.com) and includes tutorials, how-to guides, the ABL language reference, and the REST API reference.

### Community Channels

- **Community forum** at [community.ablplatform.com](https://community.ablplatform.com) -- Ask questions, share patterns, and learn from other developers. Monitored by the platform team.
- **Slack community** -- Request an invite for real-time discussions with other developers and the platform team.
- **Stack Overflow** -- Tag questions with `abl-platform` for community-driven answers.
- **In-app support** -- Click the Help button in Studio for direct support chat, or email [support@ablplatform.com](mailto:support@ablplatform.com).

### Support Tiers

The platform provides four levels of support, determined by your plan tier:

| Tier           | Response Time     | Channels                     | Availability   |
| -------------- | ----------------- | ---------------------------- | -------------- |
| **Community**  | Best effort       | Forum, Stack Overflow, Slack | 24/7           |
| **Standard**   | 1 business day    | Email, ticket system         | Business hours |
| **Premium**    | 4 hours           | Email, ticket, Slack         | Business hours |
| **Enterprise** | 1 hour (critical) | Dedicated Slack, phone       | 24/7           |

> **Key Concept**: The Enterprise support tier provides a 1-hour response time for critical issues with 24/7 availability through a dedicated Slack channel and phone support. This is the highest level of support offered by the platform.

## Reporting Bugs and Feature Requests

### Reporting Bugs

If you encounter a bug:

1. Check existing issues in the [issue tracker](https://github.com/ablplatform/issues)
2. Create a new issue with: a clear title, steps to reproduce, expected vs. actual behavior, platform/browser details, and relevant ABL definitions or trace IDs
3. Label with `bug` and applicable component labels (`studio`, `runtime`, `searchai`, `sdk`)

The platform team triages new issues within two business days.

### Feature Requests

1. Check the [public roadmap](https://roadmap.ablplatform.com) for planned features
2. Submit a request in the issue tracker with the `enhancement` label
3. Describe your use case -- explain what you are trying to accomplish
4. Vote on existing requests to signal priority

## Security Practices

### Infrastructure Security

- **Encryption in transit**: All data uses TLS 1.2 or higher. Internal service-to-service communication is encrypted.
- **Encryption at rest**: All stored data is encrypted using industry-standard encryption.
- **Network isolation**: Platform services run in isolated network segments with strict ingress/egress controls.
- **Secret management**: API keys and credentials are encrypted before storage and never exposed in logs, traces, or API responses.

### Application Security

- **Authentication**: Email/password with optional MFA, plus enterprise SSO via SAML 2.0 and OpenID Connect (OIDC).
- **Authorization**: Role-based access control (RBAC) at organization, tenant, and project levels. Every API request is scoped to a tenant.
- **Input validation**: All API inputs are validated and sanitized. Payload size limits enforced at service boundaries.
- **Dependency scanning**: Third-party dependencies scanned regularly, with critical patches applied within 48 hours.

### Tenant Data Isolation

Every piece of data is scoped to a tenant. Database queries always include tenant identifiers, and cross-tenant access returns a 404 response (not 403) to avoid leaking resource existence.

## Compliance and Certifications

### SOC 2 Type II

The Agent Platform maintains **SOC 2 Type II compliance**, independently audited against the Trust Services Criteria for security, availability, and confidentiality. Audit reports are available under NDA upon request.

> **Key Concept**: SOC 2 Type II compliance means the platform's security controls have been independently audited over an extended period (not just at a point in time). This is one of the most rigorous compliance certifications for cloud platforms and is required by many enterprise customers.

### Additional Compliance Frameworks

| Framework     | Status                                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| **GDPR**      | Compliant -- data minimization, right to erasure, data portability, DPA available |
| **ISO 27001** | Aligned with information security management practices                            |
| **CCPA**      | Compliant with California Consumer Privacy Act requirements                       |
| **HIPAA**     | Readiness available on Enterprise plans with a Business Associate Agreement       |

### Data Protection

- **Conversation data**: Configurable retention periods (default 7 days), automatic purging, compression before storage
- **LLM data**: Prompt data follows provider processing terms; credentials encrypted; no data sent for model training
- **PII handling**: GATHER fields can be marked as sensitive for automatic PII masking; transient fields auto-cleared after collection

## Vulnerability Reporting

If you discover a security vulnerability in the platform, responsible disclosure is essential.

### How to Report

1. **Email** [security@ablplatform.com](mailto:security@ablplatform.com) with a detailed description
2. **Include**: Steps to reproduce, potential impact, any proof-of-concept code or screenshots, and your contact information
3. **Do not** publicly disclose the vulnerability until the fix is confirmed and a disclosure timeline is coordinated

> **Key Concept**: Responsible vulnerability disclosure means emailing security@ablplatform.com directly -- not posting publicly. The team acknowledges reports within 2 business days and provides an initial assessment within 5 business days. They do not pursue legal action against researchers who follow responsible disclosure practices.

### Platform Status

Monitor operational status at [status.ablplatform.com](https://status.ablplatform.com), which provides real-time service status, uptime metrics, active incident details, and scheduled maintenance windows. Subscribe via email, RSS, or webhook for automatic notifications.

## Contributing to the Platform

### Documentation Contributions

1. Report documentation issues with the `docs` label
2. Submit pull requests following the style guide: second person ("you"), active voice, present tense, sentence case headings
3. Avoid words like "simply," "just," or "easily"

### Partner Program

The partner program serves system integrators, consultancies, and technology companies building on the platform. Benefits include early access to features, direct engineering team access, co-marketing opportunities, and dedicated training. Contact [partners@ablplatform.com](mailto:partners@ablplatform.com) to apply.

### Versioning Policy

The platform follows semantic versioning:

- **Major** (e.g., 2.0.0): Breaking changes requiring migration
- **Minor** (e.g., 1.3.0): New features, backward-compatible
- **Patch** (e.g., 1.3.2): Bug fixes and security updates

Breaking changes are announced at least one minor version in advance, with migration guides and a 90-day transition period.

## Key Takeaways

- **DELEGATE** dispatches a subtask and gets results back; **HANDOFF** transfers the entire conversation to another agent -- they are fundamentally different patterns
- **Workspace** and **tenant** are synonyms referring to the same isolated environment
- The **Enterprise support tier** provides 1-hour response time with 24/7 availability through dedicated Slack and phone
- The platform maintains **SOC 2 Type II** compliance with independent auditing
- Report security vulnerabilities responsibly by emailing **security@ablplatform.com** -- never disclose publicly before the fix is coordinated

## What's Next

Explore the **ABL Basics** module to start learning the ABL language syntax, or dive into **Agent Configuration** to understand advanced identity and execution settings.
