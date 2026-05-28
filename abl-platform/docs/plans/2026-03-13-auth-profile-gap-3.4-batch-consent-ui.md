# GAP-3.4: Multi-Tool Batch Consent UI — Implementation Plan

> **Parent design:** `docs/plans/2026-03-11-auth-profile-design.md` (Section 6, 7.4)
> **UX review ref:** `docs/archive/auth-profile-reviews/2026-03-11-auth-profile-review-ux.md` (GAP-3.4)
> **Date:** 2026-03-13

---

## Dependencies

This plan depends on the following:

1. **GAP-3.1 (Preflight Consent Modal)** — Defines the `AuthGate` session state, `auth_required` WS event, and consent satisfaction endpoint (`POST /api/runtime/sessions/:sessionId/consent`).
2. **GAP-3.2 Phase 1-2 (Compiler IR + Runtime)** — Provides `AuthRequirementIR` types and the runtime preflight check that produces the `auth_required` payload.

Plans that depend on this plan: None (this is a leaf UI plan).

**Implementation sequence:** This plan is Sprint N+2, after GAP-3.2 Phase 1 (Sprint N) and GAP-3.1 runtime (Sprint N+1).

---

## Problem Statement

When an agent project uses 5+ connectors requiring end-user OAuth consent (`connection: per_user, consent: preflight`), the current design shows only flat inline buttons ("[Authorize Gmail] [Authorize Calendar]"). This does not scale. There is no batch consent design, no progress tracking, no error recovery per-connector, and no consideration of the embedded widget viewport.

This plan covers the complete batch consent UI for both Studio test panel and deployed web chat widget contexts.

---

## 1. Architecture Overview

### 1.1 Data Flow

```
Runtime session start
  -> returns { type: "auth_required", pending[], satisfied[] } via WS event
  -> Client renders BatchConsentUI
  -> User authorizes connectors one-by-one or via "Connect All"
  -> Each success: POST /api/projects/:pid/auth-profiles/oauth/callback (OAuth code exchange)
  -> Client calls: POST /api/runtime/sessions/:sessionId/consent (canonical satisfaction endpoint from GAP-3.1)
  -> Server sends auth_gate_updated / auth_gate_satisfied WS events
  -> When auth_gate_satisfied received, session proceeds
```

> **Note:** This plan uses the canonical satisfaction endpoint and WS events defined in GAP-3.1 Section 9.2. No separate polling endpoint is needed — the `auth_gate_updated` WS events provide real-time updates. For non-WebSocket channels, the standalone preflight page polls `GET /api/auth/preflight/:token/status` (also defined in GAP-3.1).

### 1.2 Component Tree

```
<BatchConsentGate>                          // Top-level gate: renders children or consent UI
  <BatchConsentPanel>                       // The consent list (used in both contexts)
    <ConsentHeader />                       // Title, progress bar, "Connect All" button
    <ConsentConnectorList>                  // Scrollable list
      <ConsentConnectorRow />              // One per connector
        <ConnectorScopeDetails />          // Expandable scope list
    </ConsentConnectorList>
    <ConsentFooter />                       // Skip (if allowed), Continue button
  </BatchConsentPanel>
  <AuthProfileOAuthDialog />                // Reused — handles single OAuth popup flow
</BatchConsentGate>
```

### 1.3 Rendering Contexts

| Context                   | Container           | Layout                                                  | Max Width              |
| ------------------------- | ------------------- | ------------------------------------------------------- | ---------------------- |
| Studio test panel         | `ChatPanel` wrapper | Full-height panel replacing chat, centered content      | 560px                  |
| Deployed web chat widget  | Widget iframe root  | Full-width within widget viewport (typically 375-420px) | 100% with 16px padding |
| Studio slide-over (debug) | `ChatSlideOver`     | Same as test panel but narrower                         | 480px                  |

---

## 2. Consent Connector Row

Each connector in the `pending[]` or `satisfied[]` array renders as a row.

### 2.1 Row Layout

```
+------------------------------------------------------------------+
| [ConnectorIcon]  Connector Name              [Status Button]      |
|                  2 permissions requested       [Expand chevron]   |
+------------------------------------------------------------------+
  (expanded)
  | * Read emails and attachments                                  |
  | * Send emails on your behalf                                   |
  +----------------------------------------------------------------+
```

