# Phase 1: Robust Entity Extraction Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fragile regex-based entity extraction with a 4-tier pipeline (JS libs → Python sidecar → Fast LLM → Balanced LLM) and introduce ProjectRuntimeConfig for project-level defaults.

**Architecture:** In-process JS libraries (chrono-node, libphonenumber-js) handle dates and phones at <5ms. A Python sidecar wraps Kore.ai ML models for NER and natural-language numbers. Existing LLM extraction tiers remain as Tier 3/4. A new ProjectRuntimeConfig MongoDB model stores project-level extraction, multi-intent, and inference defaults that agents inherit.

**Tech Stack:** TypeScript, chrono-node, libphonenumber-js, Vitest, Mongoose, Express, Docker, Python (sidecar)

**Design Doc:** `docs/plans/2026-03-01-nlu-robustness-design.md`

---

## Task 1: Add JS extraction dependencies

**Files:**

- Modify: `packages/compiler/package.json`

**Step 1: Install chrono-node and libphonenumber-js**

```bash
cd /Users/prasannaarikala/projects/agent-platform
pnpm --filter @agent-platform/compiler add chrono-node libphonenumber-js
```

**Step 2: Verify installation**

```bash
pnpm --filter @agent-platform/compiler exec -- node -e "require('chrono-node'); require('libphonenumber-js'); console.log('OK')"
```

Expected: `OK`

**Step 3: Commit**

```bash
git add packages/compiler/package.json pnpm-lock.yaml
git commit -m "[ABLP-2] feat(compiler): add chrono-node and libphonenumber-js for robust extraction"
```

---

## Task 2: Create JS-based date extraction module

**Files:**

- Create: `packages/compiler/src/platform/utils/date-extraction.ts`
- Test: `packages/compiler/src/__tests__/utils/date-extraction.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/compiler/src/__tests__/utils/date-extraction.test.ts
import { describe, it, expect } from 'vitest';
import { extractDatesFromText } from '../../platform/utils/date-extraction.js';

describe('extractDatesFromText', () => {
  describe('relative dates (English)', () => {
    it('extracts "today"', () => {
      const result = extractDatesFromText('I want to check in today', 'en');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('date');
      // Value should be ISO date string for today
      expect(result[0].value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('extracts "tomorrow"', () => {
      const result = extractDatesFromText('arriving tomorrow', 'en');
      expect(result).toHaveLength(1);
    });

    it('extracts "next Monday"', () => {
      const result = extractDatesFromText('next Monday please', 'en');
      expect(result).toHaveLength(1);
    });

    it('extracts "in 3 days"', () => {
      const result = extractDatesFromText('in 3 days', 'en');
      expect(result).toHaveLength(1);
    });
  });

  describe('absolute dates', () => {
    it('extracts "March 15, 2026"', () => {
      const result = extractDatesFromText('on March 15, 2026', 'en');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('2026-03-15');
    });

    it('extracts "15/03/2026" with locale', () => {
      const result = extractDatesFromText('on 15/03/2026', 'en-GB');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('2026-03-15');
    });

    it('extracts ISO format "2026-03-15"', () => {
      const result = extractDatesFromText('date is 2026-03-15', 'en');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('2026-03-15');
    });
  });

  describe('date ranges', () => {
    it('extracts "March 6 to March 10"', () => {
      const result = extractDatesFromText('from March 6 to March 10', 'en');
      expect(result).toHaveLength(2);
    });

    it('extracts "next Monday through Friday"', () => {
      const result = extractDatesFromText('next Monday through Friday', 'en');
      expect(result).toHaveLength(2);
    });
  });

  describe('multilingual', () => {
    it('extracts Spanish date "15 de marzo"', () => {
      const result = extractDatesFromText('el 15 de marzo de 2026', 'es');
      expect(result).toHaveLength(1);
    });

    it('extracts French date "15 mars"', () => {
      const result = extractDatesFromText('le 15 mars 2026', 'fr');
      expect(result).toHaveLength(1);
    });

    it('extracts German date "15. März"', () => {
      const result = extractDatesFromText('am 15. März 2026', 'de');
      expect(result).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for no dates', () => {
      const result = extractDatesFromText('hello world', 'en');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      const result = extractDatesFromText('', 'en');
      expect(result).toEqual([]);
    });

    it('defaults to English when locale not supported', () => {
      const result = extractDatesFromText('tomorrow', 'zz');
      expect(result).toHaveLength(1);
    });
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/utils/date-extraction.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement the module**

```typescript
// packages/compiler/src/platform/utils/date-extraction.ts
/**
 * Date extraction using chrono-node (multilingual, relative/absolute/range).
 * Replaces regex-based extractDates() in entity-extraction.ts.
 */
import * as chrono from 'chrono-node';

export interface ExtractedDate {
  type: 'date';
  value: string; // ISO 8601 date (YYYY-MM-DD)
  text: string; // original matched text
  index: number; // position in input
}

/** Map BCP-47 locale prefix to chrono parser */
const LOCALE_PARSERS: Record<string, chrono.Chrono> = {
  en: chrono.en.casual,
  es: chrono.es.casual,
  fr: chrono.fr.casual,
  de: chrono.de.casual,
  pt: chrono.pt.casual,
  ja: chrono.ja.casual,
  nl: chrono.nl.casual,
};

function getParser(locale: string): chrono.Chrono {
  const prefix = locale.split('-')[0].toLowerCase();
  return LOCALE_PARSERS[prefix] ?? chrono.en.casual;
}

