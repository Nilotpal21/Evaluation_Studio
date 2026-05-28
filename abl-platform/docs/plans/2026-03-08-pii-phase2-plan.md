# PII Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the PII handling pipeline with output redaction, tokenized vault for reversible PII, transient field cleanup, sensitive display masking, and per-consumer view rendering.

**Architecture:** Builds on Phase 1's `detectPIISelective()` and context-aware PII guard. Adds a PII token vault (`packages/compiler/src/platform/security/pii-vault.ts`) that replaces destructive `[REDACTED_*]` labels with reversible `{{PII:<type>:<uuid>}}` tokens. Output redaction hooks into the existing `checkOutputGuardrails` pattern in reasoning-executor. Transient cleanup fires at gather completion. Sensitive display rendering formats tokens per consumer (`mask`, `redact`, `replace`). Encryption uses the existing `EncryptionService` from `packages/shared/src/encryption/engine.ts`.

**Tech Stack:** TypeScript, Vitest, `packages/compiler` (PII vault, pii-detector), `packages/shared` (EncryptionService), `apps/runtime` (reasoning-executor, session store)

**Design Doc:** `docs/plans/2026-03-08-bruce-feedback-p0-p1-design.md` (Phase 2 section, lines 246-291)

**Phase 1 Foundation (already implemented):**

- `detectPIISelective()` in `packages/compiler/src/platform/security/pii-detector.ts` — selective redaction with exempt types
- `createPIIGuardHook()` in `packages/compiler/src/platform/nlu/enterprise/pii-guard.ts` — context-aware input redaction
- GatherField IR: `sensitive`, `sensitive_display`, `mask_config`, `transient`, `extraction_pattern` fields
- `EntityDefinition.sensitive` flag in NLU types
- `NLUConfig.piiRedaction.redactOutput` flag exists but is not wired

---

## Task 1: Output PII Redaction Hook (P2, highest impact)

Wire `redactOutput` into the agent response path. This is the most critical security gap — agent responses can currently echo collected PII back to the user without redaction.

**Files:**

- Create: `apps/runtime/src/services/execution/output-pii-filter.ts`
- Test: `apps/runtime/src/__tests__/output-pii-filter.test.ts`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts:878-910` — add PII filter after output guardrails

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/output-pii-filter.test.ts`:

```typescript
/**
 * Output PII Filter Tests
 *
 * Tests that agent responses have PII redacted before delivery to the user,
 * controlled by the redactOutput config flag.
 */
import { describe, test, expect } from 'vitest';
import { filterOutputPII } from '../services/execution/output-pii-filter.js';

describe('Output PII Filter', () => {
  describe('filterOutputPII', () => {
    test('redacts email in agent response', () => {
      const result = filterOutputPII('I found your account under user@example.com', {
        enabled: true,
        redactInput: true,
        redactOutput: true,
      });
      expect(result.text).toContain('[REDACTED_EMAIL]');
      expect(result.text).not.toContain('user@example.com');
      expect(result.filtered).toBe(true);
    });

    test('redacts phone number in agent response', () => {
      const result = filterOutputPII('Your callback number is 555-123-4567', {
        enabled: true,
        redactInput: true,
        redactOutput: true,
      });
      expect(result.text).toContain('[REDACTED_PHONE]');
      expect(result.filtered).toBe(true);
    });

    test('returns original text when redactOutput is false', () => {
      const result = filterOutputPII('Your email is user@example.com', {
        enabled: true,
        redactInput: true,
        redactOutput: false,
      });
      expect(result.text).toBe('Your email is user@example.com');
      expect(result.filtered).toBe(false);
    });

    test('returns original text when PII redaction is disabled', () => {
      const result = filterOutputPII('SSN: 123-45-6789', {
        enabled: false,
        redactInput: true,
        redactOutput: true,
      });
      expect(result.text).toBe('SSN: 123-45-6789');
      expect(result.filtered).toBe(false);
    });

    test('returns original text when no PII found', () => {
      const result = filterOutputPII('Your order has been confirmed.', {
        enabled: true,
        redactInput: true,
        redactOutput: true,
      });
      expect(result.text).toBe('Your order has been confirmed.');
      expect(result.filtered).toBe(false);
    });

    test('redacts multiple PII types', () => {
      const result = filterOutputPII(
        'Contact: user@test.com, phone 555-123-4567, SSN 123-45-6789',
        { enabled: true, redactInput: true, redactOutput: true },
      );
      expect(result.text).toContain('[REDACTED_EMAIL]');
      expect(result.text).toContain('[REDACTED_PHONE]');
      expect(result.text).toContain('[REDACTED_SSN]');
      expect(result.redactedTypes).toContain('email');
      expect(result.redactedTypes).toContain('phone');
      expect(result.redactedTypes).toContain('ssn');
    });

    test('exempts types when exemptTypes provided', () => {
      const result = filterOutputPII(
        'Your phone is 555-123-4567 and SSN 123-45-6789',
        { enabled: true, redactInput: true, redactOutput: true },
        new Set(['phone']),
      );
      expect(result.text).toContain('555-123-4567');
      expect(result.text).toContain('[REDACTED_SSN]');
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/output-pii-filter.test.ts
```