### 2.2 Row States

| State           | Visual Treatment                    | Button                                                  | Design Token                    |
| --------------- | ----------------------------------- | ------------------------------------------------------- | ------------------------------- |
| **Connected**   | Green left border, green check icon | "Connected" text (no button)                            | `--success`, `--success-subtle` |
| **Pending**     | Default border, amber dot indicator | "Authorize" primary button                              | `--warning`, `--accent`         |
| **Authorizing** | Default border, spinner             | "Authorizing..." disabled button with `Loader2` spinner | `--info`                        |
| **Failed**      | Red left border, red X icon         | "Retry" error-styled button                             | `--error`, `--error-subtle`     |
| **Skipped**     | Gray border, gray dash icon         | "Skipped" muted text                                    | `--foreground-subtle`           |

### 2.3 Connector Icon Resolution

The connector icon comes from the `authRequirements[].connector` field. The component maintains a static icon registry mapping connector names to SVG icons or Lucide fallbacks:

```typescript
const CONNECTOR_ICONS: Record<string, React.ElementType> = {
  gmail: MailIcon,
  'google-calendar': CalendarIcon,
  slack: MessageSquareIcon,
  salesforce: BuildingIcon,
  hubspot: UsersIcon,
  // ... extensible registry
  _default: PlugIcon, // fallback for unknown connectors
};
```

Icons render at 20x20px inside a 36x36px rounded container with `bg-background-muted`.

### 2.4 Scope Display

Each connector row shows a collapsed summary ("N permissions requested") that expands to show individual scopes with human-readable labels.

**Scope label resolution priority:**

1. `authRequirements[].scopeDescriptions` (if the compiler provides human-readable descriptions)
2. Static mapping from scope string to description (e.g., `gmail.send` -> "Send emails on your behalf")
3. Raw scope string as fallback (e.g., `https://www.googleapis.com/auth/gmail.send`)

The expand/collapse uses the existing `collapse-content` CSS utility class with `grid-template-rows` animation.

---

## 3. Consent Header

### 3.1 Layout

```
+------------------------------------------------------------------+
| [ShieldCheck icon]  Connect Your Accounts                        |
|                                                                   |
| This agent needs access to your accounts to function properly.    |
| Authorize each service below to continue.                        |
|                                                                   |
| [=========>          ] 2 of 5 connected                          |
|                                                                   |
| [Connect All Remaining]                                          |
+------------------------------------------------------------------+
```

### 3.2 Progress Indicator

A horizontal progress bar showing `N of M connected`:

- **Track:** `bg-background-muted`, height 6px, full width, `border-radius: var(--radius-full)`
- **Fill:** `bg-success` with custom `transition: width 300ms var(--ease-spring)` (note: the existing `score-bar-fill` utility uses `1s` duration; this component uses a faster `300ms` for snappier feedback)
- **Label:** Text below bar: "{connected} of {total} connected" in `text-sm text-muted`
- **Segments:** Fill width = `(connected / total) * 100%`

When all connectors are connected, the progress bar fill turns fully green and the label reads "All accounts connected" in `text-success`.

### 3.3 "Connect All" Button

- **Appearance:** Full-width secondary button with `Zap` icon, label "Connect All Remaining"
- **Behavior:** Initiates sequential OAuth popup flow for all connectors in `pending` state
- **Disabled when:** No pending connectors remain, or a flow is already in progress
- **Hidden when:** Only 1 pending connector remains (single authorize button is sufficient)

---

## 4. Sequential "Connect All" Flow

### 4.1 State Machine

```
idle -> connecting(index=0) -> popup_open(index=0) -> success(index=0)
                                                       -> connecting(index=1)
                                                          -> popup_open(index=1)
                                                             -> ...
                                                    -> failed(index=0)
                                                       -> connecting(index=1) // skip failed, continue
```

The flow processes connectors sequentially because browsers block multiple popups opened without direct user interaction.

### 4.2 Algorithm

