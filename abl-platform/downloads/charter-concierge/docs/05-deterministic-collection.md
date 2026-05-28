# Deterministic Collection, Constraints, Guardrails, Limitations

This bundle uses four layers of deterministic control. They are related, but they are not interchangeable.

## `LIMITATIONS`

Limitations are authored behavioral boundaries for the model:

- no account changes without the right lane
- no waived identity rules
- no guaranteed install windows

They are important, but they are the softest layer.

## `GATHER`

`GATHER` commits the values the runtime needs to operate.

Examples in this bundle:

- `service_address`, `internet_need`, `mobile_line_count` in intake
- `address_status`, `modem_status`, `device_status` in setup readiness
- `requested_action`, `credit_amount`, `credit_reason` in billing

`GATHER` turns conversational ambiguity into explicit state.

## `ENTITIES` and `ENTITY_REF`

`Setup_Readiness_Collector` shows the extra deterministic layer that sits between raw language and committed state.

- `ENTITIES` define normalized values like `ADDR_VERIFIED` and `DEVICE_PORTING`
- `ENTITY_REF` maps user wording onto those normalized values

That is more deterministic than asking the model to “roughly understand what they meant.”

## `CONSTRAINTS`

Constraints are runtime-enforced business rules.

Examples here:

- service must be selected before setup readiness can pass
- address must be verified before readiness validation
- billing credits above the self-service ceiling cannot stay in the automated lane

The point is not only that these rules exist. The point is that they are evaluated by runtime policy instead of being left to prompt obedience.

## `GUARDRAILS`

Guardrails inspect pipeline boundaries.

Current examples:

- input SSN redaction in billing
- output neutrality enforcement for competitor comparisons
- fraud-sensitive request blocking in intake

This is why guardrails and constraints should not be merged. One protects business policy. The other protects content and boundary safety.

## The deterministic pipeline

| Layer         | Example in Charter bundle            | Why it matters                      |
| ------------- | ------------------------------------ | ----------------------------------- |
| `LIMITATIONS` | “Cannot waive verification”          | Sets model behavior expectations    |
| `GATHER`      | `credit_amount`, `address_status`    | Commits exact state                 |
| `ENTITIES`    | `ADDR_VERIFIED`, `DEVICE_PORTING`    | Makes fuzzy phrasing machine-stable |
| `CONSTRAINTS` | credit ceiling, setup prerequisites  | Blocks invalid transitions          |
| `GUARDRAILS`  | SSN redaction, fraud-sensitive block | Protects boundary safety            |

## Why this matters for telco

Telecom support has many places where “pretty good” is not good enough:

- identity verification
- SIM and port boundaries
- installation readiness
- billing credits and supervisor approval

This bundle shows how to keep those lanes deterministic without making the whole experience rigid.