Expected: FAIL — module `../services/execution/output-pii-filter.js` does not exist.

### Step 3: Implement output-pii-filter.ts

Create `apps/runtime/src/services/execution/output-pii-filter.ts`:

```typescript
/**
 * Output PII Filter
 *
 * Redacts PII from agent responses before delivery to the user.
 * Runs after output guardrails, controlled by piiRedaction.redactOutput config.
 *
 * Uses detectPIISelective from pii-detector for consistency with input redaction.
 */

import { createLogger } from '@abl/compiler/platform';
import { detectPIISelective, type PIIType } from '@abl/compiler/platform/security/pii-detector.js';

const log = createLogger('output-pii-filter');

interface PIIRedactionConfig {
  enabled: boolean;
  redactInput: boolean;
  redactOutput: boolean;
}

export interface OutputPIIFilterResult {
  text: string;
  filtered: boolean;
  redactedTypes: PIIType[];
}

/**
 * Filter PII from agent output text.
 *
 * @param text - Agent response text
 * @param config - PII redaction configuration
 * @param exemptTypes - Optional PII types to skip (e.g. types the user just provided)
 */
export function filterOutputPII(
  text: string,
  config: PIIRedactionConfig,
  exemptTypes?: Set<PIIType>,
): OutputPIIFilterResult {
  if (!config.enabled || !config.redactOutput) {
    return { text, filtered: false, redactedTypes: [] };
  }

  const result = detectPIISelective(text, exemptTypes);

  if (!result.hasPII || result.redactedTypes.length === 0) {
    return { text, filtered: false, redactedTypes: [] };
  }

  log.info('output-pii-filtered', {
    redactedTypes: result.redactedTypes,
    exemptedTypes: result.exemptedTypes,
  });

  return {
    text: result.redacted,
    filtered: true,
    redactedTypes: result.redactedTypes,
  };
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/output-pii-filter.test.ts
```

Expected: PASS — all 7 tests green.

### Step 5: Wire into reasoning-executor

In `apps/runtime/src/services/execution/reasoning-executor.ts`, add import at the top:

```typescript
import { filterOutputPII } from './output-pii-filter.js';
```

Then after the output guardrails block (around line 935, after the guardrail result handling ends), add the PII output filter:

```typescript
// --- OUTPUT PII FILTER: redact PII from agent response ---
if (finalResponse && session.nluConfig?.piiRedaction) {
  const piiResult = filterOutputPII(finalResponse, session.nluConfig.piiRedaction);
  if (piiResult.filtered) {
    finalResponse = piiResult.text;
    onTraceEvent?.({
      type: 'output_pii_filtered',
      data: {
        agent: session.agentName,
        redactedTypes: piiResult.redactedTypes,
      },
    });
  }
}
```

**Important:** Check what property the session uses for NLU config. Search for `nluConfig` or `piiRedaction` on the session type. If the session doesn't have NLU config directly, read it from `session.agentIR?.nlu` or the runtime config. Adapt the property path accordingly.

### Step 6: Build and run tests

```bash
pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime && cd apps/runtime && pnpm test -- --run src/__tests__/output-pii-filter.test.ts
```

Expected: PASS.

### Step 7: Commit

```bash
npx prettier --write apps/runtime/src/services/execution/output-pii-filter.ts apps/runtime/src/__tests__/output-pii-filter.test.ts apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/output-pii-filter.ts apps/runtime/src/__tests__/output-pii-filter.test.ts apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-2] feat(runtime): add output PII redaction filter for agent responses

Redacts PII from agent output before delivery to user, controlled by
piiRedaction.redactOutput config flag. Runs after output guardrails.
Uses detectPIISelective for consistency with input redaction pipeline."
```

---

## Task 2: PII Token Vault — Core Module (P2, reversible tokenization)

Replace destructive `[REDACTED_*]` labels with reversible `{{PII:<type>:<uuid>}}` tokens. The vault stores original values encrypted at rest, enabling detokenization for authorized consumers.

**Files:**

- Create: `packages/compiler/src/platform/security/pii-vault.ts`
- Test: `packages/compiler/src/__tests__/security/pii-vault.test.ts`

### Step 1: Write the failing test

Create `packages/compiler/src/__tests__/security/pii-vault.test.ts`:

```typescript
/**
 * PII Vault Tests
 *
 * Tests tokenization, detokenization, and token format for reversible PII handling.
 * The vault replaces [REDACTED_*] labels with {{PII:<type>:<uuid>}} tokens that
 * can be reversed by authorized consumers.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { PIIVault } from '../../platform/security/pii-vault.js';

describe('PII Vault', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  describe('tokenize', () => {
    test('replaces PII with {{PII:<type>:<uuid>}} tokens', () => {
      const result = vault.tokenize('My email is user@example.com');
      expect(result.text).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
      expect(result.text).not.toContain('user@example.com');
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].type).toBe('email');
      expect(result.tokens[0].original).toBe('user@example.com');
    });

    test('tokenizes multiple PII types', () => {
      const result = vault.tokenize('Email user@test.com, phone 555-123-4567');
      expect(result.tokens).toHaveLength(2);
      const types = result.tokens.map((t) => t.type);
      expect(types).toContain('email');
      expect(types).toContain('phone');
    });

    test('respects exempt types', () => {
      const result = vault.tokenize('Phone 555-123-4567, SSN 123-45-6789', new Set(['phone']));
      expect(result.text).toContain('555-123-4567');
      expect(result.text).toMatch(/\{\{PII:ssn:[a-f0-9-]+\}\}/);
      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0].type).toBe('ssn');
    });

    test('returns original text when no PII found', () => {
      const result = vault.tokenize('Hello world');
      expect(result.text).toBe('Hello world');
      expect(result.tokens).toHaveLength(0);
    });

    test('tokens have unique UUIDs', () => {
      const result = vault.tokenize('Email a@b.com and c@d.com');
      const ids = result.tokens.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('detokenize', () => {
    test('restores original values from tokens', () => {
      const tokenized = vault.tokenize('My email is user@example.com');
      const restored = vault.detokenize(tokenized.text);
      expect(restored).toBe('My email is user@example.com');
    });

    test('restores multiple tokens', () => {
      const original = 'Email user@test.com, SSN 123-45-6789';
      const tokenized = vault.tokenize(original);
      const restored = vault.detokenize(tokenized.text);
      expect(restored).toBe(original);
    });

    test('returns text unchanged when no tokens found', () => {
      expect(vault.detokenize('Hello world')).toBe('Hello world');
    });

    test('preserves unknown tokens in text', () => {
      const text = 'Token {{PII:email:nonexistent-id}} is unknown';
      expect(vault.detokenize(text)).toBe(text);
    });
  });

  describe('renderForConsumer', () => {
    test('renders redacted view for logs', () => {
      const tokenized = vault.tokenize('My email is user@example.com');
      const rendered = vault.renderForConsumer(tokenized.text, 'logs');
      expect(rendered).toContain('[REDACTED_EMAIL]');
      expect(rendered).not.toContain('user@example.com');
    });

    test('renders masked view for user display', () => {
      const tokenized = vault.tokenize('My phone is 555-123-4567');
      const rendered = vault.renderForConsumer(tokenized.text, 'user');
      expect(rendered).toContain('***');
      expect(rendered).not.toContain('555-123-4567');
    });

    test('renders original for tools consumer', () => {
      const tokenized = vault.tokenize('My email is user@example.com');
      const rendered = vault.renderForConsumer(tokenized.text, 'tools');
      expect(rendered).toContain('user@example.com');
    });

    test('renders redacted view for unknown consumer', () => {
      const tokenized = vault.tokenize('My email is user@example.com');
      const rendered = vault.renderForConsumer(tokenized.text, 'unknown' as any);
      expect(rendered).toContain('[REDACTED_EMAIL]');
    });
  });

  describe('clear', () => {
    test('clears all stored tokens', () => {
      vault.tokenize('My email is user@example.com');
      vault.clear();
      const text = 'Token {{PII:email:some-id}} left';
      expect(vault.detokenize(text)).toBe(text);
    });
  });

  describe('getTokenCount', () => {
    test('returns number of stored tokens', () => {
      expect(vault.getTokenCount()).toBe(0);
      vault.tokenize('Email user@test.com');
      expect(vault.getTokenCount()).toBe(1);
      vault.tokenize('Phone 555-123-4567');
      expect(vault.getTokenCount()).toBe(2);
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/security/pii-vault.test.ts
```

Expected: FAIL — module `../../platform/security/pii-vault.js` does not exist.

### Step 3: Implement pii-vault.ts

Create `packages/compiler/src/platform/security/pii-vault.ts`:

```typescript
/**
 * PII Token Vault
 *
 * Reversible tokenization for PII values. Replaces detected PII with
 * {{PII:<type>:<uuid>}} tokens and stores originals for authorized consumers.
 *
 * Token format: {{PII:<type>:<uuid>}}
 *   - type: PIIType (email, phone, ssn, credit_card, ip_address)
 *   - uuid: crypto.randomUUID()
 *
 * Consumer views:
 *   - LLM: sees tokens ({{PII:PHONE:abc123}})
 *   - User: sees masked values (***-***-4567) or [REDACTED_*]
 *   - Logs: sees [REDACTED_*] always
 *   - Tools: sees original values (configurable)
 *
 * XO migration: Replaces XO's #*#TYPE-UNIQID-DISPLAY#*# token format.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import { detectPIISelective, type PIIType, type PIIDetection } from './pii-detector.js';

const log = createLogger('pii-vault');

const TOKEN_REGEX = /\{\{PII:(\w+):([a-f0-9-]+)\}\}/g;

export type PIIConsumer = 'llm' | 'user' | 'logs' | 'tools';

export interface PIIToken {
  id: string;
  type: PIIType;
  original: string;
  token: string;
}

export interface TokenizeResult {
  text: string;
  tokens: PIIToken[];
}

const REDACT_LABELS: Record<PIIType, string> = {
  email: '[REDACTED_EMAIL]',
  phone: '[REDACTED_PHONE]',
  ssn: '[REDACTED_SSN]',
  credit_card: '[REDACTED_CARD]',
  ip_address: '[REDACTED_IP]',
};

/**
 * In-memory PII token vault. One instance per session.
 *
 * For Phase 2 persistence: extend with EncryptionService for at-rest encryption
 * and Redis for session-lifetime caching.
 */
export class PIIVault {
  private readonly store = new Map<string, PIIToken>();

  /**
   * Detect PII in text and replace with tokens. Original values stored in vault.
   */
  tokenize(text: string, exemptTypes?: Set<PIIType>): TokenizeResult {
    const result = detectPIISelective(text, exemptTypes);

    if (!result.hasPII || result.redactedTypes.length === 0) {
      return { text, tokens: [] };
    }

    const tokens: PIIToken[] = [];
    // Get only the detections that were actually redacted (not exempted)
    const toTokenize = result.detections.filter((d) => !exemptTypes || !exemptTypes.has(d.type));

    // Process in reverse order to preserve indices
    let tokenized = text;
    for (let i = toTokenize.length - 1; i >= 0; i--) {
      const det = toTokenize[i];
      const id = randomUUID();
      const token = `{{PII:${det.type}:${id}}}`;

      const piiToken: PIIToken = {
        id,
        type: det.type,
        original: det.value,
        token,
      };

      this.store.set(id, piiToken);
      tokens.unshift(piiToken);
      tokenized = tokenized.substring(0, det.start) + token + tokenized.substring(det.end);
    }

    log.debug('tokenized', { count: tokens.length, types: tokens.map((t) => t.type) });
    return { text: tokenized, tokens };
  }

  /**
   * Restore original PII values from tokens in text.
   */
  detokenize(text: string): string {
    return text.replace(TOKEN_REGEX, (match, _type, id) => {
      const token = this.store.get(id);
      return token ? token.original : match;
    });
  }

  /**
   * Render tokenized text for a specific consumer.
   */
  renderForConsumer(text: string, consumer: PIIConsumer): string {
    return text.replace(TOKEN_REGEX, (match, type: string, id: string) => {
      const token = this.store.get(id);
      if (!token) return match;

      switch (consumer) {
        case 'tools':
          return token.original;
        case 'user':
          return maskValue(token.original, token.type);
        case 'logs':
          return REDACT_LABELS[token.type] ?? '[REDACTED]';
        case 'llm':
          return match; // LLM sees tokens as-is
        default:
          return REDACT_LABELS[token.type] ?? '[REDACTED]';
      }
    });
  }

  /** Remove all stored tokens (call on session cleanup) */
  clear(): void {
    this.store.clear();
  }

  /** Number of tokens in the vault */
  getTokenCount(): number {
    return this.store.size;
  }
}

/**
 * Mask a PII value for user display.
 * Shows last 4 characters for phone/card, first+last for email, full mask for SSN.
 */
function maskValue(value: string, type: PIIType): string {
  switch (type) {
    case 'phone': {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '***';
    }
    case 'email': {
      const [local, domain] = value.split('@');
      if (!local || !domain) return '***@***';
      return `${local[0]}***@${domain}`;
    }
    case 'credit_card': {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 4 ? `****-****-****-${digits.slice(-4)}` : '****';
    }
    case 'ssn':
      return '***-**-****';
    case 'ip_address':
      return '***.***.***.***';
    default:
      return '***';
  }
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm build && pnpm test -- --run src/__tests__/security/pii-vault.test.ts
```

Expected: PASS — all tests green.