```typescript
async function connectAll(pendingConnectors: ConsentConnector[]): void {
  for (const connector of pendingConnectors) {
    setConnectorStatus(connector.id, 'authorizing');
    try {
      await openOAuthPopupAndWait(connector);
      setConnectorStatus(connector.id, 'connected');
    } catch (err) {
      setConnectorStatus(connector.id, 'failed');
      // Continue to next connector — do not abort batch
    }
  }
  // After all attempts, check if any remain pending/failed
  recheckPreflightStatus();
}
```

### 4.3 Popup Queuing

Each popup is opened only after the previous one closes (via the existing `popupRef.current.closed` polling in `AuthProfileOAuthDialog`). This avoids browser popup-blocker issues.

Between popups, a 500ms delay allows the user to see the status update before the next popup opens. A "Pause" option appears during the batch flow so the user can stop and authorize remaining connectors manually.

### 4.4 Cancelation

The user can cancel the batch at any time by:

- Closing the current OAuth popup (triggers "window closed" error for current connector)
- Clicking a "Stop" button that appears in the header during batch flow

Cancelation does not undo already-completed authorizations. The user can resume by clicking "Connect All Remaining" again (which only targets still-pending connectors).

---

## 5. Error Recovery

### 5.1 Per-Connector Error Isolation

Each connector's OAuth flow is independent. A failure in one connector (user denies consent, network error, provider timeout) does not affect others:

- Failed connector shows red "Retry" button
- Other connectors remain in their current state
- "Connect All" skips already-connected and failed connectors (only targets pending ones)

### 5.2 Error Display

Each failed connector row expands to show the error message:

```
+------------------------------------------------------------------+
| [X icon]  Gmail                              [Retry]              |
|           Authorization was denied                                |
+------------------------------------------------------------------+
```

Error messages are sanitized via the existing `sanitizeError()` utility to prevent credential leakage.

### 5.3 Popup Blocked Recovery

If `window.open()` returns `null` (popup blocked), the component:

1. Sets the connector status to `failed` with message: "Popup was blocked by your browser"
2. Shows a help message below the row: "Allow popups for this site in your browser settings, then click Retry"
3. On mobile browsers where popups are unreliable, falls back to a redirect-based flow (see Section 8.2)

### 5.4 OAuth Timeout

If the popup has been open for more than 5 minutes without a callback:

1. Show a warning on the connector row: "Authorization is taking longer than expected"
2. After 10 minutes, auto-set status to `failed` with message: "Authorization timed out"
3. The popup is NOT force-closed (user may still be completing a complex provider flow)

### 5.5 Duplicate Tab Detection

If the user opens the same agent in multiple tabs, both tabs may show the consent UI. To avoid conflicts:

- The `sessionId` is included in the OAuth `state` parameter
- Only the tab that initiated the OAuth flow receives the `postMessage` callback
- The other tab can poll the preflight status endpoint to detect changes made in the other tab

---

## 6. Consent Footer

### 6.1 Layout

```
+------------------------------------------------------------------+
| [Continue]                                    [Skip for Now]      |
+------------------------------------------------------------------+
```

### 6.2 Continue Button

- **Enabled:** When all `consent: preflight` connectors are connected
- **Disabled:** When any preflight connector is still pending or authorizing
- **Label:** "Continue" (or "Start Chat" in widget context)
- **Style:** Primary button (`bg-accent text-accent-foreground`)
- **Action:** Signals the runtime to proceed with session creation

### 6.3 Skip Option

The "Skip for Now" link is only shown if the project configuration allows partial consent (`allowPartialPreflight: true` in project settings). By default, all preflight connectors are mandatory.

When shown:

- **Style:** Ghost button, muted text, underline on hover
- **Action:** Starts the session without the pending connectors. The agent will receive tool errors when attempting to use unauthorized connectors.
- **Confirmation:** Shows a brief inline warning: "Some features may not work without all connections"

---

## 7. Loading States

### 7.1 Initial Skeleton

While the runtime checks existing token validity (the `auth_required` response), the UI shows a skeleton:

```
+------------------------------------------------------------------+
| [skeleton 24x24]  [skeleton 200px]          [skeleton 80x32]     |
| [skeleton 24x24]  [skeleton 180px]          [skeleton 80x32]     |
| [skeleton 24x24]  [skeleton 220px]          [skeleton 80x32]     |
+------------------------------------------------------------------+
```