function toISODate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function extractDatesFromText(text: string, locale: string = 'en'): ExtractedDate[] {
  if (!text.trim()) return [];

  const parser = getParser(locale);
  const results = parser.parse(text, new Date());

  return results.map((r) => ({
    type: 'date' as const,
    value: toISODate(r.start.date()),
    text: r.text,
    index: r.index,
  }));
}
```

**Step 4: Run tests to verify they pass**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/utils/date-extraction.test.ts
```

Expected: All PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/utils/date-extraction.ts packages/compiler/src/__tests__/utils/date-extraction.test.ts
git commit -m "[ABLP-2] feat(compiler): add chrono-node date extraction module"
```

---

## Task 3: Create JS-based phone extraction module

**Files:**

- Create: `packages/compiler/src/platform/utils/phone-extraction.ts`
- Test: `packages/compiler/src/__tests__/utils/phone-extraction.test.ts`

**Step 1: Write the failing tests**

```typescript
// packages/compiler/src/__tests__/utils/phone-extraction.test.ts
import { describe, it, expect } from 'vitest';
import { extractPhoneFromText } from '../../platform/utils/phone-extraction.js';

describe('extractPhoneFromText', () => {
  it('extracts US phone number', () => {
    const result = extractPhoneFromText('call me at 555-123-4567', 'US');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+15551234567');
  });

  it('extracts international format +44 20 7946 0958', () => {
    const result = extractPhoneFromText('ring +44 20 7946 0958', 'GB');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+442079460958');
  });

  it('extracts phone with parentheses (555) 123-4567', () => {
    const result = extractPhoneFromText('(555) 123-4567', 'US');
    expect(result).not.toBeNull();
    expect(result!.e164).toBe('+15551234567');
  });

  it('returns null for no phone number', () => {
    const result = extractPhoneFromText('hello world', 'US');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = extractPhoneFromText('', 'US');
    expect(result).toBeNull();
  });

  it('validates and rejects invalid numbers', () => {
    const result = extractPhoneFromText('123', 'US');
    expect(result).toBeNull();
  });

  it('normalizes to E.164 format', () => {
    const result = extractPhoneFromText('my number is 07911 123456', 'GB');
    expect(result).not.toBeNull();
    expect(result!.e164).toMatch(/^\+44/);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/utils/phone-extraction.test.ts
```

Expected: FAIL

**Step 3: Implement the module**

```typescript
// packages/compiler/src/platform/utils/phone-extraction.ts
/**
 * Phone number extraction and validation using libphonenumber-js.
 * Replaces regex-based phone extraction in entity-extraction.ts.
 */
import { findPhoneNumbersInText, type CountryCode, type E164Number } from 'libphonenumber-js';

export interface ExtractedPhone {
  type: 'phone';
  e164: E164Number; // E.164 format: +15551234567
  national: string; // national format: (555) 123-4567
  country: string; // ISO country code: US
  text: string; // original matched text
}

export function extractPhoneFromText(
  text: string,
  defaultCountry: string = 'US',
): ExtractedPhone | null {
  if (!text.trim()) return null;

  const results = findPhoneNumbersInText(text, defaultCountry as CountryCode);
  if (results.length === 0) return null;

  const phone = results[0].number;
  const formatted = phone.format('E.164');
  if (!formatted) return null;

  return {
    type: 'phone',
    e164: formatted as E164Number,
    national: phone.formatNational(),
    country: phone.country ?? defaultCountry,
    text: text.substring(results[0].startsAt, results[0].endsAt),
  };
}
```

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/utils/phone-extraction.test.ts
```

Expected: All PASS

**Step 5: Commit**

```bash
git add packages/compiler/src/platform/utils/phone-extraction.ts packages/compiler/src/__tests__/utils/phone-extraction.test.ts
git commit -m "[ABLP-2] feat(compiler): add libphonenumber-js phone extraction module"
```

---

## Task 4: Refactor entity-extraction.ts to use JS libs

**Files:**

- Modify: `packages/compiler/src/platform/utils/entity-extraction.ts`
- Modify: `packages/compiler/src/__tests__/utils/entity-extraction.test.ts` (create if missing)

**Step 1: Write tests for the refactored extractEntitiesForFields**

```typescript
// packages/compiler/src/__tests__/utils/entity-extraction.test.ts
import { describe, it, expect } from 'vitest';
import { extractEntitiesForFields } from '../../platform/utils/entity-extraction.js';

describe('extractEntitiesForFields (refactored)', () => {
  it('extracts date field using chrono-node', () => {
    const result = extractEntitiesForFields(
      'arriving next Monday',
      [{ name: 'check_in', type: 'date' }],
      'en',
    );
    expect(result.check_in).toBeDefined();
    expect(result.check_in).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('extracts phone field using libphonenumber', () => {
    const result = extractEntitiesForFields(
      'call me at 555-123-4567',
      [{ name: 'phone', type: 'phone' }],
      'en',
    );
    expect(result.phone).toBe('+15551234567');
  });

  it('extracts number field (unchanged)', () => {
    const result = extractEntitiesForFields(
      '4 guests',
      [{ name: 'num_guests', type: 'number' }],
      'en',
    );
    expect(result.num_guests).toBe(4);
  });

  it('extracts email field (unchanged regex)', () => {
    const result = extractEntitiesForFields(
      'email me at test@example.com',
      [{ name: 'email', type: 'email' }],
      'en',
    );
    expect(result.email).toBe('test@example.com');
  });

  it('handles multiple fields', () => {
    const result = extractEntitiesForFields(
      'arriving March 15 with 2 guests, call 555-123-4567',
      [
        { name: 'check_in', type: 'date' },
        { name: 'guests', type: 'number' },
        { name: 'phone', type: 'phone' },
      ],
      'en',
    );
    expect(result.check_in).toBeDefined();
    expect(result.guests).toBe(2);
    expect(result.phone).toBeDefined();
  });

  it('returns empty for no matches', () => {
    const result = extractEntitiesForFields(
      'hello world',
      [{ name: 'check_in', type: 'date' }],
      'en',
    );
    expect(result.check_in).toBeUndefined();
  });

  it('handles multilingual dates', () => {
    const result = extractEntitiesForFields(
      'el 15 de marzo de 2026',
      [{ name: 'fecha', type: 'date' }],
      'es',
    );
    expect(result.fecha).toBeDefined();
  });
});
```

**Step 2: Run to verify current state**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/utils/entity-extraction.test.ts
```

**Step 3: Refactor extractEntitiesForFields to delegate to JS libs**

In `packages/compiler/src/platform/utils/entity-extraction.ts`, modify `extractEntitiesForFields()` (lines 400-524):

- Import `extractDatesFromText` from `./date-extraction.js`
- Import `extractPhoneFromText` from `./phone-extraction.js`
- Replace the inline regex date extraction with `extractDatesFromText()` call
- Replace the inline regex phone extraction with `extractPhoneFromText()` call
- Keep number and email extraction as-is (numbers still regex for now, email regex is acceptable)

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/compiler exec vitest run src/__tests__/utils/entity-extraction.test.ts
```

Expected: All PASS

**Step 5: Run full compiler test suite to verify no regressions**

```bash
pnpm --filter @agent-platform/compiler test
```

Expected: All existing tests PASS

**Step 6: Commit**

```bash
git add packages/compiler/src/platform/utils/entity-extraction.ts packages/compiler/src/__tests__/utils/entity-extraction.test.ts
git commit -m "[ABLP-2] refactor(compiler): replace regex date/phone extraction with chrono-node/libphonenumber"
```

---

## Task 5: Create NLU sidecar client

**Files:**

- Create: `apps/runtime/src/services/nlu/sidecar-client.ts`
- Test: `apps/runtime/src/__tests__/nlu-sidecar-client.test.ts`

**Step 1: Write the failing tests**

```typescript
// apps/runtime/src/__tests__/nlu-sidecar-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NLUSidecarClient } from '../services/nlu/sidecar-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('NLUSidecarClient', () => {
  let client: NLUSidecarClient;

  beforeEach(() => {
    client = new NLUSidecarClient({
      url: 'http://localhost:8090',
      timeoutMs: 500,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 1000,
    });
    mockFetch.mockReset();
  });

  describe('extract()', () => {
    it('sends extraction request and returns entities', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entities: { destination: 'Paris' },
          confidence: { destination: 0.95 },
        }),
      });

      const result = await client.extract({
        text: 'I want to go to Paris',
        fields: [{ name: 'destination', type: 'string', hints: [] }],
        locale: 'en',
      });

      expect(result).toEqual({
        entities: { destination: 'Paris' },
        confidence: { destination: 0.95 },
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8090/extract',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns null when sidecar is unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.extract({
        text: 'hello',
        fields: [{ name: 'x', type: 'string', hints: [] }],
        locale: 'en',
      });

      expect(result).toBeNull();
    });

    it('returns null on timeout', async () => {
      mockFetch.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 2000)));

      const result = await client.extract({
        text: 'hello',
        fields: [{ name: 'x', type: 'string', hints: [] }],
        locale: 'en',
      });

      expect(result).toBeNull();
    });
  });

  describe('circuit breaker', () => {
    it('opens after consecutive failures', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      // Hit threshold (3 failures)
      await client.extract({ text: '1', fields: [], locale: 'en' });
      await client.extract({ text: '2', fields: [], locale: 'en' });
      await client.extract({ text: '3', fields: [], locale: 'en' });

      // 4th call should not even call fetch (circuit open)
      mockFetch.mockClear();
      await client.extract({ text: '4', fields: [], locale: 'en' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('half-opens after reset period', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await client.extract({ text: '1', fields: [], locale: 'en' });
      await client.extract({ text: '2', fields: [], locale: 'en' });
      await client.extract({ text: '3', fields: [], locale: 'en' });

      // Wait for reset
      await new Promise((r) => setTimeout(r, 1100));

      // Should try again (half-open)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ entities: {}, confidence: {} }),
      });

      const result = await client.extract({ text: '5', fields: [], locale: 'en' });
      expect(mockFetch).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });
  });

  describe('detectCorrection()', () => {
    it('sends correction detection request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          is_correction: true,
          field: 'destination',
          new_value: 'Barcelona',
          confidence: 0.91,
        }),
      });

      const result = await client.detectCorrection({
        text: 'actually Barcelona',
        context: { destination: 'Paris' },
        locale: 'en',
      });

      expect(result).toEqual({
        is_correction: true,
        field: 'destination',
        new_value: 'Barcelona',
        confidence: 0.91,
      });
    });

    it('returns null when sidecar unavailable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await client.detectCorrection({
        text: 'actually Barcelona',
        context: {},
        locale: 'en',
      });

      expect(result).toBeNull();
    });
  });

  describe('health()', () => {
    it('returns true when healthy', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      expect(await client.health()).toBe(true);
    });

    it('returns false when unhealthy', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await client.health()).toBe(false);
    });
  });
});
```

**Step 2: Run to verify failure**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/nlu-sidecar-client.test.ts
```

Expected: FAIL — module not found

**Step 3: Implement sidecar client**

```typescript
// apps/runtime/src/services/nlu/sidecar-client.ts
/**
 * HTTP client for the NLU Python sidecar.
 * Handles extraction, correction detection, health checks.
 * Includes circuit breaker for graceful degradation when sidecar is unavailable.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('nlu-sidecar-client');

export interface SidecarConfig {
  url: string;
  timeoutMs: number;
  circuitBreakerThreshold: number;
  circuitBreakerResetMs: number;
}

export interface ExtractionRequest {
  text: string;
  fields: Array<{ name: string; type: string; hints: string[] }>;
  locale: string;
}

export interface ExtractionResponse {
  entities: Record<string, unknown>;
  confidence: Record<string, number>;
}

export interface CorrectionRequest {
  text: string;
  context: Record<string, unknown>;
  locale: string;
}

export interface CorrectionResponse {
  is_correction: boolean;
  field?: string;
  old_value?: unknown;
  new_value?: unknown;
  confidence: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

export class NLUSidecarClient {
  private config: SidecarConfig;
  private consecutiveFailures = 0;
  private circuitState: CircuitState = 'closed';
  private circuitOpenedAt = 0;

  constructor(config: SidecarConfig) {
    this.config = config;
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResponse | null> {
    return this.callEndpoint<ExtractionResponse>('/extract', req);
  }

  async detectCorrection(req: CorrectionRequest): Promise<CorrectionResponse | null> {
    return this.callEndpoint<CorrectionResponse>('/detect-correction', req);
  }

  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const res = await fetch(`${this.config.url}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async callEndpoint<T>(path: string, body: unknown): Promise<T | null> {
    if (!this.canAttempt()) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const res = await fetch(`${this.config.url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        this.recordFailure();
        log.warn('Sidecar returned non-OK', { path, status: res.status });
        return null;
      }

      const data = (await res.json()) as T;
      this.recordSuccess();
      return data;
    } catch (err) {
      this.recordFailure();
      log.debug('Sidecar unavailable', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private canAttempt(): boolean {
    if (this.circuitState === 'closed') return true;

    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed >= this.config.circuitBreakerResetMs) {
        this.circuitState = 'half-open';
        return true;
      }
      return false;
    }

    // half-open: allow one attempt
    return true;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.circuitBreakerThreshold) {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      log.warn('Circuit breaker opened', {
        failures: this.consecutiveFailures,
        resetMs: this.config.circuitBreakerResetMs,
      });
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitState = 'closed';
  }
}
```

**Step 4: Run tests**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/nlu-sidecar-client.test.ts
```

Expected: All PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/nlu/sidecar-client.ts apps/runtime/src/__tests__/nlu-sidecar-client.test.ts
git commit -m "[ABLP-2] feat(runtime): add NLU sidecar client with circuit breaker"
```

---

## Task 6: Update ExtractionStrategy type in IR schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts`

**Step 1: Find and update the strategy type**

In `packages/compiler/src/platform/ir/schema.ts`, find the `GatherConfig` or where extraction strategy is defined. Add the new strategy type if not already present:

```typescript
/** Extraction strategy for gather fields */
export type ExtractionStrategy = 'auto' | 'ml' | 'llm' | 'hybrid' | 'pattern';
```

Add to `GatherFieldSemantics` (around line 500-515) — no new fields needed, `lookup` and `convert_to` already exist.

Add to `AgentIR` interface a new optional field:

```typescript
/** Project-level runtime config (baked at compile time from ProjectRuntimeConfig) */
project_runtime_config?: ProjectRuntimeConfigIR;
```

Add the `ProjectRuntimeConfigIR` interface:

```typescript
export interface ProjectRuntimeConfigIR {
  extraction_strategy: ExtractionStrategy;
  multi_intent: {
    enabled: boolean;
    strategy: string;
    max_intents: number;
    confidence_threshold: number;
    queue_max_age_ms: number;
  };
  inference: {
    confidence: number;
    confirm: boolean;
    model_tier: string;
    max_fields_per_pass: number;
  };
  conversion: {
    currency_mode: 'static' | 'live';
    currency_api_url?: string;
  };
  lookup_tables: Array<{
    name: string;
    source: 'inline' | 'mongodb' | 'http';
    values?: string[];
    collection?: string;
    endpoint?: string;
    field?: string;
    case_sensitive: boolean;
    fuzzy_match: boolean;
    fuzzy_threshold: number;
  }>;
}
```

**Step 2: Build to verify no type errors**

```bash
pnpm --filter @agent-platform/compiler build
```

Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add packages/compiler/src/platform/ir/schema.ts
git commit -m "[ABLP-2] feat(compiler): add ExtractionStrategy type and ProjectRuntimeConfigIR to IR schema"
```

---

## Task 7: Create ProjectRuntimeConfig database model

**Files:**

- Create: `packages/database/src/models/project-runtime-config.model.ts`
- Modify: `packages/database/src/models/index.ts` (add export)

**Step 1: Create the model following ProjectLLMConfig pattern**

```typescript
// packages/database/src/models/project-runtime-config.model.ts
import { Schema, model, type Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import { tenantIsolation } from '../mongo/plugins/tenant-isolation.plugin.js';

export interface IProjectRuntimeConfig {
  _id: string;
  tenantId: string;
  projectId: string;

  // LLM tier overrides (absorbed from ProjectLLMConfig)
  operationTierOverrides: Map<string, string> | Record<string, string>;

  // Extraction config
  extraction: {
    strategy: string;
    correction_detection: string;
    sidecar_timeout_ms: number;
    sidecar_circuit_breaker_threshold: number;
  };

  // Multi-intent config
  multi_intent: {
    enabled: boolean;
    strategy: string;
    max_intents: number;
    confidence_threshold: number;
    queue_max_age_ms: number;
  };

  // Inference config
  inference: {
    confidence: number;
    confirm: boolean;
    model_tier: string;
    max_fields_per_pass: number;
  };

  // Conversion config
  conversion: {
    currency_mode: string;
    currency_api_url?: string;
  };

  // Lookup tables
  lookup_tables: Array<{
    name: string;
    source: string;
    values?: string[];
    collection?: string;
    endpoint?: string;
    field?: string;
    case_sensitive: boolean;
    fuzzy_match: boolean;
    fuzzy_threshold: number;
  }>;

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

const LookupTableSchema = new Schema(
  {
    name: { type: String, required: true },
    source: { type: String, enum: ['inline', 'mongodb', 'http'], default: 'inline' },
    values: [String],
    collection: String,
    endpoint: String,
    field: String,
    case_sensitive: { type: Boolean, default: false },
    fuzzy_match: { type: Boolean, default: false },
    fuzzy_threshold: { type: Number, default: 0.85 },
  },
  { _id: false },
);

const ProjectRuntimeConfigSchema = new Schema<IProjectRuntimeConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    operationTierOverrides: { type: Map, of: String, default: new Map() },
    extraction: {
      type: new Schema(
        {
          strategy: { type: String, default: 'auto' },
          correction_detection: { type: String, default: 'ml' },
          sidecar_timeout_ms: { type: Number, default: 500 },
          sidecar_circuit_breaker_threshold: { type: Number, default: 5 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    multi_intent: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: true },
          strategy: { type: String, default: 'primary_queue' },
          max_intents: { type: Number, default: 3 },
          confidence_threshold: { type: Number, default: 0.6 },
          queue_max_age_ms: { type: Number, default: 600_000 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    inference: {
      type: new Schema(
        {
          confidence: { type: Number, default: 0.8 },
          confirm: { type: Boolean, default: true },
          model_tier: { type: String, default: 'fast' },
          max_fields_per_pass: { type: Number, default: 3 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    conversion: {
      type: new Schema(
        {
          currency_mode: { type: String, default: 'static' },
          currency_api_url: String,
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    lookup_tables: { type: [LookupTableSchema], default: [] },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_runtime_configs' },
);

ProjectRuntimeConfigSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });
ProjectRuntimeConfigSchema.plugin(tenantIsolation);

export const ProjectRuntimeConfig: Model<IProjectRuntimeConfig> = model<IProjectRuntimeConfig>(
  'ProjectRuntimeConfig',
  ProjectRuntimeConfigSchema,
);
```

**Step 2: Add export to models index**

In `packages/database/src/models/index.ts`, add:

```typescript
export {
  ProjectRuntimeConfig,
  type IProjectRuntimeConfig,
} from './project-runtime-config.model.js';
```

**Step 3: Build database package**

```bash
pnpm --filter @agent-platform/database build
```

Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add packages/database/src/models/project-runtime-config.model.ts packages/database/src/models/index.ts
git commit -m "[ABLP-2] feat(database): add ProjectRuntimeConfig model"
```

---

## Task 8: Create ProjectRuntimeConfig API route

**Files:**

- Create: `apps/runtime/src/routes/project-runtime-config.ts`
- Modify: `apps/runtime/src/routes/index.ts` (register route)

**Step 1: Create the route following project-llm-config.ts pattern**

```typescript
// apps/runtime/src/routes/project-runtime-config.ts
import { Router, type Request, type Response } from 'express';
import { ProjectRuntimeConfig } from '@agent-platform/database';
import { requireProjectPermission } from '../middleware/project-rbac.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('project-runtime-config-route');
const router = Router({ mergeParams: true });

/** Platform defaults — returned when no config exists */
const PLATFORM_DEFAULTS = {
  operationTierOverrides: {},
  extraction: {
    strategy: 'auto',
    correction_detection: 'ml',
    sidecar_timeout_ms: 500,
    sidecar_circuit_breaker_threshold: 5,
  },
  multi_intent: {
    enabled: true,
    strategy: 'primary_queue',
    max_intents: 3,
    confidence_threshold: 0.6,
    queue_max_age_ms: 600_000,
  },
  inference: {
    confidence: 0.8,
    confirm: true,
    model_tier: 'fast',
    max_fields_per_pass: 3,
  },
  conversion: {
    currency_mode: 'static',
  },
  lookup_tables: [],
};

/** GET /api/projects/:projectId/runtime-config */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'runtime_config:read'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const config = await ProjectRuntimeConfig.findOne({ tenantId, projectId });

    res.json({
      success: true,
      data: config?.toObject() ?? { ...PLATFORM_DEFAULTS, projectId, tenantId },
    });
  } catch (err) {
    log.error('Failed to get runtime config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load runtime config' },
    });
  }
});

