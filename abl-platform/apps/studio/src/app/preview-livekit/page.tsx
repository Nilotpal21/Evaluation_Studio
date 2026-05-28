'use client';

import { Suspense, useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, Mic, MicOff, Volume2, AlertCircle, Phone, PhoneOff } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { initializeAuth } from '@/api/auth';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  clearPersistedShareTokenFromBrowserSession,
  consumeShareTokenFromBrowserLocation,
} from '@/lib/share-preview-link';

type VoiceState = 'idle' | 'connecting' | 'listening' | 'processing' | 'speaking' | 'error';

// Progressive steps during connection — shown to user as status text
type ConnectStep = 'token' | 'room' | 'mic' | 'ready' | null;

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

interface TimingData {
  total: number;
  stt: number;
  llm: number;
  tts: number;
  ttsFirstChunk: number;
}

// =============================================================================
// VOICE ORB — Animated state indicator
// =============================================================================

function VoiceOrb({
  state,
  connectStep,
  onConnect,
  onDisconnect,
  disabled,
}: {
  state: VoiceState;
  connectStep: ConnectStep;
  onConnect: () => void;
  onDisconnect: () => void;
  disabled: boolean;
}) {
  const isActive = state !== 'idle' && state !== 'error' && state !== 'connecting';

  const orbColor =
    state === 'listening'
      ? 'bg-error shadow-[0_0_40px_rgba(239,68,68,0.3)]'
      : state === 'processing'
        ? 'bg-accent shadow-[0_0_40px_rgba(99,102,241,0.3)]'
        : state === 'speaking'
          ? 'bg-success shadow-[0_0_40px_rgba(34,197,94,0.3)]'
          : '';

  // Progress percentage for the connecting ring
  const connectProgress =
    connectStep === 'token'
      ? 25
      : connectStep === 'room'
        ? 55
        : connectStep === 'mic'
          ? 80
          : connectStep === 'ready'
            ? 100
            : 0;

  return (
    <div className="relative flex items-center justify-center" style={{ width: 180, height: 180 }}>
      {/* Pulsing rings for active states */}
      {state === 'listening' && (
        <span
          className="absolute inset-[-16px] rounded-full border-2 border-error/30 animate-ping"
          style={{ animationDuration: '2s' }}
        />
      )}
      {state === 'speaking' && (
        <span className="absolute inset-[-16px] rounded-full border-2 border-success/30 animate-pulse" />
      )}
      {state === 'processing' && (
        <span
          className="absolute inset-[-16px] rounded-full border-2 border-accent/30 border-t-accent animate-spin"
          style={{ animationDuration: '1.5s' }}
        />
      )}

      {/* Progress ring during connection */}
      {state === 'connecting' && (
        <svg
          className="absolute inset-[-12px]"
          viewBox="0 0 204 204"
          style={{ width: 204, height: 204 }}
        >
          <circle
            cx="102"
            cy="102"
            r="96"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-background-muted"
          />
          <circle
            cx="102"
            cy="102"
            r="96"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-accent"
            strokeDasharray={`${2 * Math.PI * 96}`}
            strokeDashoffset={`${2 * Math.PI * 96 * (1 - connectProgress / 100)}`}
            strokeLinecap="round"
            transform="rotate(-90 102 102)"
            style={{ transition: 'stroke-dashoffset 0.4s ease-out' }}
          />
        </svg>
      )}

      {/* Button */}
      {state === 'idle' || state === 'error' ? (
        <button
          onClick={onConnect}
          disabled={disabled}
          className="relative w-36 h-36 rounded-full flex items-center justify-center bg-accent shadow-[0_0_40px_rgba(99,102,241,0.25)] transition-all duration-300 hover:scale-105 hover:shadow-[0_0_60px_rgba(99,102,241,0.35)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
        >
          <Phone className="w-12 h-12 text-accent-foreground" />
        </button>
      ) : state === 'connecting' ? (
        <div className="relative w-36 h-36 rounded-full flex items-center justify-center bg-background-elevated">
          <Loader2 className="w-10 h-10 text-accent animate-spin" />
        </div>
      ) : (
        <button
          onClick={onDisconnect}
          className={`relative w-36 h-36 rounded-full flex items-center justify-center transition-all duration-300 ${orbColor || 'bg-background-elevated hover:bg-background-muted'}`}
        >
          {state === 'listening' ? (
            <Mic className="w-12 h-12 text-error-foreground" />
          ) : state === 'processing' ? (
            <Loader2 className="w-12 h-12 text-accent-foreground animate-spin" />
          ) : state === 'speaking' ? (
            <Volume2 className="w-12 h-12 text-success-foreground" />
          ) : (
            <PhoneOff className="w-12 h-12 text-foreground" />
          )}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// TRANSCRIPT PANEL — Chat-style message list with inline timing
// =============================================================================

function TranscriptPanel({
  transcripts,
  currentTranscript,
  timing,
}: {
  transcripts: TranscriptEntry[];
  currentTranscript: string;
  timing: TimingData | null;
}) {
  const t = useTranslations('preview.livekit');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts, currentTranscript]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-3">
        {transcripts.length === 0 && !currentTranscript && (
          <div className="flex items-center justify-center h-full">
            <p className="text-foreground-subtle text-sm">{t('start_speaking_hint')}</p>
          </div>
        )}
        {transcripts.map((entry, i) => (
          <div
            key={i}
            className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] px-4 py-2.5 text-sm leading-relaxed ${
                entry.role === 'user'
                  ? 'bg-accent text-accent-foreground rounded-2xl rounded-br-md'
                  : 'bg-background-elevated text-foreground rounded-2xl rounded-bl-md'
              }`}
            >
              {entry.text}
            </div>
          </div>
        ))}
        {currentTranscript && (
          <div className="flex justify-end">
            <div className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-br-md text-sm bg-accent/30 text-foreground-muted italic">
              {currentTranscript}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Compact timing footer */}
      {timing && (
        <div className="shrink-0 px-5 py-2.5 border-t border-default bg-background flex items-center gap-4 text-xs">
          <span className="text-foreground-subtle font-medium uppercase tracking-wider">
            {t('latency_label')}
          </span>
          <span className="font-mono text-foreground">
            {timing.total}
            <span className="text-foreground-subtle">ms</span>
          </span>
          <span className="text-foreground-subtle">|</span>
          <span className="font-mono text-accent">
            {timing.stt}
            <span className="text-foreground-subtle">ms stt</span>
          </span>
          <span className="font-mono text-purple">
            {timing.llm}
            <span className="text-foreground-subtle">ms llm</span>
          </span>
          <span className="font-mono text-success">
            {timing.tts}
            <span className="text-foreground-subtle">ms tts</span>
          </span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN CONTENT
// =============================================================================

function LiveKitPreviewContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId');
  const sessionId = searchParams.get('sessionId') || `lk_${Date.now()}`;
  const agentName = searchParams.get('agentName') || undefined;
  const t = useTranslations('preview.livekit');
  const tPreview = useTranslations('preview');

  const accessToken = useAuthStore((s) => s.accessToken);
  const tenantId = useAuthStore((s) => s.tenantId);

  const [sdkToken, setSdkToken] = useState<string | null>(null);
  const [shareProjectId, setShareProjectId] = useState<string | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [shareTokenReady, setShareTokenReady] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [connectStep, setConnectStep] = useState<ConnectStep>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [agentJoined, setAgentJoined] = useState(false);
  const [timing, setTiming] = useState<TimingData | null>(null);
  const [livekitAvailable, setLivekitAvailable] = useState<boolean | null>(null);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [authReady, setAuthReady] = useState(false);

  const roomRef = useRef<any>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const lkModuleRef = useRef<any>(null);
  const micProbeRef = useRef<Promise<string | undefined> | null>(null);
  const connectingRef = useRef(false);

  // Initialize auth on mount — this page is standalone (not wrapped by App.tsx)
  // so we must obtain the access token from the httpOnly refresh cookie ourselves.
  useEffect(() => {
    void initializeAuth().then(() => {
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    const resolved = consumeShareTokenFromBrowserLocation();
    setShareToken(resolved.token);
    setShareTokenReady(true);
  }, []);

  // Preload livekit-client on mount (JS-only, no hardware access)
  useEffect(() => {
    (import('livekit-client' as string) as Promise<any>)
      .then((mod) => {
        lkModuleRef.current = mod;
        setSdkLoaded(true);
      })
      .catch(() => setSdkLoaded(true));
  }, []);

  // Start mic probe after LiveKit is confirmed available (deferred from mount to avoid
  // triggering mic permission prompt before the user sees the page)
  useEffect(() => {
    if (!livekitAvailable) return;
    micProbeRef.current = (async (): Promise<string | undefined> => {
      try {
        const testStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const checkCtx = new AudioContext({
          sampleRate: testStream.getAudioTracks()[0]?.getSettings()?.sampleRate || 48000,
        });
        await checkCtx.resume();
        const src = checkCtx.createMediaStreamSource(testStream);
        const analyser = checkCtx.createAnalyser();
        analyser.fftSize = 2048;
        src.connect(analyser);
        await new Promise((r) => setTimeout(r, 150));
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let maxAbs = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > maxAbs) maxAbs = a;
        }
        src.disconnect();
        checkCtx.close();
        testStream.getTracks().forEach((t) => t.stop());
        setMicReady(true);
        if (maxAbs === 0) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const builtIn = devices.find(
            (d) =>
              d.kind === 'audioinput' &&
              d.label.includes('Built-in') &&
              !d.label.includes('Virtual'),
          );
          return builtIn?.deviceId;
        }
      } catch {
        // Mic permission denied or failed — still mark ready so user sees the error state
        setMicReady(true);
      }
      return undefined;
    })();
  }, [livekitAvailable]);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (sdkToken) {
      headers['X-SDK-Token'] = sdkToken;
    } else {
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      if (tenantId) headers['X-Tenant-Id'] = tenantId;
    }
    return headers;
  }, [sdkToken, accessToken, tenantId]);

  const resolvedProjectId = shareProjectId || projectId;

  // Exchange share token for SDK session JWT
  useEffect(() => {
    if (!shareTokenReady || !shareToken) return;
    fetch('/api/sdk/share/exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: shareToken, requiredPermission: 'session:voice' }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.valid) {
          setSdkToken(data.sdkToken);
          setShareProjectId(data.projectId);
          clearPersistedShareTokenFromBrowserSession();
        } else {
          setError(t('invalid_share_link'));
        }
      })
      .catch(() => setError(t('invalid_share_link')));
  }, [shareToken, shareTokenReady, t]);

  // Check LiveKit capabilities (wait for auth initialization first)
  useEffect(() => {
    if (!authReady) return;
    if (!shareTokenReady) return;
    if (shareToken && !sdkToken) return;
    const checkCapabilities = async () => {
      try {
        const res = await fetch('/api/livekit/capabilities', {
          headers: getAuthHeaders(),
        });
        if (res.status === 401) {
          setLivekitAvailable(false);
          setError(shareToken ? t('invalid_share_link') : t('not_authenticated'));
          return;
        }
        const data = await res.json();
        setLivekitAvailable(data.configured);
        if (!data.configured) {
          setError(t('livekit_not_configured'));
        }
      } catch {
        setLivekitAvailable(false);
        setError(t('server_unreachable'));
      }
    };
    checkCapabilities();
  }, [authReady, getAuthHeaders, shareToken, shareTokenReady, sdkToken, t]);

  // Disconnect on unmount
  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current
          .disconnect()
          .catch((err: unknown) =>
            console.warn('LiveKit room disconnect failed', sanitizeError(err, 'Disconnect failed')),
          );
        roomRef.current = null;
      }
      if (audioElementRef.current) {
        audioElementRef.current.remove();
        audioElementRef.current = null;
      }
    };
  }, []);

  const connect = useCallback(async () => {
    if (connectingRef.current) return; // prevent double-click
    if (!resolvedProjectId) {
      setError(t('missing_project_id'));
      return;
    }

    connectingRef.current = true;
    setVoiceState('connecting');
    setConnectStep('token');
    setError(null);

    try {
      // Step 1: Fetch token
      const tokenRes = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ sessionId, projectId: resolvedProjectId, agentName }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.json();
        throw new Error(err.error || 'Failed to get LiveKit token');
      }

      const { token, url } = await tokenRes.json();

      // Step 2: Connect to room
      setConnectStep('room');

      // Use preloaded module (falls back to fresh import if not ready)
      const lk: any =
        lkModuleRef.current || (await (import('livekit-client' as string) as Promise<any>));
      const { Room, RoomEvent, Track } = lk;

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room.on(RoomEvent.TrackSubscribed, (track: any) => {
        if (track.kind === Track.Kind.Audio) {
          const audioEl = track.attach();
          audioEl.style.display = 'none';
          document.body.appendChild(audioEl);
          audioElementRef.current = audioEl;
          // Ensure playback starts (Chrome may block without explicit play after gesture)
          audioEl
            .play()
            .catch((err: unknown) =>
              console.warn('Audio playback failed', sanitizeError(err, 'Playback failed')),
            );
        }
      });

      room.on(RoomEvent.TrackUnsubscribed, (track: any) => {
        if (track.kind === Track.Kind.Audio) {
          track.detach().forEach((el: HTMLElement) => el.remove());
          if (audioElementRef.current) {
            audioElementRef.current.remove();
            audioElementRef.current = null;
          }
        }
      });

      room.on(RoomEvent.ParticipantConnected, () => setAgentJoined(true));
      room.on(RoomEvent.ParticipantDisconnected, () => {
        if (room.remoteParticipants.size === 0) setAgentJoined(false);
      });

      room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
        try {
          const data = JSON.parse(new TextDecoder().decode(payload));
          if (data.type === 'transcript') {
            if (data.userText) {
              setTranscripts((prev) => [
                ...prev,
                {
                  role: 'user',
                  text: data.userText,
                  timestamp: data.timestamp || Date.now(),
                },
              ]);
            }
            if (data.agentText) {
              setTranscripts((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  text: data.agentText,
                  timestamp: data.timestamp || Date.now(),
                },
              ]);
            }
            setCurrentTranscript('');
          }
          if (data.type === 'timing') {
            setTiming(data.timing);
          }
        } catch {
          // Non-JSON data
        }
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
        const agentIsSpeaking = speakers.some(
          (s: any) => s.identity !== room.localParticipant?.identity,
        );
        if (agentIsSpeaking) setVoiceState('speaking');
        else if (room.state === 'connected') setVoiceState('listening');
      });

      room.on(RoomEvent.Disconnected, () => {
        connectingRef.current = false;
        setIsConnected(false);
        setAgentJoined(false);
        setConnectStep(null);
        setVoiceState('idle');
      });

      await room.connect(url, token);
      setIsConnected(true);

      // Step 3: Enable microphone
      setConnectStep('mic');
      const micDeviceId = micProbeRef.current ? await micProbeRef.current : undefined;
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true, {
        ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
      });

      // Step 4: Ready
      setConnectStep('ready');
      // Brief pause to show "ready" before transitioning to listening
      await new Promise((r) => setTimeout(r, 300));
      setConnectStep(null);
      connectingRef.current = false;
      setVoiceState('listening');
    } catch (err) {
      connectingRef.current = false;
      setConnectStep(null);
      setError(sanitizeError(err, 'Connection failed'));
      setVoiceState('error');
    }
  }, [resolvedProjectId, sessionId, agentName, getAuthHeaders, t]);

  const disconnect = useCallback(async () => {
    connectingRef.current = false;
    if (roomRef.current) {
      await roomRef.current.disconnect();
      roomRef.current = null;
    }
    if (audioElementRef.current) {
      audioElementRef.current.remove();
      audioElementRef.current = null;
    }
    setIsConnected(false);
    setAgentJoined(false);
    setConnectStep(null);
    setVoiceState('idle');
  }, []);

  const toggleMic = useCallback(async () => {
    if (!roomRef.current || !isConnected) return;
    const room = roomRef.current;
    const enabled = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!enabled);
  }, [isConnected]);

  // State label text — progressive steps during connection
  const stateLabel =
    voiceState === 'idle' && !isConnected
      ? t('start_conversation')
      : voiceState === 'connecting' && connectStep === 'token'
        ? t('authenticating')
        : voiceState === 'connecting' && connectStep === 'room'
          ? t('connecting_room')
          : voiceState === 'connecting' && connectStep === 'mic'
            ? t('enabling_mic')
            : voiceState === 'connecting' && connectStep === 'ready'
              ? t('ready')
              : voiceState === 'connecting'
                ? t('connecting')
                : voiceState === 'listening'
                  ? t('listening')
                  : voiceState === 'processing'
                    ? t('processing')
                    : voiceState === 'speaking'
                      ? t('agent_speaking')
                      : '';

  const stateColor =
    voiceState === 'listening'
      ? 'text-error'
      : voiceState === 'processing'
        ? 'text-accent'
        : voiceState === 'speaking'
          ? 'text-success'
          : voiceState === 'connecting' && connectStep === 'ready'
            ? 'text-success'
            : voiceState === 'connecting'
              ? 'text-accent'
              : 'text-foreground-muted';

  // ─── Loading — wait for capabilities, SDK bundle, AND mic warmup ────
  if (livekitAvailable === null || !sdkLoaded || (livekitAvailable && !micReady)) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto mb-4" />
          <p className="text-foreground-muted text-sm">
            {livekitAvailable === null
              ? t('checking_availability')
              : !sdkLoaded
                ? t('loading_voice_sdk')
                : t('setting_up_mic')}
          </p>
        </div>
      </div>
    );
  }

  // ─── Error (not connected) ────────────────────────────────────────────
  if (error && !isConnected) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-error-subtle flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-error" />
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">{t('connection_error')}</h2>
          <p className="text-foreground-muted text-sm mb-6">{error}</p>
          {livekitAvailable && (
            <button
              onClick={() => {
                setError(null);
                connect();
              }}
              className="px-5 py-2.5 bg-accent text-accent-foreground rounded-lg font-medium text-sm hover:opacity-90 transition-all"
            >
              {t('retry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── Main layout ──────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Keyframes */}
      <style jsx global>{`
        @keyframes soundWave {
          0% {
            transform: scaleY(0.3);
          }
          100% {
            transform: scaleY(1);
          }
        }
      `}</style>

      {/* Compact top bar — status only, no redundant title */}
      <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-default">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-foreground">{t('voice_preview_title')}</h1>
          {resolvedProjectId && (
            <span className="text-xs text-foreground-subtle">{resolvedProjectId}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
              isConnected
                ? 'bg-success-subtle text-success'
                : 'bg-background-muted text-foreground-subtle'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-success' : 'bg-foreground-subtle'}`}
            />
            {isConnected ? tPreview('connected') : tPreview('disconnected')}
          </span>
          {agentJoined && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-accent-subtle text-accent">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              {t('agent_label')}
            </span>
          )}
        </div>
      </div>

      {/* Two-panel body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left panel — Voice orb, minimal controls */}
        <div className="lg:w-[400px] shrink-0 flex flex-col items-center justify-center gap-5 px-6 py-6 lg:py-0 lg:border-r border-default">
          <VoiceOrb
            state={voiceState}
            connectStep={connectStep}
            onConnect={connect}
            onDisconnect={disconnect}
            disabled={!livekitAvailable}
          />

          {/* State label */}
          <p className={`text-sm font-medium ${stateColor}`}>{stateLabel}</p>

          {/* Audio visualization bars for active states */}
          {(voiceState === 'listening' || voiceState === 'speaking') && (
            <div className="flex items-end gap-1 h-5">
              {[35, 65, 100, 75, 40, 90, 55].map((h, i) => (
                <div
                  key={i}
                  className={`w-[3px] rounded-full ${voiceState === 'listening' ? 'bg-error' : 'bg-success'}`}
                  style={{
                    height: `${h}%`,
                    animation: `soundWave 0.6s ease-in-out infinite alternate ${i * 0.08}s`,
                  }}
                />
              ))}
            </div>
          )}

          {/* Mic toggle — only when connected */}
          {isConnected && (
            <button
              onClick={toggleMic}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-background-subtle hover:bg-background-muted text-foreground-muted text-sm transition-all border border-default"
            >
              {voiceState === 'listening' ? (
                <>
                  <MicOff className="w-4 h-4" /> {t('mute')}
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4" /> {t('unmute')}
                </>
              )}
            </button>
          )}

          {/* Speak-to-interrupt hint */}
          {voiceState === 'speaking' && (
            <p className="text-xs text-foreground-subtle">{t('speak_to_interrupt')}</p>
          )}
        </div>

        {/* Right panel — Transcript */}
        <div className="flex-1 min-h-0 flex flex-col bg-background-subtle">
          <TranscriptPanel
            transcripts={transcripts}
            currentTranscript={currentTranscript}
            timing={timing}
          />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// PAGE WRAPPER
// =============================================================================

export default function LiveKitPreviewPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen bg-background flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
        </div>
      }
    >
      <LiveKitPreviewContent />
    </Suspense>
  );
}
