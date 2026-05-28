# Decisions — Gather Interrupt Semantic Routing

### What repo readiness policy should govern this HELIX run?

- Classification: **DECIDED**
- Stage: Readiness Bootstrap
- Answer: Repo readiness is L1 / characterize-first. Stay in manual mode for readiness and autonomy scoring, but requested auto-approve remains enabled while auto-commit stays disabled because you explicitly opted in. Establish or refresh characterization, regression, or E2E evidence for affected modules before risky edits.

### Does an ON_INTERRUPT DSL construct exist for gather steps?

- Classification: **ANSWERED**
- Stage: Deep Scan
- Answer: No. ON_INTERRUPT / on_interrupt does not exist anywhere in the codebase. Gather interrupt behavior is emergent: implemented implicitly through the LEXICAL_FALLBACK directive on the supervisor's INTENTS block combined with detectFlowEscapeMatch / detectParentSupervisorRoute runtime logic.

### Is GatherExecutor the primary execution path in the runtime for gather steps?

- Classification: **ANSWERED**
- Stage: Deep Scan
- Answer: No. GatherExecutor (packages/compiler) is exported and used in pre-refactor test fixtures but the primary runtime gather execution path runs through flow-step-executor.ts in apps/runtime/src/services/execution/.

### Is the classifier-first path for gather interrupts currently wired into flow-step-executor.ts?

- Classification: **ANSWERED**
- Stage: Deep Scan
- Answer: No. The gather escape detection branch in flow-step-executor.ts does not invoke classifier.ts before falling back to lexical or LLM matching. The classifier is available via pipeline context but is not called in the interrupt branch.

### Is the lexical_fallback policy field threaded from routing-resolver.ts into the gather interrupt resolution result?

- Classification: **ANSWERED**
- Stage: Deep Scan
- Answer: No. The lexical_fallback policy compiled from INTENTS: LEXICAL_FALLBACK is not included in the ResolvedRoute or equivalent result returned by routing-resolver.ts, so flow-step-executor.ts cannot consult it when deciding whether to apply lexical rescue after a semantic rejection or during model unavailability.

### Should the gather interrupt classifier invocation use a scoped finite candidate surface rather than the full intent corpus?

- Classification: **INFERRED**
- Stage: Deep Scan
- Answer: Yes for correctness of the immediate path. routing-resolver.ts should supply a scoped candidate list (digression targets + sub-intent definitions active for the current gather step) to classifier.ts when called from the gather interrupt branch. Full corpus classification risks matching non-escape intents and requiring downstream filtering that is currently absent.

### Should the tenantId/projectId scope validation on parent-supervisor reroute resolution be added inside routing-resolver.ts or enforced at the flow-step-executor.ts call site?

- Classification: **AMBIGUOUS**
- Stage: Deep Scan
- Answer: Always apply a robust, architecturally sound solution. Do not take shortcuts. Fix the root cause — if the code is hard to test or integrate, redesign the interface. If the answer requires a breaking change, classify as AMBIGUOUS so the user can confirm.
- Resolved by: user

### What delivery horizon should finding d24c824c (No E2E test for semantic rejection preserving child gather ownership (E2E-2 from test spec)) have?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: next
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): next
  - **Testing Oracle** (82%): immediate

### What delivery horizon should finding 8962450e (No E2E test for child gather flow returning to parent supervisor via normalized lexical fallback (E2E-1)) have?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: next
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): next
  - **Testing Oracle** (82%): immediate

### What delivery horizon should finding f0a9c91b (No E2E test for voice/SDK surface gather interrupt contract parity (E2E-3)) have?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: near-term
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): near-term
  - **Testing Oracle** (82%): next

### Follow-up closure for finding f0a9c91b (No E2E test for voice/SDK surface gather interrupt contract parity (E2E-3))

- Classification: **ANSWERED**
- Stage: Doc Sync
- Answer: SDK HTTP parity is covered by `apps/runtime/src/__tests__/execution/gather-interrupt-sdk.e2e.test.ts` on the public `/api/v1/chat/agent` surface, and the remaining public voice gap is now covered by `apps/runtime/src/__tests__/channels/channels-voice-ingress.e2e.test.ts`, which binds a real deployment to `voice_vxml` ingress and asserts the same `digression` + `return_to_parent` trace contract. Any future LiveKit/WebSocket-specific parity expansion is adjacent voice-runtime work, not an open blocker for this sub-feature.

### What severity should finding d41df5a1 (routing-resolver.ts parent-supervisor reroute resolution does not validate tenantId/projectId scope on resolved route) have?

- Classification: **DECIDED**
- Stage: Oracle Analysis
- Answer: high
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): reprioritize:high
  - **Testing Oracle** (82%): reprioritize:high

### What delivery horizon should finding d41df5a1 (routing-resolver.ts parent-supervisor reroute resolution does not validate tenantId/projectId scope on resolved route) have?