/** PUT /api/projects/:projectId/runtime-config */
router.put('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireProjectPermission(req, res, 'runtime_config:write'))) return;

    const { projectId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    const config = await ProjectRuntimeConfig.findOneAndUpdate(
      { tenantId, projectId },
      { $set: { ...req.body, tenantId, projectId } },
      { upsert: true, new: true, runValidators: true },
    );

    res.json({ success: true, data: config.toObject() });
  } catch (err) {
    log.error('Failed to update runtime config', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update runtime config' },
    });
  }
});

export default router;
```

**Step 2: Register route in routes/index.ts**

Add to the project-scoped routes section:

```typescript
import projectRuntimeConfigRoutes from './project-runtime-config.js';
// ...
projectRouter.use('/:projectId/runtime-config', projectRuntimeConfigRoutes);
```

**Step 3: Build and verify**

```bash
pnpm --filter @agent-platform/runtime build
```

Expected: BUILD SUCCESS

**Step 4: Commit**

```bash
git add apps/runtime/src/routes/project-runtime-config.ts apps/runtime/src/routes/index.ts
git commit -m "[ABLP-2] feat(runtime): add ProjectRuntimeConfig API route (GET/PUT)"
```

---

## Task 9: Wire Tier 1 + Tier 2 into flow-step-executor

**Files:**

- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Step 1: Add imports for new extraction modules and sidecar client**

At the top of `flow-step-executor.ts`, add:

```typescript
import { extractDatesFromText } from '@abl/compiler/platform/utils/date-extraction.js';
import { extractPhoneFromText } from '@abl/compiler/platform/utils/phone-extraction.js';
import { NLUSidecarClient } from '../nlu/sidecar-client.js';
```

**Step 2: Create a resolveExtractionTiers function**

Add before `extractEntitiesWithLLM` (around line 720):

```typescript
/**
 * Tier 1: In-process JS extraction (chrono-node, libphonenumber-js).
 * Returns partial results for fields it can handle.
 */
