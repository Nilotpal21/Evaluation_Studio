# Feature Request: Reusable Agent Modules

**Status**: ready-for-jira
**Date**: 2026-03-17

---

## Jira Ticket

**Type**: Feature Request
**Priority**: High
**Labels**: `modularity`, `reuse`, `client-requirement`

**Title**: Reusable Agent Modules — Build once, import everywhere across projects

---

### Problem

Customers building multiple agent applications (projects) on the platform find themselves duplicating common functionality across projects. For example, an identity verification flow, a payment processing agent, or a FAQ handler may be needed in several different applications. Today, the only option is to copy-paste the agent definitions and tools into each project individually.

This leads to:

- **Duplication**: The same agent logic exists in multiple projects, each copy diverging over time
- **Maintenance burden**: A bug fix or improvement to a shared capability must be applied to every project that uses it
- **Inconsistency**: Different projects end up with slightly different versions of the same capability, causing inconsistent user experiences
- **Slower development**: Building a new application means re-implementing common patterns instead of composing from proven building blocks

---

### Requirement

**As a** customer building multiple agent applications on the platform,
**I want** to build a reusable agent module in one place and import it into any of my projects,
**so that** common capabilities are maintained once and stay consistent across all applications that use them.

Think of it like a Python module or an npm package — you define it once, publish it, and `import` it wherever you need it.

---

### What "Reusable" Means

A reusable module should be a self-contained unit of agent functionality that can be used across projects. It could contain:

- **One or more agents** — e.g., an "Identity Verification" module with a verification agent and a fraud-check sub-agent
- **Tools** — custom tools that the module's agents use (API integrations, data lookups, etc.)
- **Gather flows** — structured data collection sequences (e.g., collecting shipping address, verifying insurance details)
- **Configuration** — default settings that the importing project can override (e.g., which identity documents are accepted, retry limits)

A module is **not** a full application on its own — it doesn't have its own entry point or its own sessions besides the development test sessions. It's a building block that becomes part of the importing project when used. However, a module **should have its own deployment lifecycle** with environment tags (e.g., `dev`, `qa`, `prod`), so that the module team can develop and test improvements without affecting projects that are already using a released version. An importing project pins to a specific environment/version of the module — a module being actively worked on in `dev` does not impact a project running the `prod` tag.

---

### Expected Behaviors

1. **Create a module**: A user should be able to designate an entire project as a reusable module. The module has a name, version, and description. It defines what it provides (agents, tools) and what it requires from the importing project (configuration, credentials, data).

2. **Import a module into a project**: A project should be able to declare a dependency on a module. The module's agents and tools become available within the importing project — they can be referenced in handoffs, delegations, and routing rules as if they were defined locally.

3. **Version and environment management**: Modules should support environment-based promotion (dev → qa → prod), just like application projects. The module team works on improvements in `dev`, tests in `qa`, and promotes to `prod` when ready. An importing project pins to an environment tag or a specific version — a project running in production pulls from the module's `prod` tag, so in-progress development on the module never affects live applications. Updating to a new version is an explicit action, not automatic.

4. **Configuration and customization**: The importing project should be able to configure the module's behavior without modifying the module itself. For example:
   - Override default settings (e.g., change the greeting message, adjust thresholds)
   - Provide project-specific credentials (e.g., the module uses a payment API — each project provides its own API key)
   - Map the module's expected data fields to the project's own data model

5. **Isolation**: A module running within a project should respect the importing project's tenant isolation, data retention policies, and security boundaries. The module does not introduce its own data scope — it operates within the importing project's context.

6. **Discoverability**: Users should be able to browse available modules within their tenant. Optionally, a tenant admin could publish modules that are available to all projects within the tenant.

7. **Testing**: A module should be testable in isolation (e.g., via a test harness or sandbox project) before being published for use by other projects.

---

### User Journey Example

> A **health insurance provider** builds multiple agent applications on the platform to serve different audiences:
>
> - **Member Services Bot** — helps members with general inquiries, ID cards, claims status, and complaints
> - **Provider Portal Agent** — assists referring physicians and facilities with eligibility checks, prior authorizations, and claim dispute resolution
> - **Enrollment Assistant** — guides prospective and renewing members through plan selection, enrollment, and onboarding
> - **HR Benefits Portal Agent** — supports employer-group HR teams managing their employees' benefits packages
>
> All four applications need a **benefits queries agent** — an agent that can look up plan details, explain coverage levels, check deductibles and out-of-pocket maximums, compare plans, and answer "is this procedure covered?" questions. The underlying benefits logic is the same regardless of who's asking: a member checking their own coverage, a physician verifying a patient's eligibility, a prospective member comparing plans, or an HR administrator reviewing what's available to their employees.
>
> Today, the provider's team has copy-pasted the benefits queries agent into all four projects. Each copy has its own version of the plan lookup tools, formulary search, and coverage explanation logic. When the organization introduced a new plan tier mid-year, the team updated the benefits agent in Member Services and Provider Portal but missed Enrollment and HR Portal — those apps showed stale plan information for weeks before anyone noticed, leading to member confusion and support escalations.
>
> With reusable modules, the team creates:
>
> - `benefits-queries@1.0` — contains the benefits query agent, plan lookup tools, formulary search, and coverage explanation logic
>
> Each of the four projects imports this module. The benefits agent is maintained once by the core team. When the new plan tier is added, `benefits-queries@1.1` is published and each project team upgrades on their own schedule. The Member Services project configures it to use plain-language explanations for members, while the Provider Portal configures it to return clinical and billing detail for physicians — same module, different configuration.

---

### Constraints and Considerations

1. **Scope boundaries**: What happens when a module's agent needs data that lives in the importing project's context (e.g., customer account info)? The contract between module and project needs to be clear — what the module expects as input and what it provides as output.

2. **Credential isolation**: Modules may need API credentials (e.g., a payment gateway key). These must come from the importing project, not be baked into the module. A module should never carry secrets.

3. **Conflict resolution**: What if two imported modules define agents or tools with the same name? The platform needs a namespacing or conflict resolution strategy.

4. **Permissions**: Who can create modules? Who can publish them tenant-wide? Who can import them? This ties into the platform's existing role and permission model.

5. **Update propagation**: When a module is updated, importing projects should not be affected until they explicitly upgrade. But there should be visibility into which projects use which module version (dependency graph).

6. **Debugging and observability**: When a module's agent is executing within a project, traces and logs should clearly indicate that the agent comes from a module — making it easy to attribute issues to the module vs. the project.

7. **Tenant scoping**: Modules are scoped to a single tenant. Cross-tenant agent interaction is out of scope for modules and should be handled via external protocols like A2A.

---

### Reference

- Current project/agent architecture analysis: `docs/scratchpad/cross-channel-identity-and-recall.md` (describes the project model and agent coordination mechanisms)
- Existing cross-boundary mechanism: The platform supports remote agent handoffs via A2A protocol, but this is for external integrations, not for first-class module reuse within the platform
