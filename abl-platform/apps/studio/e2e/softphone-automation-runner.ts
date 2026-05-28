import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { z } from 'zod';
import { loginViaDevApi } from './helpers/auth';
import { env } from './helpers/env';

type RunnerMode = 'legacy-single-turn' | 'scenario';

interface RunnerOptions {
  mode: RunnerMode;
  audioFile: string | null;
  targetNumber: string;
  loginEmail: string;
  loginName: string;
  projectId: string | null;
  projectName: string | null;
  timeoutMs: number;
  autoHangupAfterResponseMs: number | null;
  record: boolean;
  recordingOutputPath: string | null;
  remoteAudioThreshold: number;
  scenarioQuietWindowMs: number;
  scenarioStepTimeoutMs: number;
  scenario: AutomationScenario | null;
  clipPayloads: Record<string, EncodedAudioClip>;
}

interface AutomationSnapshot {
  runState?: string;
  registrationStatus?: string;
  callState?: string;
  remoteAudioDetected?: boolean;
  recordingAvailable?: boolean;
  lastCallCause?: string | null;
  lastError?: string | null;
  projectId?: string | null;
  targetNumber?: string | null;
}

interface PageDebugContext {
  url: string;
  title: string;
  bodySnippet: string;
}

interface EncodedAudioClip {
  id: string;
  label: string;
  filePath: string;
  mimeType: string;
  base64: string;
}

interface RemoteMonitorState {
  attached: boolean;
  active: boolean;
  sawSpeech: boolean;
  peak: number;
  lastAboveThresholdAt: number | null;
  lastBelowThresholdAt: number | null;
  lastResetAt: number;
  lastAttachError: string | null;
  threshold: number;
  now: number;
}

interface AutomationPageControls {
  makeCall: (number: string) => void;
  hangup: () => void;
  sendDTMF: (key: string) => void;
}

interface VirtualMicrophoneControls {
  playClip: (clipId: string) => Promise<void>;
}

interface RemoteMonitorControls {
  startMonitoring: (options?: { selector?: string; threshold?: number }) => void;
  reset: () => void;
  getState: () => RemoteMonitorState;
}

type ScenarioStep =
  | ScenarioPlayAudioStep
  | ScenarioWaitForRemoteSpeechStep
  | ScenarioWaitForRemoteSilenceStep
  | ScenarioDtmfStep
  | ScenarioSleepStep;

interface ScenarioPlayAudioStep {
  type: 'playAudio';
  clipId: string;
  label: string;
  waitForRemoteSpeech: boolean;
  waitForRemoteSilence: boolean;
  timeoutMs?: number;
  quietWindowMs?: number;
}

interface ScenarioWaitForRemoteSpeechStep {
  type: 'waitForRemoteSpeech';
  timeoutMs?: number;
}

interface ScenarioWaitForRemoteSilenceStep {
  type: 'waitForRemoteSilence';
  timeoutMs?: number;
  quietWindowMs?: number;
}

interface ScenarioDtmfStep {
  type: 'dtmf';
  digits: string;
  interDigitDelayMs?: number;
  waitForRemoteSpeech: boolean;
  waitForRemoteSilence: boolean;
  timeoutMs?: number;
  quietWindowMs?: number;
}

interface ScenarioSleepStep {
  type: 'sleep';
  durationMs: number;
}

interface AutomationScenario {
  steps: ScenarioStep[];
  hangupAfterScenario: boolean;
}

interface ScenarioExecutionState {
  responseWindowOpen: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
const DEFAULT_AUTO_HANGUP_AFTER_RESPONSE_MS = 1_500;
const DEFAULT_REMOTE_AUDIO_THRESHOLD = 0.015;
const DEFAULT_SCENARIO_QUIET_WINDOW_MS = 1_000;
const DEFAULT_SCENARIO_STEP_TIMEOUT_MS = 20_000;
const REMOTE_AUDIO_SELECTOR = 'audio';
const DTMF_DEFAULT_DELAY_MS = 300;

const baseStepSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  quietWindowMs: z.number().int().positive().optional(),
});