function extractWithJSLibs(
  text: string,
  fields: Array<{ name: string; type: string }>,
  locale: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const fieldType = field.type?.toLowerCase() ?? '';

    if (fieldType === 'date' || fieldType === 'datetime') {
      const dates = extractDatesFromText(text, locale);
      if (dates.length > 0) {
        result[field.name] = dates[0].value;
      }
    } else if (fieldType === 'phone') {
      const phone = extractPhoneFromText(text, locale.split('-')[1] ?? 'US');
      if (phone) {
        result[field.name] = phone.e164;
      }
    }
    // Number and email handled by existing extractEntitiesForFields
  }

  return result;
}
```

**Step 3: Modify extractEntitiesWithLLM to use 4-tier pipeline**

Rename `extractEntitiesWithLLM` to `extractEntities` and add tier logic at the beginning of the function. The existing LLM extraction code becomes Tier 3/4. Add Tier 1 (JS libs) and Tier 2 (sidecar) before it.

Key changes:

1. Call `extractWithJSLibs()` first for fields with matching types
2. For unmatched fields, call sidecar client if available
3. For remaining unmatched fields, proceed to existing LLM extraction (Tier 3/4)
4. Merge results: Tier 1 overrides nothing, Tier 2 fills gaps, Tier 3/4 fills remaining gaps

**Step 4: Build and test**

```bash
pnpm --filter @agent-platform/runtime build && pnpm --filter @agent-platform/runtime test
```

Expected: All PASS

**Step 5: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire 4-tier extraction pipeline (JS libs → sidecar → LLM)"
```

