// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/memory-and-constraints.mdx, abl-reference/guardrails.mdx
// Regenerate: pnpm abl:docs:generate

export const LIMITATIONS_VS_CONSTRAINTS_CARD = `## LIMITATIONS vs CONSTRAINTS vs GUARDRAILS

## CONSTRAINTS
- Constraints are deterministic runtime checks that the runtime evaluates against the current session state and explicit checkpoints.
### Overview
- Constraints define runtime checks that are separate from prompt-level guidance in \`LIMITATIONS\` and content-safety checks in \`GUARDRAILS\`.
- Plain list items are not runtime constraints.
\`\`\`abl
# Invalid for agent runtime constraints: saved as text, ignored by the compiler
CONSTRAINTS:
  - "Verify identity before disclosure."
\`\`\`
\`\`\`abl
CONSTRAINTS:
  always:
    - REQUIRE customer_verified == true
      ON_FAIL: "Please verify your identity first."

  transfer_rules:
    - REQUIRE amount <= available_balance
      ON_FAIL: "Insufficient funds. Your available balance is {{available_balance}}."

    - REQUIRE sanctions_clear == true
      ON_FAIL: HANDOFF Compliance_Officer
\`\`\`
### Labels
- Named labels are retained for readability, review, and organization.
#### Syntax
\`\`\`abl
CONSTRAINTS:
  label_name:
    - REQUIRE condition_expression
      ON_FAIL: action_or_message
\`\`\`
- Use labels like \`always\`, \`booking_rules\`, or \`eligibility_checks\` when they help readers understand intent, but use \`WHEN\` to gate applicability and \`BEFORE\` only for explicit structural checkpoint targets.
### Requirement rules
- Each requirement within a labeled block uses one of three keywords: \`REQUIRE\`, \`LIMIT\`, or \`RESTRICT\`.
#### REQUIRE
- The most common form.
\`\`\`abl
- REQUIRE account_status == "active"
  ON_FAIL: "Wire transfers require an active account."
\`\`\`
#### LIMIT
- Expresses a numeric boundary.
\`\`\`abl
- LIMIT daily_wire_used + amount <= daily_wire_limit
  ON_FAIL: "This would exceed your daily wire limit of {{daily_wire_limit}}."
\`\`\`
#### RESTRICT
- Expresses a prohibition.
\`\`\`abl
- RESTRICT beneficiary_country IN ["CU", "IR", "KP", "SY"]
  ON_FAIL: "Transfers to that destination are prohibited under sanctions regulations."
\`\`\`
#### WHEN
- Use \`WHEN:\` to make a constraint apply only in a specific context without overloading the phase label.
\`\`\`abl
- REQUIRE ssn IS NOT SET
  WHEN: channel == "voice"
  ON_FAIL: "SSN cannot be collected on voice."
\`\`\`
#### BEFORE
Use \`BEFORE\` for structural checkpoints that the runtime knows how to activate.
\`\`\`abl
- REQUIRE measure_field IS SET BEFORE calling search_aggregate
  ON_FAIL: "Select a measure before running the aggregate search."

- REQUIRE aggregation_validated == true BEFORE returning results
  ON_FAIL: "Validate the aggregation before responding."
\`\`\`
Supported structural targets today:
- \`BEFORE calling <tool_name>\`
- \`BEFORE returning results\`
- Non-structural \`BEFORE\` targets are retained for compatibility, but they are warning-only and have no runtime effect.
### Constraint properties
| Property    | Type                 | Required | Default   | Description                                                                                                                           |
| ----------- | -------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |`;
