import { randomUUID } from 'node:crypto';

interface StoredOrpheusClip {
  audio?: Buffer;
  sourceText?: string;
  contentType?: string;
  createdAt: number;
  expiresAt: number;
  callSid?: string;
  voice?: string;
  model?: string;
}

const CLIP_TTL_MS = 5 * 60 * 1000;
const MAX_CLIPS = 32;
const clips = new Map<string, StoredOrpheusClip>();

function purgeExpiredClips(now = Date.now()): void {
  for (const [clipId, clip] of clips.entries()) {
    if (clip.expiresAt <= now) {
      clips.delete(clipId);
    }
  }
}

function enforceCapacity(now = Date.now()): void {
  purgeExpiredClips(now);
  if (clips.size < MAX_CLIPS) {
    return;
  }

  const oldest = [...clips.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (clips.size >= MAX_CLIPS && oldest.length > 0) {
    const next = oldest.shift();
    if (!next) {
      break;
    }
    clips.delete(next[0]);
  }
}

export function storeOrpheusPlaybackClip(params: {
  audio?: Buffer;
  sourceText?: string;
  contentType?: string;
  callSid?: string;
  voice?: string;
  model?: string;
}): { clipId: string; expiresAt: number } {
  const now = Date.now();
  enforceCapacity(now);
  const clipId = randomUUID();
  const expiresAt = now + CLIP_TTL_MS;

  clips.set(clipId, {
    audio: params.audio,
    sourceText: params.sourceText,
    contentType: params.contentType || 'audio/wav',
    createdAt: now,
    expiresAt,
    callSid: params.callSid,
    voice: params.voice,
    model: params.model,
  });

  return { clipId, expiresAt };
}

export function getOrpheusPlaybackClip(clipId: string): StoredOrpheusClip | null {
  purgeExpiredClips();
  const clip = clips.get(clipId);
  if (!clip) {
    return null;
  }
  if (clip.expiresAt <= Date.now()) {
    clips.delete(clipId);
    return null;
  }
  return clip;
}
