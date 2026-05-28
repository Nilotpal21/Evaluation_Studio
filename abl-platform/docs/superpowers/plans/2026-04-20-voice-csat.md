# Voice CSAT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a human agent disconnects from a voice call, play a TTS CSAT prompt, collect a DTMF rating (1–5), submit it to SmartAssist, play a thank-you message, then hang up.

**Architecture:** When `agent:disconnected` fires for a voice session with `csatRequired=true`, the message bridge delegates to a `VoiceCsatRunner` callback instead of hanging up immediately. The runner uses a new `gatherDTMF()` method on `VoiceGatewaySession` (implemented in `KoreVGSession`) to play the prompt and collect one DTMF digit via the existing Jambonz `verb:hook` WebSocket path. The collected score is submitted via `SmartAssistClient.submitCsatRating()` then the call is hung up.

**Tech Stack:** TypeScript, Jambonz (verb:hook WebSocket), Zod config schema, existing `verbBuilder.gather()`, `SmartAssistClient`, `CsatHandler`.

---

## File Map

| File                                                           | Action | Purpose                                                                               |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `packages/agent-transfer/src/types.ts`                         | Modify | Add `'csat'` to `postAgentAction` union                                               |
| `packages/agent-transfer/src/config/schema.ts`                 | Modify | Add `csatVoicePrompt` + `csatVoiceThankYou` to `SmartAssistConfigSchema`              |
| `apps/runtime/src/config/agent-transfer.ts`                    | Modify | Read new env vars `SMARTASSIST_CSAT_VOICE_PROMPT` + `SMARTASSIST_CSAT_VOICE_THANKYOU` |
| `packages/agent-transfer/src/voice/voice-gateway.ts`           | Modify | Add `gatherDTMF?()` method + `GatherDTMFOptions` interface to `VoiceGatewaySession`   |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts`     | Modify | Implement `gatherDTMF()`: one-shot resolver intercepted from `verb:hook` queue        |
| `apps/runtime/src/services/agent-transfer/voice-csat.ts`       | Create | `runVoiceCsatFlow()`: orchestrates prompt → gather → submit → thank-you → hangup      |
| `apps/runtime/src/services/agent-transfer/message-bridge.ts`   | Modify | Call `voiceCsatRunner` instead of `hangup()` when `csatRequired` is true              |
| `apps/runtime/src/services/agent-transfer/index.ts`            | Modify | Wire `voiceCsatRunner` on bridge startup                                              |
| `apps/runtime/src/__tests__/agent-transfer/voice-csat.test.ts` | Create | Unit tests for `runVoiceCsatFlow`                                                     |

---

## Task 1: Extend `postAgentAction` type and add CSAT config fields

**Files:**

- Modify: `packages/agent-transfer/src/types.ts:291`
- Modify: `packages/agent-transfer/src/config/schema.ts:27`
- Modify: `apps/runtime/src/config/agent-transfer.ts`

- [x] **Step 1: Extend `postAgentAction` to include `'csat'`**

In `packages/agent-transfer/src/types.ts` line 291, change:

```ts
postAgentAction?: 'return' | 'end';
```

to:

```ts
postAgentAction?: 'return' | 'end' | 'csat';
```

- [x] **Step 2: Add CSAT prompt config fields to `SmartAssistConfigSchema`**

In `packages/agent-transfer/src/config/schema.ts`, add to `SmartAssistConfigSchema` after the `botSIPURI` field (line 52):

```ts
/** TTS prompt played to caller after agent disconnects to collect CSAT rating */
csatVoicePrompt: z
  .string()
  .optional()
  .default(
    'Please rate your experience with our agent. Press 1 for poor, 2 for fair, 3 for good, 4 for very good, or 5 for excellent. Press 0 to skip.',
  ),
/** TTS message played after CSAT rating is collected */
csatVoiceThankYou: z
  .string()
  .optional()
  .default('Thank you for your feedback. Goodbye.'),
