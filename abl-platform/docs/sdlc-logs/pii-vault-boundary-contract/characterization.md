# Characterization: PII Vault Boundary Contract

**Ticket**: ABLP-535 (consolidates ABLP-673)
**Date**: 2026-05-19
**Branch**: `discuss/guardrails-pii-consolidation`

---

## Reproduction Artifacts

### Manifestation 1 — LLM-initiated tool call receives token UUID (ABLP-535 #2a)

**Scenario**: User types PII (e.g., SSN `123-45-6789`). PII vault tokenizes to `{{PII:ssn:<uuid>}}`. LLM is fed the token. LLM generates a tool call with the token. Runtime calls `restorePIITokensForToolExecution()` which dispatches to `vault.renderForConsumer(value, piiAccess)`.

**Root cause**: `resolveRenderMode('tools', ...)` at `packages/compiler/src/platform/security/pii-vault.ts:477` returns `'redacted'`. The tool receives `[REDACTED_SSN]` — not the original plaintext. The Studio UI labels `value="tools"` as "Original" (`apps/studio/src/components/agent-detail/ToolsSection.tsx:531`), misleading users into expecting plaintext.

**Evidence**:

- `pii-vault.ts:477`: `case 'tools': return 'redacted';`
- `pii-tool-execution.ts:34`: normalizes piiAccess to `'tools'` by default
- `pii-tool-execution.ts:41`: passes normalized piiAccess to `vault.renderForConsumer()`
- `ToolsSection.tsx:531`: `<option value="tools">{t('pii_original')}</option>` — UI says "Original" but value `'tools'` resolves to `'redacted'`
- `ToolsEditor.tsx:437`: same mislabel

### Manifestation 2 — User UI displays masked token UUID, not masked original (ABLP-535 #2b)

**Scenario**: LLM response contains `{{PII:ssn:<uuid>}}` tokens. `protectSessionOutputForUser()` calls `vault.renderForConsumer(text, 'user', ...)`. The `'user'` consumer resolves to `'masked'` mode. But `maskValue()` receives the original value from `token.original` — this part actually works correctly when the token wrapper is intact.

**The real user-render bug surfaces when**: the LLM strips the `{{PII:...}}` wrapper (Manifestation 3). Then the user sees a bare UUID — meaningless random text.

### Manifestation 3 — LLM strips `{{PII:type:UUID}}` wrapper (ABLP-673 main)

**Scenario**: LLM receives `{{PII:ssn:abc123}}` in context. Instead of echoing it verbatim, LLM emits just `abc123` in tool-call arguments. `restorePIITokensForToolExecution()` only matches the regex `\{\{PII:([^:}]+):([a-f0-9-]+)\}\}`. A bare UUID passes through unmatched.

**Root cause**: No bare-UUID restoration logic exists. The system relies entirely on the LLM preserving the `{{PII:...}}` wrapper, which is not guaranteed.

**Evidence**: `pii-vault.ts:28` — `createTokenRegex()` only matches the full wrapper format.

### Manifestation 4 — `resolveRenderMode('tools')` hardcoded to `'redacted'`

**Scenario**: Even if the `{{PII:...}}` wrapper is preserved AND the tool's `pii_access` is set to `'tools'`, `resolveRenderMode()` returns `'redacted'`.

**Root cause**: `pii-vault.ts:477` — hardcoded builtin default.

**Evidence**: Direct code inspection. There is no `'original'` option in the `pii_access` enum (`schema.ts:1003`), so even if a user wanted plaintext, there is no value they can set.

### Manifestation 5 — Session vars with tokens never restore at tool boundary (V-Session.1)

**Scenario**: A session variable is set to a value containing `{{PII:type:uuid}}` tokens. When tool execution reads context vars via `context_access.read`, the PII tokens in session vars are rendered through `restorePIITokensForToolExecution()` which resolves to `'redacted'`.

**Evidence**: `reasoning-executor.ts:5069-5087` — context vars are rendered through the same `restorePIITokensForToolExecution` path, which uses the tool's `pii_access` level.

### Manifestation 6 — Studio Tool Test UI bypasses PII filter entirely (V-Tool-Test)

**Scenario**: User tests a tool via Studio's Tool Test UI. The request goes to `apps/runtime/src/routes/internal-tools.ts`. The tool executor is created without any PII vault context — no session, no vault, no pattern configs. Tool receives raw values as-is.

**Evidence**: `internal-tools.ts:462-479` — `ToolBindingExecutor` is created without a `piiVault`. The `params` are passed directly from the request body without any PII processing.

---

## Target Seams