const scenarioStepSchema = z.discriminatedUnion('type', [
  baseStepSchema.extend({
    type: z.literal('playAudio'),
    audioFile: z.string().min(1),
    label: z.string().min(1).optional(),
    waitForRemoteSpeech: z.boolean().optional(),
    waitForRemoteSilence: z.boolean().optional(),
  }),
  baseStepSchema.extend({
    type: z.literal('waitForRemoteSpeech'),
  }),
  baseStepSchema.extend({
    type: z.literal('waitForRemoteSilence'),
  }),
  baseStepSchema.extend({
    type: z.literal('dtmf'),
    digits: z.string().min(1),
    interDigitDelayMs: z.number().int().nonnegative().optional(),
    waitForRemoteSpeech: z.boolean().optional(),
    waitForRemoteSilence: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('sleep'),
    durationMs: z.number().int().positive(),
  }),
]);

const scenarioFileSchema = z.object({
  steps: z.array(scenarioStepSchema).min(1),
  hangupAfterScenario: z.boolean().optional(),
});

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampOverallTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mimeTypeForAudioFile(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.m4a':
      return 'audio/mp4';
    case '.webm':
      return 'audio/webm';
    default:
      return 'audio/wav';
  }
}

function resolveExistingFile(filePath: string, description: string): string {
  const absoluteFilePath = path.resolve(filePath);
  if (!fs.existsSync(absoluteFilePath)) {
    throw new Error(`${description} not found: ${absoluteFilePath}`);
  }
  return absoluteFilePath;
}

function encodeAudioClip(filePath: string, clipId: string, label: string): EncodedAudioClip {
  const absoluteFilePath = resolveExistingFile(filePath, 'Audio file');
  return {
    id: clipId,
    label,
    filePath: absoluteFilePath,
    mimeType: mimeTypeForAudioFile(absoluteFilePath),
    base64: fs.readFileSync(absoluteFilePath).toString('base64'),
  };
}

function loadScenario(): {
  scenario: AutomationScenario | null;
  clipPayloads: Record<string, EncodedAudioClip>;
} {
  const scenarioFile = process.env.SOFTPHONE_TEST_SCENARIO_FILE?.trim();
  if (!scenarioFile) {
    return {
      scenario: null,
      clipPayloads: {},
    };
  }

  const absoluteScenarioFile = resolveExistingFile(scenarioFile, 'Scenario file');
  const parsedScenario = scenarioFileSchema.parse(
    JSON.parse(fs.readFileSync(absoluteScenarioFile, 'utf8')),
  );

  const clipPayloads: Record<string, EncodedAudioClip> = {};
  const steps: ScenarioStep[] = parsedScenario.steps.map((step, index) => {
    if (step.type === 'playAudio') {
      const clipId = `clip-${index + 1}`;
      const clipLabel = step.label?.trim() || path.basename(step.audioFile);
      clipPayloads[clipId] = encodeAudioClip(step.audioFile, clipId, clipLabel);
      return {
        type: 'playAudio',
        clipId,
        label: clipLabel,
        waitForRemoteSpeech: step.waitForRemoteSpeech ?? true,
        waitForRemoteSilence: step.waitForRemoteSilence ?? true,
        timeoutMs: step.timeoutMs,
        quietWindowMs: step.quietWindowMs,
      };
    }

    if (step.type === 'dtmf') {
      return {
        type: 'dtmf',
        digits: step.digits,
        interDigitDelayMs: step.interDigitDelayMs,
        waitForRemoteSpeech: step.waitForRemoteSpeech ?? true,
        waitForRemoteSilence: step.waitForRemoteSilence ?? true,
        timeoutMs: step.timeoutMs,
        quietWindowMs: step.quietWindowMs,
      };
    }

    return step;
  });

  return {
    scenario: {
      steps,
      hangupAfterScenario: parsedScenario.hangupAfterScenario ?? true,
    },
    clipPayloads,
  };
}

