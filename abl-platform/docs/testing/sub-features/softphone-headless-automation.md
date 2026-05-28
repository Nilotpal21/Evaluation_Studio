# Test Guide: Softphone Headless Automation

**Feature**: Programmatic LiveDial automation for scripted outbound voice tests
**Owner**: Platform team
**Branch**: develop
**Status**: BETA — phase 2
**Last Updated**: 2026-04-26
**Implementation Entry Points**:

- `apps/studio/e2e/softphone-automation-runner.ts`
- `apps/studio/src/app/softphone-automation/page.tsx`
- `apps/studio/src/hooks/useSoftphone.ts`

---

## Purpose

This flow provides a programmable, browser-driven version of the existing Studio softphone. It is meant for scripted outbound voice validation where we want to:

- reuse the normal LiveDial registration and dialing path
- inject a prerecorded WAV as microphone input
- detect whether remote audio came back
- optionally capture a recording artifact
- run the whole flow without manual browser clicks

This is a **headless browser automation harness**, not a separate SIP implementation.

---

## Current Scope

The harness currently supports two modes:

- single-turn playback using one prerecorded WAV
- scripted multi-turn playback using a scenario file with multiple clips, waits, and optional DTMF

The current implementation proves:

- Studio auth can be established automatically
- the AudioCodes softphone SDK can register through the existing config flow
- a call can be placed to a provided target number
- prerecorded caller audio can be injected as browser microphone input
- remote audio can be detected automatically
- recording availability can be surfaced in machine-readable state
- multi-turn calls can be orchestrated by waiting for remote speech start and remote silence before sending the next scripted turn
- DTMF steps can be issued in the same call during scenario execution

The current implementation does **not** yet include:

- transcript or semantic response assertions
- CI/nightly orchestration
- a non-browser SIP runner
- fully adaptive turn generation during a live call

---

## How It Works

### Single-Turn Mode

The legacy single-turn runner launches headless Chromium with fake-media flags:

- `--use-fake-ui-for-media-stream`
- `--use-fake-device-for-media-stream`
- `--use-file-for-fake-audio-capture=<wav>%noloop`

It then:

1. logs into Studio via the dev-login API
2. resolves the project to use
3. opens `/softphone-automation`
4. waits for the page to register the softphone
5. auto-dials the requested number
6. watches a machine-readable JSON snapshot rendered by the page
7. finishes when the run reaches `completed` or fails if the page reports `failed`

### Scenario Mode

For multi-turn runs, the runner switches to an automation-only virtual microphone.
Instead of binding Chromium to a single fake WAV for the full browser session, it:

1. loads clip audio from the scenario file
2. injects a virtual microphone stream before the Studio page boots
3. waits for the softphone to register
4. places the call from the automation page
5. plays each scripted step into the same live call
6. waits for remote speech to start
7. waits for remote speech to go quiet for a stable window
8. then moves to the next caller turn

This keeps normal LiveDial untouched while making multi-turn scripted tests possible in the headless harness.

The automation page itself still uses the existing `useSoftphone(...)` orchestration and AudioCodes browser SDK. The only special behavior is that it exposes status for automation and allows registration even when a project has zero voice numbers.

---

## Required Inputs

### Environment Variables

| Variable                                       | Required | Description                                                                                   |
| ---------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `SOFTPHONE_TEST_AUDIO_FILE`                    | Yes\*    | Path to the prerecorded WAV file to feed into the fake microphone in legacy single-turn mode  |
| `SOFTPHONE_TEST_SCENARIO_FILE`                 | Yes\*    | Path to a scenario JSON file for scripted multi-turn mode                                     |
| `SOFTPHONE_TEST_NUMBER`                        | Yes      | Destination phone number to dial                                                              |
| `SOFTPHONE_TEST_PROJECT_ID`                    | Usually  | Project to use directly                                                                       |
| `SOFTPHONE_TEST_PROJECT_NAME`                  | Optional | Used only when `SOFTPHONE_TEST_PROJECT_ID` is omitted; runner selects a matching project card |
| `SOFTPHONE_TEST_EMAIL`                         | No       | Dev-login email for the run; defaults to `softphone-automation@e2e-smoke.test`                |
| `SOFTPHONE_TEST_NAME`                          | No       | Dev-login display name; defaults to `Softphone Automation`                                    |
| `SOFTPHONE_TEST_TIMEOUT_MS`                    | No       | Overall timeout for the whole run; defaults to `120000`                                       |
| `SOFTPHONE_TEST_AUTO_HANGUP_AFTER_RESPONSE_MS` | No       | Delay after remote audio is detected before hanging up; defaults to `1500`                    |
| `SOFTPHONE_TEST_RECORD`                        | No       | Set to `0` to disable recording; default is enabled                                           |
| `SOFTPHONE_TEST_REMOTE_AUDIO_THRESHOLD`        | No       | Peak threshold used for remote speech detection; defaults to `0.015`                          |
| `SOFTPHONE_TEST_SCENARIO_QUIET_WINDOW_MS`      | No       | Silence window required before the next scripted turn; defaults to `1000`                     |
| `SOFTPHONE_TEST_SCENARIO_STEP_TIMEOUT_MS`      | No       | Per-step wait timeout in scenario mode; defaults to `20000`                                   |
| `TEST_BASE_URL`                                | No       | Studio base URL; defaults to the local Studio URL from the shared E2E env helper              |

\* Provide `SOFTPHONE_TEST_AUDIO_FILE` for legacy single-turn mode, or `SOFTPHONE_TEST_SCENARIO_FILE` for scenario mode.

### Preconditions

- the target Studio environment must have dev-login enabled
- the project must be voice-callable and return a working softphone config
- the runner machine must have the WAV file locally available
- the destination number must be routable from the softphone path

---

