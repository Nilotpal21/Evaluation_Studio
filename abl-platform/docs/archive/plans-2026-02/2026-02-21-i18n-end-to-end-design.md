# End-to-End Internationalization (i18n) Design

**Date**: 2026-02-21
**Status**: Approved
**Scope**: Studio, Runtime, Compiler/IR, Shared Package

## Context

The ABL platform is currently English-only with zero i18n infrastructure. All strings are hardcoded — UI labels, toast messages, API errors, agent conversation messages. Date/number formatting relies on browser defaults. No RTL support exists.

The platform needs an i18n architecture that supports global locales including RTL (Arabic, Hebrew) and scales from Studio UI to runtime agent conversations.

## Decisions

| Decision                    | Choice                                                              | Rationale                                                                                  |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Architecture                | Approach C: next-intl for Studio, shared format for everything else | Best DX per layer, shared message format enables single TMS adapter                        |
| Message format              | ICU MessageFormat                                                   | Industry standard, supported by all TMS tools, handles pluralization/gender/select         |
| Studio library              | `next-intl`                                                         | Purpose-built for Next.js 15 App Router, server component support                          |
| Runtime i18n                | Lightweight custom layer on shared package                          | Express doesn't need React hooks — just message resolution                                 |
| Agent messages              | Hybrid: DSL-declared for structured, LLM auto-adapt for free-form   | Structured messages are predictable and translatable; LLM responses adapt naturally        |
| API errors                  | Server-side localized with code + message                           | `{ code: 'AUTH_MISSING', message: '<localized>' }` — machines use code, humans see message |
| Translation management      | JSON files in repo now, TMS-pluggable later                         | Namespace structure supports Crowdin/Lokalise/Phrase integration without restructuring     |
| Locale content organization | Project-level `locales/` convention + `MESSAGES_FROM` override      | Keeps DSL files focused on logic, translators work in JSON only                            |

## Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │   @agent-platform/i18n (shared)  │
                    │                                   │
                    │  - ICU MessageFormat wrapper       │
                    │  - Locale negotiation (BCP 47)     │
                    │  - Error code catalog + types      │
                    │  - RTL utilities                   │
                    │  - Locale JSON files (all layers)  │
                    └──────────┬──────────┬─────────────┘
                               │          │
                 ┌─────────────┘          └──────────────┐
                 │                                        │
    ┌────────────▼──────────┐            ┌───────────────▼────────────┐
    │    Studio (next-intl)  │            │    Runtime (custom layer)   │
    │                        │            │                             │
    │  - [locale] routing    │            │  - Locale middleware        │
    │  - useTranslations()   │            │  - formatError()            │
    │  - useFormatter()      │            │  - Session locale lifecycle │
    │  - RTL via dir attr    │            │  - LLM language directive   │
    │  - Logical CSS props   │            │  - resolveAgentMessage()    │
    └────────────────────────┘            └──────────────┬─────────────┘
                                                         │
                                          ┌──────────────▼─────────────┐
                                          │   Compiler/IR               │
                                          │                             │
                                          │  - LocalizedMessages IR     │
                                          │  - locales/ convention      │
                                          │  - _shared.json merge       │
                                          │  - MESSAGES_FROM override   │
                                          │  - Validation diagnostics   │
                                          └─────────────────────────────┘
```

---

## Section 1: Shared Package (`@agent-platform/i18n`)

Lives in `packages/i18n/`. The spine everything else connects to.

### ICU MessageFormat Standard

All translatable strings across the platform use ICU MessageFormat syntax:

```
"agents.count": "{count, plural, =0 {No agents} one {# agent} other {# agents}}"
"agents.status": "{status, select, active {Active} paused {Paused} other {Unknown}}"
```

### Locale Negotiation

Shared `resolveLocale(requested, supported, fallback)` implementing BCP 47 matching:

```typescript
resolveLocale(['ar-EG', 'ar'], ['ar', 'en', 'de'], 'en') → 'ar'
resolveLocale(['pt-BR'], ['pt', 'en'], 'en') → 'pt'
resolveLocale(['ja'], ['en', 'de'], 'en') → 'en'
```

### Namespace Structure

| Namespace             | Owner      | Example keys                                           |
| --------------------- | ---------- | ------------------------------------------------------ |
| `studio.nav`          | Studio UI  | `studio.nav.dashboard`, `studio.nav.agents`            |
| `studio.agents`       | Studio UI  | `studio.agents.create`, `studio.agents.delete_confirm` |
| `studio.settings`     | Studio UI  | `studio.settings.api_keys.title`                       |
| `platform.errors`     | Runtime    | `platform.errors.AUTH_MISSING_HEADER`                  |
| `platform.validation` | Runtime    | `platform.validation.FIELD_REQUIRED`                   |
| `agent.messages`      | ABL DSL/IR | `agent.messages.error_default`                         |

### Error Code Catalog

Typed error catalog mapping codes to ICU message templates:

```typescript
export const ErrorCatalog = {
  AUTH_MISSING_HEADER: 'Authentication header is required',
  AUTH_INVALID_KEY: 'The API key is invalid or expired',
  AUTH_ORIGIN_BLOCKED: 'Requests from {origin} are not allowed',
  TENANT_REQUIRED: 'A tenant context is required for this operation',
  PROJECT_NOT_FOUND: 'Project {projectId} was not found',
} as const satisfies Record<string, string>;
```

### RTL Utilities

```typescript
export function isRTL(locale: string): boolean;
export function getDirection(locale: string): 'ltr' | 'rtl';
export function getTextAlign(locale: string): 'left' | 'right';
```

### File Structure

```
packages/i18n/
  locales/
    en/
      studio.json
      platform.json
    ar/
      studio.json
      platform.json
  src/
    index.ts
    resolve-locale.ts
    format-message.ts
    errors.ts
    rtl.ts
    types.ts
```

English is the source-of-truth locale. Missing keys in other locales fall back to English — never to empty strings.

---

## Section 2: Studio i18n (`next-intl`)

### Locale Routing

Next.js middleware detects locale from:

1. URL path prefix (`/ar/agents`, `/de/settings`)
2. Cookie (`NEXT_LOCALE`)
3. `Accept-Language` header
4. Fallback → `en`

URL structure: `/en/agents`, `/ar/agents`, `/de/settings`. Bare paths redirect to `/{detected-locale}/...`.

Middleware uses shared `resolveLocale()` from `@agent-platform/i18n`.

### Message Loading

```typescript
// apps/studio/src/i18n/request.ts
import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async ({ locale }) => ({
  messages: {
    ...(await import(`@agent-platform/i18n/locales/${locale}/studio.json`)),
    ...(await import(`@agent-platform/i18n/locales/${locale}/platform.json`)),
  },
}));
```

### Component Usage

```tsx
// Server components
const t = await getTranslations('studio.agents');

