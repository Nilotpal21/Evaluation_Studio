---
name: i18n-guide
description: Use when adding user-facing strings, error messages, UI labels, validation messages, or working on internationalization, localization, RTL support, or ICU MessageFormat templates.
---

# Internationalization (i18n)

All user-facing text — error messages, UI labels, validation messages — flows through `@agent-platform/i18n`. Never hardcode user-facing strings in components, middleware, or route handlers.

## Architecture

- **Package**: `packages/i18n/` — lightweight, provider-agnostic. Exports types, formatters, locale utilities.
- **Error Catalog**: `packages/i18n/src/errors.ts` — single source-of-truth for 50+ platform error codes with English templates. Accessed synchronously via `formatErrorSync(code, params)`.
- **Locale Files**: `packages/i18n/locales/{locale}/{namespace}.json` — currently `en/platform.json` (error/validation messages) and `en/studio.json` (UI strings, ~180KB, 70+ namespaces).
- **Studio Integration**: `next-intl` with webpack alias `@i18n-locales` pointing to `packages/i18n/locales/`. Server-side loader in `apps/studio/src/i18n/request.ts`. Client components use `useTranslations('namespace')`.
- **RTL Support**: `isRTL(locale)`, `getDirection(locale)`, `getTextAlign(locale)` for Arabic, Hebrew, Farsi, Urdu, Yiddish. Root layout sets `<html dir={direction}>`.

## Rules

- **Error messages use the ErrorCatalog, not inline strings.** Define new error codes in `ErrorCatalog` with ICU MessageFormat templates. Use `formatErrorSync(code, params)` in middleware and route handlers.
- **UI strings go in `locales/en/studio.json`, not in components.** Use `useTranslations('namespace')` in React components. Organize by feature: `auth.login.title`, `agents.detail.save_button`.
- **ICU MessageFormat for all interpolation.** Use `{paramName}` placeholders — never string concatenation or template literals for user-facing text. Supports pluralization (`{count, plural, one {# item} other {# items}}`) and select (`{status, select, active {Active} other {Unknown}}`).
- **BCP 47 locale codes.** Use standard codes: `en`, `ar`, `de`, `pt-BR`, `zh-Hans`. Resolve with `resolveLocale(requested, supported, fallback)`. Parse `Accept-Language` headers with `parseAcceptLanguage(header)`.
- **Fallback chain**: Requested locale → default locale (`en`) → key itself. Never return an empty string or crash on missing translation.
- **Error codes are SCREAMING_SNAKE_CASE**, UI keys are `snake_case`. Namespace with dots: `auth.login.title`, `platform.errors.AUTH_MISSING_HEADER`.
- **Synchronous in middleware, async in components.** Middleware uses `formatErrorSync()` (no file I/O). Studio components use `useTranslations()` (messages loaded at request time via `next-intl`).
- **No locale-specific logic in engine code.** The runtime engine is locale-agnostic. Locale resolution happens at the edge (Studio layout, API middleware). Agent-defined messages come from the IR, not from the i18n package.

## Component i18n Patterns _(learned from KB nav i18n sweep — 29 files, 554 keys)_

### Module-Level Constants with Labels

Constants defined at module scope that contain English labels cannot use `t()` (React context not available). Move them inside the component body as `useMemo`:

```tsx
// BEFORE (module scope — can't use t())
const OPTIONS = [
  { label: 'Foo', value: 'foo' },
  { label: 'Bar', value: 'bar' },
];

// AFTER (inside component — t() available)
const OPTIONS = useMemo(
  () => [
    { label: t('option_foo'), value: 'foo' },
    { label: t('option_bar'), value: 'bar' },
  ],
  [t],
);
```

### Sub-Component i18n Threading

Two patterns, choose based on component relationship:

1. **Private list-item sub-components** (e.g., `JobRow`, `PageRow`, `PreferenceRow`): Receive `t` as a prop to avoid redundant `useTranslations` calls in list iterations.
2. **Standalone sub-components** (e.g., `StageCard`, `SectionHeader`, ReactFlow node types): Call `useTranslations` independently — they have their own lifecycle.

### window.confirm/alert Replacement

Replace browser-native dialogs with state-driven ConfirmDialog:

```tsx
// State for confirm target
const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

// In handler: setConfirmTarget(id);
// In JSX:
<ConfirmDialog
  open={!!confirmTarget}
  onClose={() => setConfirmTarget(null)}
  onConfirm={() => {
    doAction(confirmTarget);
    setConfirmTarget(null);
  }}
  title={t('confirm_title')}
  description={t('confirm_description')}
/>;
```

For `window.alert`, replace with `toast.error()` or `toast.success()` from `sonner`.

### Locale Fix

Replace hardcoded locales with browser default:

```tsx
// BEFORE
new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// AFTER — respects browser locale
new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
```

### Parallel i18n Work (Fragment-then-Merge)

When multiple agents work on i18n in parallel, avoid studio.json contention:

1. Each agent writes keys to a separate fragment file (`docs/specs/i18n-keys/t<N>.json`). Create the directory if it does not exist.
2. A final sequential merge step inserts all fragments into `studio.json`
3. Run `npx prettier --write` on studio.json after merge

## Key Files

| File                                     | Purpose                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `packages/i18n/src/errors.ts`            | ErrorCatalog — all platform error codes and English templates |
| `packages/i18n/src/format-message.ts`    | ICU MessageFormat formatter with locale support               |
| `packages/i18n/src/resolve-locale.ts`    | BCP 47 locale matching and Accept-Language parsing            |
| `packages/i18n/src/rtl.ts`               | RTL detection and directionality utilities                    |
| `packages/i18n/locales/en/platform.json` | Platform error/validation messages                            |
| `packages/i18n/locales/en/studio.json`   | Studio UI strings (70+ namespaces)                            |
| `apps/studio/src/i18n/request.ts`        | next-intl request-time message loader                         |
| `apps/studio/src/app/layout.tsx`         | Root layout with `lang` and `dir` attributes                  |
