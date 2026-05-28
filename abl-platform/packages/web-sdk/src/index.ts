/**
 * Agent Platform Web SDK
 *
 * Embeddable SDK for voice and chat interactions with Agent Platform.
 *
 * @example
 * // Vanilla JS
 * import { AgentSDK } from '@agent-platform/web-sdk';
 * const sdk = new AgentSDK({
 *   projectId: 'xxx',
 *   apiKey: 'pk_xxx',
 *   endpoint: 'https://runtime.example.com',
 * });
 * await sdk.connect();
 *
 * // Web Component
 * <agent-widget
 *   project-id="xxx"
 *   api-key="pk_xxx"
 *   endpoint="https://runtime.example.com"
 *   mode="chat"
 * ></agent-widget>
 */

// Core exports
export { AgentSDK } from './core/AgentSDK.js';
export { SessionManager } from './core/SessionManager.js';
export { TypedEventEmitter } from './core/EventEmitter.js';

// Clients
export { ChatClient } from './chat/ChatClient.js';
export type { ChatUploadConfig } from './chat/ChatClient.js';
export { VoiceClient } from './voice/VoiceClient.js';

// Transport layer
export { DefaultTransport } from './transport/DefaultTransport.js';
export type {
  SDKTransport,
  TransportCapabilities,
  TransportClientMessage,
  TransportServerMessage,
  TransportError,
} from './transport/types.js';

// Voice modules
export { AudioCapture } from './voice/AudioCapture.js';
export { VADAdapter, ManualVADAdapter } from './voice/VADAdapter.js';

// Types
export * from './core/types.js';

// Rich content rendering
export {
  hasRichContent,
  renderRichMessage,
  renderMarkdown,
  sanitizeHtml,
} from './ui/rich-renderer.js';
export { createActionHandler } from './ui/action-handler.js';
export {
  normalizeActionSet,
  normalizeContentEnvelope,
  normalizeRichContent,
  normalizeVoiceConfig,
} from './core/message-normalization.js';

// Template system
export {
  TemplateRegistry,
  defaultRegistry,
  isSafeUrl,
  getString,
  setStrings,
  RICH_CONTENT_SUPPORT_SPECS,
  WEB_FALLBACK_RICH_CONTENT_TYPES,
  hasRenderableRichContentPayload,
  extractStructuredTextPreview,
} from './templates/index.js';
export type { TemplateRenderer, TemplateContext } from './templates/index.js';

// Trigger renderer registration (side-effect imports in barrel)
import './templates/index.js';

// Web Components (auto-registered)
export { ChatWidget } from './ui/ChatWidget.js';
export { UnifiedWidget } from './ui/UnifiedWidget.js';
export { VoiceWidget } from './ui/VoiceWidget.js';

// Static init for script tag usage
import { AgentSDK } from './core/AgentSDK.js';
import './ui/ChatWidget.js';
import './ui/UnifiedWidget.js';
import './ui/VoiceWidget.js';

// Global init function
if (typeof window !== 'undefined') {
  (window as unknown as { AgentSDK: typeof AgentSDK }).AgentSDK = AgentSDK;
}