Uses the existing `skeleton` CSS class (shimmer animation from `globals.css`).

### 7.2 Token Validation Spinner

For each connector where the runtime is checking if an existing token is still valid, the row shows a subtle `Loader2` spinner (12x12px, `text-muted`) next to the connector name with tooltip "Checking existing authorization...".

### 7.3 Transition to Chat

When the user clicks "Continue", the consent panel fades out (`animate-fade-in` in reverse) and the chat interface fades in. Use `AnimatePresence` from Framer Motion with `mode="wait"` to prevent layout shifts.

---

## 8. Responsive Design

### 8.1 Breakpoint Strategy

The batch consent UI must work at three widths:

| Viewport              | Width Range | Adaptations                                                                  |
| --------------------- | ----------- | ---------------------------------------------------------------------------- |
| Desktop (Studio)      | 560px+      | Full layout as designed, side-by-side name + button                          |
| Tablet / narrow panel | 375-559px   | Connector name and button stack vertically                                   |
| Mobile widget         | 320-374px   | Compact mode: smaller icons, shorter labels, scope details hidden by default |

### 8.2 Mobile Widget Adaptations

In the embedded chat widget context (viewport under 420px):

- The header is more compact: icon + title on one line, description collapsed to a single line
- Progress bar is always visible (sticky at top when scrolling)
- Connector rows use a card layout instead of list rows (more tappable area)
- "Connect All" button is sticky at the bottom
- OAuth flow uses redirect instead of popup (mobile browsers often block popups):
  - The widget stores consent state in `sessionStorage` before redirect
  - On return from OAuth provider, the widget restores state and updates the connector status
  - The redirect callback URL includes a `?context=widget` parameter so the callback page can close itself and redirect back to the widget URL

### 8.3 Touch Targets

All interactive elements maintain a minimum 44x44px touch target per WCAG 2.1 SC 2.5.5:

- Authorize/Retry buttons: minimum height 40px, minimum width 80px, with 4px padding
- Expand/collapse chevron: 44x44px hit area (even if the visual icon is 16x16px)
- The entire connector row is tappable to expand/collapse scope details

---

## 9. Accessibility

### 9.1 Keyboard Navigation

| Key                      | Action                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| `Tab`                    | Move focus through connector rows and buttons in document order       |
| `Enter` / `Space`        | Activate the focused button (Authorize, Retry, Connect All, Continue) |
| `Enter` / `Space` on row | Toggle scope detail expansion                                         |
| `Escape`                 | Cancel current OAuth popup (if open)                                  |
| `Arrow Down/Up`          | Move between connector rows when focus is within the list             |

### 9.2 Screen Reader Support

- The consent panel has `role="region"` with `aria-label="Account authorization required"`
- Progress indicator has `role="progressbar"` with `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="{total}"`
- Each connector row has `role="listitem"` inside a `role="list"` container
- Status changes announce via `aria-live="polite"` region: "Gmail connected. 3 of 5 accounts connected."
- The expand/collapse button has `aria-expanded` and `aria-controls` linking to the scope detail panel
- Error messages have `role="alert"` for immediate announcement

### 9.3 Focus Management

- On initial render, focus moves to the first pending connector's Authorize button
- After a successful authorization, focus moves to the next pending connector's Authorize button
- After all connectors are connected, focus moves to the Continue button
- When a popup opens, focus returns to the triggering button when the popup closes
- During "Connect All" flow, focus stays on the currently-authorizing connector row

### 9.4 Reduced Motion

When `prefers-reduced-motion: reduce` is active:

- Progress bar fill changes instantly (no transition)
- Row state changes are instant (no fade animations)
- Scope expand/collapse is instant

This aligns with the existing `@media (prefers-reduced-motion: reduce)` block in `globals.css`.

---

## 10. Edge Cases

### 10.1 Zero Pending Connectors

If the runtime returns `pending: []` (all tokens are already valid), the consent gate is skipped entirely. The `BatchConsentGate` component renders its children directly.

### 10.2 Single Pending Connector

If only one connector needs authorization, the batch UI is still shown (not the single OAuth dialog), but the "Connect All" button is hidden. This keeps the UX consistent regardless of connector count.

### 10.3 Connector Added Mid-Session

