/**
 * UT-3: 90-day TTL banner logic (FR-2.3)
 *
 * The test spec (guardrails-sensitive-data-block.md §4 UT-3) expects a pure
 * helper function `shouldShowTtlBanner(dismissedAt)` that determines whether
 * the "Your guardrail block events are auto-deleted after 90 days" cross-link
 * banner should re-surface after a 90-day dismissal window.
 *
 * Status: `it.todo` — the TTL banner logic is NOT yet implemented. No
 * `shouldShowTtlBanner` helper exists, and the localStorage keys
 * `decision-matrix-dismissed` / `settings-pii-banner-dismissed` are not
 * referenced anywhere in the Studio codebase. The underlying UI component
 * (PIIProtectionTab cross-link banner, FR-2.1–FR-2.3) has not shipped yet.
 *
 * When the helper is implemented, this file should be updated with the
 * real import and the 6 cases from the test spec:
 *   1. dismissedAt = now         → false
 *   2. dismissedAt = 89 days ago → false
 *   3. dismissedAt = 90 days ago → false (strictly greater than)
 *   4. dismissedAt = 90d + 1ms   → true
 *   5. dismissedAt = malformed   → true (fall-open)
 *   6. dismissedAt = missing     → true
 */
import { describe, it } from 'vitest';

describe('UT-3 — 90-day TTL banner re-surface logic (FR-2.3)', () => {
  it.todo(
    'shows banner when dismissedAt is missing (no localStorage entry)',
    // Expected: shouldShowTtlBanner(undefined) === true
  );

  it.todo(
    'hides banner when just dismissed (dismissedAt = now)',
    // Expected: shouldShowTtlBanner(Date.now()) === false
  );

  it.todo(
    'hides banner when dismissed 89 days ago',
    // Expected: shouldShowTtlBanner(Date.now() - 89 * 86400000) === false
  );

  it.todo(
    'hides banner at exactly 90 days (strictly greater than)',
    // Expected: shouldShowTtlBanner(Date.now() - 90 * 86400000) === false
  );

  it.todo(
    'shows banner when dismissed 90 days + 1ms ago',
    // Expected: shouldShowTtlBanner(Date.now() - 90 * 86400000 - 1) === true
  );

  it.todo(
    'shows banner when dismissedAt is malformed (fall-open)',
    // Expected: shouldShowTtlBanner('invalid') === true
  );
});