// Client components
const t = useTranslations('studio.agents');

<Button>{t('create')}</Button>;
toast.success(t('api_key_created'));
```

### Date/Number Formatting

`next-intl`'s `useFormatter()` replaces all custom formatting:

```tsx
const format = useFormatter();
format.relativeTime(date); // locale-aware relative time
format.number(9.99, { style: 'currency', currency: 'USD' }); // locale-aware currency
```

Replaces: custom `formatRelativeTime()` functions, hardcoded `$` currency formatting, raw `.toLocaleDateString()`.

### RTL Layout

Three mechanisms:

1. **`dir` attribute** on `<html>` set by root layout via `getDirection(locale)`
2. **Logical CSS properties** via Tailwind: `ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`
3. **`rtl:` variant** for edge cases: `rtl:rotate-180` on directional icons, `rtl:space-x-reverse`

### Folder Structure Change

```
apps/studio/src/app/
  [locale]/
    layout.tsx          # Sets lang, dir, loads messages
    page.tsx
    agents/
    settings/
  api/                  # API routes stay outside [locale]
```

### Language Switcher

Locale selector component showing native language names, sets `NEXT_LOCALE` cookie, redirects to same page under new locale prefix.

---

## Section 3: Runtime i18n

### Locale Resolution for API Requests

Resolution chain (Express middleware, runs after auth):

```
1. Session locale (if resuming)
2. X-Locale header (explicit override)
3. Accept-Language header
4. Tenant default locale
5. Fallback → 'en'
```

Sets `req.locale` — downstream handlers never parse headers themselves.

### Localized Error Responses

```typescript
import { formatError } from '@agent-platform/i18n';

// Before
res.status(401).json({ error: 'Missing X-Public-Key header' });

// After
res.status(401).json(formatError('AUTH_MISSING_HEADER', req.locale));
// → { code: 'AUTH_MISSING_HEADER', message: 'رأس المصادقة مطلوب' }
```

### Validation Error Localization

Zod issue codes map to `platform.validation` namespace keys:

```typescript
res.status(400).json(formatValidationErrors(result.error.issues, req.locale));
// → { code: 'VALIDATION_FAILED', errors: [
//     { field: 'name', code: 'FIELD_REQUIRED', message: 'الاسم مطلوب' }
//   ]}
```

### Agent Conversation Messages — Hybrid Model

**Structured messages** (DSL-declared, translated at compile time): Error defaults, gather prompts, escalation text. Resolved from IR `LocalizedMessages` using session locale with fallback chain.

**Free-form LLM responses** (auto-adapted): Runtime injects language directive into system prompt when session locale isn't English. NLU language detection (already implemented) feeds into session locale.

```typescript
const languageDirective =
  sessionLocale !== 'en' ? `Respond in ${localeToLanguageName(sessionLocale)}.` : '';
```

### Session Locale Lifecycle

1. Session created → locale set from SDK init params or first message language detection
2. User sends message → NLU detects language
3. Language changed and agent supports it → update session locale
4. Agent doesn't support detected language → keep current locale
5. Session locale persists across pod hops (stored in Redis/MongoDB)

---

## Section 4: Compiler/IR Changes

### Locale Content Organization

**Convention**: Project-level `locales/` directory. Translators work in JSON, never touch DSL files.

```
my-project/
  agents/
    hotel_booking.abl       # No inline messages — just logic
    flight_search.abl
  locales/
    en/
      hotel_booking.json
      flight_search.json
      _shared.json           # cross-agent defaults
    ar/
      hotel_booking.json
      flight_search.json
      _shared.json
```

**Override**: Agents can use `MESSAGES_FROM` for custom paths:

```yaml
AGENT legacy_bot:
  LOCALE: en, ar
  DEFAULT_LOCALE: en
  MESSAGES_FROM: ./custom-locales/
```

### Message Resolution at Compile Time

```
1. MESSAGES_FROM (explicit override)          → highest priority
2. locales/{locale}/{agent_name}.json         → project convention
3. locales/{locale}/_shared.json              → cross-agent defaults
4. Inline MESSAGES block                      → legacy / quick prototyping
```

Agent-specific keys override `_shared.json` keys. Compiler merges at compile time — runtime never does this merge.

### `_shared.json` Pattern

```json
// locales/en/_shared.json — shared defaults
{
  "error_default": "Something went wrong. Let me try again.",
  "constraint_blocked": "I can't do that right now.",
  "escalation_format": "Let me connect you with someone who can help."
}

// locales/en/hotel_booking.json — agent-specific overrides only
{
  "gather_prompt": "I need your travel dates and destination.",
  "conversation_complete": "Your booking is confirmed! Have a great trip."
}
```

### IR Schema Changes

```typescript
export interface AgentIR {
  localization: AgentLocalizationIR;
  messages: LocalizedMessages; // replaces single-locale AgentMessages
}

export interface AgentLocalizationIR {
  supportedLocales: string[]; // ['en', 'ar', 'de']
  defaultLocale: string; // 'en'
}

export type LocalizedMessages = Record<string, AgentMessages>;
```

### Gather Field Prompts Externalized

Prompts move to locale files:

```json
{
  "fields.destination.prompt": "Where would you like to go?",
  "fields.destination.extraction_hints": "city name or airport code"
}
```

DSL field definitions become leaner — just type and structural info. Prompts resolved by convention: `fields.{field_name}.prompt`.

### Backward Compatibility

Agents without `LOCALE` or multi-locale blocks continue to work. Compiler wraps single-language messages under `en` automatically.

### Compiler Validation

- `LOCALE` declared but no locale files found → error
- Missing keys in non-default locale → warning (falls back to defaultLocale)
- Default locale missing required keys → error
- Invalid locale codes (not BCP 47) → error
- All diagnostics as `ValidationDiagnostic` with severity and location

### Runtime Message Resolution

```typescript
export function resolveAgentMessage(
  messages: LocalizedMessages,
  defaultLocale: string,
  sessionLocale: string,
  key: string,
  params?: Record<string, string | number>,
): string {
  const localeMessages = messages[sessionLocale] ?? messages[defaultLocale] ?? messages['en'];
  const template = localeMessages?.[key] ?? key;
  return formatICU(template, params);
}
```

Fallback chain: `sessionLocale → agent's defaultLocale → 'en' → raw key`.

---

## Section 5: Migration Strategy

### Phase 0: Foundation (no user-visible changes)

- Create `packages/i18n/` with locale negotiation, ICU formatter, RTL utils, error catalog types
- Extract all current English strings into `en/studio.json` and `en/platform.json`
- Add `next-intl` to Studio with `[locale]` layout — `en` only
- Add locale middleware to Runtime — resolves to `en`
- All existing behavior unchanged

