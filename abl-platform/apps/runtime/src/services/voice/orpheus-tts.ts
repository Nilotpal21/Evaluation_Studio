import { PassThrough, Readable } from 'node:stream';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('orpheus-tts');

export const ORPHEUS_API_URL = 'https://api.groq.com/openai/v1/audio/speech';
export const ORPHEUS_DEFAULT_MODEL = 'canopylabs/orpheus-v1-english';
export const ORPHEUS_DEFAULT_VOICE = 'hannah';
export const ORPHEUS_MAX_INPUT_CHARS = 200;
export const ORPHEUS_TELEPHONY_SAMPLE_RATE = 8_000;
const ORPHEUS_WAV_AUDIO_FORMAT_PCM = 1;
const ORPHEUS_WAV_BITS_PER_SAMPLE = 16;
const ORPHEUS_WAV_CHANNELS = 1;
const ORPHEUS_WAV_SAMPLE_RATE = 24_000;

const TTS_TAG_RE = /<(emotion|speed|break)\b[^>]*\/>/gi;
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
const GENERIC_XML_TAG_RE = /<\/?[^>]+>/g;
const SAINT_RE = /\bSt\.\s+(?=[A-Z])/g;
const DOLLAR_AMOUNT_RE = /\$([0-9][0-9,]*)(?:\.(\d{2}))?/g;
const RESAMPLER_DEFAULT_LOW_PASS_TAPS = 63;
const RESAMPLER_DEFAULT_CUTOFF_SCALE = 0.95;

export interface OrpheusSynthesisInput {
  apiKey: string;
  text: string;
  voice?: string;
  model?: string;
}

export interface OrpheusStreamingSynthesisResult {
  stream: Readable;
  normalizedText: string;
  chunks: string[];
  contentLength?: number;
}

interface ParsedWav {
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  pcmData: Buffer;
}

export interface OrpheusPcmSynthesisResult {
  pcmData: Buffer;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  normalizedText: string;
  chunks: string[];
}

export interface OrpheusPcmStreamingChunk {
  pcmData: Buffer;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  normalizedText: string;
  chunks: string[];
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberUnderOneThousandToWords(value: number): string {
  if (value < 20) {
    return ONES[value];
  }
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return ones === 0 ? TENS[tens] : `${TENS[tens]}-${ONES[ones]}`;
  }

  const hundreds = Math.floor(value / 100);
  const remainder = value % 100;
  return remainder === 0
    ? `${ONES[hundreds]} hundred`
    : `${ONES[hundreds]} hundred ${numberUnderOneThousandToWords(remainder)}`;
}

function numberToWords(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 999_999_999) {
    return String(value);
  }
  if (value < 1000) {
    return numberUnderOneThousandToWords(value);
  }
  if (value < 1_000_000) {
    const thousands = Math.floor(value / 1000);
    const remainder = value % 1000;
    return remainder === 0
      ? `${numberUnderOneThousandToWords(thousands)} thousand`
      : `${numberUnderOneThousandToWords(thousands)} thousand ${numberUnderOneThousandToWords(remainder)}`;
  }

  const millions = Math.floor(value / 1_000_000);
  const remainder = value % 1_000_000;
  if (remainder === 0) {
    return `${numberUnderOneThousandToWords(millions)} million`;
  }
  if (remainder < 1000) {
    return `${numberUnderOneThousandToWords(millions)} million ${numberUnderOneThousandToWords(remainder)}`;
  }
  const thousands = Math.floor(remainder / 1000);
  const trailing = remainder % 1000;
  const remainderWords =
    trailing === 0
      ? `${numberUnderOneThousandToWords(thousands)} thousand`
      : `${numberUnderOneThousandToWords(thousands)} thousand ${numberUnderOneThousandToWords(trailing)}`;
  return `${numberUnderOneThousandToWords(millions)} million ${remainderWords}`;
}

