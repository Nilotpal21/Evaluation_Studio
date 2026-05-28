/**
 * React Components for Agent SDK
 */

// Match the root SDK entry: importing the React subpath must register the
// default rich-content template renderers before any React consumer reads the registry.
import '../templates/index.js';

// Core provider and hooks
export { AgentProvider, useAgent, useChat, useVoice } from './AgentProvider.js';

// Legacy components (backwards compat)
export { RichMessage } from './RichMessage.js';
export { RichContent } from './RichContent.js';
export type { RichContentProps } from './RichContent.js';

// New SDK UI components
export {
  MarkdownContent,
  StreamingMessage,
  ThoughtCard,
  HandoffMessage,
  ErrorMessage,
  ActionHandler,
  TypingIndicator,
  StatusIndicator,
  ChatInput,
  MessageList,
  ChatWidget,
  MessageFeedbackControls,
  SendIcon,
  AttachIcon,
  ExpandIcon,
  CollapseIcon,
  ThoughtIcon,
  ErrorIcon as ErrorSvgIcon,
  HandoffIcon,
} from './components/index.js';
export type {
  ChatWidgetProps,
  MessageListProps,
  MessageFeedbackControlsProps,
  MessageFeedbackSubmit,
} from './components/index.js';

// Theme system
export { SDKThemeProvider } from './theme/ThemeProvider.js';
export type { SDKTheme } from './theme/types.js';
export { defaultTheme } from './theme/default-theme.js';

// Strings / i18n system
export { StringsProvider, useStrings } from './strings/StringsProvider.js';
export type { SDKStrings } from './strings/types.js';
export { defaultStrings } from './strings/defaults.js';