function readOptions(): RunnerOptions {
  const targetNumber = process.env.SOFTPHONE_TEST_NUMBER?.trim();
  if (!targetNumber) {
    throw new Error('SOFTPHONE_TEST_NUMBER is required');
  }

  const { scenario, clipPayloads } = loadScenario();
  const mode: RunnerMode = scenario ? 'scenario' : 'legacy-single-turn';

  let audioFile: string | null = null;
  if (mode === 'legacy-single-turn') {
    const rawAudioFile = process.env.SOFTPHONE_TEST_AUDIO_FILE?.trim();
    if (!rawAudioFile) {
      throw new Error('SOFTPHONE_TEST_AUDIO_FILE is required when no scenario file is provided');
    }
    audioFile = resolveExistingFile(rawAudioFile, 'Audio file');
  }

  return {
    mode,
    audioFile,
    targetNumber,
    loginEmail: process.env.SOFTPHONE_TEST_EMAIL?.trim() || 'softphone-automation@e2e-smoke.test',
    loginName: process.env.SOFTPHONE_TEST_NAME?.trim() || 'Softphone Automation',
    projectId: process.env.SOFTPHONE_TEST_PROJECT_ID?.trim() || null,
    projectName: process.env.SOFTPHONE_TEST_PROJECT_NAME?.trim() || null,
    timeoutMs: clampOverallTimeoutMs(
      parsePositiveInteger(process.env.SOFTPHONE_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    ),
    autoHangupAfterResponseMs:
      mode === 'legacy-single-turn'
        ? (parseOptionalPositiveInteger(process.env.SOFTPHONE_TEST_AUTO_HANGUP_AFTER_RESPONSE_MS) ??
          DEFAULT_AUTO_HANGUP_AFTER_RESPONSE_MS)
        : parseOptionalPositiveInteger(process.env.SOFTPHONE_TEST_AUTO_HANGUP_AFTER_RESPONSE_MS),
    record: process.env.SOFTPHONE_TEST_RECORD !== '0',
    recordingOutputPath: process.env.SOFTPHONE_TEST_RECORDING_OUTPUT_PATH?.trim() || null,
    remoteAudioThreshold: parsePositiveFloat(
      process.env.SOFTPHONE_TEST_REMOTE_AUDIO_THRESHOLD,
      DEFAULT_REMOTE_AUDIO_THRESHOLD,
    ),
    scenarioQuietWindowMs: parsePositiveInteger(
      process.env.SOFTPHONE_TEST_SCENARIO_QUIET_WINDOW_MS,
      DEFAULT_SCENARIO_QUIET_WINDOW_MS,
    ),
    scenarioStepTimeoutMs: parsePositiveInteger(
      process.env.SOFTPHONE_TEST_SCENARIO_STEP_TIMEOUT_MS,
      DEFAULT_SCENARIO_STEP_TIMEOUT_MS,
    ),
    scenario,
    clipPayloads,
  };
}

function getRemainingTimeout(deadlineMs: number, label: string): number {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Softphone automation exceeded overall timeout before ${label}`);
  }
  return remainingMs;
}

function getEffectiveTimeout(
  deadlineMs: number,
  requestedTimeoutMs: number,
  label: string,
): number {
  return Math.min(requestedTimeoutMs, getRemainingTimeout(deadlineMs, label));
}

async function resolveProjectId(page: Page, options: RunnerOptions): Promise<string> {
  if (options.projectId) {
    await loginViaDevApi(page, {
      email: options.loginEmail,
      name: options.loginName,
      landingPath: '/projects',
    });
    return options.projectId;
  }

  await loginViaDevApi(page, {
    email: options.loginEmail,
    name: options.loginName,
    landingPath: '/projects',
  });

  const projectCards = page.locator('button:has(h3)');
  const firstVisible = await projectCards
    .first()
    .isVisible({ timeout: 15_000 })
    .catch(() => false);
  if (!firstVisible) {
    throw new Error('No project cards found on /projects after login');
  }

  const targetCard = options.projectName
    ? page.locator('button:has(h3)', {
        hasText: new RegExp(escapeRegExp(options.projectName), 'i'),
      })
    : projectCards.first();

  const cardVisible = await targetCard.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!cardVisible) {
    throw new Error(`Project card not found: ${options.projectName}`);
  }

  await targetCard.click();
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });

  const projectId = page.url().match(/\/projects\/([^/?#]+)/)?.[1];
  if (!projectId) {
    throw new Error(`Failed to extract projectId from URL: ${page.url()}`);
  }

  return projectId;
}

async function readSnapshot(page: Page): Promise<AutomationSnapshot | null> {
  const raw = await page
    .getByTestId('softphone-automation-snapshot')
    .textContent()
    .catch(() => null);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AutomationSnapshot;
  } catch {
    return null;
  }
}

async function getPageDebugContext(page: Page): Promise<PageDebugContext> {
  const title = await page.title().catch(() => '');
  const bodySnippet = await page
    .locator('body')
    .innerText()
    .then((value) => value.slice(0, 1_000))
    .catch(() => '');

  return {
    url: page.url(),
    title,
    bodySnippet,
  };
}

async function waitForSnapshot(
  page: Page,
  predicate: (snapshot: AutomationSnapshot | null) => boolean,
  options: {
    timeoutMs: number;
    label: string;
    pageErrors: string[];
  },
): Promise<AutomationSnapshot> {
  const deadline = Date.now() + options.timeoutMs;
  let lastSnapshot: AutomationSnapshot | null = null;

  while (Date.now() < deadline) {
    lastSnapshot = await readSnapshot(page);
    if (lastSnapshot?.runState === 'failed') {
      throw new Error(
        `Softphone automation failed while waiting for ${options.label}: ${JSON.stringify(lastSnapshot, null, 2)}`,
      );
    }
    if (predicate(lastSnapshot)) {
      return lastSnapshot ?? {};
    }
    await page.waitForTimeout(500);
  }

  const debugContext = await getPageDebugContext(page);
  throw new Error(
    `Timed out waiting for ${options.label} after ${options.timeoutMs}ms. ${JSON.stringify(
      {
        lastSnapshot,
        ...debugContext,
        pageErrors: options.pageErrors,
      },
      null,
      2,
    )}`,
  );
}

async function installScenarioBootstrap(
  context: BrowserContext,
  clipPayloads: Record<string, EncodedAudioClip>,
): Promise<void> {
  const serializedClips = JSON.stringify(
    Object.fromEntries(
      Object.entries(clipPayloads).map(([clipId, clip]) => [
        clipId,
        {
          base64: clip.base64,
          mimeType: clip.mimeType,
          label: clip.label,
        },
      ]),
    ),
  );

  const bootstrapScript = `
    (() => {
      const clipRecords = ${serializedClips};
      const defaultRemoteThreshold = ${JSON.stringify(DEFAULT_REMOTE_AUDIO_THRESHOLD)};
      const mediaDevices = navigator.mediaDevices;
      const originalGetUserMedia = mediaDevices && typeof mediaDevices.getUserMedia === 'function'
        ? mediaDevices.getUserMedia.bind(mediaDevices)
        : null;
      const audioContext = new AudioContext();
      const micDestination = audioContext.createMediaStreamDestination();
      const micGain = audioContext.createGain();
      micGain.gain.value = 1;
      micGain.connect(micDestination);

      const decodedClips = new Map();

      async function ensureAudioContextRunning() {
        if (audioContext.state !== 'running') {
          await audioContext.resume().catch(() => {});
        }
      }

      async function decodeClip(clipId) {
        const cached = decodedClips.get(clipId);
        if (cached) {
          return cached;
        }

        const clip = clipRecords[clipId];
        if (!clip) {
          throw new Error('Unknown clip: ' + clipId);
        }

        const decodePromise = (async () => {
          const binary = atob(clip.base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
          }
          return audioContext.decodeAudioData(bytes.buffer.slice(0));
        })();

        decodedClips.set(clipId, decodePromise);
        return decodePromise;
      }

      if (mediaDevices && originalGetUserMedia) {
        mediaDevices.getUserMedia = async (constraints) => {
          const wantsAudio =
            constraints === undefined ||
            constraints === true ||
            (typeof constraints === 'object' && Boolean(constraints.audio));

          if (wantsAudio) {
            await ensureAudioContextRunning();
            return micDestination.stream;
          }

          return originalGetUserMedia(constraints);
        };
      }

      window.__SOFTPHONE_AUTOMATION_MEDIA__ = {
        async playClip(clipId) {
          await ensureAudioContextRunning();
          const audioBuffer = await decodeClip(clipId);

          await new Promise((resolve) => {
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(micGain);
            source.onended = () => resolve();
            source.start();
          });
        },
      };

      const remoteState = {
        attached: false,
        active: false,
        sawSpeech: false,
        peak: 0,
        lastAboveThresholdAt: null,
        lastBelowThresholdAt: null,
        lastResetAt: Date.now(),
        lastAttachError: null,
        threshold: defaultRemoteThreshold,
        now: Date.now(),
      };

      let remoteAudioContext = null;
      let remoteAnalyser = null;
      let remoteSource = null;
      let remoteAnimationFrameId = null;
      let remoteAttachPollId = null;

      const cleanupRemoteNodes = () => {
        if (remoteAttachPollId !== null) {
          window.clearInterval(remoteAttachPollId);
          remoteAttachPollId = null;
        }
        if (remoteAnimationFrameId !== null) {
          window.cancelAnimationFrame(remoteAnimationFrameId);
          remoteAnimationFrameId = null;
        }
        if (remoteSource) {
          remoteSource.disconnect();
          remoteSource = null;
        }
        if (remoteAnalyser) {
          remoteAnalyser.disconnect();
          remoteAnalyser = null;
        }
        if (remoteAudioContext) {
          void remoteAudioContext.close().catch(() => {});
          remoteAudioContext = null;
        }
        remoteState.attached = false;
      };

      const attachRemoteMonitor = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLAudioElement)) {
          remoteState.lastAttachError = 'Audio element not found for selector: ' + selector;
          return false;
        }

        const stream = element.srcObject;
        if (!(stream instanceof MediaStream)) {
          remoteState.lastAttachError = 'Remote audio stream not attached yet';
          return false;
        }

        cleanupRemoteNodes();

        remoteAudioContext = new AudioContext();
        remoteAnalyser = remoteAudioContext.createAnalyser();
        remoteAnalyser.fftSize = 2048;
        remoteSource = remoteAudioContext.createMediaStreamSource(stream);
        remoteSource.connect(remoteAnalyser);
        void remoteAudioContext.resume().catch(() => {});

        const sampleBuffer = new Float32Array(remoteAnalyser.fftSize);
        remoteState.attached = true;
        remoteState.lastAttachError = null;

        const tick = () => {
          if (!remoteAnalyser) return;

          remoteAnalyser.getFloatTimeDomainData(sampleBuffer);

          let peak = 0;
          for (const sample of sampleBuffer) {
            const absolute = Math.abs(sample);
            if (absolute > peak) {
              peak = absolute;
            }
          }

          const isActive = peak >= remoteState.threshold;
          remoteState.now = Date.now();
          remoteState.peak = peak;
          remoteState.active = isActive;

          if (isActive) {
            remoteState.sawSpeech = true;
            remoteState.lastAboveThresholdAt = remoteState.now;
          } else {
            remoteState.lastBelowThresholdAt = remoteState.now;
          }

          remoteAnimationFrameId = window.requestAnimationFrame(tick);
        };

        tick();
        return true;
      };

      window.__SOFTPHONE_AUTOMATION_REMOTE__ = {
        startMonitoring(options) {
          const selector = (options && options.selector) || 'audio';
          remoteState.threshold = options && options.threshold ? options.threshold : remoteState.threshold;

          if (attachRemoteMonitor(selector)) {
            return;
          }

          remoteAttachPollId = window.setInterval(() => {
            if (attachRemoteMonitor(selector)) {
              if (remoteAttachPollId !== null) {
                window.clearInterval(remoteAttachPollId);
                remoteAttachPollId = null;
              }
            }
          }, 200);
        },
        reset() {
          remoteState.active = false;
          remoteState.sawSpeech = false;
          remoteState.peak = 0;
          remoteState.lastAboveThresholdAt = null;
          remoteState.lastBelowThresholdAt = null;
          remoteState.lastResetAt = Date.now();
          remoteState.now = Date.now();
        },
        getState() {
          return {
            ...remoteState,
            now: Date.now(),
          };
        },
      };
    })();
  `;

  await context.addInitScript({ content: bootstrapScript });
}

async function installRecordingCapture(context: BrowserContext): Promise<void> {
  await context.addInitScript({
    content: `
      (() => {
        const originalCreateObjectURL = URL.createObjectURL.bind(URL);
        let latestRecordingBlob = null;

        URL.createObjectURL = (object) => {
          const url = originalCreateObjectURL(object);
          if (object instanceof Blob && object.type.startsWith('audio/webm')) {
            latestRecordingBlob = object;
          }
          return url;
        };

        window.__SOFTPHONE_AUTOMATION_RECORDING__ = {
          async readLatestBase64() {
            if (!latestRecordingBlob) return null;
            const buffer = await latestRecordingBlob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const chunkSize = 0x8000;
            for (let offset = 0; offset < bytes.length; offset += chunkSize) {
              const chunk = bytes.subarray(offset, offset + chunkSize);
              binary += String.fromCharCode(...chunk);
            }
            return {
              base64: btoa(binary),
              mimeType: latestRecordingBlob.type || 'audio/webm',
              size: latestRecordingBlob.size,
            };
          },
        };
      })();
    `,
  });
}

async function writeCapturedRecording(page: Page, outputPath: string): Promise<void> {
  const recording = await page.evaluate(async () => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_RECORDING__?: {
        readLatestBase64: () => Promise<{ base64: string; mimeType: string; size: number } | null>;
      };
    };
    return automationWindow.__SOFTPHONE_AUTOMATION_RECORDING__?.readLatestBase64() ?? null;
  });

  if (!recording) {
    throw new Error('Softphone recording was marked available but no recording blob was captured');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(recording.base64, 'base64'));
}

async function startRemoteMonitor(page: Page, threshold: number): Promise<void> {
  await page.evaluate(
    ({ selector, thresholdValue }) => {
      const automationWindow = window as typeof window & {
        __SOFTPHONE_AUTOMATION_REMOTE__?: RemoteMonitorControls;
      };
      automationWindow.__SOFTPHONE_AUTOMATION_REMOTE__?.startMonitoring({
        selector,
        threshold: thresholdValue,
      });
    },
    {
      selector: REMOTE_AUDIO_SELECTOR,
      thresholdValue: threshold,
    },
  );
}

async function resetRemoteMonitor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_REMOTE__?: RemoteMonitorControls;
    };
    automationWindow.__SOFTPHONE_AUTOMATION_REMOTE__?.reset();
  });
}

async function getRemoteMonitorState(page: Page): Promise<RemoteMonitorState> {
  return page.evaluate(() => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_REMOTE__?: RemoteMonitorControls;
    };
    return (
      automationWindow.__SOFTPHONE_AUTOMATION_REMOTE__?.getState() ?? {
        attached: false,
        active: false,
        sawSpeech: false,
        peak: 0,
        lastAboveThresholdAt: null,
        lastBelowThresholdAt: null,
        lastResetAt: Date.now(),
        lastAttachError: 'Remote monitor not initialized',
        threshold: 0.015,
        now: Date.now(),
      }
    );
  });
}

async function waitForRemoteSpeech(
  page: Page,
  timeoutMs: number,
  label: string,
): Promise<RemoteMonitorState> {
  const deadline = Date.now() + timeoutMs;
  let lastState = await getRemoteMonitorState(page);

  while (Date.now() < deadline) {
    lastState = await getRemoteMonitorState(page);
    if (lastState.sawSpeech || lastState.active) {
      return lastState;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for remote speech during ${label}: ${JSON.stringify(lastState, null, 2)}`,
  );
}