### Phase 1: Studio String Extraction

Migrate components from hardcoded strings to `useTranslations()`. English-only. Priority order:

1. Navigation, sidebar, header
2. Agent list, agent detail
3. Settings pages
4. Toast messages
5. Forms, validation, empty states
6. Tooltips, confirmations, modals

Each group is a self-contained PR.

### Phase 2: Runtime Error Catalog

Replace hardcoded error strings with `formatError()`:

1. Define typed error codes
2. Create `en/platform.json` entries
3. Migrate middleware (auth, RBAC, validation, SDK auth)
4. Migrate route handlers
5. All responses return `{ code, message }` structure

### Phase 3: CSS Logical Properties & RTL Prep

Parallel with Phases 1-2 (CSS-only):

1. Replace physical CSS properties with logical equivalents (`ml-*` → `ms-*`, `text-left` → `text-start`)
2. Add `rtl:rotate-180` to directional icons
3. Handle `space-x-*` with `rtl:space-x-reverse`
4. Verify layout with `dir="rtl"` — fix what breaks

### Phase 4: Compiler/IR Locale Support

1. Extend IR schema with `LocalizedMessages` and `AgentLocalizationIR`
2. Implement `locales/` convention resolution
3. Add `MESSAGES_FROM` override parsing
4. Add `_shared.json` merge logic
5. Backward compatibility wrapper for single-language agents
6. Compiler validation for locale completeness
7. Externalize gather field prompts
8. Update runtime executor to use `resolveAgentMessage()`

### Phase 5: First Non-English Locale

Prove the full pipeline end-to-end with one locale:

- Translate `studio.json` and `platform.json`
- Add locale to `SUPPORTED_LOCALES`
- Test Studio rendering, Runtime errors, agent responses
- Test RTL if locale is Arabic/Hebrew
- Add language switcher to Studio

### Phase 6: LLM Language Adaptation

1. NLU language detection sets/updates session locale
2. System prompt includes language directive for non-English locales
3. Agent `LOCALE` declaration gates supported languages
4. Unsupported language → respond in `defaultLocale`

### Rollout Principles

- English strings extracted first, translations added later
- Each phase is independently shippable
- No big bang — components migrate one PR at a time
- Feature flag for locale routing to preserve existing bookmarks

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish end-to-end internationalization across the ABL platform — shared i18n package, Studio (next-intl), Runtime locale middleware, and Compiler/IR multi-locale support.

**Architecture:** Shared `@agent-platform/i18n` package provides ICU MessageFormat, locale negotiation, RTL utils, and error catalog. Studio uses `next-intl` for React/Next.js integration. Runtime uses a lightweight custom layer for Express request-scoped locale resolution. Compiler/IR extends to support multi-locale agent messages.

**Tech Stack:** `intl-messageformat` (ICU), `next-intl` (Studio), TypeScript, Vitest

**Design doc:** `docs/plans/2026-02-21-i18n-end-to-end-design.md`

---

## Phase 0: Foundation (Shared i18n Package)

No user-visible changes. Creates `packages/i18n/` with all shared utilities.

### Task 1: Scaffold `packages/i18n` package

**Files:**

- Create: `packages/i18n/package.json`
- Create: `packages/i18n/tsconfig.json`
- Create: `packages/i18n/vitest.config.ts`

**Step 1: Create package.json**

```json
{
  "name": "@agent-platform/i18n",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Internationalization utilities and message catalogs for Agent Platform",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./locales/*": "./locales/*"
  },
  "files": ["dist", "locales"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "intl-messageformat": "^10.5.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  }
}
```

**Step 2: Create tsconfig.json**

Model after existing packages (e.g., `packages/shared/tsconfig.json`). Key settings:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/__tests__"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**Step 4: Install dependencies**

Run: `pnpm install`

**Step 5: Commit**

```bash
git add packages/i18n/package.json packages/i18n/tsconfig.json packages/i18n/vitest.config.ts
git commit -m "[ABLP-2] feat(shared): scaffold @agent-platform/i18n package"
```

---

### Task 2: Types module

**Files:**

- Create: `packages/i18n/src/types.ts`

**Step 1: Write types**

```typescript
/**
 * BCP 47 locale code: 'en', 'ar', 'de', 'pt-BR', 'zh-Hans', etc.
 */
export type Locale = string;

/**
 * Platform error code from the error catalog.
 */
export type ErrorCode = string;

/**
 * ICU MessageFormat parameters.
 */
export interface MessageParams {
  [key: string]: string | number | boolean;
}

/**
 * Structured error response returned by all API endpoints.
 */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Structured validation error response.
 */
export interface ValidationErrorResponse {
  code: 'VALIDATION_FAILED';
  errors: Array<{
    field: string;
    code: string;
    message: string;
  }>;
}
```

**Step 2: Verify typecheck**