If an inline-consent connector triggers mid-conversation, it does NOT re-show the batch consent UI. Instead, the existing inline consent pattern applies (a message bubble with an "[Authorize]" button). This plan covers only the preflight batch consent.

### 10.4 Token Revoked Between Check and Use

The runtime may return `satisfied: ["gmail"]` but the token could be revoked between the preflight check and actual tool invocation. This is handled at the runtime layer (not the consent UI) via the 401 retry-with-refresh path described in the auth profile design.

### 10.5 Same Provider, Multiple Connectors

An agent may use both `gmail` and `google-calendar`, both requiring Google OAuth. The consent UI shows them as separate rows (since they may require different scopes), but the underlying OAuth flow may share a single Google consent screen if the scopes are combined. The compiler's scope deduplication (Section 6 of the auth profile design) handles this at the IR level.

### 10.6 Very Long Scope Lists

Some connectors (e.g., Salesforce) may request 10+ scopes. The scope detail panel caps at 200px height with overflow scroll. Each scope is a single line with ellipsis truncation for very long scope URIs. A "Show all N scopes" link appears if scopes exceed the visible area.

---

## 11. Widget vs Studio Differences

| Aspect         | Studio Test Panel                          | Deployed Web Chat Widget               |
| -------------- | ------------------------------------------ | -------------------------------------- |
| Container      | Full-height panel inside `ChatPanel`       | Widget iframe (typically 400x600px)    |
| Header         | Full title + description + progress bar    | Compact: title + progress bar only     |
| "Connect All"  | Inline below progress bar                  | Sticky bottom bar                      |
| OAuth method   | Popup (reliable in desktop browser)        | Redirect on mobile, popup on desktop   |
| Skip option    | Always available (testing context)         | Controlled by project config           |
| Error recovery | Full error messages with technical details | Simplified messages, link to help page |
| Scope details  | Expanded by default for first 3            | Always collapsed, tap to expand        |
| Animation      | Full Framer Motion transitions             | Reduced to CSS-only for bundle size    |

---

## 12. State Management

### 12.1 Zustand Store

```typescript
interface BatchConsentState {
  // Data from runtime
  connectors: ConsentConnector[];
  // Per-connector status
  statuses: Record<string, ConsentStatus>;
  // Batch flow
  batchFlowActive: boolean;
  batchFlowIndex: number;
  // Active OAuth
  activeOAuthConnector: string | null;

  // Actions
  setConnectors: (connectors: ConsentConnector[]) => void;
  setStatus: (connectorId: string, status: ConsentStatus) => void;
  startBatchFlow: () => void;
  pauseBatchFlow: () => void;
  setActiveOAuth: (connectorId: string | null) => void;
  reset: () => void;
}

interface ConsentConnector {
  connector: string;
  displayName: string;
  scopes: string[];
  scopeDescriptions?: string[];
  authProfileId: string;
  consent: 'preflight' | 'inline';
}

type ConsentStatus =
  | { state: 'pending' }
  | { state: 'checking' }
  | { state: 'connected' }
  | { state: 'authorizing' }
  | { state: 'failed'; error: string }
  | { state: 'skipped' };
```

This store is NOT persisted (no `persist` middleware) since consent state is session-scoped and reconstructed from the runtime on each session start.

### 12.2 Integration with Session Store

The `BatchConsentGate` component reads the `auth_required` message from `useSessionStore` and populates the batch consent store. When all preflight connectors are satisfied, it signals the session store to proceed.

---

## 13. i18n Keys

All user-facing strings use `next-intl` with the namespace `auth_profiles.batch_consent`:

| Key                     | Default (en)                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `title`                 | "Connect Your Accounts"                                                 |
| `description`           | "This agent needs access to your accounts to function properly."        |
| `progress`              | "{connected} of {total} connected"                                      |
| `progress_complete`     | "All accounts connected"                                                |
| `connect_all`           | "Connect All Remaining"                                                 |
| `authorize`             | "Authorize"                                                             |
| `authorizing`           | "Authorizing..."                                                        |
| `connected`             | "Connected"                                                             |
| `retry`                 | "Retry"                                                                 |
| `skipped`               | "Skipped"                                                               |
| `failed`                | "Failed"                                                                |
| `continue`              | "Continue"                                                              |
| `start_chat`            | "Start Chat"                                                            |
| `skip`                  | "Skip for Now"                                                          |
| `skip_warning`          | "Some features may not work without all connections"                    |
| `permissions_requested` | "{count} permissions requested"                                         |
| `popup_blocked`         | "Popup was blocked by your browser"                                     |
| `popup_blocked_help`    | "Allow popups for this site in your browser settings, then click Retry" |
| `timeout_warning`       | "Authorization is taking longer than expected"                          |
| `timeout_error`         | "Authorization timed out"                                               |
| `checking_existing`     | "Checking existing authorization..."                                    |
| `batch_paused`          | "Paused — click Continue to resume"                                     |
| `stop_batch`            | "Stop"                                                                  |

---

## 14. Implementation Tasks

### Phase 1: Core Components (3-4 days)

| #   | Task                                                        | Files                                                                | Depends On    |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| 1.1 | Create `ConsentConnectorRow` component                      | `apps/studio/src/components/auth-profiles/ConsentConnectorRow.tsx`   | --            |
| 1.2 | Create `ConnectorScopeDetails` expandable panel             | `apps/studio/src/components/auth-profiles/ConnectorScopeDetails.tsx` | --            |
| 1.3 | Create `ConsentHeader` with progress bar                    | `apps/studio/src/components/auth-profiles/ConsentHeader.tsx`         | --            |
| 1.4 | Create `BatchConsentPanel` composing header + list + footer | `apps/studio/src/components/auth-profiles/BatchConsentPanel.tsx`     | 1.1, 1.2, 1.3 |
| 1.5 | Create batch consent Zustand store                          | `apps/studio/src/store/batch-consent-store.ts`                       | --            |
| 1.6 | Add i18n keys                                               | `apps/studio/messages/en/auth_profiles.json`                         | --            |

### Phase 2: OAuth Integration (2-3 days)

| #   | Task                                                                                                                                                                                                                                                                                 | Files                                                                                                                                   | Depends On |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 2.1 | Create `BatchConsentGate` wrapper component                                                                                                                                                                                                                                          | `apps/studio/src/components/auth-profiles/BatchConsentGate.tsx`                                                                         | 1.4, 1.5   |
| 2.2 | Implement sequential "Connect All" flow logic                                                                                                                                                                                                                                        | `apps/studio/src/components/auth-profiles/useBatchOAuth.ts` (custom hook)                                                               | 1.5        |
| 2.3 | Wire existing `AuthProfileOAuthDialog` component (`apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`) for single-connector auth within the batch consent flow. Extend its props if needed to accept `sessionId` for consent-mode OAuth state parameter inclusion. | `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`, `apps/studio/src/components/auth-profiles/BatchConsentPanel.tsx` | 2.1        |
| 2.4 | Add preflight status polling endpoint integration                                                                                                                                                                                                                                    | `apps/studio/src/api/auth-profiles.ts`                                                                                                  | --         |

### Phase 3: Studio Integration (1-2 days)

| #   | Task                                                   | Files                                           | Depends On |
| --- | ------------------------------------------------------ | ----------------------------------------------- | ---------- |
| 3.1 | Integrate `BatchConsentGate` into `ChatPanel`          | `apps/studio/src/components/chat/ChatPanel.tsx` | 2.1        |
| 3.2 | Handle `auth_required` message type in session store   | `apps/studio/src/store/session-store.ts`        | 2.1        |
| 3.3 | Add Framer Motion transitions between consent and chat | `apps/studio/src/components/chat/ChatPanel.tsx` | 3.1        |

### Phase 4: Widget Adaptations (2-3 days)

| #   | Task                                                        | Files                                                                               | Depends On |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| 4.1 | Create responsive variant of `BatchConsentPanel` for widget | `apps/studio/src/components/auth-profiles/BatchConsentPanel.tsx` (responsive props) | 1.4        |
| 4.2 | Implement redirect-based OAuth fallback for mobile          | `apps/studio/src/components/auth-profiles/useBatchOAuth.ts`                         | 2.2        |
| 4.3 | Add widget callback page for OAuth redirects                | `apps/studio/src/app/oauth/widget-consent-callback/page.tsx`                        | 4.2        |