async function waitForRemoteSilence(
  page: Page,
  timeoutMs: number,
  quietWindowMs: number,
  label: string,
): Promise<RemoteMonitorState> {
  const deadline = Date.now() + timeoutMs;
  let lastState = await getRemoteMonitorState(page);

  while (Date.now() < deadline) {
    lastState = await getRemoteMonitorState(page);
    const silenceReady =
      lastState.sawSpeech &&
      !lastState.active &&
      lastState.lastAboveThresholdAt !== null &&
      lastState.now - lastState.lastAboveThresholdAt >= quietWindowMs;

    if (silenceReady) {
      return lastState;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for remote silence during ${label}: ${JSON.stringify(
      {
        quietWindowMs,
        lastState,
      },
      null,
      2,
    )}`,
  );
}

async function makeCallFromPage(page: Page, number: string): Promise<void> {
  await page.evaluate((numberToCall) => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_PAGE__?: AutomationPageControls;
    };
    const controls = automationWindow.__SOFTPHONE_AUTOMATION_PAGE__;
    if (!controls) {
      throw new Error('Softphone automation page controls are not available');
    }
    controls.makeCall(numberToCall);
  }, number);
}

async function hangupFromPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_PAGE__?: AutomationPageControls;
    };
    const controls = automationWindow.__SOFTPHONE_AUTOMATION_PAGE__;
    if (!controls) {
      throw new Error('Softphone automation page controls are not available');
    }
    controls.hangup();
  });
}

async function sendDtmfFromPage(page: Page, digit: string): Promise<void> {
  await page.evaluate((digitToSend) => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_PAGE__?: AutomationPageControls;
    };
    const controls = automationWindow.__SOFTPHONE_AUTOMATION_PAGE__;
    if (!controls) {
      throw new Error('Softphone automation page controls are not available');
    }
    controls.sendDTMF(digitToSend);
  }, digit);
}

async function playScenarioClip(page: Page, clipId: string): Promise<void> {
  await page.evaluate(async (clipToPlay) => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_MEDIA__?: VirtualMicrophoneControls;
    };
    const media = automationWindow.__SOFTPHONE_AUTOMATION_MEDIA__;
    if (!media) {
      throw new Error('Softphone automation media controls are not available');
    }
    await media.playClip(clipToPlay);
  }, clipId);
}

async function sendDtmfDigits(
  page: Page,
  digits: string,
  interDigitDelayMs: number,
): Promise<void> {
  for (const digit of digits) {
    await sendDtmfFromPage(page, digit);
    if (interDigitDelayMs > 0) {
      await page.waitForTimeout(interDigitDelayMs);
    }
  }
}

async function executeScenario(
  page: Page,
  options: RunnerOptions,
  pageErrors: string[],
  overallDeadlineMs: number,
): Promise<void> {
  if (!options.scenario) {
    return;
  }

  const scenarioState: ScenarioExecutionState = {
    responseWindowOpen: false,
  };

  await waitForSnapshot(page, (snapshot) => snapshot?.registrationStatus === 'registered', {
    timeoutMs: getEffectiveTimeout(overallDeadlineMs, options.timeoutMs, 'softphone registration'),
    label: 'softphone registration',
    pageErrors,
  });

  await startRemoteMonitor(page, options.remoteAudioThreshold);

  await makeCallFromPage(page, options.targetNumber);

  await waitForSnapshot(page, (snapshot) => snapshot?.callState === 'connected', {
    timeoutMs: getEffectiveTimeout(overallDeadlineMs, options.timeoutMs, 'call connection'),
    label: 'call connection',
    pageErrors,
  });

  for (let index = 0; index < options.scenario.steps.length; index += 1) {
    const step = options.scenario.steps[index];
    const stepLabel = `scenario step ${index + 1} (${step.type})`;
    const stepTimeoutMs =
      step.type === 'sleep' ? step.durationMs : (step.timeoutMs ?? options.scenarioStepTimeoutMs);
    const timeoutMs = getEffectiveTimeout(overallDeadlineMs, stepTimeoutMs, stepLabel);
    const quietWindowMs =
      'quietWindowMs' in step && step.quietWindowMs
        ? step.quietWindowMs
        : options.scenarioQuietWindowMs;

    if (step.type === 'playAudio') {
      await resetRemoteMonitor(page);
      scenarioState.responseWindowOpen = true;
      await playScenarioClip(page, step.clipId);
      if (step.waitForRemoteSpeech) {
        await waitForRemoteSpeech(page, timeoutMs, `${stepLabel} remote speech`);
      }
      if (step.waitForRemoteSilence) {
        await waitForRemoteSilence(page, timeoutMs, quietWindowMs, `${stepLabel} remote silence`);
        scenarioState.responseWindowOpen = false;
      }
      continue;
    }

    if (step.type === 'dtmf') {
      await resetRemoteMonitor(page);
      scenarioState.responseWindowOpen = true;
      await sendDtmfDigits(page, step.digits, step.interDigitDelayMs ?? DTMF_DEFAULT_DELAY_MS);
      if (step.waitForRemoteSpeech) {
        await waitForRemoteSpeech(page, timeoutMs, `${stepLabel} remote speech`);
      }
      if (step.waitForRemoteSilence) {
        await waitForRemoteSilence(page, timeoutMs, quietWindowMs, `${stepLabel} remote silence`);
        scenarioState.responseWindowOpen = false;
      }
      continue;
    }

    if (step.type === 'waitForRemoteSpeech') {
      if (!scenarioState.responseWindowOpen) {
        await resetRemoteMonitor(page);
      }
      await waitForRemoteSpeech(page, timeoutMs, stepLabel);
      scenarioState.responseWindowOpen = true;
      continue;
    }

    if (step.type === 'waitForRemoteSilence') {
      if (!scenarioState.responseWindowOpen) {
        await resetRemoteMonitor(page);
        await waitForRemoteSpeech(page, timeoutMs, `${stepLabel} remote speech`);
      }
      await waitForRemoteSilence(page, timeoutMs, quietWindowMs, stepLabel);
      scenarioState.responseWindowOpen = false;
      continue;
    }

    await page.waitForTimeout(timeoutMs);
  }

  if (options.scenario.hangupAfterScenario) {
    await hangupFromPage(page);
  }
}

async function main(): Promise<void> {
  const options = readOptions();
  const overallDeadlineMs = Date.now() + options.timeoutMs;
  const browserArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (options.mode === 'legacy-single-turn' && options.audioFile) {
    browserArgs.push(`--use-file-for-fake-audio-capture=${options.audioFile}%noloop`);
  }

  const browser = await chromium.launch({
    headless: true,
    args: browserArgs,
  });

  let finalSnapshot: AutomationSnapshot | null = null;

  try {
    const context = await browser.newContext();
    await context.grantPermissions(['microphone'], {
      origin: new URL(env.baseUrl).origin,
    });

    if (options.mode === 'scenario') {
      await installScenarioBootstrap(context, options.clipPayloads);
    }
    if (options.recordingOutputPath) {
      await installRecordingCapture(context);
    }

    const page = await context.newPage();
    const pageErrors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        console.error(`[browser:${message.type()}] ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
      console.error(`[pageerror] ${error.message}`);
    });

    const projectId = await resolveProjectId(page, options);

    const automationUrl = new URL('/softphone-automation', env.baseUrl);
    automationUrl.searchParams.set('projectId', projectId);
    automationUrl.searchParams.set('number', options.targetNumber);
    automationUrl.searchParams.set('autostart', options.mode === 'scenario' ? '0' : '1');
    automationUrl.searchParams.set('record', options.record ? '1' : '0');
    automationUrl.searchParams.set('remoteAudioThreshold', String(options.remoteAudioThreshold));
    if (options.autoHangupAfterResponseMs) {
      automationUrl.searchParams.set(
        'autoHangupAfterResponseMs',
        String(options.autoHangupAfterResponseMs),
      );
    }

    await page.goto(automationUrl.toString());
    await page.waitForLoadState('domcontentloaded');
    await page
      .getByTestId('softphone-automation-snapshot')
      .waitFor({ timeout: 15_000 })
      .catch(async () => {
        const debugContext = await getPageDebugContext(page);
        throw new Error(
          `Automation page did not render snapshot. ${JSON.stringify(
            {
              ...debugContext,
              pageErrors,
            },
            null,
            2,
          )}`,
        );
      });

    if (options.mode === 'scenario') {
      await executeScenario(page, options, pageErrors, overallDeadlineMs);
    }

    finalSnapshot = await waitForSnapshot(page, (snapshot) => snapshot?.runState === 'completed', {
      timeoutMs: getEffectiveTimeout(
        overallDeadlineMs,
        options.timeoutMs,
        'completed softphone automation run',
      ),
      label: 'completed softphone automation run',
      pageErrors,
    });

    if (options.recordingOutputPath && finalSnapshot.recordingAvailable) {
      await writeCapturedRecording(page, options.recordingOutputPath);
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          mode: options.mode,
          projectId,
          number: options.targetNumber,
          audioFile: options.audioFile,
          scenarioStepCount: options.scenario?.steps.length ?? 0,
          recordingOutputPath: options.recordingOutputPath,
          snapshot: finalSnapshot,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