## Local Usage

### Typical Local Run

```bash
SOFTPHONE_TEST_AUDIO_FILE='/absolute/path/to/input.wav' \
SOFTPHONE_TEST_NUMBER='+19784812614' \
SOFTPHONE_TEST_EMAIL='bhanuraja1997@kore.ai' \
SOFTPHONE_TEST_PROJECT_ID='019daeff-fc4d-7904-a5b4-c5e0afa2d59e' \
pnpm --dir apps/studio test:e2e:softphone
```

### Multi-Turn Scenario Run

```bash
SOFTPHONE_TEST_SCENARIO_FILE='/absolute/path/to/scenario.json' \
SOFTPHONE_TEST_NUMBER='+19784812614' \
SOFTPHONE_TEST_EMAIL='bhanuraja1997@kore.ai' \
SOFTPHONE_TEST_PROJECT_ID='019daeff-fc4d-7904-a5b4-c5e0afa2d59e' \
pnpm --dir apps/studio test:e2e:softphone
```

### Scenario File Shape

```json
{
  "hangupAfterScenario": true,
  "steps": [
    {
      "type": "playAudio",
      "audioFile": "/absolute/path/to/turn-1.wav"
    },
    {
      "type": "playAudio",
      "audioFile": "/absolute/path/to/turn-2.wav",
      "quietWindowMs": 1500
    },
    {
      "type": "dtmf",
      "digits": "1"
    }
  ]
}
```

Supported step types:

- `playAudio`
- `waitForRemoteSpeech`
- `waitForRemoteSilence`
- `dtmf`
- `sleep`

Default behavior for `playAudio` and `dtmf` is:

1. send the caller input
2. wait for remote speech to begin
3. wait for remote speech to go quiet
4. proceed to the next step

If you split those waits into standalone steps, the runner now keeps that turn state attached to the current response window, so `waitForRemoteSpeech` and `waitForRemoteSilence` operate on the intended turn instead of stale prior audio.

### Run Against a Remote Dev Studio

```bash
TEST_BASE_URL='https://agents-dev.kore.ai' \
SOFTPHONE_TEST_AUDIO_FILE='/absolute/path/to/input.wav' \
SOFTPHONE_TEST_NUMBER='+19784812614' \
SOFTPHONE_TEST_EMAIL='softphone-automation@e2e-smoke.test' \
SOFTPHONE_TEST_PROJECT_ID='019daeff-fc4d-7904-a5b4-c5e0afa2d59e' \
pnpm --dir apps/studio test:e2e:softphone
```

### Select by Project Name Instead of Project ID

If `SOFTPHONE_TEST_PROJECT_ID` is omitted, the runner:

1. logs into `/projects`
2. looks for a project card matching `SOFTPHONE_TEST_PROJECT_NAME`
3. falls back to the first visible project card if no name is provided

---

## Automation Page Contract

The page lives at:

- `/softphone-automation`

### Query Parameters

| Param                       | Required | Default                                 | Description                                          |
| --------------------------- | -------- | --------------------------------------- | ---------------------------------------------------- |
| `projectId`                 | Yes      | —                                       | Project used for config + registration               |
| `number`                    | Yes      | —                                       | Number to dial                                       |
| `autostart`                 | No       | `true`                                  | Auto-place the call after registration               |
| `record`                    | No       | `true`                                  | Enable or disable recording                          |
| `autoHangupAfterResponseMs` | No       | disabled on the page, set by the runner | Auto-hangup delay after remote audio is detected     |
| `remoteAudioThreshold`      | No       | `0.015`                                 | Peak threshold used to mark remote audio as detected |

### Machine-Readable Snapshot

The page renders a JSON blob at:

- `data-testid="softphone-automation-snapshot"`

Useful fields include:

- `runState`
- `registrationStatus`
- `callState`
- `remoteAudioDetected`
- `recordingAvailable`
- `lastCallCause`
- `lastError`
- `sipDomain`
- `wsServers`
- `phoneNumberCount`

The runner treats the run as successful when:

- `runState === "completed"`

In practice, the happy-path snapshot should usually show:

- `registrationStatus: "registered"`
- `remoteAudioDetected: true`
- `recordingAvailable: true`
- `lastError: null`

---

## Operational Notes

- This path is still **browser-based**. It does not bypass the AudioCodes browser/WebRTC layer.
- The current softphone is **outbound-focused** for this automation path.
- The automation page reuses the same per-user SIP identity model as the normal softphone and waits for auth before deriving it.
- The automation page is additive. Normal LiveDial entry points and user behavior remain unchanged.
- Projects with zero voice numbers can still register through this automation path because direct-dial automation is the goal of this page.
- Scenario mode is still **scripted**, not fully adaptive. It advances turns based on remote audio start plus remote silence, not transcript semantics.
- Per-step waits are still bounded by the single overall run timeout.

---

## Troubleshooting

### Snapshot Never Appears

Usually means one of:

- wrong `TEST_BASE_URL`
- dev-login disabled on the target
- auth redirect or page load failure

### `runState: "waiting-registration"`

Usually means:

- softphone config loaded, but SIP registration did not complete
- SBC / KoreVG / Jambonz side is not ready
- the environment returned config that is not usable from the runner

### `runState: "failed"` with warnings

Most often points to:

- `softphone-config` not ready
- missing voice gateway configuration
- target environment not prepared for softphone use

### No Remote Audio Detected

Check:

- target number answers
- WAV file actually contains the expected caller utterance
- remote side really returns audio
- `remoteAudioThreshold` is not set too high

---

## Recommended Next Steps

The highest-value follow-ons are:

1. transcript/content assertions instead of audio-only pass/fail
2. per-run artifact export
3. CI/nightly orchestration for selected voice-ready projects
4. fully adaptive turn generation during a live call
