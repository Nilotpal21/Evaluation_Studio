/**
 * Barrel export for SDK React components.
 */

export { MarkdownContent } from './MarkdownContent.js';
export { StreamingMessage } from './StreamingMessage.js';
export { ThoughtCard } from './ThoughtCard.js';
export { HandoffMessage } from './HandoffMessage.js';
export { ErrorMessage } from './ErrorMessage.js';
export { ActionHandler } from './ActionHandler.js';
export { TypingIndicator, StatusIndicator } from './TypingIndicator.js';
export { ChatInput } from './ChatInput.js';
export { MessageList } from './MessageList.js';
export type { MessageListProps } from './MessageList.js';
export { ChatWidget } from './ChatWidget.js';
export type { ChatWidgetProps } from './ChatWidget.js';
export { MessageFeedbackControls } from './MessageFeedbackControls.js';
export type {
  MessageFeedbackControlsProps,
  MessageFeedbackSubmit,
} from './MessageFeedbackControls.js';
export { RichContent } from './RichContent.js';
export type { RichContentProps } from './RichContent.js';

// Icons (for consumers who want to use them directly)
export {
  SendIcon,
  AttachIcon,
  ExpandIcon,
  CollapseIcon,
  ThoughtIcon,
  ErrorIcon,
  HandoffIcon,
} from './icons.js';