### Phase 5: Accessibility & Polish (1-2 days)

| #   | Task                                              | Files                                                            | Depends On    |
| --- | ------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| 5.1 | Add keyboard navigation (arrow keys between rows) | `apps/studio/src/components/auth-profiles/BatchConsentPanel.tsx` | 1.4           |
| 5.2 | Add `aria-live` announcements for status changes  | `apps/studio/src/components/auth-profiles/BatchConsentPanel.tsx` | 1.4           |
| 5.3 | Add focus management (auto-focus next pending)    | `apps/studio/src/components/auth-profiles/useBatchOAuth.ts`      | 2.2           |
| 5.4 | Test with VoiceOver and NVDA screen readers       | --                                                               | 5.1, 5.2, 5.3 |
| 5.5 | Add `prefers-reduced-motion` support              | `apps/studio/src/app/globals.css`                                | --            |

**Total estimated effort:** 9-14 days

---

## 15. Testing Strategy

### Unit Tests

- `ConsentConnectorRow` renders all 5 states correctly
- `ConnectorScopeDetails` expands/collapses with correct aria attributes
- `ConsentHeader` progress bar reflects correct percentage
- `useBatchOAuth` hook processes connectors sequentially and handles failures
- Batch consent store state transitions

### Integration Tests

- `BatchConsentGate` shows consent UI when `auth_required` message received
- `BatchConsentGate` passes through to chat when `pending[]` is empty
- "Connect All" flow completes with mixed success/failure outcomes
- Popup blocked detection triggers fallback messaging
- OAuth timeout triggers correct state transition

### E2E Tests (Playwright)

- Full batch consent flow with 3 connectors (mock OAuth provider)
- Keyboard-only navigation through the consent UI
- Mobile viewport renders responsive layout
- Screen reader announces status changes

---

## 16. Open Questions

| #   | Question                                                                                           | Impact                 | Proposed Default                                                                     |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| Q1  | Should the "Connect All" flow allow the user to reorder connectors before starting?                | UX complexity          | No reordering; process in the order returned by runtime                              |
| Q2  | Should scope descriptions come from the compiler IR or a client-side mapping?                      | Data flow architecture | Compiler IR provides `scopeDescriptions[]`; client-side fallback for missing entries |
| Q3  | Should the batch consent UI show `consent: inline` connectors as "optional" rows?                  | User understanding     | Yes, show as gray informational rows (not blocking)                                  |
| Q4  | What is the maximum number of connectors before the list becomes scrollable?                       | UI sizing              | 4 visible rows, then scroll (approx 320px list height)                               |
| Q5  | Should the widget use a separate lightweight consent component (no Framer Motion) for bundle size? | Performance            | Yes, CSS-only animations for widget context                                          |

---

## 17. Additional Testing Requirements

### Dark Mode Verification

All 5 row states (Connected, Pending, Authorizing, Failed, Skipped) must be verified in both light and dark themes. The design tokens should handle this automatically, but explicit visual verification is needed, especially for:

- Connector row border colors
- Status indicator contrast
- Progress bar fill visibility

### Server-Side Rendering for Standalone Page

The standalone preflight page (from GAP-3.1, used by voice/WhatsApp channels) should use Next.js server components for the initial connector list (data fetched server-side from the opaque token), with client-side hydration for interactive OAuth flows. This ensures fast initial load on slow mobile connections.

---

## Revision History

- **Pass 1 (2026-03-13)**: Initial implementation plan.
- **Pass 2 (2026-03-13)**: Applied 131 audit findings from 3 auditors. Added cross-plan dependencies section, replaced custom polling endpoint with canonical satisfaction endpoint and WS events from GAP-3.1, fixed progress bar transition duration note (custom 300ms vs existing 1s utility), added dark mode verification testing requirement, added SSR recommendation for standalone page, sequenced sprint to N+2.
- **Pass 4 (2026-03-13)**: Applied 20 findings from Pass 3 auditors. Clarified `AuthProfileOAuthDialog` reference in Task 2.3.
- **Pass 6 (2026-03-13)**: Fixed P5-1 — `AuthProfileOAuthDialog` already exists (created in Phase 1); Task 2.3 now references the existing component instead of claiming it needs creation.