```

- [x] **Step 3: Read new env vars in `apps/runtime/src/config/agent-transfer.ts`**

Find the block that builds the `smartassist` config object (around line 60) and add:

```ts
smartassistCsatVoicePrompt: process.env.SMARTASSIST_CSAT_VOICE_PROMPT,
smartassistCsatVoiceThankYou: process.env.SMARTASSIST_CSAT_VOICE_THANKYOU,
```

And in the object passed to `SmartAssistConfigSchema`:

```ts
csatVoicePrompt: smartassistCsatVoicePrompt,
csatVoiceThankYou: smartassistCsatVoiceThankYou,
```

- [x] **Step 4: Build and verify no type errors**

```bash
pnpm build --filter=@agent-platform/agent-transfer --filter=@agent-platform/runtime
```

Expected: both packages build with 0 errors.

- [x] **Step 5: Commit**

```bash
git add packages/agent-transfer/src/types.ts \
        packages/agent-transfer/src/config/schema.ts \
        apps/runtime/src/config/agent-transfer.ts
git commit -m "[ABLP-142] feat(agent-transfer): add csat postAgentAction and voice CSAT prompt config"
```

---

## Task 2: Add `gatherDTMF` to `VoiceGatewaySession` interface

**Files:**

- Modify: `packages/agent-transfer/src/voice/voice-gateway.ts`

- [x] **Step 1: Add `GatherDTMFOptions` interface and `gatherDTMF` method**

In `packages/agent-transfer/src/voice/voice-gateway.ts`, add after `PlayMessageOptions` (line 52):

```ts
export interface GatherDTMFOptions {
  /** Seconds to wait for input before timing out (default: 10) */
  timeout?: number;
  /** Number of digits to collect before returning (default: 1) */
  numDigits?: number;
}
```

And add `gatherDTMF` to `VoiceGatewaySession` interface after `playMessage?` (line 43):

```ts
/**
 * Play a TTS prompt and collect DTMF input from the caller.
 * Returns the collected digits string, or null on timeout/error.
 */
gatherDTMF?(prompt: string, options?: GatherDTMFOptions): Promise<string | null>;
```

- [x] **Step 2: Build to verify interface compiles**

```bash
pnpm build --filter=@agent-platform/agent-transfer
```

Expected: 0 errors.

- [x] **Step 3: Commit**

```bash
git add packages/agent-transfer/src/voice/voice-gateway.ts
git commit -m "[ABLP-142] feat(agent-transfer): add gatherDTMF to VoiceGatewaySession interface"
```

---

## Task 3: Implement `gatherDTMF` in `KoreVGSession`

**Files:**

- Modify: `apps/runtime/src/services/voice/korevg/korevg-session.ts`

- [x] **Step 1: Add `csatGatherResolve` field to `KoreVGSession`**

Find the block of private fields around `dtmfTurnCount` (line 391). Add:

```ts
/** One-shot resolver for CSAT DTMF gather — set by gatherDTMF(), consumed by handleVerbHook() */
private csatGatherResolve?: ((digits: string | null) => void) | undefined;
```

- [x] **Step 2: Intercept `verb:hook` in `handleVerbHook` for CSAT gather**

At the start of `handleVerbHook` (line 1265), before the `dial_call_status` check, add:

```ts
// If a CSAT gather is pending, route this verb:hook to its resolver instead
// of the normal LLM turn pipeline.
if (this.csatGatherResolve) {
  const resolver = this.csatGatherResolve;
  this.csatGatherResolve = undefined;
  const digits = (msg.data?.digits as string | undefined) ?? null;
  this.sendAck(msg.msgid);
  resolver(digits);
  return;
}
```

- [x] **Step 3: Implement `gatherDTMF` method**

Add after the `playMessage` method (after line 3100):

```ts
gatherDTMF(prompt: string, options?: GatherDTMFOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!this.isActive || this.ws.readyState !== 1) {
      resolve(null);
      return;
    }

    const timeoutMs = (options?.timeout ?? 10) * 1000;
    const numDigits = options?.numDigits ?? 1;

    // Set timeout fallback — if no verb:hook arrives, resolve null
    const timer = setTimeout(() => {
      if (this.csatGatherResolve === resolve) {
        this.csatGatherResolve = undefined;
      }
      log.info('[CSAT-GATHER] Timed out waiting for DTMF', {
        callSid: this.config.callSid,
        timeoutMs,
      });
      resolve(null);
    }, timeoutMs + 2000); // +2s buffer over Jambonz timeout

    this.csatGatherResolve = (digits) => {
      clearTimeout(timer);
      resolve(digits);
    };

    const gatherVerb = this.verbBuilder.gather({
      prompt,
      input: ['dtmf'],
      numDigits,
      timeout: timeoutMs,
      bargein: false,
    });

    this.sendCommand('redirect', [gatherVerb]);

    log.info('[CSAT-GATHER] Dispatched DTMF gather', {
      callSid: this.config.callSid,
      numDigits,
      timeoutMs,
    });
  });
}
```

Also add the import for `GatherDTMFOptions` at the top of the file (find where `VoiceGatewaySession` is imported from `@agent-platform/agent-transfer`):

```ts
import type {
  VoiceGatewaySession,
  GatherDTMFOptions,
  DialAgentOptions,
  PlayMessageOptions,
} from '@agent-platform/agent-transfer';
```

- [x] **Step 4: Build and verify**

```bash
pnpm build --filter=@agent-platform/runtime
```

Expected: 0 errors.

- [x] **Step 5: Commit**

```bash
git add apps/runtime/src/services/voice/korevg/korevg-session.ts
git commit -m "[ABLP-142] feat(runtime): implement gatherDTMF in KoreVGSession via verb:hook one-shot resolver"
```

---

## Task 4: Create `voice-csat.ts` service

**Files:**

- Create: `apps/runtime/src/services/agent-transfer/voice-csat.ts`

- [x] **Step 1: Write the failing test first**

Create `apps/runtime/src/__tests__/agent-transfer/voice-csat.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runVoiceCsatFlow,
  type VoiceCsatOptions,
} from '../../services/agent-transfer/voice-csat.js';
import type { VoiceGatewaySession } from '@agent-platform/agent-transfer';