Run: `cd packages/i18n && npx tsc --noEmit`
Expected: No errors (may warn about no index.ts yet — that's fine)

**Step 3: Commit**

```bash
git add packages/i18n/src/types.ts
git commit -m "[ABLP-2] feat(shared): add i18n type definitions"
```

---

### Task 3: Locale negotiation — tests first

**Files:**

- Create: `packages/i18n/src/__tests__/resolve-locale.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { resolveLocale, parseAcceptLanguage } from '../resolve-locale.js';

describe('resolveLocale', () => {
  it('returns exact match', () => {
    expect(resolveLocale(['ar'], ['ar', 'en', 'de'], 'en')).toBe('ar');
  });

  it('returns prefix match (ar-EG → ar)', () => {
    expect(resolveLocale(['ar-EG'], ['ar', 'en', 'de'], 'en')).toBe('ar');
  });

  it('returns first match in priority order', () => {
    expect(resolveLocale(['ja', 'de'], ['ar', 'en', 'de'], 'en')).toBe('de');
  });

  it('returns fallback when no match', () => {
    expect(resolveLocale(['ja'], ['en', 'de'], 'en')).toBe('en');
  });

  it('handles empty requested list', () => {
    expect(resolveLocale([], ['en', 'de'], 'en')).toBe('en');
  });

  it('is case-insensitive', () => {
    expect(resolveLocale(['AR-EG'], ['ar', 'en'], 'en')).toBe('ar');
  });

  it('handles pt-BR → pt fallback', () => {
    expect(resolveLocale(['pt-BR'], ['pt', 'en'], 'en')).toBe('pt');
  });
});

describe('parseAcceptLanguage', () => {
  it('parses simple header', () => {
    expect(parseAcceptLanguage('en-US,en;q=0.9,ar;q=0.8')).toEqual(['en-US', 'en', 'ar']);
  });

  it('sorts by quality descending', () => {
    expect(parseAcceptLanguage('ar;q=0.5,en;q=0.9,de;q=0.7')).toEqual(['en', 'de', 'ar']);
  });

  it('defaults quality to 1.0', () => {
    expect(parseAcceptLanguage('en,ar;q=0.5')).toEqual(['en', 'ar']);
  });

  it('returns empty array for empty string', () => {
    expect(parseAcceptLanguage('')).toEqual([]);
  });

  it('excludes q=0 entries', () => {
    expect(parseAcceptLanguage('en,ar;q=0')).toEqual(['en']);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/i18n && npx vitest run src/__tests__/resolve-locale.test.ts`
Expected: FAIL — module `../resolve-locale.js` not found

**Step 3: Commit failing tests**

```bash
git add packages/i18n/src/__tests__/resolve-locale.test.ts
git commit -m "[ABLP-2] test(shared): add locale negotiation tests"
```

---

### Task 4: Locale negotiation — implementation

**Files:**

- Create: `packages/i18n/src/resolve-locale.ts`

**Step 1: Implement resolve-locale.ts**

```typescript
import type { Locale } from './types.js';

/**
 * BCP 47 locale matching with fallback chain.
 * Supports exact match and language-prefix match (e.g., pt-BR → pt).
 */
export function resolveLocale(requested: Locale[], supported: Locale[], fallback: Locale): Locale {
  const supportedLower = new Map(supported.map((s) => [s.toLowerCase(), s]));

  for (const req of requested) {
    const reqLower = req.toLowerCase();

    // Exact match
    if (supportedLower.has(reqLower)) {
      return supportedLower.get(reqLower)!;
    }

    // Prefix match: ar-EG → ar
    const langPart = reqLower.split('-')[0];
    if (langPart && supportedLower.has(langPart)) {
      return supportedLower.get(langPart)!;
    }
  }

  return fallback;
}

/**
 * Parse Accept-Language header into locale array sorted by quality descending.
 */
export function parseAcceptLanguage(header: string): Locale[] {
  if (!header) return [];

  return header
    .split(',')
    .map((part) => {
      const [locale, q] = part.trim().split(';');
      const quality = q ? parseFloat(q.trim().replace('q=', '')) : 1;
      return [locale.trim(), quality] as const;
    })
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([locale]) => locale);
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/i18n && npx vitest run src/__tests__/resolve-locale.test.ts`
Expected: All 12 tests PASS

**Step 3: Commit**

```bash
git add packages/i18n/src/resolve-locale.ts
git commit -m "[ABLP-2] feat(shared): implement BCP 47 locale negotiation"
```

---

### Task 5: ICU message formatting — tests first

**Files:**

- Create: `packages/i18n/src/__tests__/format-message.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { formatMessage, resolveMessage } from '../format-message.js';

describe('formatMessage', () => {
  it('returns plain string unchanged', () => {
    expect(formatMessage('Hello world', undefined, 'en')).toBe('Hello world');
  });

  it('substitutes simple parameters', () => {
    expect(formatMessage('Project {projectId} was not found', { projectId: '123' }, 'en')).toBe(
      'Project 123 was not found',
    );
  });

  it('handles pluralization', () => {
    const tpl = '{count, plural, =0 {No agents} one {# agent} other {# agents}}';
    expect(formatMessage(tpl, { count: 0 }, 'en')).toBe('No agents');
    expect(formatMessage(tpl, { count: 1 }, 'en')).toBe('1 agent');
    expect(formatMessage(tpl, { count: 5 }, 'en')).toBe('5 agents');
  });

  it('handles select', () => {
    const tpl = '{status, select, active {Active} paused {Paused} other {Unknown}}';
    expect(formatMessage(tpl, { status: 'active' }, 'en')).toBe('Active');
    expect(formatMessage(tpl, { status: 'archived' }, 'en')).toBe('Unknown');
  });

  it('returns template on format error', () => {
    expect(formatMessage('{broken', undefined, 'en')).toBe('{broken');
  });
});

describe('resolveMessage', () => {
  const messages = {
    en: { greeting: 'Hello', farewell: 'Goodbye' },
    ar: { greeting: 'مرحبا' },
  };

  it('resolves from requested locale', () => {
    expect(resolveMessage(messages, 'en', 'ar', 'greeting')).toBe('مرحبا');
  });

  it('falls back to default locale', () => {
    expect(resolveMessage(messages, 'en', 'ar', 'farewell')).toBe('Goodbye');
  });

  it('falls back to en if default locale missing', () => {
    expect(resolveMessage(messages, 'de', 'ja', 'greeting')).toBe('Hello');
  });

  it('returns key itself as last resort', () => {
    expect(resolveMessage(messages, 'en', 'en', 'nonexistent')).toBe('nonexistent');
  });

  it('formats ICU params through fallback chain', () => {
    const msgs = {
      en: { err: 'Error in {field}' },
    };
    expect(resolveMessage(msgs, 'en', 'de', 'err', { field: 'name' })).toBe('Error in name');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/i18n && npx vitest run src/__tests__/format-message.test.ts`
Expected: FAIL — module not found

**Step 3: Commit failing tests**

```bash
git add packages/i18n/src/__tests__/format-message.test.ts
git commit -m "[ABLP-2] test(shared): add ICU message formatting tests"
```

---

### Task 6: ICU message formatting — implementation

**Files:**

- Create: `packages/i18n/src/format-message.ts`

**Step 1: Implement format-message.ts**

```typescript
import IntlMessageFormat from 'intl-messageformat';
import type { Locale, MessageParams } from './types.js';

/**
 * Format an ICU MessageFormat template with parameters.
 */
export function formatMessage(
  template: string,
  params?: MessageParams,
  locale: Locale = 'en',
): string {
  try {
    const formatter = new IntlMessageFormat(template, locale);
    return formatter.format(params ?? {}) as string;
  } catch {
    return template;
  }
}

/**
 * Resolve a message key from locale-keyed messages with fallback chain:
 * requestedLocale → defaultLocale → 'en' → key itself.
 */
export function resolveMessage(
  messages: Record<string, Record<string, string>>,
  defaultLocale: Locale,
  requestedLocale: Locale,
  key: string,
  params?: MessageParams,
): string {
  const template =
    messages[requestedLocale]?.[key] ??
    messages[defaultLocale]?.[key] ??
    messages['en']?.[key] ??
    key;

  return formatMessage(template, params, requestedLocale);
}
```

**Step 2: Run tests to verify they pass**

Run: `cd packages/i18n && npx vitest run src/__tests__/format-message.test.ts`
Expected: All 10 tests PASS

**Step 3: Commit**

```bash
git add packages/i18n/src/format-message.ts
git commit -m "[ABLP-2] feat(shared): implement ICU message formatting with fallback chain"
```

---

### Task 7: RTL utilities — tests first

**Files:**

- Create: `packages/i18n/src/__tests__/rtl.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { isRTL, getDirection, getTextAlign } from '../rtl.js';

describe('isRTL', () => {
  it.each(['ar', 'he', 'fa', 'ur'])('returns true for %s', (locale) => {
    expect(isRTL(locale)).toBe(true);
  });

  it.each(['en', 'de', 'fr', 'ja', 'zh'])('returns false for %s', (locale) => {
    expect(isRTL(locale)).toBe(false);
  });

  it('handles regional variants (ar-EG → true)', () => {
    expect(isRTL('ar-EG')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRTL('AR')).toBe(true);
  });
});

describe('getDirection', () => {
  it('returns rtl for Arabic', () => {
    expect(getDirection('ar')).toBe('rtl');
  });

  it('returns ltr for English', () => {
    expect(getDirection('en')).toBe('ltr');
  });
});

describe('getTextAlign', () => {
  it('returns right for Arabic', () => {
    expect(getTextAlign('ar')).toBe('right');
  });

  it('returns left for English', () => {
    expect(getTextAlign('en')).toBe('left');
  });
});
```

**Step 2: Run to verify failure**

Run: `cd packages/i18n && npx vitest run src/__tests__/rtl.test.ts`
Expected: FAIL

**Step 3: Commit**

```bash
git add packages/i18n/src/__tests__/rtl.test.ts
git commit -m "[ABLP-2] test(shared): add RTL utility tests"
```

---

### Task 8: RTL utilities — implementation

**Files:**

- Create: `packages/i18n/src/rtl.ts`

**Step 1: Implement rtl.ts**

```typescript
import type { Locale } from './types.js';

const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'yi']);

export function isRTL(locale: Locale): boolean {
  const base = locale.split('-')[0].toLowerCase();
  return RTL_LOCALES.has(base);
}

export function getDirection(locale: Locale): 'ltr' | 'rtl' {
  return isRTL(locale) ? 'rtl' : 'ltr';
}

export function getTextAlign(locale: Locale): 'left' | 'right' {
  return isRTL(locale) ? 'right' : 'left';
}
```

**Step 2: Run tests**

Run: `cd packages/i18n && npx vitest run src/__tests__/rtl.test.ts`
Expected: All 10 tests PASS

**Step 3: Commit**

```bash
git add packages/i18n/src/rtl.ts
git commit -m "[ABLP-2] feat(shared): implement RTL detection utilities"
```

---

### Task 9: Error catalog — tests first

**Files:**

- Create: `packages/i18n/src/__tests__/errors.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { ErrorCatalog, formatErrorSync } from '../errors.js';

describe('ErrorCatalog', () => {
  it('has AUTH_MISSING_HEADER', () => {
    expect(ErrorCatalog.AUTH_MISSING_HEADER).toBeDefined();
  });

  it('has all required error codes', () => {
    const required = [
      'AUTH_MISSING_HEADER',
      'AUTH_INVALID_KEY',
      'AUTH_INVALID_TOKEN',
      'TENANT_REQUIRED',
      'PROJECT_NOT_FOUND',
      'VALIDATION_FAILED',
      'INTERNAL_SERVER_ERROR',
    ];
    for (const code of required) {
      expect(ErrorCatalog).toHaveProperty(code);
    }
  });
});

describe('formatErrorSync', () => {
  it('returns code and message', () => {
    const result = formatErrorSync('AUTH_MISSING_HEADER');
    expect(result).toEqual({
      code: 'AUTH_MISSING_HEADER',
      message: 'Authentication header is required',
    });
  });

  it('substitutes ICU parameters', () => {
    const result = formatErrorSync('PROJECT_NOT_FOUND', { projectId: 'abc-123' });
    expect(result.code).toBe('PROJECT_NOT_FOUND');
    expect(result.message).toContain('abc-123');
  });

  it('returns code as message for unknown codes', () => {
    const result = formatErrorSync('UNKNOWN_CODE');
    expect(result).toEqual({
      code: 'UNKNOWN_CODE',
      message: 'UNKNOWN_CODE',
    });
  });
});
```

**Step 2: Run to verify failure**

Run: `cd packages/i18n && npx vitest run src/__tests__/errors.test.ts`
Expected: FAIL

**Step 3: Commit**

```bash
git add packages/i18n/src/__tests__/errors.test.ts
git commit -m "[ABLP-2] test(shared): add error catalog tests"
```

---

### Task 10: Error catalog — implementation

**Files:**

- Create: `packages/i18n/src/errors.ts`

**Step 1: Implement errors.ts**

```typescript
import type { ErrorCode, ErrorResponse, MessageParams } from './types.js';
import { formatMessage } from './format-message.js';

/**
 * Platform error catalog. English source-of-truth templates.
 * Each value is an ICU MessageFormat template.
 */
export const ErrorCatalog = {
  // Authentication
  AUTH_MISSING_HEADER: 'Authentication header is required',
  AUTH_INVALID_KEY: 'The API key is invalid or expired',
  AUTH_INVALID_TOKEN: 'The authentication token is invalid or expired',
  AUTH_ORIGIN_BLOCKED: 'Requests from {origin} are not allowed',
  AUTH_INSUFFICIENT_PERMISSIONS: 'You do not have permission to access this resource',

  // Tenant & Project
  TENANT_REQUIRED: 'A tenant context is required for this operation',
  PROJECT_NOT_FOUND: 'Project {projectId} was not found',
  PROJECT_NOT_ACCESSIBLE: 'You do not have access to project {projectId}',

  // Validation
  VALIDATION_FAILED: 'Validation failed',
  FIELD_REQUIRED: '{field} is required',
  FIELD_INVALID_FORMAT: '{field} has an invalid format',

  // Runtime
  INTERNAL_SERVER_ERROR: 'An internal server error occurred',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable',
  SESSION_NOT_FOUND: 'Session {sessionId} was not found',

  // Compilation
  COMPILATION_FAILED: 'ABL compilation failed',
} as const satisfies Record<string, string>;

export type ErrorCodeType = keyof typeof ErrorCatalog;

/**
 * Synchronous error formatting using English catalog.
 * For use in middleware where async locale file loading is impractical.
 */
export function formatErrorSync(code: ErrorCode, params?: MessageParams): ErrorResponse {
  const template = (ErrorCatalog as Record<string, string>)[code] ?? code;
  return {
    code,
    message: formatMessage(template, params, 'en'),
  };
}
```

**Step 2: Run tests**

Run: `cd packages/i18n && npx vitest run src/__tests__/errors.test.ts`
Expected: All 5 tests PASS

**Step 3: Commit**

```bash
git add packages/i18n/src/errors.ts
git commit -m "[ABLP-2] feat(shared): implement typed error catalog with ICU formatting"
```

---

### Task 11: Locale utility helpers

**Files:**

- Create: `packages/i18n/src/utils.ts`

**Step 1: Implement utils.ts**

```typescript
import type { Locale } from './types.js';

/** Native language names for locale selector UIs. */
export const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
  ar: 'العربية',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  he: 'עברית',
  hi: 'हिन्दी',
  ja: '日本語',
  ko: '한국어',
  pt: 'Português',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  zh: '中文',
};

/** Get native language name for a locale code. */
export function localeToLanguageName(locale: Locale): string {
  return LOCALE_NAMES[locale] ?? LOCALE_NAMES[locale.split('-')[0]] ?? locale;
}

/** Extract language part from a locale code (before the hyphen). */
export function getLanguageCode(locale: Locale): string {
  return locale.split('-')[0];
}
```

**Step 2: Commit**

```bash
git add packages/i18n/src/utils.ts
git commit -m "[ABLP-2] feat(shared): add locale name mapping and utility helpers"
```

---

### Task 12: English locale JSON files

**Files:**

- Create: `packages/i18n/locales/en/studio.json`
- Create: `packages/i18n/locales/en/platform.json`

**Step 1: Create en/studio.json**

Start with a representative set of keys. These will grow as Phase 1 extracts strings from components.

```json
{
  "common": {
    "cancel": "Cancel",
    "save": "Save",
    "delete": "Delete",
    "create": "Create",
    "edit": "Edit",
    "back": "Back",
    "loading": "Loading\u2026",
    "search": "Search",
    "confirm": "Confirm",
    "close": "Close"
  },
  "nav": {
    "dashboard": "Dashboard",
    "agents": "Agents",
    "tools": "Tools",
    "settings": "Settings",
    "projects": "Projects"
  },
  "agents": {
    "create": "Create Agent",
    "delete_confirm": "Are you sure you want to delete this agent?",
    "list_empty": "No agents yet. Create your first agent to get started.",
    "updated_ago": "Updated {time}"
  },
  "settings": {
    "title": "Settings",
    "api_keys": {
      "title": "API Keys",
      "create": "Create API Key",
      "created": "API key created",
      "deleted": "Key deleted",
      "create_failed": "Failed to create key",
      "delete_failed": "Failed to delete key",
      "load_failed": "Failed to load API keys"
    },
    "locale": {
      "title": "Language",
      "description": "Select your preferred language"
    }
  }
}
```

**Step 2: Create en/platform.json**

```json
{
  "errors": {
    "AUTH_MISSING_HEADER": "Authentication header is required",
    "AUTH_INVALID_KEY": "The API key is invalid or expired",
    "AUTH_INVALID_TOKEN": "The authentication token is invalid or expired",
    "AUTH_ORIGIN_BLOCKED": "Requests from {origin} are not allowed",
    "AUTH_INSUFFICIENT_PERMISSIONS": "You do not have permission to access this resource",
    "TENANT_REQUIRED": "A tenant context is required for this operation",
    "PROJECT_NOT_FOUND": "Project {projectId} was not found",
    "PROJECT_NOT_ACCESSIBLE": "You do not have access to project {projectId}",
    "VALIDATION_FAILED": "Validation failed",
    "INTERNAL_SERVER_ERROR": "An internal server error occurred",
    "SERVICE_UNAVAILABLE": "The service is temporarily unavailable",
    "SESSION_NOT_FOUND": "Session {sessionId} was not found",
    "COMPILATION_FAILED": "ABL compilation failed"
  },
  "validation": {
    "FIELD_REQUIRED": "{field} is required",
    "FIELD_INVALID_FORMAT": "{field} has an invalid format"
  }
}
```

**Step 3: Commit**

```bash
git add packages/i18n/locales/en/studio.json packages/i18n/locales/en/platform.json
git commit -m "[ABLP-2] feat(shared): add English locale JSON files for studio and platform"
```

---

### Task 13: Package barrel export and build verification

**Files:**

- Create: `packages/i18n/src/index.ts`

**Step 1: Create index.ts**

```typescript
// Types
export type {
  Locale,
  ErrorCode,
  MessageParams,
  ErrorResponse,
  ValidationErrorResponse,
} from './types.js';

// Locale resolution
export { resolveLocale, parseAcceptLanguage } from './resolve-locale.js';

// Message formatting
export { formatMessage, resolveMessage } from './format-message.js';

// Error catalog
export { ErrorCatalog, formatErrorSync } from './errors.js';
export type { ErrorCodeType } from './errors.js';

// RTL utilities
export { isRTL, getDirection, getTextAlign } from './rtl.js';

// Helpers
export { LOCALE_NAMES, localeToLanguageName, getLanguageCode } from './utils.js';
```

**Step 2: Build the package**

Run: `cd packages/i18n && npx tsc`
Expected: Compiles successfully, `dist/` directory created with `.js` and `.d.ts` files

**Step 3: Run all tests**

Run: `cd packages/i18n && npx vitest run`
Expected: All tests pass (resolve-locale, format-message, rtl, errors)

**Step 4: Commit**

```bash
git add packages/i18n/src/index.ts
git commit -m "[ABLP-2] feat(shared): add barrel export for @agent-platform/i18n"
```

---

### Task 14: Wire into monorepo

**Files:**

- Modify: `apps/studio/package.json` — add `@agent-platform/i18n` dependency
- Modify: `apps/runtime/package.json` — add `@agent-platform/i18n` dependency
- Modify: `apps/studio/next.config.mjs` — add to `transpilePackages`

**Step 1: Add workspace dependency to Studio**

In `apps/studio/package.json`, add to `dependencies`:

```json
"@agent-platform/i18n": "workspace:*"
```

**Step 2: Add workspace dependency to Runtime**

In `apps/runtime/package.json`, add to `dependencies`:

```json
"@agent-platform/i18n": "workspace:*"
```

**Step 3: Add to Studio transpilePackages**

In `apps/studio/next.config.mjs`, add `'@agent-platform/i18n'` to the `transpilePackages` array.

**Step 4: Install and verify build**

Run: `pnpm install && pnpm build`
Expected: Full monorepo builds without errors

**Step 5: Commit**

```bash
git add apps/studio/package.json apps/runtime/package.json apps/studio/next.config.mjs pnpm-lock.yaml
git commit -m "[ABLP-2] feat(shared): wire @agent-platform/i18n into studio and runtime"
```

---

## Phase 1: Studio String Extraction

Migrate Studio components from hardcoded strings to `next-intl`. English-only — no new locales yet.

### Task 15: Install next-intl and configure

**Files:**

- Modify: `apps/studio/package.json` — add `next-intl`
- Create: `apps/studio/src/i18n/request.ts`
- Modify: `apps/studio/src/app/layout.tsx` — wrap with `NextIntlClientProvider`

**Step 1: Install next-intl**

Run: `cd apps/studio && pnpm add next-intl`

**Step 2: Create i18n request config**

Create `apps/studio/src/i18n/request.ts`:

```typescript
import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  const locale = 'en'; // Phase 0: single locale, no routing yet

  return {
    locale,
    messages: {
      ...(await import(`@agent-platform/i18n/locales/${locale}/studio.json`)),
      ...(await import(`@agent-platform/i18n/locales/${locale}/platform.json`)),
    },
  };
});
```

**Step 3: Update root layout**

Wrap children in `NextIntlClientProvider` with messages loaded server-side. Read `apps/studio/src/app/layout.tsx` first to understand current structure. Add:

```typescript
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
```

And wrap children:

```tsx
const messages = await getMessages();
<NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
```

Set `lang` and `dir` on `<html>` using `getDirection('en')`.

**Step 4: Add next-intl plugin to next.config.mjs**

```javascript
import createNextIntlPlugin from 'next-intl/plugin';
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
export default withNextIntl(nextConfig);
```

**Step 5: Verify Studio starts**

Run: `cd apps/studio && pnpm dev`
Expected: Studio starts without errors, renders same as before

**Step 6: Commit**

```bash
git add apps/studio/
git commit -m "[ABLP-2] feat(studio): configure next-intl with English-only locale"
```

---

### Task 16: Migrate navigation strings

**Files:**

- Modify: Navigation/sidebar components (read first to find exact paths)
- Modify: `packages/i18n/locales/en/studio.json` — add any missing nav keys

**Step 1: Identify navigation components**

Search for sidebar/nav components in `apps/studio/src/components/`. Read each file, identify hardcoded strings.

**Step 2: Replace hardcoded strings with `useTranslations()`**

Pattern:

```tsx
// Before
<span>Agents</span>;

// After
import { useTranslations } from 'next-intl';
const t = useTranslations('nav');
<span>{t('agents')}</span>;
```

**Step 3: Add missing keys to studio.json**

Any strings not already in `en/studio.json` get added.

**Step 4: Verify visually**

Run dev server, confirm navigation renders identically.

**Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): extract navigation strings to i18n"
```

---

### Tasks 17-21: Remaining Studio string extraction

Follow the same pattern as Task 16 for each group:

- **Task 17**: Agent list and agent detail pages — keys under `agents.*`
- **Task 18**: Settings pages (API keys, model config) — keys under `settings.*`
- **Task 19**: Toast messages — search for `toast.success()`, `toast.error()` across all files
- **Task 20**: Forms, validation messages, empty states — keys under `forms.*`, `common.*`
- **Task 21**: Tooltips, confirmation dialogs, modals — keys under `dialogs.*`, `ui.*`

Each task follows: identify components → replace strings → add keys → verify → commit.

---

### Task 22: Replace custom date/number formatting

**Files:**

- Modify: Components using custom `formatRelativeTime()` (search for this function)
- Modify: Components using hardcoded `$` currency formatting

**Step 1: Find and list all custom formatting**

Search: `formatRelativeTime`, `toLocaleDateString`, `toFixed`, `$${` across Studio components.

**Step 2: Replace with `useFormatter()` from next-intl**

```tsx
import { useFormatter } from 'next-intl';

const format = useFormatter();
format.relativeTime(date);
format.number(cost, { style: 'currency', currency: 'USD' });
```

**Step 3: Remove duplicate `formatRelativeTime` functions**

These exist in multiple component files — delete them all once replaced.

**Step 4: Verify formatting renders correctly**

**Step 5: Commit**

```bash
git commit -m "[ABLP-2] feat(studio): replace custom date/number formatting with next-intl useFormatter"
```

---

## Phase 2: Runtime Error Catalog

Replace all hardcoded runtime error strings with structured error responses.

### Task 23: Create locale middleware

**Files:**

- Create: `apps/runtime/src/middleware/locale.ts`
- Create: `apps/runtime/src/__tests__/locale-middleware.test.ts`

**Step 1: Write test**

```typescript
import { describe, it, expect } from 'vitest';
// Test that middleware sets req.locale based on headers

describe('localeMiddleware', () => {
  it('resolves from X-Locale header', () => {
    /* ... */
  });
  it('resolves from Accept-Language header', () => {
    /* ... */
  });
  it('falls back to en', () => {
    /* ... */
  });
});
```

**Step 2: Implement middleware**

```typescript
import type { Request, Response, NextFunction } from 'express';
import { resolveLocale, parseAcceptLanguage, type Locale } from '@agent-platform/i18n';

const SUPPORTED_LOCALES: Locale[] = ['en'];
const DEFAULT_LOCALE: Locale = 'en';

export function localeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const requested: Locale[] = [];

  const xLocale = req.headers['x-locale'];
  if (typeof xLocale === 'string') requested.push(xLocale);

  const acceptLang = req.headers['accept-language'];
  if (typeof acceptLang === 'string') requested.push(...parseAcceptLanguage(acceptLang));

  (req as any).locale = resolveLocale(requested, SUPPORTED_LOCALES, DEFAULT_LOCALE);
  next();
}
```

**Step 3: Mount in server.ts**

Read `apps/runtime/src/server.ts`, add `app.use(localeMiddleware)` after auth middleware.

**Step 4: Run tests, commit**

```bash
git commit -m "[ABLP-2] feat(runtime): add locale resolution middleware"
```

---

### Task 24: Migrate auth middleware errors

**Files:**

- Modify: `apps/runtime/src/middleware/sdk-auth.ts`
- Modify: `apps/runtime/src/middleware/rbac.ts`
- Modify: `apps/runtime/src/middleware/auth.ts` (if it has inline error strings)

**Step 1: Read each middleware file**

Identify all inline error strings.

**Step 2: Replace with formatErrorSync()**

```typescript
import { formatErrorSync } from '@agent-platform/i18n';