- Classification: **DECIDED**
- Stage: Oracle Analysis
- Answer: immediate
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): immediate
  - **Testing Oracle** (82%): immediate

### Should finding b6a747b9 (No inline contract comment on classifier.ts gather-interrupt entry point distinguishing gather-scoped vs global classification) remain in the implementation plan?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: keep
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): confirm
  - **Testing Oracle** (82%): challenge

### Follow-up closure for finding b6a747b9 (No inline contract comment on classifier.ts gather-interrupt entry point distinguishing gather-scoped vs global classification)

- Classification: **ANSWERED**
- Stage: Doc Sync
- Answer: Resolved. `apps/runtime/src/services/pipeline/classifier.ts` now documents the exported classify seam as the gather-scoped routing entry point used by runtime integration coverage so future changes do not bypass prompt construction or finite-candidate filtering.

### Should finding 86c5bea6 (Prior Deep Scan finding (network/DNS failure) remains unresolved in findings.md) remain in the implementation plan?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: keep
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): confirm
  - **Testing Oracle** (82%): challenge

### What delivery horizon should finding 86c5bea6 (Prior Deep Scan finding (network/DNS failure) remains unresolved in findings.md) have?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: near-term
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): near-term
  - **Testing Oracle** (82%): long-term

### Follow-up closure for finding 86c5bea6 (Prior Deep Scan finding (network/DNS failure) remains unresolved in findings.md)

- Classification: **ANSWERED**
- Stage: Doc Sync
- Answer: Closed as superseded. Later recovered HELIX runs proved the environment was not persistently DNS-blocked, and the final audit session `0f8f7064` completed successfully on April 23, 2026. The historical transport noise is retained as HELIX executor context, not as an open feature finding.

### Should the lexical_fallback policy gate be owned by routing-resolver (same module that produces ResolvedRoute) or by a new dedicated policy module shared with other pipeline decisions (e.g., confidence thresholds, rerank policy)?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: ambiguous
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): AMBIGUOUS

### When the classifier is unavailable AND lexical_fallback is 'never', what is the correct runtime outcome — retain gather ownership silently, or surface a structured error to the channel surface?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: ambiguous
- Resolved by: oracle-consensus
- Oracle votes:
  - **Architecture Oracle** (82%): AMBIGUOUS

### Is the nlu-sidecar deployed as an in-process module or a separate service in the test environment? This determines whether contract tests need to span process boundaries or can share a test harness.

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: ambiguous
- Resolved by: oracle-consensus
- Oracle votes:
  - **Testing Oracle** (82%): AMBIGUOUS

### Does the test spec's E2E-3 (voice/SDK parity) require a real LiveKit / WebSocket harness, or can it be satisfied with a channel adapter mock that mimics the surface?

- Classification: **INFERRED**
- Stage: Oracle Analysis
- Answer: ambiguous
- Resolved by: oracle-consensus
- Oracle votes:
  - **Testing Oracle** (82%): AMBIGUOUS

### Does the public gather-interrupt chat surface preserve fail-closed tenant/project/session resume isolation?

- Classification: **ANSWERED**
- Stage: Security Audit
- Answer: Yes. The audited `/api/v1/chat/agent` resume path remains fail-closed for tenant/project ownership and uses 404 for unauthorized cross-scope access.

### Does the new sidecar semantic-match surface validate tenancy strongly enough to avoid cross-scope request confusion?

- Classification: **ANSWERED**
- Stage: Security Audit
- Answer: Yes. The semantic-match contract is strict and fail-closed on missing or mismatched tenancy fields; no blocking cross-tenant or cross-project exposure was identified in this slice.

### Is the current workspace diff introducing additional security-sensitive source changes beyond the implemented gather-interrupt slices?

- Classification: **ANSWERED**
- Stage: Security Audit
- Answer: No. The security audit was effectively against already-landed implementation, not fresh uncommitted source changes.

### What verification was completed, and what was blocked by the local environment?

- Classification: **ANSWERED**
- Stage: Security Audit
- Answer: TypeScript build and targeted runtime/shared-kernel tests passed. Python sidecar contract tests were not executable in this environment due a missing `flask` dependency.

### Does the current scoped work introduce a user-facing surface that needs UX remediation?

- Classification: **ANSWERED**
- Stage: UX Design Audit
- Answer: No new user-facing surface is changed in the current workspace diff. The only end-user impact is existing runtime chat/voice rerouting behavior, which is already covered by targeted gather-interrupt tests.

### Are there any remaining blocking UX or accessibility regressions in the current implementation?

- Classification: **ANSWERED**
- Stage: UX Design Audit
- Answer: No blocking UX or accessibility regressions were identified. Response continuity, discoverability of the reroute outcome, and non-empty fallback behavior are already exercised by the existing runtime tests.

### Was any direct UX remediation applied during this audit?

- Classification: **ANSWERED**
- Stage: UX Design Audit
- Answer: No. No scoped, clearly-correct UX fix was necessary based on the inspected implementation.
