'use client';

/**
 * TTS Preview Component
 *
 * Inline voice preview control that synthesizes sample text using
 * the tenant's configured TTS credentials. Shared across channel
 * configuration and admin voice services surfaces.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Play, Pause, Loader2, AlertCircle, Volume2, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { SearchableSelect } from '../ui/SearchableSelect';
import { synthesizeTTSPreview } from '../../api/tts-preview';
import { fetchSpeechOptions } from '../../api/speech-providers';

// =============================================================================
// TYPES
// =============================================================================

export interface TTSPreviewProps {
  provider: string;
  serviceInstanceId: string;
  voice?: string;
  model?: string;
  language?: string;
  voiceSettings?: {
    speed?: number;
    stability?: number;
    similarityBoost?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  };
  /** When true, shows a voice ID input to override the configured voice */
  allowVoiceOverride?: boolean;
}

interface VoiceOption {
  value: string;
  label: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_TEXT = 'Hello, how can I help you today?';
const MAX_CHARS = 500;

function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TTSPreview({
  provider,
  serviceInstanceId,
  voice,
  model,
  language,
  voiceSettings,
  allowVoiceOverride = false,
}: TTSPreviewProps) {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [voiceOverride, setVoiceOverride] = useState('');
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [voiceOptionsLoading, setVoiceOptionsLoading] = useState(false);
  const [voiceOptionsError, setVoiceOptionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [shouldAutoplay, setShouldAutoplay] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Cleanup object URL on unmount or before creating a new one
  const revokeAudioUrl = useCallback(() => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => revokeAudioUrl();
  }, [revokeAudioUrl]);

  useEffect(() => {
    if (!shouldAutoplay || !audioRef.current || !audioUrl) return;

    audioRef.current.play().catch(() => {
      setError('Playback failed');
    });
    setShouldAutoplay(false);
  }, [audioUrl, shouldAutoplay]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDurationSeconds(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    const handleTimeUpdate = () => {
      setCurrentTimeSeconds(audio.currentTime || 0);
    };
    const handlePlayEvent = () => setIsPlaying(true);
    const handlePauseEvent = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTimeSeconds(0);
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('play', handlePlayEvent);
    audio.addEventListener('pause', handlePauseEvent);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('play', handlePlayEvent);
      audio.removeEventListener('pause', handlePauseEvent);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [hasPlayed]);

  useEffect(() => {
    setVoiceOverride(voice || '');
  }, [voice]);

  useEffect(() => {
    if (!allowVoiceOverride) {
      setVoiceOptions([]);
      setVoiceOptionsLoading(false);
      setVoiceOptionsError(null);
      return;
    }

    let cancelled = false;

    async function loadVoiceOptions() {
      setVoiceOptionsLoading(true);
      setVoiceOptionsError(null);

      try {
        const options = await fetchSpeechOptions(provider);
        if (cancelled) return;

        const seen = new Set<string>();
        const nextOptions: VoiceOption[] = [];

        for (const languageEntry of options.tts) {
          for (const voiceEntry of languageEntry.voices ?? []) {
            if (seen.has(voiceEntry.value)) continue;
            seen.add(voiceEntry.value);
            nextOptions.push({
              value: voiceEntry.value,
              label: voiceEntry.name,
            });
          }
        }

        setVoiceOptions(nextOptions);
      } catch {
        if (cancelled) return;
        setVoiceOptions([]);
        setVoiceOptionsError('Failed to load voices');
      } finally {
        if (!cancelled) {
          setVoiceOptionsLoading(false);
        }
      }
    }

    void loadVoiceOptions();

    return () => {
      cancelled = true;
    };
  }, [allowVoiceOverride, provider]);

  const handlePlay = useCallback(async () => {
    if (!serviceInstanceId || !text.trim()) return;

    setLoading(true);
    setError(null);
    setLatencyMs(null);

    try {
      const resolvedVoice = (allowVoiceOverride && voiceOverride.trim()) || voice;
      const result = await synthesizeTTSPreview({
        text: text.trim(),
        serviceInstanceId,
        provider: provider as 'elevenlabs' | 'custom:orpheus',
        voice: resolvedVoice || undefined,
        model: model || undefined,
        language: language || undefined,
        ...voiceSettings,
      });

      // Revoke previous URL, create new one
      revokeAudioUrl();
      const url = URL.createObjectURL(result.audioBlob);
      audioUrlRef.current = url;
      setAudioUrl(url);

      setLatencyMs(result.latencyMs);
      setHasPlayed(true);
      setCurrentTimeSeconds(0);
      setDurationSeconds(0);
      setIsPlaying(false);
      setShouldAutoplay(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }, [
    serviceInstanceId,
    text,
    provider,
    voice,
    model,
    language,
    voiceSettings,
    allowVoiceOverride,
    voiceOverride,
    revokeAudioUrl,
  ]);

  const isPlayDisabled = loading || !serviceInstanceId || !text.trim();
  const previewActionLabel = hasPlayed ? 'Regenerate' : 'Generate';

  const handlePlaybackToggle = useCallback(() => {
    if (!audioRef.current) return;

    if (audioRef.current.paused) {
      audioRef.current.play().catch(() => {
        setError('Playback failed');
      });
      return;
    }

    audioRef.current.pause();
  }, []);

  const handleSeek = useCallback((nextValue: string) => {
    if (!audioRef.current) return;

    const seconds = Number(nextValue);
    audioRef.current.currentTime = seconds;
    setCurrentTimeSeconds(seconds);
  }, []);

  return (
    <div className="space-y-2 p-3 rounded-lg border border-default bg-background-subtle">
      <div className="flex items-center gap-1.5">
        <Volume2 className="w-3.5 h-3.5 text-muted" />
        <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Preview Voice
        </span>
      </div>

      {/* Voice override input (admin surface only) */}
      {allowVoiceOverride && (
        <div className="space-y-1">
          {voiceOptions.length > 0 ? (
            <SearchableSelect
              label="Voice"
              options={voiceOptions}
              value={voiceOverride}
              onChange={setVoiceOverride}
              disabled={voiceOptionsLoading}
              placeholder="Use configured voice"
              error={voiceOptionsError || undefined}
            />
          ) : (
            <div className="space-y-1">
              <Input
                label="Voice ID (override)"
                placeholder="Leave empty to use configured voice"
                value={voiceOverride}
                onChange={(e) => setVoiceOverride(e.target.value)}
              />
              {voiceOptionsError && (
                <p className="text-xs text-muted">
                  Failed to load voices. Enter a voice ID manually.
                </p>
              )}
            </div>
          )}
          {voiceOptionsLoading && <p className="text-xs text-muted">Loading voices...</p>}
        </div>
      )}

      {/* Text input */}
      <div className="space-y-1">
        <textarea
          className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm p-2 resize-none focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
          rows={2}
          maxLength={MAX_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type sample text to preview..."
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">
            {text.length} / {MAX_CHARS} characters
          </span>
          <Button
            variant="secondary"
            size="xs"
            onClick={handlePlay}
            disabled={isPlayDisabled}
            loading={loading}
            icon={
              loading ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )
            }
          >
            {loading ? 'Generating...' : previewActionLabel}
          </Button>
        </div>
      </div>

      {/* Audio player */}
      {hasPlayed && (
        <div className="rounded-xl border border-default bg-background-elevated px-3 py-2.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePlaybackToggle}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-default bg-background-muted text-foreground transition-default hover:bg-background-subtle"
              aria-label={isPlaying ? 'Pause preview audio' : 'Play preview audio'}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </button>
            <div className="min-w-0 flex-1 space-y-1">
              <input
                type="range"
                min={0}
                max={durationSeconds || 0}
                step={0.01}
                value={Math.min(currentTimeSeconds, durationSeconds || 0)}
                onChange={(e) => handleSeek(e.target.value)}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-background-muted accent-[var(--color-accent)]"
                disabled={durationSeconds <= 0}
                aria-label="Preview playback progress"
              />
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>{formatPlaybackTime(currentTimeSeconds)}</span>
                <span>{formatPlaybackTime(durationSeconds)}</span>
              </div>
            </div>
          </div>
          <audio ref={audioRef} src={audioUrl ?? undefined} className="hidden" />
        </div>
      )}

      {/* Latency display */}
      {latencyMs !== null && <p className="text-xs text-muted">Generated in {latencyMs}ms</p>}

      {/* Error display */}
      {error && (
        <div className="flex items-start gap-1.5 text-xs text-error">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