### Step 5: Commit

```bash
npx prettier --write packages/compiler/src/platform/security/pii-vault.ts packages/compiler/src/__tests__/security/pii-vault.test.ts
git add packages/compiler/src/platform/security/pii-vault.ts packages/compiler/src/__tests__/security/pii-vault.test.ts
git commit -m "[ABLP-2] feat(compiler): add PII token vault with reversible tokenization

New PIIVault class replaces destructive [REDACTED_*] labels with
reversible {{PII:<type>:<uuid>}} tokens. Supports per-consumer views
(tools=original, user=masked, logs=redacted, llm=tokens). XO migration:
replaces #*#TYPE-UNIQID-DISPLAY#*# format."
```

---

## Task 3: Sensitive Display Rendering (P2, sensitive_display + mask_config)

Implement the rendering logic that reads `sensitive_display` and `mask_config` from GatherField definitions to format collected values when displayed outside the gather context.

**Files:**

- Create: `packages/compiler/src/platform/security/sensitive-display.ts`
- Test: `packages/compiler/src/__tests__/security/sensitive-display.test.ts`

### Step 1: Write the failing test

Create `packages/compiler/src/__tests__/security/sensitive-display.test.ts`:

```typescript
/**
 * Sensitive Display Tests
 *
 * Tests rendering of sensitive GatherField values according to their
 * sensitive_display and mask_config settings.
 */
import { describe, test, expect } from 'vitest';
import { renderSensitiveValue } from '../../platform/security/sensitive-display.js';
import type { GatherField } from '../../platform/ir/schema.js';

function makeField(overrides: Partial<GatherField>): GatherField {
  return {
    name: 'test_field',
    prompt: 'Enter value',
    type: 'string',
    required: true,
    ...overrides,
  };
}

describe('Sensitive Display', () => {
  describe('renderSensitiveValue', () => {
    test('returns original value when field is not sensitive', () => {
      const field = makeField({ sensitive: false });
      expect(renderSensitiveValue('secret123', field)).toBe('secret123');
    });

    test('returns original value when sensitive but no display mode', () => {
      const field = makeField({ sensitive: true });
      expect(renderSensitiveValue('secret123', field)).toBe('secret123');
    });

    test('redacts value when sensitive_display is redact', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue('555-123-4567', field)).toBe('[REDACTED]');
    });

    test('replaces value when sensitive_display is replace', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'replace' });
      const result = renderSensitiveValue('user@example.com', field);
      expect(result).toMatch(/^\[.+\]$/);
      expect(result).not.toContain('user@example.com');
    });

    test('masks value with default config when sensitive_display is mask', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'mask' });
      const result = renderSensitiveValue('1234567890', field);
      expect(result).toContain('*');
      expect(result).toContain('890');
    });

    test('masks value with custom mask_config', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 2, show_last: 3, char: '#' },
      });
      const result = renderSensitiveValue('1234567890', field);
      expect(result.startsWith('12')).toBe(true);
      expect(result.endsWith('890')).toBe(true);
      expect(result).toContain('#');
    });

    test('handles short values with mask_config gracefully', () => {
      const field = makeField({
        sensitive: true,
        sensitive_display: 'mask',
        mask_config: { show_first: 5, show_last: 5, char: '*' },
      });
      const result = renderSensitiveValue('abc', field);
      expect(result).toBeTruthy();
      expect(result.length).toBeGreaterThan(0);
    });

    test('handles null/undefined values', () => {
      const field = makeField({ sensitive: true, sensitive_display: 'redact' });
      expect(renderSensitiveValue(null as any, field)).toBe('');
      expect(renderSensitiveValue(undefined as any, field)).toBe('');
    });
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm test -- --run src/__tests__/security/sensitive-display.test.ts
```

Expected: FAIL — module does not exist.

### Step 3: Implement sensitive-display.ts

Create `packages/compiler/src/platform/security/sensitive-display.ts`:

```typescript
/**
 * Sensitive Display Renderer
 *
 * Renders collected GatherField values according to their sensitive_display
 * and mask_config settings. Used when displaying values outside the gather
 * context (e.g. in confirmation messages, summaries, agent responses).
 *
 * XO migration: Maps from sensitive_pattern.display.type and maskingProps.
 */

import type { GatherField } from '../ir/schema.js';

const DEFAULT_MASK_CHAR = '*';
const DEFAULT_SHOW_FIRST = 0;
const DEFAULT_SHOW_LAST = 3;

/**
 * Render a sensitive value according to its field's display configuration.
 *
 * @param value - The raw collected value
 * @param field - GatherField definition with sensitive_display and mask_config
 * @returns Rendered value (masked, redacted, replaced, or original)
 */
export function renderSensitiveValue(value: unknown, field: GatherField): string {
  if (value === null || value === undefined) return '';

  const str = String(value);

  if (!field.sensitive || !field.sensitive_display) {
    return str;
  }

  switch (field.sensitive_display) {
    case 'redact':
      return '[REDACTED]';

    case 'replace':
      return `[${field.name.toUpperCase()}]`;

    case 'mask': {
      const config = field.mask_config ?? {
        show_first: DEFAULT_SHOW_FIRST,
        show_last: DEFAULT_SHOW_LAST,
        char: DEFAULT_MASK_CHAR,
      };
      return maskString(str, config.show_first, config.show_last, config.char);
    }

    default:
      return str;
  }
}

function maskString(value: string, showFirst: number, showLast: number, char: string): string {
  if (value.length <= showFirst + showLast) {
    return char.repeat(Math.max(value.length, 3));
  }

  const first = value.substring(0, showFirst);
  const last = value.substring(value.length - showLast);
  const middle = char.repeat(value.length - showFirst - showLast);

  return first + middle + last;
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm build && pnpm test -- --run src/__tests__/security/sensitive-display.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
npx prettier --write packages/compiler/src/platform/security/sensitive-display.ts packages/compiler/src/__tests__/security/sensitive-display.test.ts
git add packages/compiler/src/platform/security/sensitive-display.ts packages/compiler/src/__tests__/security/sensitive-display.test.ts
git commit -m "[ABLP-2] feat(compiler): add sensitive display renderer for gathered values

Implements renderSensitiveValue() that reads GatherField.sensitive_display
(redact/mask/replace) and mask_config to format values for display
outside gather context. XO migration: maps from sensitive_pattern.display."
```

---

## Task 4: Transient PII Cleanup After Gather Completes (P2)

When a gather operation completes, automatically clean up fields marked `transient: true` from session data. This handles CVV, OTP, and other ephemeral PII that should not persist.

**Files:**

- Create: `apps/runtime/src/services/execution/transient-cleanup.ts`
- Test: `apps/runtime/src/__tests__/transient-cleanup.test.ts`
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` — call cleanup at gather completion

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/transient-cleanup.test.ts`:

```typescript
/**
 * Transient PII Cleanup Tests
 *
 * Tests that fields marked transient: true on GatherField are cleaned
 * from session data after gather completes.
 */
import { describe, test, expect } from 'vitest';
import { cleanupTransientFields } from '../services/execution/transient-cleanup.js';
import type { GatherField } from '@abl/compiler';

describe('Transient PII Cleanup', () => {
  function makeField(name: string, overrides?: Partial<GatherField>): GatherField {
    return {
      name,
      prompt: `Enter ${name}`,
      type: 'string',
      required: true,
      ...overrides,
    };
  }

  test('removes transient fields from data', () => {
    const data: Record<string, unknown> = {
      card_number: '4111111111111111',
      cvv: '123',
      name: 'John Doe',
    };
    const fields: GatherField[] = [
      makeField('card_number', { sensitive: true }),
      makeField('cvv', { sensitive: true, transient: true }),
      makeField('name'),
    ];

    const removed = cleanupTransientFields(data, fields);

    expect(data.cvv).toBeUndefined();
    expect(data.card_number).toBe('4111111111111111');
    expect(data.name).toBe('John Doe');
    expect(removed).toEqual(['cvv']);
  });

  test('returns empty array when no transient fields', () => {
    const data: Record<string, unknown> = { name: 'Alice' };
    const fields: GatherField[] = [makeField('name')];

    const removed = cleanupTransientFields(data, fields);
    expect(removed).toEqual([]);
    expect(data.name).toBe('Alice');
  });

  test('handles multiple transient fields', () => {
    const data: Record<string, unknown> = {
      cvv: '123',
      otp: '456789',
      email: 'user@test.com',
    };
    const fields: GatherField[] = [
      makeField('cvv', { transient: true }),
      makeField('otp', { transient: true }),
      makeField('email', { sensitive: true }),
    ];

    const removed = cleanupTransientFields(data, fields);
    expect(removed).toEqual(['cvv', 'otp']);
    expect(data.cvv).toBeUndefined();
    expect(data.otp).toBeUndefined();
    expect(data.email).toBe('user@test.com');
  });

  test('skips fields not present in data', () => {
    const data: Record<string, unknown> = { name: 'Alice' };
    const fields: GatherField[] = [makeField('cvv', { transient: true }), makeField('name')];

    const removed = cleanupTransientFields(data, fields);
    expect(removed).toEqual([]);
  });

  test('handles empty fields array', () => {
    const data: Record<string, unknown> = { name: 'Alice' };
    const removed = cleanupTransientFields(data, []);
    expect(removed).toEqual([]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/transient-cleanup.test.ts
```