function makeSession(overrides: Partial<VoiceGatewaySession> = {}): VoiceGatewaySession {
  return {
    sessionId: 'call-123',
    isActive: () => true,
    sendAgentMessage: vi.fn(),
    playMessage: vi.fn(),
    hangup: vi.fn(),
    gatherDTMF: vi.fn(),
    ...overrides,
  };
}

const baseOptions = (): VoiceCsatOptions => ({
  sessionId: 'session-abc',
  voiceSession: makeSession(),
  csatData: {
    userId: 'user-1',
    conversationId: 'conv-1',
    channel: 'voice',
    surveyType: 'csat',
    botId: 'bot-1',
    orgId: 'org-1',
  },
  prompt: 'Rate 1 to 5.',
  thankYouMessage: 'Thank you.',
  submitRating: vi.fn().mockResolvedValue({ success: true }),
  onComplete: vi.fn(),
  onSkip: vi.fn(),
});

describe('runVoiceCsatFlow', () => {
  it('plays prompt, submits valid digit, plays thank-you, then hangs up', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('4');

    await runVoiceCsatFlow(opts);

    expect(opts.voiceSession.gatherDTMF).toHaveBeenCalledWith('Rate 1 to 5.', {
      timeout: 10,
      numDigits: 1,
    });
    expect(opts.submitRating).toHaveBeenCalledWith(4, 'csat');
    expect(opts.voiceSession.playMessage).toHaveBeenCalledWith('Thank you.');
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_complete');
    expect(opts.onComplete).toHaveBeenCalledWith(4);
    expect(opts.onSkip).not.toHaveBeenCalled();
  });

  it('skips CSAT when user presses 0', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('0');

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_skipped');
    expect(opts.onSkip).toHaveBeenCalledWith('user_skipped');
  });

  it('skips CSAT on timeout (null digits)', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_timeout');
    expect(opts.onSkip).toHaveBeenCalledWith('timeout');
  });

  it('skips CSAT on invalid digit (not 1-5)', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('9');

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_skipped');
    expect(opts.onSkip).toHaveBeenCalledWith('invalid_input');
  });

  it('still hangs up even if submitRating throws', async () => {
    const opts = baseOptions();
    (opts.voiceSession.gatherDTMF as ReturnType<typeof vi.fn>).mockResolvedValue('3');
    (opts.submitRating as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));

    await runVoiceCsatFlow(opts);

    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_complete');
  });

  it('falls back to hangup when gatherDTMF not available on session', async () => {
    const opts = baseOptions();
    opts.voiceSession = makeSession({ gatherDTMF: undefined });

    await runVoiceCsatFlow(opts);

    expect(opts.submitRating).not.toHaveBeenCalled();
    expect(opts.voiceSession.hangup).toHaveBeenCalledWith('csat_unavailable');
    expect(opts.onSkip).toHaveBeenCalledWith('no_gather_support');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
pnpm build --filter=@agent-platform/runtime --skip-build 2>/dev/null; cd apps/runtime && npx vitest run src/__tests__/agent-transfer/voice-csat.test.ts 2>&1 | tail -20
```

Expected: FAIL — `voice-csat.ts` does not exist yet.

- [x] **Step 3: Implement `voice-csat.ts`**

Create `apps/runtime/src/services/agent-transfer/voice-csat.ts`:

```ts
import { createLogger } from '@abl/compiler/platform';
import type { VoiceGatewaySession } from '@agent-platform/agent-transfer';

const log = createLogger('voice-csat');

export interface VoiceCsatData {
  userId: string;
  conversationId: string;
  channel: string;
  surveyType: 'csat' | 'nps' | 'likeDislike';
  botId?: string;
  orgId?: string;
}

export interface VoiceCsatOptions {
  sessionId: string;
  voiceSession: VoiceGatewaySession;
  csatData: VoiceCsatData;
  prompt: string;
  thankYouMessage: string;
  submitRating: (score: number, surveyType: string) => Promise<unknown>;
  onComplete: (score: number) => void;
  onSkip: (reason: string) => void;
}

const VALID_SCORES: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };

export async function runVoiceCsatFlow(opts: VoiceCsatOptions): Promise<void> {
  const {
    sessionId,
    voiceSession,
    csatData,
    prompt,
    thankYouMessage,
    submitRating,
    onComplete,
    onSkip,
  } = opts;

  if (!voiceSession.gatherDTMF) {
    log.warn('[VOICE-CSAT] gatherDTMF not available on voice session', { sessionId });
    voiceSession.hangup?.('csat_unavailable');
    onSkip('no_gather_support');
    return;
  }

  log.info('[VOICE-CSAT] Starting voice CSAT flow', {
    sessionId,
    surveyType: csatData.surveyType,
  });

  let digits: string | null = null;
  try {
    digits = await voiceSession.gatherDTMF(prompt, { timeout: 10, numDigits: 1 });
  } catch (err) {
    log.error('[VOICE-CSAT] gatherDTMF threw unexpectedly', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Timeout
  if (digits === null) {
    log.info('[VOICE-CSAT] No input received (timeout)', { sessionId });
    voiceSession.hangup?.('csat_timeout');
    onSkip('timeout');
    return;
  }

  // Skip (0) or invalid input
  const score = VALID_SCORES[digits];
  if (!score) {
    log.info('[VOICE-CSAT] Invalid or skip digit received', { sessionId, digits });
    voiceSession.hangup?.('csat_skipped');
    onSkip(digits === '0' ? 'user_skipped' : 'invalid_input');
    return;
  }

  // Submit rating — don't let a submission failure prevent hangup
  try {
    await submitRating(score, csatData.surveyType);
    log.info('[VOICE-CSAT] Rating submitted', { sessionId, score });
  } catch (err) {
    log.error('[VOICE-CSAT] Rating submission failed', {
      sessionId,
      score,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  voiceSession.playMessage?.(thankYouMessage);
  voiceSession.hangup?.('csat_complete');
  onComplete(score);
}
```

- [x] **Step 4: Run test to verify it passes**

```bash
cd apps/runtime && npx vitest run src/__tests__/agent-transfer/voice-csat.test.ts 2>&1 | tail -20
```

Expected: 6 tests pass.

- [x] **Step 5: Build**

```bash
pnpm build --filter=@agent-platform/runtime
```

Expected: 0 errors.

- [x] **Step 6: Commit**

```bash
git add apps/runtime/src/services/agent-transfer/voice-csat.ts \
        apps/runtime/src/__tests__/agent-transfer/voice-csat.test.ts
git commit -m "[ABLP-142] feat(runtime): add runVoiceCsatFlow service for voice CSAT IVR collection"
```

---

## Task 5: Wire voice CSAT into `message-bridge.ts`

**Files:**

- Modify: `apps/runtime/src/services/agent-transfer/message-bridge.ts`

- [x] **Step 1: Add `voiceCsatRunner` to bridge options**

Find the `AgentTransferMessageBridgeOptions` interface (or wherever the bridge constructor options are defined) and add:

```ts
/**
 * Called instead of hangup() when agent:disconnected fires for a voice session
 * with csatRequired=true. The runner is responsible for hanging up the call.
 */
voiceCsatRunner?: (sessionId: string, event: AgentEvent, voiceSession: VoiceGatewaySession) => Promise<void>;
```

Also store it on the class:

```ts
private readonly voiceCsatRunner?: (sessionId: string, event: AgentEvent, voiceSession: VoiceGatewaySession) => Promise<void>;
```

And assign it in the constructor.

- [x] **Step 2: Update `agent:disconnected` in `deliverViaVoiceGateway`**

Find the `case 'agent:disconnected'` block (line 747-753) and replace with:

```ts
case 'agent:disconnected': {
  const csatRequired = event.data?.csatRequired === true;
  if (csatRequired && this.voiceCsatRunner) {
    log.info('[VOICE-CSAT] Delegating to voice CSAT runner', {
      sessionId: event.sessionId,
    });
    this.voiceCsatRunner(event.sessionId, event, voiceSession).catch((err) => {
      log.error('[VOICE-CSAT] Runner failed, falling back to hangup', {
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      voiceSession.hangup?.('agent_disconnect');
    });
  } else {
    voiceSession.hangup?.('agent_disconnect');
    log.info('Voice call ended on agent disconnect', {
      sessionId: event.sessionId,
    });
  }
  break;
}
```

- [x] **Step 3: Build and verify**

```bash
pnpm build --filter=@agent-platform/runtime
```

Expected: 0 errors.

- [x] **Step 4: Commit**

```bash
git add apps/runtime/src/services/agent-transfer/message-bridge.ts
git commit -m "[ABLP-142] feat(runtime): route voice agent:disconnected to CSAT runner when csatRequired"
```

---

## Task 6: Wire `voiceCsatRunner` in runtime service

**Files:**

- Modify: `apps/runtime/src/services/agent-transfer/index.ts`

- [x] **Step 1: Create the CSAT runner factory and pass it to the bridge**

Find where the `AgentTransferMessageBridge` is instantiated in `index.ts`. Add a `voiceCsatRunner` that:

1. Looks up the voice session via the registry
2. Reads CSAT data from the event
3. Calls `runVoiceCsatFlow` with `submitRating` wired to `koreAdapter.submitCsatRating()`
4. Calls `CsatHandler.completeCsat()` or `skipCsat()` when done

Add the following import near the top of `index.ts`:

```ts
import { runVoiceCsatFlow } from './voice-csat.js';
import { CsatHandler } from '@agent-platform/agent-transfer';
```

Then, after the bridge is constructed and `koreAdapter` is available, set the runner. Find the section where `koreAdapter.onAgentEvent` is wired (around line 250) and add the runner wiring:

```ts
const csatHandler = new CsatHandler(transferSessionStore!);

bridge.setVoiceCsatRunner(async (sessionId, event, voiceSession) => {
  const csatData = {
    userId: (event.data?.userId as string) ?? '',
    conversationId: (event.data?.conversationId as string) ?? '',
    channel: (event.data?.source as string) ?? 'voice',
    surveyType: ((event.data?.csatSurveyType as string) ?? 'csat') as
      | 'csat'
      | 'nps'
      | 'likeDislike',
    botId: event.data?.iId as string | undefined,
    orgId: event.data?.orgId as string | undefined,
  };

  const sessionData = {
    tenantId: (event.data?.tenantId as string) ?? '',
    contactId: csatData.userId,
    channel: csatData.channel,
  };

  const smartAssistCfg = config.smartassist;
  const prompt =
    smartAssistCfg?.csatVoicePrompt ??
    'Please rate your experience. Press 1 for poor through 5 for excellent. Press 0 to skip.';
  const thankYouMessage =
    smartAssistCfg?.csatVoiceThankYou ?? 'Thank you for your feedback. Goodbye.';

  await csatHandler.handleAgentClosed(sessionId, sessionData, {
    action: 'csat',
    surveyType: 'inline',
  });

  await runVoiceCsatFlow({
    sessionId,
    voiceSession,
    csatData,
    prompt,
    thankYouMessage,
    submitRating: async (score, surveyType) => {
      await koreAdapter.submitCsatRating({
        userId: csatData.userId,
        channel: csatData.channel,
        botId: csatData.botId ?? '',
        score,
        surveyType: surveyType as 'csat' | 'nps' | 'likeDislike',
      });
    },
    onComplete: (score) => {
      csatHandler.completeCsat(sessionId, sessionData, score).catch((err) => {
        log.error('CSAT completeCsat failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onSkip: (reason) => {
      csatHandler.skipCsat(sessionId, sessionData, reason).catch((err) => {
        log.error('CSAT skipCsat failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  });
});
```

Note: If `bridge.setVoiceCsatRunner()` doesn't exist yet, add it to the bridge class alongside the field set in Task 5 (or pass it in the constructor options instead).

- [x] **Step 2: Build and verify**

```bash
pnpm build --filter=@agent-platform/runtime
```

Expected: 0 errors.

- [x] **Step 3: Commit**

```bash
git add apps/runtime/src/services/agent-transfer/index.ts
git commit -m "[ABLP-142] feat(runtime): wire voiceCsatRunner into agent-transfer service"
```

---

## Task 7: Fix `SmartAssistClient.submitCsatRating` URL (already done)

The URL was already fixed in the conversation prior to this plan:
`packages/agent-transfer/src/adapters/kore/smartassist-client.ts:515`
changed from `/api/v1/csatResponse/save` → `/agentassist/api/v1/csatResponse/save`.

- [x] **Step 1: Verify the fix is in place**

```bash
grep "csatResponse" packages/agent-transfer/src/adapters/kore/smartassist-client.ts
```

Expected: `${baseUrl}/agentassist/api/v1/csatResponse/save`

- [x] **Step 2: Commit the URL fix together with the other changes if not yet committed**

```bash
git add packages/agent-transfer/src/adapters/kore/smartassist-client.ts
git commit -m "[ABLP-142] fix(agent-transfer): correct CSAT submit URL to /agentassist/api/v1/csatResponse/save"
```

---

## Task 8: Integration test — voice CSAT end-to-end

**Files:**

- Create: `apps/runtime/src/__tests__/agent-transfer/voice-csat-integration.test.ts`

- [x] **Step 1: Write integration test**

Create `apps/runtime/src/__tests__/agent-transfer/voice-csat-integration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runVoiceCsatFlow } from '../../services/agent-transfer/voice-csat.js';
import type { VoiceGatewaySession } from '@agent-platform/agent-transfer';

/**
 * Integration-style test: exercises the full flow from gatherDTMF → submit → hangup
 * without mocking internal platform modules. All I/O is injected via options.
 */
describe('voice CSAT integration flow', () => {
  it('full happy path: gather=3, submit succeeds, thank-you played, call ended', async () => {
    const playMessage = vi.fn();
    const hangup = vi.fn();
    const submitRating = vi.fn().mockResolvedValue({ success: true, data: {} });
    const onComplete = vi.fn();
    const onSkip = vi.fn();

    const session: VoiceGatewaySession = {
      sessionId: 'call-abc',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      playMessage,
      hangup,
      gatherDTMF: vi.fn().mockResolvedValue('3'),
    };

    await runVoiceCsatFlow({
      sessionId: 'transfer-session-1',
      voiceSession: session,
      csatData: {
        userId: 'u1',
        conversationId: 'c1',
        channel: 'voice',
        surveyType: 'csat',
        botId: 'bot1',
        orgId: 'org1',
      },
      prompt: 'Rate 1 to 5.',
      thankYouMessage: 'Thanks!',
      submitRating,
      onComplete,
      onSkip,
    });

    expect(submitRating).toHaveBeenCalledWith(3, 'csat');
    expect(playMessage).toHaveBeenCalledWith('Thanks!');
    expect(hangup).toHaveBeenCalledWith('csat_complete');
    expect(onComplete).toHaveBeenCalledWith(3);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('timeout path: no digits → skip → hangup csat_timeout', async () => {
    const hangup = vi.fn();
    const onSkip = vi.fn();

    const session: VoiceGatewaySession = {
      sessionId: 'call-timeout',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      hangup,
      gatherDTMF: vi.fn().mockResolvedValue(null),
    };

    await runVoiceCsatFlow({
      sessionId: 'ts-2',
      voiceSession: session,
      csatData: { userId: 'u2', conversationId: 'c2', channel: 'voice', surveyType: 'csat' },
      prompt: 'Rate.',
      thankYouMessage: 'Thanks.',
      submitRating: vi.fn(),
      onComplete: vi.fn(),
      onSkip,
    });

    expect(hangup).toHaveBeenCalledWith('csat_timeout');
    expect(onSkip).toHaveBeenCalledWith('timeout');
  });

  it('submit error path: hangup still fires even when submitRating rejects', async () => {
    const hangup = vi.fn();
    const session: VoiceGatewaySession = {
      sessionId: 'call-err',
      isActive: () => true,
      sendAgentMessage: vi.fn(),
      playMessage: vi.fn(),
      hangup,
      gatherDTMF: vi.fn().mockResolvedValue('5'),
    };

    await runVoiceCsatFlow({
      sessionId: 'ts-3',
      voiceSession: session,
      csatData: { userId: 'u3', conversationId: 'c3', channel: 'voice', surveyType: 'csat' },
      prompt: 'Rate.',
      thankYouMessage: 'Thanks.',
      submitRating: vi.fn().mockRejectedValue(new Error('SmartAssist down')),
      onComplete: vi.fn(),
      onSkip: vi.fn(),
    });

    expect(hangup).toHaveBeenCalledWith('csat_complete');
  });
});
```

- [x] **Step 2: Run tests**

```bash
cd apps/runtime && npx vitest run src/__tests__/agent-transfer/voice-csat-integration.test.ts 2>&1 | tail -20
```

Expected: 3 tests pass.

- [x] **Step 3: Run full test suite to check for regressions**

```bash
pnpm build --filter=@agent-platform/runtime && cd apps/runtime && npx vitest run 2>&1 | tail -30
```

Expected: All existing tests pass.

- [x] **Step 4: Commit**

```bash
git add apps/runtime/src/__tests__/agent-transfer/voice-csat-integration.test.ts
git commit -m "[ABLP-142] test(runtime): add voice CSAT integration tests"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: URL fix (smartassist-client.ts), `postAgentAction: 'csat'`, `gatherDTMF` interface + implementation, `runVoiceCsatFlow` service, message-bridge wiring, runtime service wiring, CSAT prompt config — all covered.
- [x] **No placeholders**: All code blocks are complete and runnable.
- [x] **Type consistency**: `VoiceCsatOptions`, `VoiceCsatData`, `GatherDTMFOptions` defined once in Task 2/4 and reused consistently.
- [x] **Hangup safety**: Every code path in `runVoiceCsatFlow` calls `hangup` — timeout, invalid input, skip, submit error, no-gather-support.
- [x] **csatGatherResolve race**: One-shot resolver is cleared before calling `resolve()` to prevent double-resolve if both timeout and verb:hook fire simultaneously.
- [x] **Existing chat CSAT unaffected**: Changes to `message-bridge.ts` only trigger on `csatRequired === true && voiceCsatRunner set` — chat sessions don't use `deliverViaVoiceGateway`.

---

## Post-Implementation Fixes (discovered during live testing)

### Fix 1: Close-message regex had `$` anchor (both injection and synthesis)

**Problem:** SmartAssist appends trailing text after the close phrase (e.g. "srinivas has now closed this conversation. Please reach out..."). The regex `/has now closed this conversation\.?$/i` failed to match.

**Fixed in:**

- `packages/agent-transfer/src/adapters/kore/event-handler.ts` — synthesis path
- `packages/agent-transfer/src/adapters/kore/index.ts` — injection path

**Fix:** Remove `\.?$` → `/has now closed this conversation/i`

---

### Fix 2: Jambonz `gather` timeout was in milliseconds (should be seconds)

**Problem:** `gatherDTMF` passed `timeout: timeoutMs` (e.g. `10000`) to the Jambonz gather verb. Jambonz expects **seconds** — it treated this as 10,000 seconds, so Jambonz never terminated the gather. Only the Node.js fallback fired, and it fired too early (before the prompt finished playing).

**Fixed in:** `apps/runtime/src/services/voice/korevg/korevg-session.ts` — `gatherDTMF()`

**Fix:**

```ts
const estimatedPromptMs = Math.ceil(prompt.split(/\s+/).length / 2.5) * 1000;
const jambonzTimeoutSec = Math.ceil((estimatedPromptMs + timeoutMs) / 1000);
const fallbackMs = estimatedPromptMs + timeoutMs + 2000;
// pass jambonzTimeoutSec to gather verb, use fallbackMs for Node.js timer
```

---

### Fix 3: Jambonz doesn't send verb:hook on DTMF-only gather timeout — `actionHook` required

**Problem:** Without `actionHook`, Jambonz sends no `verb:hook` when a digit is received either. The `csatGatherResolve` resolver was never called on digit press.

**Fixed in:** `apps/runtime/src/services/voice/korevg/korevg-session.ts` — `gatherDTMF()`

**Fix:** Add `actionHook: this.wsPath` to the gather verb so Jambonz sends a `verb:hook` when a digit arrives. The Node.js fallback remains the primary mechanism for no-digit timeout (Jambonz does not always send a hook on timeout with no input).

---

### Fix 4: `playMessage()` on dial-complete enabled barge-in, intercepting CSAT gather

**Problem:** After `dialCallStatus=completed`, `this.playMessage('Please hold for a moment.')` was called to fill the ~20s silence before SmartAssist sends the close webhook. `playMessage` internally calls `buildStreamingConfig` which enables **sticky barge-in**. The resulting speech `verb:hook` was queued and intercepted `csatGatherResolve` before any DTMF was received, causing CSAT to skip immediately.

**Fixed in:** `apps/runtime/src/services/voice/korevg/korevg-session.ts` — `dialCallStatus=completed` branch

**Fix:** Replace `this.playMessage(...)` with a bare `say` verb redirect (no config/barge-in):

```ts
this.sendCommand('redirect', [
  this.verbBuilder.say('Please hold for a moment.', { streaming: false }),
]);
```

---

### Fix 5: Duplicate CSAT trigger from `remove_id_to_acc_identity`

**Problem:** SmartAssist sends `remove_id_to_acc_identity` ~6 seconds after the close message, which also maps to `agent:disconnected`. This triggered the CSAT runner a second time while it was already running.

**Fixed in:** `apps/runtime/src/services/agent-transfer/index.ts`

**Fix:** Wrap the voice CSAT runner in an `activeCsatSessions: Set<string>` guard:

```ts
if (activeCsatSessions.has(sessionId)) return;
activeCsatSessions.add(sessionId);
try { await runVoiceCsatFlow(...); } finally { activeCsatSessions.delete(sessionId); }
```

---

### Fix 6: NPS survey type skipped (single DTMF digit can't represent 0–10 scale)

**Problem:** NPS requires a 0–10 scale which cannot be collected via a single DTMF digit press.

**Fixed in:** `apps/runtime/src/services/agent-transfer/voice-csat.ts`

**Fix:** Early-return with `onSkip('nps_not_supported')` when `surveyType === 'nps'`.
