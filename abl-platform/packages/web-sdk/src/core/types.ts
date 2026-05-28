/**
 * Core SDK Types
 */

export interface WebSocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: WebSocketCloseEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketCloseEventLike {
  code?: number;
  reason?: string;
}

export interface WebSocketConstructor {
  new (url: string, protocols?: string | string[]): WebSocketLike;
  readonly OPEN: number;
}

export type SDKUserContextPrimitive = string | number | boolean | null;
export type SDKUserContextAttributeValue =
  | SDKUserContextPrimitive
  | readonly SDKUserContextPrimitive[];
export type SDKUserContextCustomAttributes = Record<string, SDKUserContextAttributeValue>;

export interface SDKUserContext {
  userId?: string;
  customAttributes?: SDKUserContextCustomAttributes;
}

export interface SDKSessionScope {
  tenantId: string;
  projectId: string;
  channelId: string;
  deploymentId?: string;
  permissions: string[];
  showActivityUpdates: boolean;
}

export type SDKIdleDisconnectBehavior = 'disconnect' | 'end_session';

export interface SDKIdleDisconnectConfig {
  /**
   * Browser inactivity window before the SDK disconnects, in milliseconds.
   */
  timeoutMs: number;
  /**
   * `disconnect` drops the websocket and leaves server lifecycle policy to decide
   * whether the session is resumable. `end_session` asks Runtime to terminalize
   * the conversation before closing.
   */
  behavior?: SDKIdleDisconnectBehavior;
}

export interface SDKConfigBase {
  /**
   * Project scope used by session-scoped HTTP APIs (for example attachment upload routes).
   */
  projectId: string;
  /**
   * Runtime base URL (required at runtime). Example: https://runtime.example.com
   */
  endpoint: string;
  debug?: boolean;
  webSocketConstructor?: WebSocketConstructor;
  voice?: VoiceClientOptions;
  idleDisconnect?: SDKIdleDisconnectConfig;
}

export interface SDKPublicKeyConfig extends SDKConfigBase {
  apiKey: string;
  bootstrapToken?: never;
  channelId?: string;
  channelName?: string;
  deploymentSlug?: string;
  userContext?: SDKUserContext;
}

export interface SDKBootstrapTokenConfig extends SDKConfigBase {
  bootstrapToken: string;
  apiKey?: never;
  channelId?: never;
  channelName?: never;
  deploymentSlug?: never;
  userContext?: never;
}

// SDK Configuration
export type SDKConfig = SDKPublicKeyConfig | SDKBootstrapTokenConfig;

// Carousel card (mirrors CarouselCardIR from compiler)
export interface CarouselCard {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action_url?: string;
  buttons?: ActionElement[];
}

// Carousel of cards (mirrors CarouselIR from compiler)
export interface Carousel {
  cards: CarouselCard[];
}

// =============================================================================
// RICH CONTENT TEMPLATE SUB-TYPES
// =============================================================================

// --- Tier 1: Basic Templates ---

export interface QuickReply {
  id: string;
  label: string;
  icon_url?: string;
}

export interface ListTemplate {
  title?: string;
  items: ListItem[];
}

export interface ListItem {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action_url?: string;
}

export interface MediaContent {
  url: string;
  alt?: string;
  thumbnail_url?: string;
  caption?: string;
}

export interface FileContent {
  url: string;
  filename: string;
  size_bytes?: number;
  mime_type?: string;
}

// --- Tier 2: Data-Rich Templates ---

export interface KPITemplate {
  label: string;
  value: string | number;
  unit?: string;
  trend?: 'up' | 'down' | 'flat';
  icon_url?: string;
}

export interface TableTemplate {
  columns: TableColumn[];
  rows: Record<string, string | number>[];
  max_visible_rows?: number;
}

export interface TableColumn {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
}

export interface ChartTemplate {
  type: 'bar' | 'line' | 'pie';
  title?: string;
  data: ChartDataPoint[];
}

export interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

export interface FormTemplate {
  title?: string;
  fields: ActionElement[];
  submit_label?: string;
}

export interface ProgressTemplate {
  label?: string;
  value: number;
  max?: number;
  variant?: 'bar' | 'circle';
}

export interface FeedbackTemplate {
  prompt: string;
  type: 'thumbs' | 'stars' | 'scale';
  max?: number;
}

// =============================================================================
// RICH CONTENT (Format Variants + Templates)
// =============================================================================

// Rich content format variants
export interface RichContent {
  type?: string;
  markdown?: string;
  adaptive_card?: string;
  html?: string;
  slack?: string;
  ag_ui?: string;
  whatsapp?: string;
  carousel?: Carousel;
  // Template types (Tier 1)
  quick_replies?: QuickReply[];
  list?: ListTemplate;
  image?: MediaContent;
  video?: MediaContent;
  audio?: MediaContent;
  file?: FileContent;
  // Template types (Tier 2)
  kpi?: KPITemplate;
  table?: TableTemplate;
  chart?: ChartTemplate;
  form?: FormTemplate;
  progress?: ProgressTemplate;
  feedback?: FeedbackTemplate;
  [key: string]: unknown;
}

export interface VoiceConfig {
  ssml?: string;
  instructions?: string;
  plain_text?: string;
  plainText?: string;
  [key: string]: unknown;
}

// Interactive action element
export interface ActionElement {
  id: string;
  type: 'button' | 'select' | 'input';
  label: string;
  value?: string;
  description?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  input_type?: 'text' | 'number' | 'date' | 'time' | 'email';
  placeholder?: string;
  required?: boolean;
}

// Set of interactive actions
export interface ActionSet {
  elements: ActionElement[];
  submit_label?: string;
  submit_id?: string;
  renderId?: string;
}

export interface ActionSubmitOptions {
  value?: string;
  formData?: Record<string, unknown>;
  renderId?: string;
}

// Attachment types
export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  category: 'image' | 'document' | 'audio' | 'video';
}

export interface SendMessageOptions {
  /** Pre-uploaded attachment IDs to include with the message */
  attachmentIds?: string[];
  /** Optional per-message metadata. Values must be JSON-like and are validated server-side. */
  metadata?: Record<string, unknown>;
}

// Message role type alias (backwards-compatible superset)
export type MessageRole = 'user' | 'assistant' | 'system' | 'thought';

export type ResponseProvenanceKind = 'scripted' | 'llm' | 'mixed';

export interface ResponseProvenance {
  schemaVersion: 1;
  kind: ResponseProvenanceKind;
  disclaimerRequired: boolean;
  usedLlmInternally: boolean;
}

// Typed metadata with well-known optional fields and open index signature
export interface MessageMetadata {
  toolName?: string;
  agentName?: string;
  traceIds?: string[];
  llmCallId?: string;
  isLlmGenerated?: boolean;
  responseProvenance?: ResponseProvenance;
  localization?: Record<string, unknown>;
  handoffFrom?: string;
  handoffTo?: string;
  errorCode?: string;
  severity?: 'warning' | 'error';
  [key: string]: unknown;
}

export interface SessionHealthDiagnostic {
  category: string;
  severity: 'warning' | 'error' | string;
  code: string;
  message: string;
}

export interface PreflightAuthRequirement {
  requirementKey?: string;
  connector: string;
  authProfileRef: string;
  profileId?: string;
  environment?: string | null;
  scopes?: string[];
  connectionMode: 'per_user' | 'shared';
}

/** Citation reference from a search-powered answer */
export interface CitationRef {
  /** 1-based index matching [N] in the response text */
  index: number;
  /** Document title */
  title: string;
  /** URL to open (direct URL for connectors, JWT download URL for uploads) */
  url: string;
  /** Source type */
  sourceType: 'connector' | 'upload' | 'crawled';
  /** Page number within the document (when available from chunk metadata) */
  pageNumber?: number;
}

