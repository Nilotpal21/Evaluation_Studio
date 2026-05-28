/**
 * Realtime Voice LLM Module
 *
 * Exports types, provider registry, and adapter implementations
 * for realtime voice LLM providers (OpenAI Realtime, Gemini Live, Ultravox).
 */

export * from './types.js';
export * from './provider.js';
export { OpenAIRealtimeSession } from './openai-realtime.js';
export { GeminiLiveSession } from './gemini-live.js';
export { UltravoxRealtimeSession } from './ultravox-realtime.js';

// Auto-register built-in realtime providers
import { registerRealtimeProvider } from './provider.js';
import { OpenAIRealtimeSession } from './openai-realtime.js';
import { GeminiLiveSession } from './gemini-live.js';
import { UltravoxRealtimeSession } from './ultravox-realtime.js';

registerRealtimeProvider('openai_realtime', () => new OpenAIRealtimeSession());
registerRealtimeProvider('gemini_live', () => new GeminiLiveSession());
registerRealtimeProvider('ultravox', () => new UltravoxRealtimeSession());