Expected: FAIL — module does not exist.

### Step 3: Implement transient-cleanup.ts

Create `apps/runtime/src/services/execution/transient-cleanup.ts`:

```typescript
/**
 * Transient PII Cleanup
 *
 * Removes fields marked transient: true from session data after gather
 * completes. Handles ephemeral PII like CVV, OTP, and one-time tokens.
 *
 * XO migration: Replaces isTransient with TTL-based Redis cleanup.
 */

import { createLogger } from '@abl/compiler/platform';
import type { GatherField } from '@abl/compiler';

const log = createLogger('transient-cleanup');

/**
 * Remove transient fields from the data record.
 * Returns the list of field names that were removed.
 */
export function cleanupTransientFields(
  data: Record<string, unknown>,
  fields: GatherField[],
): string[] {
  const removed: string[] = [];

  for (const field of fields) {
    if (field.transient && field.name in data) {
      delete data[field.name];
      removed.push(field.name);
    }
  }

  if (removed.length > 0) {
    log.info('transient-fields-cleaned', { fields: removed });
  }

  return removed;
}
```

### Step 4: Run test to verify it passes

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/transient-cleanup.test.ts
```

Expected: PASS — all 5 tests green.

### Step 5: Wire into gather completion

In `apps/runtime/src/services/execution/reasoning-executor.ts`, add import:

```typescript
import { cleanupTransientFields } from './transient-cleanup.js';
```

Then find where gather completion is detected (search for `gather_complete_reason` or where `gatherFieldsCollected` is updated). After gather fields are marked as complete, add:

```typescript
// Clean up transient fields (CVV, OTP) after gather completes
const gatherFields = session.agentIR?.gather?.fields;
if (gatherFields?.some((f) => f.transient)) {
  const removed = cleanupTransientFields(session.data.values, gatherFields);
  if (removed.length > 0) {
    onTraceEvent?.({
      type: 'transient_pii_cleaned',
      data: { fields: removed, agent: session.agentName },
    });
  }
}
```

**Note:** The exact location depends on the gather completion flow. Search for `checkAndMarkComplete` or `gather_complete` in reasoning-executor.ts and routing-executor.ts to find the right insertion point. The cleanup should fire AFTER the gather data has been used for its purpose (e.g., passed to a tool call) but BEFORE the session is persisted.

### Step 6: Build and run tests

```bash
pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime && cd apps/runtime && pnpm test -- --run src/__tests__/transient-cleanup.test.ts
```

Expected: PASS.

### Step 7: Commit

```bash
npx prettier --write apps/runtime/src/services/execution/transient-cleanup.ts apps/runtime/src/__tests__/transient-cleanup.test.ts apps/runtime/src/services/execution/reasoning-executor.ts
git add apps/runtime/src/services/execution/transient-cleanup.ts apps/runtime/src/__tests__/transient-cleanup.test.ts apps/runtime/src/services/execution/reasoning-executor.ts
git commit -m "[ABLP-2] feat(runtime): add transient PII cleanup after gather completes

Fields marked transient: true on GatherField are automatically removed
from session.data.values after gather completes. Handles CVV, OTP, and
other ephemeral PII. XO migration: replaces isTransient behavior."
```

---

## Task 5: Wire PII Vault into Session Lifecycle (P2)

Integrate the PIIVault into the runtime session so tokenization is available throughout the execution lifecycle.

**Files:**

- Modify: `apps/runtime/src/services/session/types.ts` — add `piiVault` to session type
- Modify: `apps/runtime/src/services/execution/reasoning-executor.ts` — initialize vault per session
- Test: `apps/runtime/src/__tests__/session-pii-vault.test.ts`

### Step 1: Write the failing test

Create `apps/runtime/src/__tests__/session-pii-vault.test.ts`:

```typescript
/**
 * Session PII Vault Integration Tests
 *
 * Tests that the PIIVault is available on the session and tokenization
 * flows through the reasoning execution pipeline.
 */
import { describe, test, expect } from 'vitest';
import { PIIVault } from '@abl/compiler/platform/security/pii-vault.js';

