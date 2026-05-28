Bruce's ABL Spec Review — Analysis & Response

Legend

- Already Covered = implemented in parser + compiler + runtime
- Partially Covered = parsed/compiled but not fully wired at runtime
- Not Covered = not implemented, needs design work

---

1. GATHER — Entity Collection & Data Capture

1.1 Historical Context

Bruce's framing is accurate. ABL bridges intent-entity capture and agentic flow. No action needed — this is contextual commentary.

1.2 Entity Type System Deficiencies

What Bruce Wants: 25+ Kore platform entity types (Address, Airport, Currency, etc.)
What We Have: 6 types: string, number, date, email, phone, boolean
Gap: Large gap
────────────────────────────────────────
What Bruce Wants: Supplemental semantics for numbers (unit, currency, age, duration)
What We Have: None — number is just number
Gap: Not covered
────────────────────────────────────────
What Bruce Wants: Supplemental semantics for strings (enum set, location subtype)
What We Have: extraction_hints can hint at this informally
Gap: Not covered (no formal structure)

Design Consideration: We have two options:

1. Expand the type enum to include all Kore entity types (address, airport, currency, etc.) with a subtype or unit field — this is the "wide type system"
   approach
2. Keep fundamental types + supplemental metadata — add semantics: { unit?: string, enumSet?: string[], format?: string } to GatherField — this is the
   "composable" approach

Recommendation: Option 2 is more extensible. The LLM-based extraction already handles type inference well; formal semantics help with validation and
auto-conversion, not extraction.

1.3 RANGE Data Support

┌──────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────┬───────────────────┐
│ What Bruce Wants │ What We Have │ Gap │
├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┼───────────────────┤
│ RANGE field (true/false) to capture low+high bounds │ Validation type range for validating a value is in range │ Different concept │
├──────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────┼───────────────────┤
│ Parse "under $250" or "between 3-5 nights" naturally │ Not supported │ Not covered │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┴───────────────────┘

Design Consideration: A range: true attribute on GatherField would change the collected value from a scalar to { low?: T, high?: T }. The LLM naturally parses
"under $250" → { high: 250 } and "between 3 and 5" → { low: 3, high: 5 }. This is a compiler + runtime change to the field shape, not just validation.

1.4 LIST and Preference Modeling

┌──────────────────────────────────────────────────────┬──────────────┬─────────────┐
│ What Bruce Wants │ What We Have │ Gap │
├──────────────────────────────────────────────────────┼──────────────┼─────────────┤
│ LIST attribute for multi-value fields │ None │ Not covered │
├──────────────────────────────────────────────────────┼──────────────┼─────────────┤
│ Preference categories: accept, desire, avoid, refuse │ None │ Not covered │
└──────────────────────────────────────────────────────┴──────────────┴─────────────┘