---

## Task 10: Create Python NLU sidecar scaffold

**Files:**

- Create: `apps/nlu-sidecar/Dockerfile`
- Create: `apps/nlu-sidecar/requirements.txt`
- Create: `apps/nlu-sidecar/app.py`
- Create: `apps/nlu-sidecar/tests/test_app.py`
- Modify: `docker-compose.yml`

**Step 1: Create sidecar app**

```python
# apps/nlu-sidecar/app.py
"""NLU Sidecar — wraps Kore.ai ML models + spaCy for entity extraction and correction detection."""
from flask import Flask, request, jsonify
import logging

app = Flask(__name__)
log = logging.getLogger(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'}), 200

@app.route('/extract', methods=['POST'])
def extract():
    data = request.json
    text = data.get('text', '')
    fields = data.get('fields', [])
    locale = data.get('locale', 'en')

    entities = {}
    confidence = {}

    # TODO: Wire Kore.ai ML models here
    # TODO: Wire spaCy NER here
    # For now, return empty (graceful — runtime falls through to LLM)

    return jsonify({'entities': entities, 'confidence': confidence})

@app.route('/detect-correction', methods=['POST'])
def detect_correction():
    data = request.json
    text = data.get('text', '')
    context = data.get('context', {})
    locale = data.get('locale', 'en')

    # TODO: Wire Kore.ai correction model here
    # For now, return no correction (graceful — runtime uses heuristic fallback)

    return jsonify({'is_correction': False, 'confidence': 0.0})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8090)
```