function convertDollarAmount(match: string, dollarsPart: string, centsPart?: string): string {
  const dollars = Number(dollarsPart.replace(/,/g, ''));
  if (!Number.isFinite(dollars)) {
    return match;
  }

  const dollarsWords = `${numberToWords(dollars)} dollar${dollars === 1 ? '' : 's'}`;
  if (!centsPart) {
    return dollarsWords;
  }

  const cents = Number(centsPart);
  if (!Number.isFinite(cents) || cents === 0) {
    return dollarsWords;
  }

  return `${dollarsWords} and ${numberToWords(cents)} cent${cents === 1 ? '' : 's'}`;
}

function mapSpeedRatioToDirection(ratioRaw: string | undefined): string {
  const ratio = Number(ratioRaw);
  if (!Number.isFinite(ratio)) {
    return '';
  }
  if (ratio < 0.97) {
    return '[slowly] ';
  }
  if (ratio > 1.03) {
    return '[quickly] ';
  }
  return '';
}

function mapInlineTtsTag(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower.startsWith('<emotion')) {
    const match = /value="([^"]+)"/i.exec(tag);
    return match?.[1] ? `[${match[1]}] ` : '';
  }
  if (lower.startsWith('<speed')) {
    const match = /ratio="([^"]+)"/i.exec(tag);
    return mapSpeedRatioToDirection(match?.[1]);
  }
  if (lower.startsWith('<break')) {
    return ' ... ';
  }
  return '';
}

export function prepareOrpheusInputText(text: string): string {
  const withoutThink = text.replace(THINK_TAG_RE, ' ');
  const mappedTags = withoutThink.replace(TTS_TAG_RE, (tag) => mapInlineTtsTag(tag));
  const strippedXml = mappedTags.replace(GENERIC_XML_TAG_RE, ' ');
  const saintExpanded = strippedXml.replace(SAINT_RE, 'Saint ');
  const dollarsExpanded = saintExpanded.replace(DOLLAR_AMOUNT_RE, (match, dollarsPart, centsPart) =>
    convertDollarAmount(match, dollarsPart, centsPart),
  );

  return dollarsExpanded
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function splitOversizedChunk(chunk: string, maxChars: number): string[] {
  const tokens = chunk.split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let current = '';

  for (const token of tokens) {
    const next = current ? `${current} ${token}` : token;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) {
      result.push(current);
    }
    current = token;
  }

  if (current) {
    result.push(current);
  }

  return result;
}

export function chunkOrpheusInput(text: string, maxChars = ORPHEUS_MAX_INPUT_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const sentenceCandidates = text
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) => sentence.split(/(?<=[,;:])\s+/))
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const candidate of sentenceCandidates) {
    if (candidate.length > maxChars) {
      const split = splitOversizedChunk(candidate, maxChars);
      for (const part of split) {
        if (current) {
          chunks.push(current);
          current = '';
        }
        chunks.push(part);
      }
      continue;
    }

    const next = current ? `${current} ${candidate}` : candidate;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = candidate;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function findWavChunkOffset(wav: Buffer, chunkId: string): number {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === chunkId) {
      return offset;
    }
    offset += 8 + size + (size % 2);
  }
  return -1;
}

function parseWav(wav: Buffer): ParsedWav {
  if (
    wav.length < 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Invalid WAV response from Orpheus');
  }

  const fmtOffset = findWavChunkOffset(wav, 'fmt ');
  const dataOffset = findWavChunkOffset(wav, 'data');
  if (fmtOffset < 0 || dataOffset < 0) {
    throw new Error('Missing WAV fmt/data chunk in Orpheus response');
  }

  const audioFormat = wav.readUInt16LE(fmtOffset + 8);
  const channels = wav.readUInt16LE(fmtOffset + 10);
  const sampleRate = wav.readUInt32LE(fmtOffset + 12);
  const bitsPerSample = wav.readUInt16LE(fmtOffset + 22);
  const dataSize = wav.readUInt32LE(dataOffset + 4);

  if (audioFormat !== ORPHEUS_WAV_AUDIO_FORMAT_PCM) {
    throw new Error(`Unsupported WAV audio format from Orpheus: ${audioFormat}`);
  }

  return {
    sampleRate,
    bitsPerSample,
    channels,
    pcmData: wav.subarray(dataOffset + 8, dataOffset + 8 + dataSize),
  };
}