Design Consideration: This is the most complex GATHER enhancement Bruce requests. The pizza example ("pepperoni and mushroom, allergic to anchovies, prefer deep
crust") requires the field value to be structured as:
{ accept: string[], desire: string[], avoid: string[], refuse: string[] }
This requires LLM extraction with a structured schema output — which our reasoning executor already supports. The IR schema needs list: true and
preference_categories: boolean on GatherField.

1.5 Progressive/Dynamic GATHER

┌────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────┬───────────────────┐
│ What Bruce Wants │ What We Have │ Gap │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼───────────────────┤
│ Optional fields that become relevant based on conversation │ required: false exists but no progressive activation │ Partially covered │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼───────────────────┤
│ Data-driven dynamic fields (military status for Hale Koa) │ None — all fields defined at compile time │ Not covered │
├────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────┼───────────────────┤
│ Fields marked as progressive or optional │ Only required: true/false │ Gap │
└────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────┴───────────────────┘

Answer to Bruce's Key Concern: "Can we represent data-driven GATHERs using ABL notation?"

Currently, no. ABL GATHER fields are statically defined at compile time. Dynamic fields require one of:

1. Reasoning mode — the LLM naturally asks contextual follow-ups without predefined fields (this already works, but isn't "GATHER" per se)
2. Conditional GATHER steps in FLOW — we already support IF/THEN branching that can route to different GATHER steps based on prior data
3. A new WHEN clause on fields — field: military_status, WHEN: search_results contains "Hale Koa" — this would need compiler+runtime work

Recommendation: Option 2 (conditional flow steps) covers 80% of Bruce's scenarios. Option 3 is a nice-to-have for complex cases.

1.6 Scripted Gather Format

┌─────────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────┬───────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├─────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────┼───────────────────┤
│ Multi-field GATHER as first-class format │ Already implemented — both inline and structured GATHER in FLOW steps │ Covered │
├─────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────┼───────────────────┤
│ STRATEGY field on all GATHER (not just multi-field) │ STRATEGY supported in both top-level and flow GATHER │ Covered │
├─────────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────┼───────────────────┤
│ CORRECTIONS field clarification │ Parsed in compiler but not executed at runtime │ Partially covered │
└─────────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────┴───────────────────┘

Answer to Bruce: CORRECTIONS means "allow the user to say 'actually 4 guests not 3' to correct a previously gathered value within the same GATHER block." We
parse it, but the runtime doesn't act on it yet. When implemented, it would re-evaluate extraction against already-collected fields.

1.7 Default Values and PROMPT Semantics

┌────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────┬────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────┤
│ Document that PROMPT serves dual role (user-facing vs LLM-guiding) │ default and prompt exist but behavior is undefined │ Not documented │
└────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────┴────────────────┘

Answer to Bruce: He's exactly right. When default is set, the PROMPT should guide the LLM to detect overrides, not be asked to the user. This needs explicit
spec documentation and runtime enforcement. Currently, our runtime doesn't distinguish these two modes.

1.8 GATHER Validation

┌────────────────────────────────────────┬──────────────────────────────────────────────────────────┬─────────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├────────────────────────────────────────┼──────────────────────────────────────────────────────────┼─────────────────────┤
│ VALIDATION_PROCESS: LLM | REGEX | CODE │ Validation type: 'pattern' | 'range' | 'enum' | 'custom' │ Covered differently │
└────────────────────────────────────────┴──────────────────────────────────────────────────────────┴─────────────────────┘

Answer to Bruce: We already support regex via type: 'pattern', range validation via type: 'range', enum checking via type: 'enum', and LLM validation via type:
'custom' (expression string). The names are different but the functionality is there. We should document this mapping clearly.

---

2. Action Tools & Error Handling

2.1 Error Returns from Action Tools

What Bruce Wants: ON_XXX failure handlers (timeout, declined, unavailable)
What We Have: ErrorHandler with types: tool_timeout, tool_failure, validation_error, network_error
Status: Schema exists
────────────────────────────────────────
What Bruce Wants: Different recovery per failure type
What We Have: then: 'continue' | 'escalate' | 'handoff' | 'complete'
Status: Schema exists
────────────────────────────────────────
What Bruce Wants: Retry logic
What We Have: retry and retry_delay_ms fields defined
Status: Parsed but NOT executed

Answer to Bruce: The ABL spec supports this:
ERROR_HANDLING: - TYPE: tool_timeout
RETRY: 2
THEN: escalate - TYPE: tool_failure
RESPOND: "Payment failed"
THEN: handoff
HANDOFF_TARGET: PaymentRecovery_Agent

The schema and parser handle this, but runtime execution of retry logic and conditional error recovery is not yet wired. This is a known implementation gap.

---

3. Memory System

3.1 Memory Condition Syntax

Answer to Bruce: Memory conditions use the same expression evaluator as all other conditions — ==, !=, >, <, >=, <=, AND, OR, NOT, IS SET, CONTAINS, matches,
path expressions (user.preferences.budget). The syntax is documented in the evaluator but not explicitly in the MEMORY section of the spec. This is a
documentation gap.

3.2 Session Clarification Count

Answer to Bruce: This is not implemented. Session memory values are initialized once and persisted for the session. There's no built-in clarification_count — it
would be a custom session variable. Whether it resets per step or per session would depend on where you reset it in the flow. This needs a design decision.

3.3 Persistent Values Need Type Metadata

┌──────────────────────────────────────────┬──────────────────────────────────┬─────────────┐
│ What Bruce Wants │ What We Have │ Status │
├──────────────────────────────────────────┼──────────────────────────────────┼─────────────┤
│ Named value + type for persistent memory │ path + description + access only │ Not covered │
└──────────────────────────────────────────┴──────────────────────────────────┴─────────────┘

Answer to Bruce: He's right — user.average_budget should carry { value: 250, currency: 'USD' } or have a type annotation. Currently, persistent memory paths
have no type metadata. This connects back to the supplemental semantics discussion in 1.2.

3.4 Preference Detection Patterns

┌────────────────────────────────────┬───────────────────────────────────────┬──────────────────────────────────────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├────────────────────────────────────┼───────────────────────────────────────┼──────────────────────────────────────────────────┤
│ Symmetric prefer + avoid detection │ CONTAINS operator exists in evaluator │ Evaluator supports it, MEMORY triggers don't run │
└────────────────────────────────────┴───────────────────────────────────────┴──────────────────────────────────────────────────┘

Answer to Bruce: The expression user.states_preference CONTAINS "avoid" is syntactically valid and the evaluator would handle it. But REMEMBER triggers that
would fire this condition are not executed at runtime. This is an implementation gap, not a design gap.

3.5 Recall — Non-Actionable Triggers

Answer to Bruce: He raises a valid point. ON_DESTINATION_MENTION: "Check if user has visited..." is an instruction string, not executable code. In our IR:
interface RecallInstruction {
event: string; // "destination_mention"
instruction: string; // Natural language instruction for LLM
}
The design intent is that these are LLM system prompt injections — when the event fires, the instruction is added to the LLM's context so it knows to check
persistent memory. But this is not implemented at runtime, and Bruce is right that it's ambiguous.

---

4. Conditions, Operators & Constraints

4.1 Hierarchical Conditions (AND/OR Nesting)

┌────────────────────────────────────────────┬──────────────────────────────────────┬─────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├────────────────────────────────────────────┼──────────────────────────────────────┼─────────────────┤
│ (A AND B) OR C with parenthetical grouping │ Full parenthetical nesting supported │ Already covered │
└────────────────────────────────────────────┴──────────────────────────────────────┴─────────────────┘

Answer to Bruce: This works. The expression parser and evaluator support full parenthetical nesting: (destination IS SET AND origin IS SET) OR override == true.
This is a documentation gap — the spec examples don't show nested parens but the implementation handles them.

4.2-4.3 Comparison Operators

┌──────────────────────┬─────────────────┬─────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├──────────────────────┼─────────────────┼─────────────────┤
│ ==, !=, >, >=, <, <= │ All implemented │ Already covered │
└──────────────────────┴─────────────────┴─────────────────┘

Answer to Bruce: All six comparison operators are fully implemented with type coercion (string→number, boolean→string, etc.). The spec should show examples
beyond just ==.

4.4 IS SET vs. Null Comparison

┌───────────────────────────────────────┬───────────────────────────────┬─────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├───────────────────────────────────────┼───────────────────────────────┼─────────────────┤
│ Prefer user.email != null over IS SET │ Both work: IS SET and != null │ Already covered │
└───────────────────────────────────────┴───────────────────────────────┴─────────────────┘

Answer to Bruce: We support both. IS SET checks for null/undefined. != null also works. We also have IS NOT SET. The spec can note that != null is equivalent to
IS SET for those who prefer it.

---

5. Control Flow on Constraint Failure

┌───────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────┬───────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├───────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┼───────────────────┤
│ ON_FAIL with control flow (insert sub-step vs. backtrack) │ ON_FAIL: respond | escalate | handoff | block │ Partially covered │
├───────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┼───────────────────┤
│ Distinguish "insert question" vs "redo search" │ Not distinguished — all failures are terminal actions │ Not covered │
└───────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────┴───────────────────┘

Answer to Bruce: This is a significant design gap. His email vs. rooms-available example perfectly illustrates the problem:

- Missing email → should insert a sub-step (ask for email), then continue forward
- No rooms → should backtrack to search step and re-execute

Currently, ON_FAIL can only: send a message, escalate, hand off, or block. There's no:

- ON_FAIL: INSERT_STEP collect_email THEN: continue
- ON_FAIL: BACKTRACK TO search_step

Design Consideration: This needs a new ConstraintAction type — perhaps retry_step (re-run current step) or goto_step (jump to a named step). This is a compiler

- runtime change.

---

6. Agent Interaction: DELEGATE vs. HANDOFF

6.1 DELEGATE

Answer to Bruce: He confirms our implementation is correct. No issues.

6.2 HANDOFF Semantics

┌────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────┬───────────────────┐
│ What Bruce Wants │ What We Have │ Status │
├────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────┤
│ Clarify "terminate self" semantics │ return: false = permanent (parent marked 'completed'), return: true = temporary (parent pauses) │ Implemented │
├────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────┤
│ RETURN field contradiction │ RETURN is boolean: true means parent waits, false means parent dies │ Needs better docs │
├────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────┤
│ SUMMARY before handoff target │ SUMMARY is in context block, evaluated before handoff executes │ Already correct │
└────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────┴───────────────────┘

Answer to Bruce: His confusion is valid. The spec language is ambiguous. Here's how it actually works:

- RETURN: false — Permanent handoff. Parent thread is marked completed. If the child ever "hands back," the parent starts fresh (as Bruce suggests). This
  matches his recommendation.
- RETURN: true — Temporary handoff (more like DELEGATE). Parent is pushed onto a thread stack and waits. When child completes, parent resumes with child's
  results. This is the "or until that agent hands back" case.
- SUMMARY is evaluated and passed to the child before the handoff, so it works correctly regardless of RETURN value.

The RETURN field doesn't mean "return a value" — it means "expect the other agent to return control to us." This naming is confusing and Bruce's critique is
fair. The spec should rename to EXPECT_RETURN or restructure.

---

Summary: Consolidated View

Already Covered (15 items)

┌─────┬─────────────────────────────────────────────────────┬─────────────────────────────┐
│ # │ Topic │ Status │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ 6 │ Multi-field GATHER format │ Complete │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ 7 │ STRATEGY field on all GATHER │ Complete │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ 17 │ Hierarchical AND/OR conditions │ Complete (underdocumented) │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ 18 │ Full comparison operator set (==, !=, >, >=, <, <=) │ Complete (underdocumented) │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ 19 │ IS SET vs null comparison │ Both work │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ - │ DELEGATE semantics │ Complete │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ - │ HANDOFF with RETURN=true/false │ Complete │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ - │ SUMMARY evaluated before handoff │ Complete │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ - │ Basic error handler schema │ Complete │
├─────┼─────────────────────────────────────────────────────┼─────────────────────────────┤
│ - │ Validation types (pattern, range, enum, custom) │ Complete (different naming) │
└─────┴─────────────────────────────────────────────────────┴─────────────────────────────┘

Partially Covered — Needs Runtime Wiring (6 items)

┌─────┬────────────────────────────────┬──────────────────────────┬───────────────────────────────────────────┐
│ # │ Topic │ What Exists │ What's Missing │
├─────┼────────────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ 8 │ CORRECTIONS semantics │ Parsed in compiler │ Runtime execution │
├─────┼────────────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ 11 │ ON_XXX failure handlers │ Schema + parser complete │ Runtime retry logic, conditional recovery │
├─────┼────────────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ 14 │ Symmetric preference detection │ Evaluator CONTAINS works │ REMEMBER triggers not executed │
├─────┼────────────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ 9 │ PROMPT dual role with defaults │ Both fields exist │ Runtime distinction, documentation │
├─────┼────────────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ 12 │ Memory condition syntax │ Evaluator handles it │ Not documented in MEMORY spec section │
├─────┼────────────────────────────────┼──────────────────────────┼───────────────────────────────────────────┤
│ 21 │ HANDOFF RETURN field │ Works correctly │ Spec language is misleading │
└─────┴────────────────────────────────┴──────────────────────────┴───────────────────────────────────────────┘

Not Covered — Needs Design & Implementation (9 items)

┌─────┬───────────────────────────────────────────────────────┬────────────┬─────────────────────────────────────────────┐
│ # │ Topic │ Complexity │ Priority │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 1 │ Expanded entity types + supplemental semantics │ Medium │ High — connects to Kore platform migration │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 2 │ RANGE attribute on GATHER fields │ Medium │ Medium — useful for search/filter scenarios │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 3 │ LIST/preference modeling (accept/desire/avoid/refuse) │ High │ Medium — sales/commerce agents need this │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 4 │ Progressive/optional GATHER requirements │ Medium │ High — conditional flow steps cover 80% │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 5 │ Data-driven dynamic GATHER │ High │ Low — reasoning mode handles this naturally │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 13 │ Clarification count scope │ Low │ Low — custom session variable │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 15 │ Recall trigger implementation │ Medium │ Medium — REMEMBER/RECALL not wired │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 16 │ Make Recall triggers actionable │ Medium │ Medium — LLM prompt injection design │
├─────┼───────────────────────────────────────────────────────┼────────────┼─────────────────────────────────────────────┤
│ 20 │ ON_FAIL control flow (insert-step vs backtrack) │ High │ High — fundamental flow control gap │
└─────┴───────────────────────────────────────────────────────┴────────────┴─────────────────────────────────────────────┘

Documentation-Only Fixes (5 items)

┌─────┬───────────────────────────────┬───────────────────────────────────────────────────────────┐
│ # │ Topic │ Action │
├─────┼───────────────────────────────┼───────────────────────────────────────────────────────────┤
│ 17 │ Paren nesting in conditions │ Add examples to spec │
├─────┼───────────────────────────────┼───────────────────────────────────────────────────────────┤
│ 18 │ All operators (not just ==) │ Add examples to spec │
├─────┼───────────────────────────────┼───────────────────────────────────────────────────────────┤
│ 19 │ IS SET equivalence to != null │ Note in spec │
├─────┼───────────────────────────────┼───────────────────────────────────────────────────────────┤
│ 10 │ Validation types mapping │ Document pattern/range/enum/custom │
├─────┼───────────────────────────────┼───────────────────────────────────────────────────────────┤
│ 21 │ HANDOFF RETURN semantics │ Rewrite spec language, consider renaming to EXPECT_RETURN │
└─────┴───────────────────────────────┴───────────────────────────────────────────────────────────┘

Top 3 Design Priorities from Bruce's Review

1. ON_FAIL Control Flow (item 20) — The missing ability to distinguish "insert sub-step and continue" from "backtrack to earlier step" is a fundamental gap.
   Every serious scripted agent will hit this.
2. Entity Type Expansion + Supplemental Semantics (item 1) — For Kore platform migration, customers expect the 25+ entity types they already use. Adding
   semantics: { unit, format, enumSet } to GatherField is the extensible path.
3. REMEMBER/RECALL Runtime Wiring (items 14, 15, 16) — The IR design is solid but none of it runs. This blocks any agent that needs cross-session learning.
