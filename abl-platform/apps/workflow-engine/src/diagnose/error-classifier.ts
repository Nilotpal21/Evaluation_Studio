/**
 * Maps a raw probe error into a small, stable classifier string suitable
 * for a user-visible `detail` field. The raw error is logged at the
 * probe site — this helper produces only the sanitized value that ships
 * in the `/diagnose` response, so SASL usernames, connection strings,
 * and other provider-specific diagnostic text do not leak even to
 * callers on the internal network.
 *
 * Keep the classifier set small and grep-friendly — operators read this
 * alongside logs, so a stable vocabulary beats precise but noisy text.
 */

const PATTERNS: ReadonlyArray<{ test: RegExp; classifier: string }> = [
  { test: /ECONNREFUSED/i, classifier: 'connection_refused' },
  { test: /ETIMEDOUT|ESOCKETTIMEDOUT|timed out/i, classifier: 'timeout' },
  { test: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i, classifier: 'dns_failure' },
  { test: /ECONNRESET|broken pipe|socket hang up/i, classifier: 'connection_reset' },
  { test: /unknown.*topic|topic.*not.*exist/i, classifier: 'topic_missing' },
  {
    test: /unauthori[sz]ed|forbidden|authentication|auth.*fail|password|credential/i,
    classifier: 'auth_failed',
  },
  { test: /broker|network/i, classifier: 'broker_unreachable' },
];

export function classifyProbeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  for (const { test, classifier } of PATTERNS) {
    if (test.test(message)) return classifier;
  }
  return 'probe_failed';
}