function buildWav(parts: ParsedWav[]): Buffer {
  if (parts.length === 0) {
    throw new Error('Cannot build Orpheus WAV with zero parts');
  }

  const first = parts[0];
  if (
    first.sampleRate !== ORPHEUS_WAV_SAMPLE_RATE ||
    first.bitsPerSample !== ORPHEUS_WAV_BITS_PER_SAMPLE ||
    first.channels !== ORPHEUS_WAV_CHANNELS
  ) {
    throw new Error(
      `Unexpected Orpheus WAV format ${first.sampleRate}Hz/${first.bitsPerSample}bit/${first.channels}ch`,
    );
  }

  for (const part of parts.slice(1)) {
    if (
      part.sampleRate !== first.sampleRate ||
      part.bitsPerSample !== first.bitsPerSample ||
      part.channels !== first.channels
    ) {
      throw new Error('Inconsistent Orpheus WAV chunks');
    }
  }

  const pcmData = Buffer.concat(parts.map((part) => part.pcmData));
  const blockAlign = (first.channels * first.bitsPerSample) / 8;
  const byteRate = first.sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(ORPHEUS_WAV_AUDIO_FORMAT_PCM, 20);
  header.writeUInt16LE(first.channels, 22);
  header.writeUInt32LE(first.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(first.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

export function buildPcm16MonoWav(
  pcmData: Buffer,
  sampleRate: number,
  bitsPerSample = ORPHEUS_WAV_BITS_PER_SAMPLE,
  channels = ORPHEUS_WAV_CHANNELS,
): Buffer {
  if (sampleRate <= 0) {
    throw new Error('WAV sample rate must be greater than zero');
  }
  if (bitsPerSample !== ORPHEUS_WAV_BITS_PER_SAMPLE || channels !== ORPHEUS_WAV_CHANNELS) {
    throw new Error(`Unsupported PCM WAV format ${sampleRate}Hz/${bitsPerSample}bit/${channels}ch`);
  }

  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(ORPHEUS_WAV_AUDIO_FORMAT_PCM, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

function buildStreamingWavHeader(
  part: Pick<ParsedWav, 'sampleRate' | 'bitsPerSample' | 'channels'>,
): Buffer {
  const blockAlign = (part.channels * part.bitsPerSample) / 8;
  const byteRate = part.sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(ORPHEUS_WAV_AUDIO_FORMAT_PCM, 20);
  header.writeUInt16LE(part.channels, 22);
  header.writeUInt32LE(part.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(part.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0xffffffff, 40);

  return header;
}

function combineWavParts(parts: ParsedWav[]): ParsedWav {
  if (parts.length === 0) {
    throw new Error('Cannot combine Orpheus WAV with zero parts');
  }

  const first = parts[0];
  if (
    first.sampleRate !== ORPHEUS_WAV_SAMPLE_RATE ||
    first.bitsPerSample !== ORPHEUS_WAV_BITS_PER_SAMPLE ||
    first.channels !== ORPHEUS_WAV_CHANNELS
  ) {
    throw new Error(
      `Unexpected Orpheus WAV format ${first.sampleRate}Hz/${first.bitsPerSample}bit/${first.channels}ch`,
    );
  }

  for (const part of parts.slice(1)) {
    if (
      part.sampleRate !== first.sampleRate ||
      part.bitsPerSample !== first.bitsPerSample ||
      part.channels !== first.channels
    ) {
      throw new Error('Inconsistent Orpheus WAV chunks');
    }
  }

  return {
    sampleRate: first.sampleRate,
    bitsPerSample: first.bitsPerSample,
    channels: first.channels,
    pcmData: Buffer.concat(parts.map((part) => part.pcmData)),
  };
}

async function requestChunk(
  apiKey: string,
  text: string,
  voice: string,
  model: string,
): Promise<Response> {
  const response = await fetch(ORPHEUS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Orpheus TTS failed (${response.status}): ${body}`);
  }

  return response;
}

async function synthesizeChunk(
  apiKey: string,
  text: string,
  voice: string,
  model: string,
): Promise<Buffer> {
  const response = await requestChunk(apiKey, text, voice, model);
  return Buffer.from(await response.arrayBuffer());
}

interface StreamingWavParserState {
  headerParsed: boolean;
  headerBuffer: Buffer;
  audioFormat: number;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
  remainingPcmBytes: number;
}

function createStreamingWavParser(): StreamingWavParserState {
  return {
    headerParsed: false,
    headerBuffer: Buffer.alloc(0),
    audioFormat: 0,
    sampleRate: 0,
    bitsPerSample: 0,
    channels: 0,
    remainingPcmBytes: Number.POSITIVE_INFINITY,
  };
}

function extractStreamingPcmChunks(
  state: StreamingWavParserState,
  chunk: Buffer,
): OrpheusPcmStreamingChunk[] {
  const outputs: OrpheusPcmStreamingChunk[] = [];

  if (state.headerParsed) {
    if (state.remainingPcmBytes <= 0) {
      return outputs;
    }
    const pcmBytes =
      state.remainingPcmBytes === Number.POSITIVE_INFINITY
        ? chunk
        : chunk.subarray(0, Math.min(chunk.length, state.remainingPcmBytes));
    if (pcmBytes.length > 0) {
      outputs.push({
        pcmData: pcmBytes,
        sampleRate: state.sampleRate,
        bitsPerSample: state.bitsPerSample,
        channels: state.channels,
        normalizedText: '',
        chunks: [],
      });
      if (state.remainingPcmBytes !== Number.POSITIVE_INFINITY) {
        state.remainingPcmBytes -= pcmBytes.length;
      }
    }
    return outputs;
  }

  state.headerBuffer = Buffer.concat([state.headerBuffer, chunk]);
  if (
    state.headerBuffer.length >= 12 &&
    (state.headerBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
      state.headerBuffer.toString('ascii', 8, 12) !== 'WAVE')
  ) {
    throw new Error('Invalid WAV response from Orpheus');
  }

  let offset = 12;

  while (state.headerBuffer.length >= offset + 8) {
    const chunkId = state.headerBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = state.headerBuffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === 'fmt ') {
      if (state.headerBuffer.length < chunkStart + chunkSize) {
        return outputs;
      }
      state.audioFormat = state.headerBuffer.readUInt16LE(chunkStart);
      state.channels = state.headerBuffer.readUInt16LE(chunkStart + 2);
      state.sampleRate = state.headerBuffer.readUInt32LE(chunkStart + 4);
      state.bitsPerSample = state.headerBuffer.readUInt16LE(chunkStart + 14);
      offset += 8 + chunkSize + (chunkSize % 2);
      continue;
    }

    if (chunkId === 'data') {
      if (state.audioFormat !== ORPHEUS_WAV_AUDIO_FORMAT_PCM) {
        throw new Error(`Unsupported WAV audio format from Orpheus: ${state.audioFormat}`);
      }
      if (!state.channels || !state.sampleRate || !state.bitsPerSample) {
        throw new Error('Missing WAV fmt chunk before data chunk in Orpheus response');
      }

      state.headerParsed = true;
      state.remainingPcmBytes = chunkSize === 0xffffffff ? Number.POSITIVE_INFINITY : chunkSize;

      const availablePcm = state.headerBuffer.subarray(chunkStart);
      state.headerBuffer = Buffer.alloc(0);

      if (availablePcm.length > 0) {
        const pcmBytes =
          state.remainingPcmBytes === Number.POSITIVE_INFINITY
            ? availablePcm
            : availablePcm.subarray(0, Math.min(availablePcm.length, state.remainingPcmBytes));
        outputs.push({
          pcmData: pcmBytes,
          sampleRate: state.sampleRate,
          bitsPerSample: state.bitsPerSample,
          channels: state.channels,
          normalizedText: '',
          chunks: [],
        });
        if (state.remainingPcmBytes !== Number.POSITIVE_INFINITY) {
          state.remainingPcmBytes -= pcmBytes.length;
        }
      }

      return outputs;
    }

    if (state.headerBuffer.length < chunkStart + chunkSize) {
      return outputs;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return outputs;
}

export async function synthesizeOrpheusSpeechStream(
  input: OrpheusSynthesisInput,
): Promise<OrpheusStreamingSynthesisResult> {
  const normalizedText = prepareOrpheusInputText(input.text);
  if (!normalizedText) {
    throw new Error('No synthesizeable text remained after Orpheus preprocessing');
  }

  const chunks = chunkOrpheusInput(normalizedText);
  const voice = input.voice || ORPHEUS_DEFAULT_VOICE;
  const model = input.model || ORPHEUS_DEFAULT_MODEL;
  if (chunks.length === 1) {
    const response = await requestChunk(input.apiKey, chunks[0], voice, model);
    const body = response.body;
    if (!body) {
      throw new Error('Groq Orpheus response did not include a body stream');
    }

    const contentLengthHeader = response.headers.get('content-length');
    const contentLength =
      contentLengthHeader && Number.isFinite(Number(contentLengthHeader))
        ? Number(contentLengthHeader)
        : undefined;

    log.info('Streaming Orpheus speech progressively', {
      voice,
      chunks: chunks.length,
      inputChars: input.text.length,
      normalizedChars: normalizedText.length,
      contentLength,
      mode: 'single-chunk-direct',
    });

    return {
      stream: Readable.fromWeb(body as globalThis.ReadableStream<Uint8Array>),
      normalizedText,
      chunks,
      contentLength,
    };
  }

  const stream = new PassThrough();
  const firstChunk = chunks[0] ?? '';

  log.info('Streaming Orpheus speech progressively', {
    voice,
    chunks: chunks.length,
    inputChars: input.text.length,
    normalizedChars: normalizedText.length,
    firstChunkChars: firstChunk.length,
    mode: 'multi-chunk-wav',
  });

  void (async () => {
    try {
      let headerSent = false;
      let firstPcmSent = false;

      for (const chunk of chunks) {
        const wav = await synthesizeChunk(input.apiKey, chunk, voice, model);
        const parsed = parseWav(wav);

        if (!headerSent) {
          stream.write(buildStreamingWavHeader(parsed));
          headerSent = true;
        }

        if (!firstPcmSent) {
          log.info('Streaming first multi-chunk Orpheus PCM segment', {
            voice,
            pcmBytes: parsed.pcmData.length,
            chunkChars: chunk.length,
          });
          firstPcmSent = true;
        }

        stream.write(parsed.pcmData);
      }

      stream.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to stream multi-chunk Orpheus speech', {
        voice,
        chunks: chunks.length,
        error: message,
      });
      stream.destroy(err instanceof Error ? err : new Error(message));
    }
  })();

  return {
    stream,
    normalizedText,
    chunks,
  };
}

export async function* synthesizeOrpheusPcmStream(
  input: OrpheusSynthesisInput,
): AsyncGenerator<OrpheusPcmStreamingChunk> {
  const normalizedText = prepareOrpheusInputText(input.text);
  if (!normalizedText) {
    throw new Error('No synthesizeable text remained after Orpheus preprocessing');
  }

  const chunks = chunkOrpheusInput(normalizedText);
  const voice = input.voice || ORPHEUS_DEFAULT_VOICE;
  const model = input.model || ORPHEUS_DEFAULT_MODEL;

  for (const chunk of chunks) {
    const response = await requestChunk(input.apiKey, chunk, voice, model);
    const body = response.body;
    if (!body) {
      throw new Error('Groq Orpheus response did not include a body stream');
    }

    const parser = createStreamingWavParser();
    const nodeStream = Readable.fromWeb(body as globalThis.ReadableStream<Uint8Array>);

    for await (const rawPart of nodeStream) {
      const part = Buffer.isBuffer(rawPart) ? rawPart : Buffer.from(rawPart);
      const pcmParts = extractStreamingPcmChunks(parser, part);
      for (const pcmPart of pcmParts) {
        yield {
          ...pcmPart,
          normalizedText,
          chunks,
        };
      }
    }
  }
}

export async function synthesizeOrpheusSpeech(input: OrpheusSynthesisInput): Promise<{
  audio: Buffer;
  normalizedText: string;
  chunks: string[];
}> {
  const pcmResult = await synthesizeOrpheusPcm(input);
  const audio = buildWav([
    {
      pcmData: pcmResult.pcmData,
      sampleRate: pcmResult.sampleRate,
      bitsPerSample: pcmResult.bitsPerSample,
      channels: pcmResult.channels,
    },
  ]);

  log.info('Synthesized Orpheus speech', {
    voice: input.voice || ORPHEUS_DEFAULT_VOICE,
    chunks: pcmResult.chunks.length,
    inputChars: input.text.length,
    normalizedChars: pcmResult.normalizedText.length,
    bytes: audio.length,
  });

  return {
    audio,
    normalizedText: pcmResult.normalizedText,
    chunks: pcmResult.chunks,
  };
}

export async function synthesizeOrpheusPcm(
  input: OrpheusSynthesisInput,
): Promise<OrpheusPcmSynthesisResult> {
  const normalizedText = prepareOrpheusInputText(input.text);
  if (!normalizedText) {
    throw new Error('No synthesizeable text remained after Orpheus preprocessing');
  }

  const chunks = chunkOrpheusInput(normalizedText);
  const voice = input.voice || ORPHEUS_DEFAULT_VOICE;
  const model = input.model || ORPHEUS_DEFAULT_MODEL;
  const wavParts: ParsedWav[] = [];

  for (const chunk of chunks) {
    const wav = await synthesizeChunk(input.apiKey, chunk, voice, model);
    wavParts.push(parseWav(wav));
  }

  const combined = combineWavParts(wavParts);
  log.info('Synthesized Orpheus PCM', {
    voice,
    chunks: chunks.length,
    inputChars: input.text.length,
    normalizedChars: normalizedText.length,
    pcmBytes: combined.pcmData.length,
  });

  return {
    pcmData: combined.pcmData,
    sampleRate: combined.sampleRate,
    bitsPerSample: combined.bitsPerSample,
    channels: combined.channels,
    normalizedText,
    chunks,
  };
}

export function resamplePcm16Mono(
  pcmData: Buffer,
  sourceSampleRate: number,
  targetSampleRate: number,
): Buffer {
  if (sourceSampleRate === targetSampleRate) {
    return pcmData;
  }

  if (sourceSampleRate <= 0 || targetSampleRate <= 0) {
    throw new Error('PCM resample requires positive source and target sample rates');
  }

  if (pcmData.length % 2 !== 0) {
    throw new Error('PCM16 mono data must have an even byte length');
  }

  const decimationFactor = sourceSampleRate / targetSampleRate;
  if (Number.isInteger(decimationFactor) && decimationFactor > 1) {
    return decimatePcm16MonoWithLowPass(pcmData, decimationFactor);
  }

  const sourceSamples = pcmData.length / 2;
  const sourceView = new Int16Array(pcmData.buffer, pcmData.byteOffset, sourceSamples);
  const targetSamples = Math.max(
    1,
    Math.round((sourceSamples * targetSampleRate) / sourceSampleRate),
  );
  const output = Buffer.allocUnsafe(targetSamples * 2);

  for (let index = 0; index < targetSamples; index += 1) {
    const position = (index * sourceSampleRate) / targetSampleRate;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(lowerIndex + 1, sourceSamples - 1);
    const fraction = position - lowerIndex;
    const lowerSample = sourceView[Math.min(lowerIndex, sourceSamples - 1)] ?? 0;
    const upperSample = sourceView[upperIndex] ?? lowerSample;
    const mixed = clampPcm16Sample(
      Math.round(lowerSample + (upperSample - lowerSample) * fraction),
    );
    output.writeInt16LE(mixed, index * 2);
  }

  return output;
}

function clampPcm16Sample(value: number): number {
  return Math.max(-32_768, Math.min(32_767, value));
}

function sinc(value: number): number {
  if (value === 0) {
    return 1;
  }
  const scaled = Math.PI * value;
  return Math.sin(scaled) / scaled;
}

function buildWindowedLowPassKernel(
  decimationFactor: number,
  tapCount = RESAMPLER_DEFAULT_LOW_PASS_TAPS,
  cutoffScale = RESAMPLER_DEFAULT_CUTOFF_SCALE,
): Float64Array {
  if (!Number.isInteger(decimationFactor) || decimationFactor <= 1) {
    throw new Error('Low-pass kernel requires an integer decimation factor greater than one');
  }
  if (tapCount < 3 || tapCount % 2 === 0) {
    throw new Error(
      'Low-pass kernel tap count must be an odd number greater than or equal to three',
    );
  }

  const cutoff = Math.min(0.5 / decimationFactor, 0.5) * cutoffScale;
  const halfWidth = (tapCount - 1) / 2;
  const kernel = new Float64Array(tapCount);
  let sum = 0;

  for (let index = 0; index < tapCount; index += 1) {
    const centeredIndex = index - halfWidth;
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * index) / Math.max(1, tapCount - 1));
    const coefficient = 2 * cutoff * sinc(2 * cutoff * centeredIndex) * window;
    kernel[index] = coefficient;
    sum += coefficient;
  }

  if (sum === 0) {
    throw new Error('Low-pass kernel normalization failed');
  }

  for (let index = 0; index < kernel.length; index += 1) {
    kernel[index] /= sum;
  }

  return kernel;
}

function decimatePcm16MonoWithLowPass(pcmData: Buffer, decimationFactor: number): Buffer {
  const sourceSamples = pcmData.length / 2;
  const sourceView = new Int16Array(pcmData.buffer, pcmData.byteOffset, sourceSamples);
  const targetSamples = Math.max(1, Math.round(sourceSamples / decimationFactor));
  const output = Buffer.allocUnsafe(targetSamples * 2);
  const kernel = buildWindowedLowPassKernel(decimationFactor);
  const halfWidth = (kernel.length - 1) / 2;

  for (let outputIndex = 0; outputIndex < targetSamples; outputIndex += 1) {
    const centerIndex = outputIndex * decimationFactor;
    let sum = 0;

    for (let kernelIndex = 0; kernelIndex < kernel.length; kernelIndex += 1) {
      const sourceIndex = clampSampleIndex(centerIndex + kernelIndex - halfWidth, sourceSamples);
      sum += (sourceView[sourceIndex] ?? 0) * kernel[kernelIndex];
    }

    output.writeInt16LE(clampPcm16Sample(Math.round(sum)), outputIndex * 2);
  }

  return output;
}

function clampSampleIndex(index: number, totalSamples: number): number {
  if (totalSamples <= 1) {
    return 0;
  }
  return Math.max(0, Math.min(totalSamples - 1, index));
}

export function chunkPcmFrames(
  pcmData: Buffer,
  sampleRate: number,
  frameDurationMs = 20,
): Buffer[] {
  if (frameDurationMs <= 0) {
    throw new Error('frameDurationMs must be greater than zero');
  }

  const bytesPerFrame = Math.max(2, Math.round((sampleRate * frameDurationMs) / 1000) * 2);
  const alignedBytesPerFrame = bytesPerFrame % 2 === 0 ? bytesPerFrame : bytesPerFrame + 1;
  const frames: Buffer[] = [];

  for (let offset = 0; offset < pcmData.length; offset += alignedBytesPerFrame) {
    frames.push(pcmData.subarray(offset, Math.min(offset + alignedBytesPerFrame, pcmData.length)));
  }

  return frames;
}