// Message types
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  metadata?: MessageMetadata;
  voiceConfig?: VoiceConfig;
  richContent?: RichContent;
  actions?: ActionSet;
  /** Canonical runtime content envelope preserved for consumers that need replay/readback parity. */
  contentEnvelope?: MessageContentEnvelope;
  /** Attachment references associated with this message */
  attachments?: AttachmentRef[];
  /** Source channel that originated this message (voice, text, system) */
  sourceChannel?: SourceChannel;
  /** Input mode for this message (speech, typed, system) */
  inputMode?: InputMode;
  /** Citation references from search-powered answers */
  citations?: CitationRef[];
}

export interface MessageContentEnvelope {
  version?: string | number;
  text?: string;
  rawContent?: unknown[];
  richContent?: RichContent;
  actions?: ActionSet;
  voiceConfig?: VoiceConfig;
  localization?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

// Voice states
export type VoiceState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error';

// Voice info
export interface VoiceInfo {
  state: VoiceState;
  voiceMode: VoiceMode;
  isMuted: boolean;
  currentTranscript: string;
  hasMicPermission?: boolean;
  capabilities?: VoiceSessionCapabilities;
}

// Widget configuration
export interface WidgetTheme {
  primaryColor?: string;
  textColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  fontFamily?: string;
  darkMode?: boolean;
}

export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type WidgetMode = 'chat' | 'voice' | 'unified';

// SDK Events
export interface SDKEvents {
  connected: void;
  disconnected: void;
  error: { error: Error };
  idleTimeout: {
    timeoutMs: number;
    behavior: SDKIdleDisconnectBehavior;
  };
  sessionStart: {
    sessionId: string;
    projectId?: string;
    channelId?: string;
  };
  sessionEnd: void;
}

// Auth challenge from JIT auth (Phase 5)
export interface AuthChallengeMessage {
  type: 'auth_challenge';
  code?: 'AUTH_JIT_REQUIRED';
  sessionId: string;
  toolCallId: string;
  authType: string;
  authUrl?: string;
  profileId: string;
  profileName: string;
  prompt: string;
  timeoutMs: number;
}

// Chat Events
export interface ChatEvents {
  message: Message;
  messagesReplaced: { messages: Message[] };
  messageChunk: { messageId: string; chunk: string };
  typing: { isTyping: boolean };
  error: { error: Error };
  messageSent: { messageId: string };
  attachmentUploaded: { attachmentId: string; filename: string };
  attachmentError: { filename: string; error: string };
  authChallenge: AuthChallengeMessage;
  authRequired: {
    sessionId: string;
    pending: PreflightAuthRequirement[];
    satisfied: PreflightAuthRequirement[];
  };
  messageQueued: { sessionId?: string; reason: string };
  // Feedback capture (ABLP-1068) — emitted whenever the runtime acks a
  // chat.submitFeedback / action_submit(feedback) call.
  feedbackAck: FeedbackAckEventData;
  // Status events
  statusUpdate: StatusUpdateEventData;
  statusClear: void;
}

export interface FeedbackAckEventData {
  messageId: string;
  success: boolean;
  feedbackId?: string;
  actionRenderId?: string;
  error?: { code: string; message: string };
}

// Voice mode (pipeline = STT→LLM→TTS, realtime = native audio I/O)
export type VoiceMode = 'pipeline' | 'realtime';

export interface VoiceSessionCapabilities {
  localBargeIn: boolean;
  remoteTypedInterrupt: boolean;
  dtmf: boolean;
  returnToParent: boolean;
  activeAgentSync: boolean;
}

// Thought event data (from trace_event with tool_thought)
export interface ThoughtEventData {
  toolName: string;
  thought: string;
  reasoning: string;
  agent: string;
}

// Status update event data
export interface StatusUpdateEventData {
  text: string;
  operation: string;
}

// Voice Events
export interface VoiceEvents {
  stateChange: { state: VoiceState; previousState: VoiceState };
  transcription: { text: string; isFinal: boolean; confidence?: number };
  transcriptionFinal: { text: string; confidence: number };
  responseStart: { messageId: string };
  responseChunk: { messageId: string; text: string };
  responseEnd: { messageId: string; text: string };
  speaking: { isSpeaking: boolean };
  volumeChange: { level: number };
  ready: void;
  error: { error: Error };
  micPermissionDenied: void;
  // Pipeline voice events
  bargeIn: void;
  vadAvailable: { available: boolean };
  // Realtime voice events
  realtimeAudio: { audio: ArrayBuffer };
  realtimeTranscript: { text: string; role: 'user' | 'assistant'; isFinal: boolean };
  // Trace events (thoughts, status)
  thought: ThoughtEventData;
  statusUpdate: StatusUpdateEventData;
  statusClear: void;
}

// Voice client configuration options
export interface VoiceClientOptions {
  /** Enable barge-in (interrupt audio playback when user speaks). Default: true */
  enableBargeIn?: boolean;
  /** Audio capture sample rate in Hz. Default: 16000 */
  sampleRate?: number;
  /** Specific audio input device ID */
  deviceId?: string;
  /** VAD configuration overrides */
  vadConfig?: {
    positiveSpeechThreshold?: number;
    negativeSpeechThreshold?: number;
    redemptionMs?: number;
    minSpeechMs?: number;
    preSpeechPadMs?: number;
    baseAssetPath?: string;
    onnxWASMBasePath?: string;
    vadScriptUrl?: string;
    onnxRuntimeScriptUrl?: string;
    scriptNonce?: string;
  };
}

// ===========================================================================
// Omnichannel Types
// ===========================================================================

/** Source channel that originated a transcript item */
export type SourceChannel = 'voice' | 'text' | 'system';

/** Input mode for how the content was produced */
export type InputMode = 'speech' | 'typed' | 'system';

/** Runtime-facing participant surface */
export type ParticipantSurface = 'voice' | 'web' | 'mobile' | 'api';

/** Current live-sync state for an active session */
export type LiveSyncState = 'active' | 'idle' | 'ended';

/** A single transcript item in a live session */
export interface TranscriptItem {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  contentEnvelope?: MessageContentEnvelope;
  metadata?: MessageMetadata;
  channel: SourceChannel;
  sourceChannel: SourceChannel;
  inputMode: InputMode;
  sequence: number;
  timestamp: Date;
  final: boolean;
}

/** A participant in a live session */
export interface Participant {
  participantId: string;
  sessionId: string;
  contactId: string;
  surface: ParticipantSurface;
  channel: SourceChannel;
  mode: InputMode;
  interactive: boolean;
  attachedAt: Date;
  label?: string;
}

/** Result of discovering a live session */
export interface LiveSessionDiscoveryResult {
  sessionId: string;
  participants: Participant[];
  liveSyncState: LiveSyncState;
}

/** Result of joining a live session */
export interface JoinResult {
  success: boolean;
  backfill: TranscriptItem[];
  participants: Participant[];
  error?: { code: string; message: string };
}

/** Event data for participant changes */
export interface ParticipantEvent {
  type: 'attached' | 'detached';
  participant: Participant;
}

/** Omnichannel event subscriptions */
export interface OmnichannelEvents {
  liveSessionDiscovered: LiveSessionDiscoveryResult;
  liveSessionJoined: JoinResult;
  liveSessionEnded: { sessionId: string; reason: string };
  transcriptItem: TranscriptItem;
  transcriptBackfill: { items: TranscriptItem[] };
  participantAttached: Participant;
  participantDetached: Participant;
}

// WebSocket message types
export interface WSClientMessage {
  type: string;
  [key: string]: unknown;
}

export interface WSServerMessage {
  type: string;
  [key: string]: unknown;
}
