/**
 * Microbenchmark: recognizer-pack throughput at 100 / 500 / 1000 / 5000-char payloads.
 *
 * Non-blocking per LLD D-11. Tracks p50/p95 over time so regressions in
 * regex compilation, context-enhancer windowing, or registry dispatch
 * surface as deltas in the CI bench lane (operator-reviewed, not merge-gating).
 *
 * Run with: `pnpm --filter=@abl/compiler exec vitest bench src/__tests__/security/recognizer-packs.bench.ts`
 *
 * Production p95 / p99 budgets (sub-feature §14 success metrics: ≤ 5 ms / ≤ 10 ms)
 * are observed via the `pii.detect.latency_ms` trace dimension in real traffic,
 * NOT asserted here. This file is for trend tracking only.
 */

import { bench, describe } from 'vitest';
import { PIIRecognizerRegistry, registerPacks } from '../../platform/security/index.js';
import type { PackName } from '@agent-platform/shared/validation';

const PACKS: PackName[] = [
  'core',
  'us',
  'eu',
  'apac',
  'financial',
  'medical',
  'network',
  'international-phone',
];

const FIXTURES: Record<string, string> = {
  // Realistic mix of structured PII embedded in conversational text.
  email: 'Please contact me at john.doe@example.com about the order.',
  phone: 'Call me at +1 (415) 555-0100 or (212) 555-0199.',
  ssn: 'My SSN is 123-45-6789 for tax filing.',
  credit_card: 'My card is 4111 1111 1111 1111 expiring 12/26.',
  iban: 'Wire to IBAN GB82 WEST 1234 5698 7654 32 reference INV-001.',
  passport: 'Passport A12345678 issued 2020 expires 2030.',
  medicare: 'Medicare 2123 45670 1 is current through next year.',
  abn: 'Business ABN 51 824 753 556 is registered in NSW.',
};

function buildPayload(approxChars: number): string {
  // Interleave PII fixtures with filler to reach the target length.
  const filler =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
  const piiBundle = Object.values(FIXTURES).join(' ');
  let out = '';
  while (out.length < approxChars) {
    out += filler + ' ' + piiBundle + ' ';
  }
  return out.slice(0, approxChars);
}

const PAYLOADS: Record<string, string> = {
  '100ch': buildPayload(100),
  '500ch': buildPayload(500),
  '1000ch': buildPayload(1000),
  '5000ch': buildPayload(5000),
};

// Build the registry once at module load — pre-compiled regexes,
// no per-bench-iteration allocation overhead.
const registry = new PIIRecognizerRegistry();
registerPacks(PACKS, registry);

describe('STANDARD tier — all 8 packs enabled', () => {
  for (const [label, payload] of Object.entries(PAYLOADS)) {
    bench(`detectAll @ ${label}`, () => {
      registry.detectAll(payload);
    });
  }
});

describe('Per-pack isolation — single pack overhead', () => {
  // Each pack measured in isolation against the 1000-char payload.
  // Useful for spotting a single pack that regresses out of proportion.
  for (const pack of PACKS) {
    const reg = new PIIRecognizerRegistry();
    registerPacks([pack], reg);
    bench(`${pack} @ 1000ch`, () => {
      reg.detectAll(PAYLOADS['1000ch']);
    });
  }
});

describe('detectAllAsync sync-only path', () => {
  // Confirms async path adds no measurable overhead when no async recognizer
  // is registered — the timeout wrapper short-circuits.
  bench('detectAllAsync @ 1000ch (sync recognizers only)', async () => {
    await registry.detectAllAsync(PAYLOADS['1000ch'], { latencyBudgetMs: 200 });
  });
});