// Before
res.status(401).json({ error: 'Missing X-Public-Key header' });

// After
res.status(401).json(formatErrorSync('AUTH_MISSING_HEADER'));
```

**Step 3: Run existing tests to verify no regressions**

Run: `cd apps/runtime && pnpm test`

Note: Existing tests may assert on the old `{ error: '...' }` format. Update test assertions to match `{ code: '...', message: '...' }`.

**Step 4: Commit**

```bash
git commit -m "[ABLP-2] feat(runtime): migrate auth middleware to structured error responses"
```

---

### Tasks 25-26: Remaining runtime error migration

- **Task 25**: Migrate route handler errors (projects, agents, sessions, deployments)
- **Task 26**: Migrate Zod validation error wrapping — create `formatValidationErrors()` helper

---

## Phase 3: CSS Logical Properties & RTL Prep

Can run in parallel with Phases 1-2. Pure CSS changes.

### Task 27: Audit physical CSS properties

**Step 1: Search for physical properties**

Search Studio components for: `ml-`, `mr-`, `pl-`, `pr-`, `text-left`, `text-right`, `float-left`, `float-right`, `left-`, `right-`.

**Step 2: Create replacement map**

| Find         | Replace      |
| ------------ | ------------ |
| `ml-`        | `ms-`        |
| `mr-`        | `me-`        |
| `pl-`        | `ps-`        |
| `pr-`        | `pe-`        |
| `text-left`  | `text-start` |
| `text-right` | `text-end`   |

**Step 3: Apply replacements file by file**

Do NOT do a blanket find-and-replace. Review each usage — some may be intentionally physical (e.g., absolute positioning of fixed UI elements).

**Step 4: Verify visually with LTR**

**Step 5: Commit per batch of files**

---

### Task 28: Add RTL icon rotation

**Step 1: Find directional icons**

Search for `ChevronRight`, `ChevronLeft`, `ArrowRight`, `ArrowLeft` in Studio components.

**Step 2: Add `rtl:rotate-180` class**

```tsx
<ChevronRight className="w-4 h-4 rtl:rotate-180" />
```

**Step 3: Commit**

---

### Task 29: Verify RTL layout

**Step 1: Temporarily set `dir="rtl"` in root layout**

**Step 2: Start dev server, screenshot every page**

**Step 3: Fix any layout breakages**

**Step 4: Revert `dir` back to dynamic (based on locale)**

**Step 5: Commit fixes**

---

## Phase 4: Compiler/IR Locale Support

### Task 30: Extend IR schema

**Files:**

- Modify: `packages/compiler/src/platform/ir/schema.ts`

**Step 1: Add `AgentLocalizationIR` and `LocalizedMessages` types**

```typescript
export interface AgentLocalizationIR {
  supportedLocales: string[];
  defaultLocale: string;
}

