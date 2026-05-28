/**
 * useSoftphone Hook
 *
 * Orchestrates the AudioCodes WebRTC SDK lifecycle:
 * fetch config → provision Jambonz apps → register SIP → expose call controls.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSoftphoneStore } from '../store/softphone-store';
import { useAuthStore } from '../store/auth-store';
import { toast } from 'sonner';
import { SoftphoneManager } from '../lib/softphone-manager';
import {
  fetchSoftphoneConfig,
  fetchSoftphoneNumbers,
  fetchSoftphoneProjectDiagnostics,
  type SoftphoneProjectDiagnostics,
} from '../api/softphone';

/**
 * Generate a session-stable random SIP user suffix.
 * Stored in sessionStorage so re-renders reuse the same ID,
 * but each browser tab gets a unique one — avoids SIP registration conflicts
 * when multiple people (or tabs) use the same login.
 */
function getSipSessionId(): string {
  if (typeof window === 'undefined') return '';
  const key = 'softphone_session_id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)).slice(0, 8);
    sessionStorage.setItem(key, id);
  }
  return id;
}

/** SIP termination causes that indicate a normal call end (not an error) */
const NORMAL_HANGUP_CAUSES = new Set([
  'Location Not Found',
  'BYE',
  'Location Not Found',
  'Redirected',
  '',
]);

/** Map common SIP cause strings to user-friendly messages */
function friendlyCallError(cause: string): string | null {
  if (!cause || NORMAL_HANGUP_CAUSES.has(cause)) return null;
  const lower = cause.toLowerCase();
  if (lower.includes('busy')) return 'Line is busy';
  if (lower.includes('timeout') || lower.includes('request timeout'))
    return 'Call timed out — no answer';
  if (lower.includes('not found') || lower.includes('does not exist'))
    return 'Number not reachable';
  if (lower.includes('rejected') || lower.includes('decline')) return 'Call was rejected';
  if (lower.includes('forbidden') || lower.includes('not acceptable')) return 'Call not allowed';
  if (lower.includes('service unavailable') || lower.includes('temporarily unavailable'))
    return 'Service temporarily unavailable';
  if (lower.includes('server') || lower.includes('internal')) return 'Server error — try again';
  // Return the raw cause for anything unrecognized
  return `Call ended: ${cause}`;
}

type SoftphoneTranslator = ReturnType<typeof useTranslations<'softphone'>>;

function buildProjectWarning(
  diagnostics: SoftphoneProjectDiagnostics,
  t: SoftphoneTranslator,
): string | null {
  if (!diagnostics.hasIssues) {
    return null;
  }

  const issueCount =
    diagnostics.issueCount > 0 ? diagnostics.issueCount : diagnostics.messages.length;
  const agentText =
    diagnostics.failedAgentCount > 0
      ? t('project_setup_warning_agent_text', { agentCount: diagnostics.failedAgentCount })
      : '';
  return t('project_setup_warning', { issueCount, agentText });
}

interface UseSoftphoneOptions {
  projectId: string | null;
  /** Ref to the hidden <audio> element for remote audio playback */
  remoteAudioRef: React.RefObject<HTMLAudioElement | null>;
  /** Allow automation/direct-dial pages to register even when the project has no voice numbers */
  allowDirectDialWithoutProjectNumbers?: boolean;
}