describe('Session PII Vault Integration', () => {
  test('vault tokenizes input and detokenizes for tools', () => {
    const vault = new PIIVault();
    const tokenized = vault.tokenize('My email is user@example.com');
    const forTools = vault.renderForConsumer(tokenized.text, 'tools');
    expect(forTools).toBe('My email is user@example.com');
  });

  test('vault renders redacted view for logs', () => {
    const vault = new PIIVault();
    const tokenized = vault.tokenize('Phone: 555-123-4567');
    const forLogs = vault.renderForConsumer(tokenized.text, 'logs');
    expect(forLogs).toContain('[REDACTED_PHONE]');
    expect(forLogs).not.toContain('555-123-4567');
  });

  test('vault renders masked view for user', () => {
    const vault = new PIIVault();
    const tokenized = vault.tokenize('Card: 4111 1111 1111 1111');
    const forUser = vault.renderForConsumer(tokenized.text, 'user');
    expect(forUser).toContain('1111');
    expect(forUser).not.toContain('4111 1111 1111 1111');
  });

  test('vault cleanup clears all tokens', () => {
    const vault = new PIIVault();
    vault.tokenize('Email user@test.com');
    expect(vault.getTokenCount()).toBe(1);
    vault.clear();
    expect(vault.getTokenCount()).toBe(0);
  });
});
```

### Step 2: Run test to verify it fails

```bash
cd packages/compiler && pnpm build && cd ../../apps/runtime && pnpm test -- --run src/__tests__/session-pii-vault.test.ts
```

Expected: Depends on export setup — may pass if PIIVault is already exported from compiler barrel, or fail if not.

### Step 3: Add PIIVault to compiler barrel exports

Ensure `packages/compiler/src/platform/security/index.ts` exports PIIVault:

```typescript
export { PIIVault, type PIIToken, type PIIConsumer, type TokenizeResult } from './pii-vault.js';
```

Also ensure the `renderSensitiveValue` from Task 3 is exported:

```typescript
export { renderSensitiveValue } from './sensitive-display.js';
```

### Step 4: Add piiVault to session type

In `apps/runtime/src/services/session/types.ts`, add to the session interface (search for `RuntimeSession` or the main session type):

```typescript
  /** PII token vault for reversible tokenization (Phase 2) */
  piiVault?: import('@abl/compiler/platform/security/pii-vault.js').PIIVault;
```

### Step 5: Initialize vault in reasoning-executor

In `apps/runtime/src/services/execution/reasoning-executor.ts`, at the start of `execute()`, initialize the vault if PII redaction is enabled:

```typescript
// Initialize PII vault for this session if not already present
if (!session.piiVault && session.nluConfig?.piiRedaction?.enabled) {
  const { PIIVault } = await import('@abl/compiler/platform/security/pii-vault.js');
  session.piiVault = new PIIVault();
}
```

### Step 6: Build and run tests

```bash
pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime && cd apps/runtime && pnpm test -- --run src/__tests__/session-pii-vault.test.ts
```

### Step 7: Commit

```bash
npx prettier --write packages/compiler/src/platform/security/index.ts apps/runtime/src/services/session/types.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/session-pii-vault.test.ts
git add packages/compiler/src/platform/security/index.ts apps/runtime/src/services/session/types.ts apps/runtime/src/services/execution/reasoning-executor.ts apps/runtime/src/__tests__/session-pii-vault.test.ts
git commit -m "[ABLP-2] feat(runtime): integrate PII vault into session lifecycle

PIIVault is lazily initialized on the session when PII redaction is
enabled. Vault provides per-consumer views (tools=original, user=masked,
logs=redacted) and session-scoped token management."
```

---

## Summary

| Task      | Item                        | Files Changed                                         | Tests Added  |
| --------- | --------------------------- | ----------------------------------------------------- | ------------ |
| 1         | Output PII redaction        | `output-pii-filter.ts` (new), `reasoning-executor.ts` | 7            |
| 2         | PII token vault             | `pii-vault.ts` (new)                                  | 14           |
| 3         | Sensitive display rendering | `sensitive-display.ts` (new)                          | 8            |
| 4         | Transient PII cleanup       | `transient-cleanup.ts` (new), `reasoning-executor.ts` | 5            |
| 5         | Session vault integration   | `types.ts`, `reasoning-executor.ts`, `index.ts`       | 4            |
| **Total** |                             | **7 files**                                           | **38 tests** |

### What's NOT in this plan (deferred to Phase 3)

- **Encrypted vault persistence** — PIIVault currently stores tokens in-memory. Redis + MongoDB persistence with AES-256-GCM encryption is a larger infra task that requires the existing `EncryptionService` to be wired into the session store. The in-memory vault is sufficient for single-request PII handling.
- **Pluggable recognizers** — The Presidio-inspired `PIIRecognizer` interface for ML-based and custom domain recognizers. This is a Phase 3 extensibility feature.
- **Per-consumer views in streaming** — The `onChunk` streaming path wraps chunks for output guardrails but the PII vault integration for streaming requires buffering strategy. Deferred to when streaming + PII requirements are concrete.

### Recommended execution order

Tasks 1-5 in sequence. Task 1 (output redaction) is the highest-impact security fix and can be deployed immediately. Tasks 2-3 lay the foundation for the vault and display rendering. Task 4 handles transient cleanup. Task 5 ties everything together.