export type LocalizedMessages = Record<string, AgentMessages>;
```

**Step 2: Update `AgentIR` to use new types**

Replace `messages: AgentMessages` with `messages: LocalizedMessages` and add `localization: AgentLocalizationIR`.

**Step 3: Update all compiler code that reads/writes `agentIR.messages`**

This is the ripple — search for `.messages.` usage across the compiler. Each access needs to be locale-aware.

**Step 4: Add backward compat normalization**

Agents without locale declaration get wrapped: `{ en: existingMessages }`.

**Step 5: Build and run compiler tests**

Run: `pnpm build && cd packages/compiler && pnpm test`

**Step 6: Commit**

---

### Task 31: DSL locale parsing

**Files:**

- Modify: DSL parser to recognize `LOCALE:`, `DEFAULT_LOCALE:`, `MESSAGES_FROM:` keywords
- Create: Locale file resolution logic

**Step 1: Add parsing for new keywords in the DSL parser**

Read the parser code first to understand the current parsing pattern.

**Step 2: Implement `locales/` convention resolution**

Read locale JSON files from `locales/{locale}/{agent_name}.json` and merge with `_shared.json`.

**Step 3: Add compiler validation diagnostics**

**Step 4: Test with sample ABL files**

**Step 5: Commit**

---

### Task 32: Runtime message resolution

**Files:**

- Create: `packages/i18n/src/resolve-agent-message.ts`
- Modify: Runtime executor to use `resolveAgentMessage()` instead of direct `agentIR.messages` access

Uses the `resolveMessage()` function already built in Task 6 — this is a thin wrapper for the agent-specific message shape.

---

## Phase 5: First Non-English Locale (Arabic)

### Task 33: Create Arabic locale files

**Files:**

- Create: `packages/i18n/locales/ar/studio.json`
- Create: `packages/i18n/locales/ar/platform.json`

Translate all keys from the English files. Use professional translation or native speaker review.

---

### Task 34: Enable locale routing in Studio

**Files:**

- Modify: `apps/studio/src/middleware.ts` — add locale detection and redirect
- Create: `apps/studio/src/app/[locale]/layout.tsx`
- Move: pages under `[locale]/` route segment

This is the structural change to the Studio app router. Feature-flag it so existing URLs keep working during rollout.

---

### Task 35: Language switcher component

**Files:**

- Create: `apps/studio/src/components/ui/LanguageSwitcher.tsx`
- Modify: Settings page or header to include the switcher

---

### Task 36: End-to-end RTL verification

Full visual QA pass with Arabic locale active. Fix layout issues.

---

## Phase 6: LLM Language Adaptation

### Task 37: Session locale lifecycle

**Files:**

- Modify: Session creation to accept and store `locale`
- Modify: Session types to include `locale` field

---

### Task 38: Language directive in system prompt

**Files:**

- Modify: Runtime executor system prompt builder

Add locale-aware language directive:

```typescript
if (sessionLocale !== 'en') {
  prompt += `\nRespond in ${localeToLanguageName(sessionLocale)}.`;
}
```

---

### Task 39: NLU language detection → session locale

**Files:**

- Modify: Message processing pipeline to update session locale when NLU detects language change
- Only update if the agent's `localization.supportedLocales` includes the detected language

---

### Task 40: Gather prompt locale resolution

**Files:**

- Modify: Gather service to resolve field prompts from `LocalizedMessages` using session locale

---

## Appendix: Key Reference Files

| Purpose              | Path                                          |
| -------------------- | --------------------------------------------- |
| Root layout          | `apps/studio/src/app/layout.tsx`              |
| Studio middleware    | `apps/studio/src/middleware.ts`               |
| Next.js config       | `apps/studio/next.config.mjs`                 |
| Tailwind config      | `apps/studio/tailwind.config.js`              |
| Runtime server setup | `apps/runtime/src/server.ts`                  |
| SDK auth middleware  | `apps/runtime/src/middleware/sdk-auth.ts`     |
| RBAC middleware      | `apps/runtime/src/middleware/rbac.ts`         |
| IR schema            | `packages/compiler/src/platform/ir/schema.ts` |
| Shared package       | `packages/shared/package.json`                |
| CSS variables        | `apps/studio/src/app/globals.css`             |
| Animation presets    | `apps/studio/src/lib/animation.ts`            |
| Workspace config     | `pnpm-workspace.yaml`                         |
| Build pipeline       | `turbo.json`                                  |