export function useSoftphone({
  projectId,
  remoteAudioRef,
  allowDirectDialWithoutProjectNumbers = false,
}: UseSoftphoneOptions) {
  const store = useSoftphoneStore();
  const t = useTranslations('softphone');
  const user = useAuthStore((s) => s.user);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const managerRef = useRef<SoftphoneManager | null>(null);
  const initializedForProject = useRef<string | null>(null);
  const diagnosticsRequestId = useRef(0);

  // Track user-initiated hangup so we don't show an error banner for it
  const userHangupRef = useRef(false);

  // Recording refs — cleaned up when call ends
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Pre-create the ringback audio element so play() works within user-gesture context
  const ringbackRef = useRef<HTMLAudioElement | null>(null);
  if (typeof window !== 'undefined' && !ringbackRef.current) {
    ringbackRef.current = new Audio('/sounds/ringback.mp3');
    ringbackRef.current.loop = true;
  }

  // Derive SIP username: <emailPrefix>_<sessionId> (e.g., "john_a1b2c3d4")
  // Unique per tab so multiple users/tabs with the same login don't collide on SIP registration
  const emailPrefix = user?.email?.split('@')[0] ?? null;
  const sipUser = isAuthLoading ? null : `${emailPrefix ?? 'testcaller'}_${getSipSessionId()}`;

  const refreshProjectDiagnostics = useCallback(
    async (options: { showToast?: boolean } = {}) => {
      if (!projectId) return null;

      const requestId = ++diagnosticsRequestId.current;
      try {
        const diagnostics = await fetchSoftphoneProjectDiagnostics(projectId);
        if (requestId !== diagnosticsRequestId.current) return diagnostics;

        const warning = buildProjectWarning(diagnostics, t);
        useSoftphoneStore
          .getState()
          .setProjectWarning(warning, warning ? diagnostics.messages.slice(0, 4) : []);

        if (warning && options.showToast) {
          toast.warning(warning);
        }

        return diagnostics;
      } catch {
        if (requestId === diagnosticsRequestId.current) {
          useSoftphoneStore.getState().setProjectWarning(null);
        }
        return null;
      }
    },
    [projectId, t],
  );

  // --- Fetch config and numbers when project changes ---
  useEffect(() => {
    if (isAuthLoading) return;
    if (!projectId || !sipUser) return;
    // Don't re-initialize for same project
    if (initializedForProject.current === projectId) return;

    let cancelled = false;

    async function init() {
      try {
        // Fetch softphone config and phone numbers in parallel
        const [config, numbers] = await Promise.all([
          fetchSoftphoneConfig(),
          fetchSoftphoneNumbers(projectId!),
        ]);

        if (cancelled) return;

        store.setConfig(config.sipDomain, config.wsServers, config.ready, config.warnings);
        store.setPhoneNumbers(numbers);
        refreshProjectDiagnostics().catch(() => undefined);

        // Normal Studio softphone hides itself when a project has no voice numbers.
        // Automation pages can opt into direct dial and still register to the SBC.
        if (numbers.length === 0 && !allowDirectDialWithoutProjectNumbers) return;

        // Don't register if Jambonz account is not ready — show warning toast
        if (!config.ready) {
          toast.warning('Kore Voicegateway not configured for making test calls');
          initializedForProject.current = projectId;
          return;
        }

        // Initialize the softphone manager
        const manager = SoftphoneManager.getInstance();
        managerRef.current = manager;

        manager.setCallbacks({
          onRegistrationStatusChange: (status) => {
            useSoftphoneStore.getState().setRegistrationStatus(status);
          },
          onCallStateChange: (state) => {
            useSoftphoneStore.getState().setCallState(state);

            // Ringback tone: stop when call connects or ends
            if (state !== 'dialing' && state !== 'ringing' && ringbackRef.current) {
              ringbackRef.current.pause();
              ringbackRef.current.currentTime = 0;
            }

            // Recording: start when connected (if enabled), stop when call ends
            if (state === 'connected' && useSoftphoneStore.getState().recordingEnabled) {
              // Small delay to ensure remote stream is attached
              setTimeout(() => startRecording(), 500);
            } else if (state === 'idle') {
              stopRecording();
            }
          },
          onCallTerminated: (cause) => {
            const s = useSoftphoneStore.getState();
            s.setLastCallCause(cause);

            // User-initiated hangup → always clear error, never show new one
            if (userHangupRef.current) {
              userHangupRef.current = false;
              s.setError(null);
              return;
            }

            // Show user-friendly error for non-normal terminations, clear on normal hangup
            const errorMsg = friendlyCallError(cause);
            s.setError(errorMsg);
          },
          onRemoteStream: (stream) => {
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = stream;
            }
          },
          onError: (message) => {
            useSoftphoneStore.getState().setError(message);
          },
        });

        // Register with SBC
        await manager.register({
          sipDomain: config.sipDomain,
          wsServers: config.wsServers,
          sipUser: sipUser!,
          sipPassword: sipUser!,
          displayName: user?.name ?? sipUser!,
        });

        initializedForProject.current = projectId;
      } catch (err) {
        if (!cancelled) {
          store.setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    init();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowDirectDialWithoutProjectNumbers, isAuthLoading, projectId, sipUser]);

  // --- Refresh phone numbers when popover opens ---
  const isOpen = useSoftphoneStore((s) => s.isOpen);
  const callState = useSoftphoneStore((s) => s.callState);
  useEffect(() => {
    if (!isOpen || !projectId || callState !== 'idle') return;
    Promise.all([fetchSoftphoneNumbers(projectId), refreshProjectDiagnostics()])
      .then(([numbers]) => {
        useSoftphoneStore.getState().setPhoneNumbers(numbers);
      })
      .catch(() => {
        // Non-critical — keep existing numbers
      });
  }, [isOpen, projectId, callState, refreshProjectDiagnostics]);

  // --- Recording helpers ---
  const startRecording = useCallback(() => {
    const remoteAudio = remoteAudioRef.current;
    if (!remoteAudio?.srcObject) return;

    // Revoke any previous recording URL to free memory
    const prevUrl = useSoftphoneStore.getState().recordingUrl;
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl);
      useSoftphoneStore.getState().setRecordingUrl(null);
    }

    try {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();

      // Remote audio stream (what the other party says)
      const remoteStream = remoteAudio.srcObject as MediaStream;
      const remoteSource = ctx.createMediaStreamSource(remoteStream);
      remoteSource.connect(dest);

      // Local microphone (our side) — grab from active WebRTC connection
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((localStream) => {
          const localSource = ctx.createMediaStreamSource(localStream);
          localSource.connect(dest);
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn(
            '[Softphone] Mic unavailable, recording remote-only:',
            err instanceof Error ? err.message : String(err),
          );
        });

      const recorder = new MediaRecorder(dest.stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = recorder;
      recordedChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
        const url = URL.createObjectURL(blob);
        useSoftphoneStore.getState().setRecordingUrl(url);
        // Clear chunks to free memory
        recordedChunksRef.current = [];
      };

      // Collect data every 5 seconds to avoid huge single chunk
      recorder.start(5000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        '[Softphone] Recording failed to start:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [remoteAudioRef]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    mediaRecorderRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(
          '[Softphone] AudioContext close error:',
          err instanceof Error ? err.message : String(err),
        );
      });
      audioContextRef.current = null;
    }
  }, []);

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => {
      stopRecording();
      const url = useSoftphoneStore.getState().recordingUrl;
      if (url) URL.revokeObjectURL(url);

      if (ringbackRef.current) {
        ringbackRef.current.pause();
        ringbackRef.current = null;
      }
      if (managerRef.current) {
        managerRef.current.logout();
        managerRef.current = null;
        initializedForProject.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Call actions ---
  const makeCall = useCallback(
    async (number: string) => {
      // Microphone access requires a secure context (HTTPS or localhost)
      if (!navigator.mediaDevices?.getUserMedia) {
        useSoftphoneStore.getState().setError('Microphone unavailable');
        return;
      }
      const manager = managerRef.current;
      if (!manager) return;
      const sipDomain = useSoftphoneStore.getState().sipDomain;
      if (!sipDomain) return;

      // Clear previous recording URL to free memory
      const prevUrl = useSoftphoneStore.getState().recordingUrl;
      if (prevUrl) {
        URL.revokeObjectURL(prevUrl);
        useSoftphoneStore.getState().setRecordingUrl(null);
      }

      // Start ringback tone — must be inside user gesture context for browser autoplay policy
      ringbackRef.current?.play().catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(
          '[Softphone] Ringback play failed:',
          err instanceof Error ? err.message : String(err),
        );
      });

      await refreshProjectDiagnostics({ showToast: true });
      manager.makeCall(`sip:${number}@${sipDomain}`);
    },
    [refreshProjectDiagnostics],
  );

  const hangup = useCallback(() => {
    userHangupRef.current = true;
    managerRef.current?.hangup();
  }, []);

  const sendDTMF = useCallback((key: string) => {
    managerRef.current?.sendDTMF(key);
  }, []);

  const toggleMute = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const newMuted = manager.toggleMute();
    useSoftphoneStore.getState().setMuted(newMuted);
  }, []);

  const toggleHold = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const newHold = manager.toggleHold();
    useSoftphoneStore.getState().setOnHold(newHold);
  }, []);

  return {
    ...store,
    makeCall,
    hangup,
    sendDTMF,
    toggleMute,
    toggleHold,
    hasVoiceNumbers: store.phoneNumbers.length > 0,
    isRegistered: store.registrationStatus === 'registered',
    ready: store.ready,
    warnings: store.warnings,
    projectWarning: store.projectWarning,
    projectWarningDetails: store.projectWarningDetails,
  };
}
