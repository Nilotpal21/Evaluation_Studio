# LLM Provider Content-Filter Error Handling — Improvements Summary

**Date:** 2026-05-21
**JIRA:** ABLP-1229 (https://koreteam.atlassian.net/browse/ABLP-1229)
**Status:** Implementation complete, PR pending (`feat/ABLP-1229-llm-error-classification`)
**Audience:** Product managers, technical architects, security architects, support / SRE leads
**For:** Internal circulation, customer-facing release notes (after merge)

---

## Executive Summary

When an LLM provider blocks a response (content safety filter, rate limit, timeout, context overflow), several things were quietly going wrong:

1. The platform's automatic error classification was **dependent on a coincidence** in how the upstream SDK formats Azure OpenAI's error message. A future SDK upgrade could silently break it.
2. The **rich category data** Azure provides (which filter triggered — jailbreak / hate / violence / sexual / self-harm — with severity levels) was being **discarded**. Operators couldn't tell a malicious jailbreak attempt from a false-positive on low-severity hate. Compliance teams couldn't tune their thresholds.
3. When the provider blocked output **mid-stream** (different code path than input-side filter), the user got **no error and no response** — just silence. The agent loop quietly terminated.
4. Every classified error collapsed into a single bucket called `unknown_error`. **Agent authors could not write a content-filter-specific recovery** because the runtime didn't surface the distinction.
5. The classifier produced a sanitized, user-safe message ("AI Model Error: The response was blocked by the provider's content safety filter."), but the **reasoning layer threw it away** and replaced it with the generic `"An error occurred. Please try again."`. Authors had no way to keep the more specific message OR substitute their own.

This work ships fixes for all five and adds **80 tests** (64 unit + 13 integration + 3 end-to-end) so each guarantee is proven, not just claimed.

**Zero regression.** Agents that don't opt into the new authoring patterns continue to behave exactly as before, including the verbatim default message.

---

## The Five Issues, with Real Examples

### Issue 1 — Brittle content-filter classification

**Symptom.** Azure OpenAI returns an error like this when its safety policy blocks a prompt:

```json
{
  "error": {
    "message": "The response was filtered due to the prompt triggering Azure OpenAI's content management policy...",
    "code": "content_filter",
    "status": 400,
    "innererror": { ... }
  }
}
```

**What was happening.** Our classifier looked for either an HTTP status of 422 OR for one of seven recognizable phrases in the error message (e.g., "content_filter", "blocked by", "flagged"). Azure returns status 400 (not 422), and Azure's exact phrasing — "content management policy" — wasn't in our pattern list. Classification only worked because the upstream SDK happened to include the literal string `"content_filter"` somewhere in the formatted error string. Any change in SDK error formatting would silently break detection and the user would have seen `"AI Model Error: 400 The response was filtered..."` — leaking provider implementation detail.

**After the fix.** Three changes: (a) added Azure's literal phrase "content management policy" to the pattern list, (b) added a direct check on the structured `code` field (every provider that uses the OpenAI-compatible error shape sets this), (c) added Azure's specific inner code `ResponsibleAIPolicyViolation` as a pattern. Detection is now robust to any combination of status code, message phrasing, and SDK formatting — the structured `code` field alone is sufficient.

### Issue 2 — Rich category data was discarded

**Symptom.** A user gets blocked. The operator dashboard shows a single line: "AI Model Error: blocked by content safety filter." A SOC analyst tries to investigate whether this was a jailbreak attempt (high concern) or a low-severity false positive on hate-speech detection. They have to dig into raw provider logs.

**What was happening.** Azure (and OpenAI) return a structured object with each category and its severity:

```json
"content_filter_result": {
  "jailbreak":   { "detected": true,  "filtered": true },
  "hate":        { "filtered": false, "severity": "low" },
  "violence":    { "filtered": false, "severity": "safe" },
  "self_harm":   { "filtered": false, "severity": "safe" },
  "sexual":      { "filtered": false, "severity": "safe" }
}
```

The classifier extracted only the top-level message — never reached into this structure. All five category readings were dropped at the network boundary.

**After the fix.** A new function inspects the upstream error's response body for the `content_filter_result` object, parses each category into a `{ category, severity, filtered, detected }` record, and attaches the resulting array to the platform's error trace event. SOC analysts now see in Studio's session debugger: "Blocked by: jailbreak (detected, filtered)" or "Blocked by: hate (severity: medium)". DSAR queries can filter by category. The customer-facing message stays sanitized — the rich data only goes to traces and audit logs, not to end users.

### Issue 3 — Silent failure when the filter trims the output

**Symptom.** A user asks a question. The agent says nothing. The conversation just stops. No error appears in the trace. No error appears to the user. The user repeats their question; same silence.

**What was happening.** Provider content filters operate in two places: input-side (the prompt is blocked before any generation happens) and output-side (the model starts responding, but its words are trimmed mid-stream when they trip a filter). Input-side filters throw an exception we caught and classified. Output-side filters returned a "successful" response object with a special stop reason (`finishReason: 'content-filter'`) and empty text. Our code only converted stop-reason-based failures into errors when the stop reason was literally the string `'error'`. So `'content-filter'` was treated as a normal completion with empty content — the agent loop iterated a few more times, hit its empty-response safety counter, and silently exited.

**Real production scenario.** A voice agent for a healthcare clinic. Caller asks about a topic that triggers the output-side filter. The line goes dead. The caller hears nothing. They eventually hang up.

**After the fix.** The stop-reason check now treats `'content-filter'` (and the snake_case variant `'content_filter'`) the same way it treats `'error'`: as a provider failure that produces a real, classified `MODEL_CONTENT_FILTERED` error. Operators see the trace event. The user sees the configured error message (default or customized). No more silent termination.

### Issue 4 — Agent authors couldn't write subtype-specific handlers

**Symptom.** A product team builds a financial agent. They want different user messages for "the AI is rate-limited right now" (try again in a moment) versus "the AI refused to respond to that input" (rephrase your question). They look at the agent DSL's `ON_ERROR:` block and discover they can only match by error TYPE, and every LLM error reports as the generic `unknown_error`. There's no way to express the distinction.

**What was happening.** When the reasoning layer caught an exception during a turn, it constructed an internal error-context object and **hardcoded** its `type` field to the string `'unknown_error'`, regardless of what kind of error it actually was. The downstream handler-resolver supports matching by type AND subtype — it had since day one — but no real subtypes were ever fed into it.

**After the fix.** The reasoning layer now derives the type and subtype from the underlying classified error code:

| Underlying error code    | type            | subtype                |
| ------------------------ | --------------- | ---------------------- |
| `MODEL_CONTENT_FILTERED` | `llm_error`     | `content_filter`       |
| `MODEL_RATE_LIMITED`     | `llm_error`     | `rate_limited`         |
| `MODEL_TIMEOUT`          | `llm_error`     | `timeout`              |
| `MODEL_CONTEXT_EXCEEDED` | `llm_error`     | `context_exceeded`     |
| `MODEL_API_ERROR`        | `llm_error`     | `api_error`            |
| `CREDENTIAL_NOT_FOUND`   | `llm_error`     | `credential_not_found` |
| (anything else)          | `unknown_error` | (none)                 |

Agent authors can now write:

```abl
ON_ERROR:
  llm_error:
    SUBTYPE: content_filter
    RESPOND: "I can't help with that specific phrasing. Could you ask in a different way?"

  llm_error:
    SUBTYPE: rate_limited
    RESPOND: "I'm a bit slow right now — give me one moment."
    RETRY: 1
    RETRY_DELAY: 2000

  llm_error:
    SUBTYPE: context_exceeded
    HANDOFF: Live_Agent
```

**Backwards compatibility:** if an existing agent has an `unknown_error` handler that was implicitly catching LLM errors, that handler **still fires**. The runtime's handler resolution first tries to match the new typed/subtyped form; if nothing matches AND the error is an LLM error, it falls through to a second pass that matches `unknown_error`. No author needs to update their existing agents.

### Issue 5 — Customizable message text per error subtype

**Symptom.** Even authors who don't want to write a full `ON_ERROR:` handler still want the user-facing message to be domain-appropriate. A healthcare agent saying "An error occurred. Please try again." is generic; saying "I can't discuss that specific topic — let me know how else I can help" is on-brand.

**What was happening.** The DSL's `MESSAGES:` block already existed and supported several generic keys (`error_default`, `voice_error`, etc.), but had no LLM-subtype-specific keys. So `error_default` was the only override for any LLM error — content-filter, rate-limit, timeout all got the same fallback. There was no way to differentiate by error class without writing a full `ON_ERROR:` handler.

**After the fix.** Five new message keys are recognized by the platform:

| Key                              | Used when                                                 |
| -------------------------------- | --------------------------------------------------------- |
| `error_llm_content_filter`       | A provider content filter blocked the request or response |
| `error_llm_rate_limited`         | The provider was over quota / rate-limited                |
| `error_llm_context_exceeded`     | The conversation exceeded the model's context window      |
| `error_llm_api_error`            | Generic provider API failure (5xx, malformed responses)   |
| `error_llm_credential_not_found` | Credentials missing or invalid                            |

Authors put these in their `MESSAGES:` block:

```abl
MESSAGES:
  error_default: "Sorry, something went wrong. Could you try again?"
  error_llm_content_filter: "I'm not able to help with that specific question. Let me know how else I can help."
  error_llm_rate_limited: "I'm a bit slow right now — give me a moment."
```

The resolution precedence is: handler-specific `RESPOND:` → subtype-specific `MESSAGES:` key → general `error_default` → platform default `"An error occurred. Please try again."`. Each layer is opt-in.

**The zero-regression guarantee.** The five new message keys default to the same string as `error_default` (`"An error occurred. Please try again."`). An agent that defines none of them sees no behavior change — the platform default still applies. This is explicitly verified by an integration test (INT-3) and an end-to-end test (E2E-5) that fail immediately if a future change accidentally alters the default.

---

## What Operators See (Trace Events)

The fix preserves and **enriches** what shows up in Studio's session debugger and downstream observability (ClickHouse, Grafana, audit logs).

**Before**:

```
ERROR  AI Model Error: The response was blocked by the provider's content safety filter.
       code: MODEL_CONTENT_FILTERED
```

**After** (same event, more data):

```
ERROR  AI Model Error: The response was blocked by the provider's content safety filter.
       code: MODEL_CONTENT_FILTERED
       contentFilterCategories: [
         { category: 'jailbreak', detected: true, filtered: true },
         { category: 'hate', filtered: false, severity: 'low' },
         { category: 'violence', filtered: false, severity: 'safe' },
         ...
       ]
       provider: 'azure-openai'
       modelId: 'gpt-4o-2024-08-06'
```

DSAR queries like "show every plaintext PII dispense related to this user" can now also answer "every content-filter event triggered by this user, by category, with severity". Auditors can examine whether the filters are firing too aggressively (lots of low-severity false positives) or whether actual jailbreak attempts are being detected.

---

## Verification — How We Know the Fixes Work

| Layer           | Tests                                                | What they prove                                                                                                                                                                        |
| --------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**        | 34 in `classify-llm-error.test.ts`                   | Each new pattern matches; the code-based check catches Azure's specific shape; category extraction handles JSON-string and parsed-object response bodies; diagnostic field propagation |
| **Unit**        | 30 in `error-handler-router.test.ts`                 | Resolution order (subtype > type > default), backwards-compat fallback for legacy `unknown_error` handlers, retry calculation correctness                                              |
| **Integration** | 13 in `llm-error-classification.integration.test.ts` | The full composition: classifier output → reasoning-layer catch → `errorCtx` construction → handler resolution → response message                                                      |
| **End-to-End**  | 3 in `e2e/llm-error-classification.e2e.test.ts`      | Through the real HTTP API: triggering a mocked content-filter error produces the expected response body, trace events, and no regressions for non-customized agents                    |

The **regression guard** is verified twice — once at the integration layer (INT-3) and once at the HTTP boundary (E2E-5). Any future change that alters the default fallback message breaks both tests immediately.

---

## What's NOT Changing (Important for Stakeholders)

- **Existing agents** with no `MESSAGES:` overrides and no `ON_ERROR:` handlers behave exactly as they do today. End-users still see `"An error occurred. Please try again."` for unhandled errors.
- **Existing `ON_ERROR:` handlers** with the legacy `unknown_error` type continue to match LLM errors via the backwards-compatibility fallback. Nothing breaks for agents that pre-date this change.
- **The customer-facing default message** is unchanged. We do not start leaking provider-implementation detail to end users.
- **Audit-log shape is additive.** The new `contentFilterCategories` field is added alongside existing fields, not replacing anything. Downstream consumers (ClickHouse, Grafana, Studio trace viewer) need no schema migration.

---

## What's Explicitly Out of Scope

The bug ticket originally listed a sixth gap — **automatic fallback to a different model when content-filter fires** — as a possible roadmap item. We deferred this. It needs deliberate design (cost, latency, compliance posture, risk of bypassing intended safety controls) and a separate product decision. This work is purely about classification, observability, and authoring surfaces — not about automatically bypassing the provider's policy.

---

## Authoring Documentation

A new guide at `docs/guides/error-handling-guide.md` covers the three customization layers (`MESSAGES:`, agent-level `ON_ERROR:`, step-level `ON_ERROR:`) with the full subtype taxonomy, resolution precedence diagram, and worked examples. Agent authors should be pointed at this guide before they write their first error-handling block.

---

## References

- **JIRA:** https://koreteam.atlassian.net/browse/ABLP-1229
- **PR (pending):** https://bitbucket.org/koreteam1/abl-platform/pull-requests/new?source=feat/ABLP-1229-llm-error-classification&dest=develop
- **Author guide:** `docs/guides/error-handling-guide.md`
- **Surfaced during:** ABLP-535 BETA review (Payment_Details_Agent voice flow trace inspection)
- **Sibling tickets merged:** ABLP-1197 (PII pattern upsert) is on develop; ABLP-535 (PII vault boundary contract) is on develop
- **Out-of-scope for next ticket:** agent-level automatic recovery / fallback model on content-filter