1. **Primary seam**: `resolveRenderMode()` in `pii-vault.ts:461-492` — the render-mode resolution function that maps consumer+pattern to a rendering strategy. Adding `'original'` as a valid consumer/mode value here is the core fix.

2. **Schema seam**: `pii_access` enum in `schema.ts:1003` — currently `'tools' | 'user' | 'logs' | 'llm'`. Must add `'original'`.

3. **Bare-UUID seam**: `PIIVault.renderForConsumer()` in `pii-vault.ts:184-219` — currently only processes `{{PII:...}}` regex matches. Bare-UUID restoration must be added as a secondary pass.

4. **Tool Test seam**: `internal-tools.ts:460-490` — tool executor creation without PII context.

5. **UI label seam**: `ToolsSection.tsx:520-536` and `ToolsEditor.tsx:420-443` — dropdown options with mismatched labels.

---

## Negative Proofs

These assertions document the broken behavior that any correct fix must change:

1. **`pii-vault.ts:477`**: `resolveRenderMode('tools') === 'redacted'` — after fix, the default for `'tools'` should remain `'redacted'` (secure default), but a new `'original'` consumer must exist that returns `'original'`.

2. **`schema.ts:1003`**: `pii_access` enum does not include `'original'` — after fix, it must.

3. **`session-pii-vault.test.ts:88`**: `vault.renderForConsumer(tokenized, 'tools')` asserts `[REDACTED_SSN]` — this assertion is correct for the default `'tools'` consumer; a NEW test must verify `'original'` returns plaintext.

4. **`ToolsSection.tsx:531`**: `<option value="tools">{t('pii_original')}</option>` — after fix, the label "Original" must map to `value="original"`, not `value="tools"`.

5. **No bare-UUID detection**: `createTokenRegex()` only matches `{{PII:...}}` — after fix, `renderForConsumer` must also handle bare UUIDs that match vault entries in the current session.

---

## Known Blast Radius

| Area                                                               | Impact                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/security/pii-vault.ts`             | Core vault logic — `resolveRenderMode`, `renderForConsumer`, new bare-UUID restoration                      |
| `packages/compiler/src/platform/ir/schema.ts`                      | `pii_access` enum expansion                                                                                 |
| `apps/runtime/src/services/execution/pii-tool-execution.ts`        | `ToolPIIAccess` type, `normalizeToolPIIAccess()`                                                            |
| `apps/runtime/src/services/execution/reasoning-executor.ts`        | Callsite for `restorePIITokensForToolExecution()` — audit log on `'original'` path                          |
| `apps/runtime/src/services/execution/session-output-protection.ts` | User-render path — if bare-UUID fix lands in vault, this benefits automatically                             |
| `apps/runtime/src/routes/internal-tools.ts`                        | Tool Test UI — needs PII context wiring                                                                     |
| `apps/runtime/src/routes/pii-patterns.ts`                          | RBAC sub-issue — `requirePermission` vs `requireProjectPermission`                                          |
| `apps/studio/src/components/agent-detail/ToolsSection.tsx`         | UI label fix + add `'original'` option                                                                      |
| `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx` | Same UI label fix                                                                                           |
| `packages/i18n/locales/en/studio.json`                             | i18n label updates                                                                                          |
| `packages/shared-kernel/src/constants/trace-event-registry.ts`     | New `pii_plaintext_dispensed` trace event                                                                   |
| `packages/compiler/src/platform/security/pii-audit.ts`             | Audit entry shape for plaintext dispense                                                                    |
| `apps/runtime/src/__tests__/sessions/session-pii-vault.test.ts`    | Must update assertion at line 88 comment; add new tests                                                     |
| `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`     | Must update assertion at line 1083; add new tests                                                           |
| `apps/runtime/src/services/execution/flow-step-executor.ts`        | OUT OF SCOPE — uses `restorePIITokensForTrustedInternalExecution` which calls `vault.detokenize()` directly |

---

## Open Ambiguities

1. **Tool Test UI PII wiring depth**: Should the Tool Test UI create a temporary session-like context with a PII vault, or should it accept PII tokens in the request and render them? The internal-tools route currently has no session context. Resolution: the feature spec must decide.

2. **Bare-UUID false positive boundary**: A bare UUID in a tool arg could be a legitimate non-PII UUID (e.g., a document ID). The lookup must be exact-match against the current session vault. If no match, pass through unchanged. This is architecturally decided but needs explicit test coverage.

3. **User-render masking source when LLM strips wrapper**: If the LLM emits a bare UUID, and the user sees the response, the user sees a random UUID string. After bare-UUID restoration in the tool path, should the user-render path ALSO detect and mask bare UUIDs? Or is it acceptable for the user to see the UUID (since the LLM chose to emit it)? Resolution needed.
