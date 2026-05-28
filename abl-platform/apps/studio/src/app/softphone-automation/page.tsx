'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import Script from 'next/script';
import { initializeAuth } from '@/api/auth';
import { useSoftphone } from '@/hooks/useSoftphone';
import { useSoftphoneStore } from '@/store/softphone-store';

type AuthStatus = 'pending' | 'ready' | 'failed';
type RunState =
  | 'blocked'
  | 'auth-pending'
  | 'auth-ready'
  | 'loading-config'
  | 'waiting-registration'
  | 'ready'
  | 'dialing'
  | 'connected'
  | 'response-detected'
  | 'completed'
  | 'failed';

interface AutomationSnapshot {
  authStatus: AuthStatus;
  projectId: string | null;
  targetNumber: string | null;
  autostart: boolean;
  recordingEnabled: boolean;
  autoHangupAfterResponseMs: number | null;
  runState: RunState;
  registrationStatus: string;
  callState: string;
  ready: boolean;
  warnings: string[];
  sipDomain: string | null;
  wsServers: string[];
  phoneNumberCount: number;
  selectedNumber: string | null;
  remoteAudioDetected: boolean;
  remoteAudioPeak: number;
  dialAttempted: boolean;
  autoHangupScheduled: boolean;
  recordingAvailable: boolean;
  lastCallCause: string | null;
  lastError: string | null;
}

interface SoftphoneAutomationPageControls {
  makeCall: (number: string) => void;
  hangup: () => void;
  sendDTMF: (key: string) => void;
}