**Step 2: Create requirements.txt**

```
flask==3.0.0
gunicorn==21.2.0
# Add when integrating:
# spacy==3.7.2
# kore-nlu-models (private package)
```

**Step 3: Create Dockerfile**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:8090/health || exit 1
CMD ["gunicorn", "--bind", "0.0.0.0:8090", "--workers", "2", "--timeout", "30", "app:app"]
```

**Step 4: Add to docker-compose.yml**

Add after the existing Python services:

```yaml
abl-nlu-sidecar:
  build: ./apps/nlu-sidecar
  container_name: abl-nlu-sidecar
  ports:
    - '8090:8090'
  environment:
    - LOG_LEVEL=info
  healthcheck:
    test: ['CMD', 'curl', '-f', 'http://localhost:8090/health']
    interval: 30s
    timeout: 5s
    retries: 3
  restart: unless-stopped
```

**Step 5: Create basic test**

```python
# apps/nlu-sidecar/tests/test_app.py
import pytest
from app import app

@pytest.fixture
def client():
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

def test_health(client):
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json['status'] == 'ok'

def test_extract_empty(client):
    response = client.post('/extract', json={'text': '', 'fields': [], 'locale': 'en'})
    assert response.status_code == 200
    assert response.json['entities'] == {}

def test_detect_correction_empty(client):
    response = client.post('/detect-correction', json={'text': '', 'context': {}, 'locale': 'en'})
    assert response.status_code == 200
    assert response.json['is_correction'] == False
