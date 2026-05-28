# ABL Best Practices

## Agent Design

### Choosing the Right Mode

- **Reasoning mode**: Use when the agent needs to make judgment calls, handle ambiguous input, or dynamically decide which tools to use. Best for open-ended tasks.
- **Scripted mode**: Use when the workflow is well-defined with clear steps. Best for forms, wizards, and structured data collection.

### Writing Effective Goals

- Be specific about what the agent should accomplish
- Include key constraints in the goal description
- Avoid vague goals like "help the user" - specify how

### PERSONA Guidelines

- Define personality traits that affect communication style
- Include domain expertise relevant to the agent's role
- Keep it concise - 2-4 lines maximum

## Tool Design

### Parameter Types

- Use specific types: `string`, `number`, `boolean`, `date`, `email`
- Set defaults for optional parameters: `status: string = "active"`
- Return structured objects: `-> {success: boolean, data: object}`

### Error Handling

- Always define ON_ERROR handlers for tool failures
- Use RETRY for transient errors (API timeouts)
- Use ESCALATE for persistent failures

## GATHER Best Practices

- Provide clear, specific prompts
- Mark fields as required/optional explicitly
- Use appropriate types for validation
- Keep field names in snake_case

## Multi-Agent Patterns

### Supervisor Pattern (Unified AgentIR)

- Supervisors are agents with routing config — detected by `ir.routing?.rules?.length > 0`
- All agents (including supervisors) live in one unified registry
- Supervisors can hand off to other supervisors (hierarchical composition)
- Keep routing conditions specific and non-overlapping
- Always include a fallback agent
- Use RETURN: true when the supervisor needs to orchestrate further
- Use RETURN: false for terminal handoffs

### Adaptive Network Pattern

- Define clear handoff conditions between agents
- Use RETURN: true for round-trip consultations
- Use RETURN: false for permanent transfers
- Ensure there's always a path back or to completion

## Common Pitfalls

1. **Missing error handlers**: Always define ON_ERROR for each tool failure type
2. **Overlapping routing rules**: Ensure HANDOFF conditions are mutually exclusive
3. **Missing COMPLETE conditions**: Define when the conversation ends
4. **Circular handoffs**: Avoid A -> B -> A loops without exit conditions
5. **Over-gathering**: Don't collect more information than needed