function parseFlag(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  return value === '1' || value.toLowerCase() === 'true';
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function SoftphoneAutomationContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  const targetNumber = searchParams.get('number')?.trim() || null;
  const autostart = parseFlag(searchParams.get('autostart'), true);
  const record = parseFlag(searchParams.get('record'), true);
  const autoHangupAfterResponseMs = parsePositiveInteger(
    searchParams.get('autoHangupAfterResponseMs'),
  );
  const remoteAudioThreshold = Number.parseFloat(
    searchParams.get('remoteAudioThreshold') ?? '0.015',
  );
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const responseHangupTimerRef = useRef<number | null>(null);

  const [authStatus, setAuthStatus] = useState<AuthStatus>('pending');
  const [authError, setAuthError] = useState<string | null>(null);
  const [dialAttempted, setDialAttempted] = useState(false);
  const [remoteAudioDetected, setRemoteAudioDetected] = useState(false);
  const [remoteAudioPeak, setRemoteAudioPeak] = useState(0);
  const [autoHangupScheduled, setAutoHangupScheduled] = useState(false);

  const setRecordingEnabled = useSoftphoneStore((s) => s.setRecordingEnabled);

  const {
    registrationStatus,
    callState,
    ready,
    warnings,
    lastError,
    lastCallCause,
    phoneNumbers,
    selectedNumber,
    sipDomain,
    wsServers,
    recordingUrl,
    makeCall,
    hangup,
    sendDTMF,
  } = useSoftphone({
    projectId,
    remoteAudioRef,
    allowDirectDialWithoutProjectNumbers: true,
  });

  useEffect(() => {
    useSoftphoneStore.getState().reset();

    let cancelled = false;
    initializeAuth()
      .then(() => {
        if (cancelled) return;
        setAuthStatus('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : String(err));
        setAuthStatus('failed');
      });

    return () => {
      cancelled = true;
      if (responseHangupTimerRef.current !== null) {
        window.clearTimeout(responseHangupTimerRef.current);
      }
      useSoftphoneStore.getState().reset();
    };
  }, []);

  useEffect(() => {
    setRecordingEnabled(record);
  }, [record, setRecordingEnabled]);

  const triggerDial = useCallback(
    (number: string) => {
      setDialAttempted(true);
      void makeCall(number);
    },
    [makeCall],
  );

  useEffect(() => {
    const automationWindow = window as typeof window & {
      __SOFTPHONE_AUTOMATION_PAGE__?: SoftphoneAutomationPageControls;
    };

    automationWindow.__SOFTPHONE_AUTOMATION_PAGE__ = {
      makeCall: triggerDial,
      hangup,
      sendDTMF,
    };

    return () => {
      delete automationWindow.__SOFTPHONE_AUTOMATION_PAGE__;
    };
  }, [hangup, sendDTMF, triggerDial]);

  useEffect(() => {
    if (!autostart || !projectId || !targetNumber) return;
    if (authStatus !== 'ready') return;
    if (registrationStatus !== 'registered') return;
    if (!ready) return;
    if (dialAttempted) return;

    triggerDial(targetNumber);
  }, [
    authStatus,
    autostart,
    dialAttempted,
    projectId,
    ready,
    registrationStatus,
    targetNumber,
    triggerDial,
  ]);

  useEffect(() => {
    if (responseHangupTimerRef.current !== null) {
      window.clearTimeout(responseHangupTimerRef.current);
      responseHangupTimerRef.current = null;
    }
    setAutoHangupScheduled(false);

    if (callState !== 'connected') {
      setRemoteAudioPeak(0);
      return;
    }

    let disposed = false;
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let animationFrameId: number | null = null;
    let pollId: number | null = null;

    const cleanup = () => {
      disposed = true;
      if (pollId !== null) {
        window.clearInterval(pollId);
      }
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      if (source) {
        source.disconnect();
      }
      if (analyser) {
        analyser.disconnect();
      }
      if (audioContext) {
        void audioContext.close().catch(() => {});
      }
    };

    const attachMonitor = (): boolean => {
      const stream = remoteAudioRef.current?.srcObject;
      if (!(stream instanceof MediaStream)) {
        return false;
      }

      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      void audioContext.resume().catch(() => {});

      const sampleBuffer = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (disposed || !analyser) return;

        analyser.getFloatTimeDomainData(sampleBuffer);
        let peak = 0;
        for (const sample of sampleBuffer) {
          const absolute = Math.abs(sample);
          if (absolute > peak) {
            peak = absolute;
          }
        }

        setRemoteAudioPeak((previous) => Math.max(previous, peak));

        if (peak >= remoteAudioThreshold) {
          setRemoteAudioDetected(true);
        }

        animationFrameId = window.requestAnimationFrame(tick);
      };

      tick();
      return true;
    };

    if (!attachMonitor()) {
      pollId = window.setInterval(() => {
        if (attachMonitor() && pollId !== null) {
          window.clearInterval(pollId);
          pollId = null;
        }
      }, 200);
    }

    return cleanup;
  }, [callState, remoteAudioThreshold]);

  useEffect(() => {
    if (!remoteAudioDetected) return;
    if (callState !== 'connected') return;
    if (!autoHangupAfterResponseMs) return;
    if (responseHangupTimerRef.current !== null) return;

    setAutoHangupScheduled(true);
    responseHangupTimerRef.current = window.setTimeout(() => {
      responseHangupTimerRef.current = null;
      hangup();
    }, autoHangupAfterResponseMs);
  }, [autoHangupAfterResponseMs, callState, hangup, remoteAudioDetected]);

  const runState = useMemo<RunState>(() => {
    if (!projectId || !targetNumber) return 'blocked';
    if (authStatus === 'pending') return 'auth-pending';
    if (authStatus === 'failed') return 'failed';
    if (lastError || authError) return 'failed';
    if (!sipDomain) return 'loading-config';
    if (!ready && warnings.length > 0) return 'failed';
    if (registrationStatus !== 'registered') return 'waiting-registration';
    if (!dialAttempted) return autostart ? 'ready' : 'auth-ready';
    if (callState === 'dialing' || callState === 'ringing' || callState === 'on-hold') {
      return 'dialing';
    }
    if (callState === 'connected' && remoteAudioDetected) {
      return 'response-detected';
    }
    if (callState === 'connected') {
      return 'connected';
    }
    if (callState === 'idle' && dialAttempted) {
      if (remoteAudioDetected || Boolean(recordingUrl)) {
        return 'completed';
      }
      if (lastCallCause) {
        return 'failed';
      }
    }
    return 'ready';
  }, [
    authError,
    authStatus,
    autostart,
    callState,
    dialAttempted,
    lastCallCause,
    lastError,
    projectId,
    ready,
    recordingUrl,
    registrationStatus,
    remoteAudioDetected,
    sipDomain,
    targetNumber,
    warnings,
  ]);

  const snapshot = useMemo<AutomationSnapshot>(
    () => ({
      authStatus,
      projectId,
      targetNumber,
      autostart,
      recordingEnabled: record,
      autoHangupAfterResponseMs,
      runState,
      registrationStatus,
      callState,
      ready,
      warnings,
      sipDomain,
      wsServers: wsServers ?? [],
      phoneNumberCount: phoneNumbers.length,
      selectedNumber,
      remoteAudioDetected,
      remoteAudioPeak: roundTo(remoteAudioPeak, 4),
      dialAttempted,
      autoHangupScheduled,
      recordingAvailable: Boolean(recordingUrl),
      lastCallCause,
      lastError: lastError ?? authError,
    }),
    [
      authError,
      authStatus,
      autoHangupAfterResponseMs,
      autoHangupScheduled,
      autostart,
      callState,
      dialAttempted,
      lastCallCause,
      lastError,
      phoneNumbers.length,
      projectId,
      ready,
      record,
      recordingUrl,
      registrationStatus,
      remoteAudioDetected,
      remoteAudioPeak,
      runState,
      selectedNumber,
      sipDomain,
      targetNumber,
      warnings,
      wsServers,
    ],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Script src="/js/ac_webrtc.min.js" strategy="afterInteractive" />
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-6 py-10">
        <div className="space-y-2">
          <p className="text-sm uppercase tracking-[0.24em] text-muted">Softphone Automation</p>
          <h1 className="text-3xl font-semibold">Headless LiveDial Runner</h1>
          <p className="max-w-3xl text-sm text-muted">
            This page reuses the existing Studio softphone flow and exposes machine-readable state
            for a headless browser runner.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-default bg-background-subtle p-5">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-muted">
              Status
            </h2>
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Run State</dt>
                <dd data-testid="softphone-automation-run-state" className="font-mono">
                  {runState}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Auth</dt>
                <dd data-testid="softphone-automation-auth-status" className="font-mono">
                  {authStatus}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Registration</dt>
                <dd data-testid="softphone-automation-registration-status" className="font-mono">
                  {registrationStatus}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Call State</dt>
                <dd data-testid="softphone-automation-call-state" className="font-mono">
                  {callState}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Remote Audio</dt>
                <dd data-testid="softphone-automation-remote-audio" className="font-mono">
                  {remoteAudioDetected ? 'detected' : 'waiting'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Recording</dt>
                <dd data-testid="softphone-automation-recording" className="font-mono">
                  {recordingUrl ? 'available' : record ? 'armed' : 'disabled'}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-default bg-background-subtle p-5">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-muted">
              Inputs
            </h2>
            <dl className="space-y-3 text-sm">
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted">Project</dt>
                <dd className="max-w-[60%] break-all font-mono">{projectId ?? 'missing'}</dd>
              </div>
              <div className="flex items-start justify-between gap-4">
                <dt className="text-muted">Target</dt>
                <dd className="max-w-[60%] break-all font-mono">{targetNumber ?? 'missing'}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Voice Numbers</dt>
                <dd className="font-mono">{phoneNumbers.length}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Auto Start</dt>
                <dd className="font-mono">{autostart ? 'enabled' : 'disabled'}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Auto Hangup</dt>
                <dd className="font-mono">
                  {autoHangupAfterResponseMs ? `${autoHangupAfterResponseMs}ms` : 'disabled'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted">Remote Audio Peak</dt>
                <dd className="font-mono">{roundTo(remoteAudioPeak, 4)}</dd>
              </div>
            </dl>
          </div>
        </div>

        {(warnings.length > 0 || lastError || authError || lastCallCause) && (
          <div className="rounded-2xl border border-warning/30 bg-warning/10 p-5 text-sm">
            <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-warning">
              Diagnostics
            </h2>
            <div className="space-y-2">
              {warnings.length > 0 && (
                <p data-testid="softphone-automation-warnings">{warnings.join(' | ')}</p>
              )}
              {lastError && <p data-testid="softphone-automation-error">{lastError}</p>}
              {authError && <p>{authError}</p>}
              {lastCallCause && <p data-testid="softphone-automation-cause">{lastCallCause}</p>}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-default bg-black/80 p-5">
          <div className="mb-3 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium uppercase tracking-[0.18em] text-white/70">
              Snapshot
            </h2>
            <span className="text-xs text-white/40">Consumed by the headless runner</span>
          </div>
          <pre
            data-testid="softphone-automation-snapshot"
            className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-white/90"
          >
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function SoftphoneAutomationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        </div>
      }
    >
      <SoftphoneAutomationContent />
    </Suspense>
  );
}