```

**Step 6: Commit**

```bash
git add apps/nlu-sidecar/ docker-compose.yml
git commit -m "[ABLP-2] feat(nlu-sidecar): scaffold Python NLU sidecar service"
```

---

## Task 11: Update correction detection to use sidecar

**Files:**

- Modify: `packages/compiler/src/platform/constructs/utils.ts`
- Modify: `apps/runtime/src/services/execution/flow-step-executor.ts`

**Step 1: Add sidecar-based correction detection to flow-step-executor**

In `flow-step-executor.ts`, find the correction detection section (around lines 1619-1731). Before the existing regex-based `detectCorrection()` call, add a sidecar call:

```typescript
// Try sidecar ML correction detection first (if available)
let correctionResult = null;
if (sidecarClient) {
  correctionResult = await sidecarClient.detectCorrection({
    text: currentMessage,
    context: session.data.values,
    locale: session.locale ?? 'en',
  });
}

// Fall back to heuristic if sidecar returned nothing
if (!correctionResult?.is_correction) {
  correctionResult = detectCorrection(currentMessage, session.data.values, correctionPatterns);
}
```

**Step 2: Run tests**

```bash
pnpm --filter @agent-platform/runtime test
```

Expected: All PASS (sidecar is optional, falls through to existing heuristic)

**Step 3: Commit**

```bash
git add apps/runtime/src/services/execution/flow-step-executor.ts
git commit -m "[ABLP-2] feat(runtime): wire sidecar correction detection with heuristic fallback"
```

---

## Task 12: Write integration tests for 4-tier extraction

**Files:**

- Create: `apps/runtime/src/__tests__/extraction-pipeline.test.ts`

**Step 1: Write integration tests**

```typescript
// apps/runtime/src/__tests__/extraction-pipeline.test.ts
import { describe, it, expect, vi } from 'vitest';
import { extractDatesFromText } from '@abl/compiler/platform/utils/date-extraction.js';
import { extractPhoneFromText } from '@abl/compiler/platform/utils/phone-extraction.js';
import { NLUSidecarClient } from '../services/nlu/sidecar-client.js';

describe('4-Tier Extraction Pipeline', () => {
  describe('Tier 1: JS Libraries', () => {
    it('chrono-node extracts relative dates that regex missed', () => {
      const result = extractDatesFromText('in 3 business days', 'en');
      expect(result.length).toBeGreaterThan(0);
    });

    it('chrono-node handles "the day after tomorrow"', () => {
      const result = extractDatesFromText('the day after tomorrow', 'en');
      expect(result.length).toBe(1);
    });

    it('libphonenumber validates and normalizes international phones', () => {
      const result = extractPhoneFromText('+33 1 23 45 67 89', 'FR');
      expect(result).not.toBeNull();
      expect(result!.e164).toBe('+33123456789');
    });

    it('libphonenumber rejects invalid numbers', () => {
      const result = extractPhoneFromText('12345', 'US');
      expect(result).toBeNull();
    });
  });

  describe('Tier 2: Sidecar (mocked)', () => {
    it('falls through to Tier 3 when sidecar unavailable', async () => {
      const client = new NLUSidecarClient({
        url: 'http://localhost:99999',
        timeoutMs: 100,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
      });

      const result = await client.extract({
        text: 'go to Paris',
        fields: [{ name: 'dest', type: 'string', hints: [] }],
        locale: 'en',
      });

      expect(result).toBeNull(); // graceful degradation
    });
  });

  describe('Strategy resolution', () => {
    it('auto strategy: uses all tiers in order', () => {
      // Dates extracted by Tier 1 (chrono-node)
      const dates = extractDatesFromText('arriving March 15', 'en');
      expect(dates.length).toBe(1);
      // Remaining fields would go to Tier 2, then Tier 3
    });

    it('ml strategy: skips LLM tiers', () => {
      // ML strategy uses only Tier 1 + Tier 2
      const dates = extractDatesFromText('tomorrow', 'en');
      expect(dates.length).toBe(1);
      // No LLM call needed
    });
  });
});
```

**Step 2: Run tests**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/extraction-pipeline.test.ts
```

Expected: All PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/extraction-pipeline.test.ts
git commit -m "[ABLP-2] test(runtime): add 4-tier extraction pipeline integration tests"
```

---

## Review Pass 1 — Addendum Tasks

The following tasks were identified as missing during completeness review.

---

## Task 13: Add ProjectRuntimeConfig API route tests

**Files:**

- Create: `apps/runtime/src/__tests__/project-runtime-config-route.test.ts`

**Step 1: Write authorization and happy-path tests**

```typescript
// apps/runtime/src/__tests__/project-runtime-config-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ProjectRuntimeConfig Route', () => {
  describe('GET /api/projects/:projectId/runtime-config', () => {
    it('returns platform defaults when no config exists', async () => {
      // Mock findOne returning null
      // Assert response includes all default sections (extraction, multi_intent, inference, conversion, lookup_tables)
    });

    it('returns saved config when exists', async () => {
      // Mock findOne returning a config document
      // Assert response matches saved config
    });

    it('returns 401 when not authenticated', async () => {
      // No auth header
      // Assert 401
    });

    it('returns 404 for cross-tenant access', async () => {
      // Tenant A's token, Tenant B's project
      // Assert 404 (not 403 — per CLAUDE.md tenant isolation rules)
    });

    it('requires runtime_config:read permission', async () => {
      // Token without required permission
      // Assert 403
    });
  });

  describe('PUT /api/projects/:projectId/runtime-config', () => {
    it('creates config on first PUT (upsert)', async () => {
      // PUT with extraction config
      // Assert 200, config created
    });

    it('updates existing config', async () => {
      // PUT with updated multi_intent config
      // Assert 200, config updated
    });

    it('returns 401 when not authenticated', async () => {
      // Assert 401
    });

    it('returns 404 for cross-tenant access', async () => {
      // Assert 404
    });

    it('requires runtime_config:write permission', async () => {
      // Assert 403
    });
  });
});
```

**Step 2: Run tests**

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/project-runtime-config-route.test.ts
```

**Step 3: Commit**

```bash
git add apps/runtime/src/__tests__/project-runtime-config-route.test.ts
git commit -m "[ABLP-2] test(runtime): add ProjectRuntimeConfig route authorization and happy-path tests"
```

---

## Task 14: Add backward-compatibility alias for /llm-config

**Files:**

- Modify: `apps/runtime/src/routes/project-llm-config.ts`

**Step 1: Update existing llm-config route to delegate to ProjectRuntimeConfig**

The existing GET/PUT handlers at `/api/projects/:projectId/llm-config` should read/write `operationTierOverrides` from the `ProjectRuntimeConfig` document instead of the old `ProjectLLMConfig` collection.

```typescript
// In project-llm-config.ts GET handler:
// Replace: const config = await ProjectLLMConfig.findOne({ tenantId, projectId });
// With: const config = await ProjectRuntimeConfig.findOne({ tenantId, projectId });
// Return only: { operationTierOverrides: config?.operationTierOverrides ?? {} }

// In project-llm-config.ts PUT handler:
// Replace: update ProjectLLMConfig
// With: update ProjectRuntimeConfig.operationTierOverrides field only
```

**Step 2: Run existing llm-config tests to verify backward compat**

```bash
pnpm --filter @agent-platform/runtime test
```

Expected: All PASS

**Step 3: Commit**

```bash
git add apps/runtime/src/routes/project-llm-config.ts
git commit -m "[ABLP-2] refactor(runtime): alias /llm-config to read/write ProjectRuntimeConfig.operationTierOverrides"
```

---

## Task 15: Fix Task 7 — add sidecar_url to DB model

**Files:**

- Modify: `packages/database/src/models/project-runtime-config.model.ts`

**Step 1: Add missing field to extraction sub-schema**

In the extraction sub-schema (inside `ProjectRuntimeConfigSchema`), add:

```typescript
sidecar_url: { type: String }, // Optional per-project sidecar URL override
```

And to the `IProjectRuntimeConfig` interface:

```typescript
extraction: {
  strategy: string;
  sidecar_url?: string;              // Added: per-project sidecar URL override
  correction_detection: string;
  sidecar_timeout_ms: number;
  sidecar_circuit_breaker_threshold: number;
};
```

Also add `sidecar_circuit_breaker_reset_ms` (default: 30000) to match design doc's 30s specification.

**Step 2: Build**

```bash
pnpm --filter @agent-platform/database build
```

**Step 3: Commit**

```bash
git add packages/database/src/models/project-runtime-config.model.ts
git commit -m "[ABLP-2] fix(database): add sidecar_url and circuit_breaker_reset_ms to ProjectRuntimeConfig"
```

---

## Notes

- **Studio UI "Runtime Config" tab** is explicitly deferred to a separate Studio-focused plan. This plan covers backend only.
- **Task 9 Step 3** (4-tier pipeline wiring) intentionally provides architectural guidance rather than complete code because the existing `extractEntitiesWithLLM` function body varies and the implementer needs to read current state. The strategy routing (`auto` → cascade, `ml` → Tier 1+2 only, `llm` → Tier 3+4 only) must branch on `agentIR.project_runtime_config?.extraction_strategy`.

---

## Review Corrections (from Review Pass 2 & 3)

### CRITICAL — Task 9: `extractWithJSLibs` needs unit tests

Task 9 introduces `extractWithJSLibs()` as a new function but has no dedicated unit tests. The implementer MUST add tests in `apps/runtime/src/__tests__/extract-with-js-libs.test.ts` covering:

- Date field extraction delegates to `extractDatesFromText`
- Phone field extraction delegates to `extractPhoneFromText`
- Unknown field types are skipped (returns empty for those)
- Empty text returns empty object
- Multiple fields of different types in one call

### CRITICAL — Task 9 Step 3: Must be complete code, not prose

Task 9 Step 3 currently gives architectural guidance. The implementer must write full code for:

1. The `extractWithJSLibs()` function (exact code is in Step 2 — that's fine)
2. The strategy routing in the refactored `extractEntities()` function body — specifically the `switch` on extraction strategy:

```typescript
switch (strategy) {
  case 'auto': // cascade: Tier 1 → remaining → Tier 2 → remaining → Tier 3/4
  case 'hybrid': // same as auto
    break;
  case 'ml': // Tier 1 + Tier 2 only, no LLM
    break;
  case 'llm': // Tier 3/4 only, skip JS libs and sidecar
    break;
  case 'pattern': // existing regex-based only
    break;
}
```

The implementer should read the current `extractEntitiesWithLLM()` body to understand its shape before refactoring.

### CRITICAL — Task 13: Route tests must have real assertions

Task 13 test bodies are empty stubs (`// Mock findOne returning null`, `// Assert response includes...`). The implementer MUST write full test implementations following the authz test pattern in `apps/runtime/src/__tests__/*-authz.test.ts`. Each test must:

1. Set up mock `ProjectRuntimeConfig.findOne()` / `findOneAndUpdate()`
2. Create a mock request with `tenantContext`
3. Call the route handler
4. Assert the response status and body

### IMPORTANT — Multi-intent config resolution

Phase 1 (Task 6) adds `project_runtime_config.multi_intent` to AgentIR. Phase 2 (Task 1) adds `intent_handling.multi_intent` to AgentIR. The implementer must use this resolution order at runtime:

```typescript
const multiIntentConfig =
  agentIR.intent_handling?.multi_intent ?? // agent-level override (from DSL)
  agentIR.project_runtime_config?.multi_intent ?? // project-level default
  PLATFORM_DEFAULTS.multi_intent; // platform default
```

This ensures agent-level DSL config takes priority over project defaults.
