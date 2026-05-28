/**
 * JS Style Objects for SDK Components
 *
 * All colors reference CSS custom properties (var(--sdk-*)) so they are
 * theme-driven. If no SDKThemeProvider wraps the tree the default-theme
 * values still show via the provider's default context.
 */

import type { CSSProperties } from 'react';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const chatContainer: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  fontFamily: 'var(--sdk-font-family, system-ui, -apple-system, sans-serif)',
  fontSize: 'var(--sdk-font-size, 14px)',
  color: 'var(--sdk-text, #1e293b)',
  backgroundColor: 'var(--sdk-bg, #ffffff)',
};

export const messageListContainer: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

const bubbleBase: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--sdk-radius, 12px)',
  maxWidth: '75%',
  wordBreak: 'break-word',
  lineHeight: '1.6',
  fontSize: 'var(--sdk-font-size, 14px)',
};

export const userBubble: CSSProperties = {
  ...bubbleBase,
  alignSelf: 'flex-end',
  backgroundColor: 'var(--sdk-user-bubble, #2563eb)',
  color: 'var(--sdk-user-bubble-text, #ffffff)',
  borderBottomRightRadius: '4px',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)',
};

export const assistantBubble: CSSProperties = {
  ...bubbleBase,
  alignSelf: 'flex-start',
  backgroundColor: 'var(--sdk-assistant-bubble, #f1f5f9)',
  color: 'var(--sdk-assistant-bubble-text, #1e293b)',
  borderBottomLeftRadius: '4px',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
};

export const systemMessage: CSSProperties = {
  alignSelf: 'center',
  color: 'var(--sdk-text-muted, #64748b)',
  fontSize: '0.85em',
  fontStyle: 'italic',
  padding: '4px 8px',
};

// ---------------------------------------------------------------------------
// Thought Card
// ---------------------------------------------------------------------------

export const thoughtCard: CSSProperties = {
  alignSelf: 'flex-start',
  backgroundColor: 'var(--sdk-surface, #f8fafc)',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  borderRadius: '12px',
  padding: '12px 16px',
  maxWidth: '75%',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
};

export const thoughtCardHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.85em',
  color: 'var(--sdk-text-muted, #64748b)',
  userSelect: 'none',
};

export const thoughtCardBody: CSSProperties = {
  marginTop: '8px',
  fontSize: '0.9em',
  color: 'var(--sdk-text, #1e293b)',
  whiteSpace: 'pre-wrap',
};

export const thoughtCardFooter: CSSProperties = {
  marginTop: '6px',
  display: 'flex',
  justifyContent: 'flex-end',
};

export const viewTraceLink: CSSProperties = {
  fontSize: '0.8em',
  color: 'var(--sdk-primary, #2563eb)',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  padding: 0,
  textDecoration: 'underline',
};

// ---------------------------------------------------------------------------
// Error / Handoff
// ---------------------------------------------------------------------------

export const errorMessage: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '10px 14px',
  borderRadius: 'var(--sdk-radius, 8px)',
  maxWidth: '80%',
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
};

export const handoffMessage: CSSProperties = {
  alignSelf: 'center',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: '6px',
  width: 'fit-content',
  maxWidth: '85%',
};

export const handoffMessageButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 10px',
  borderRadius: '999px',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  backgroundColor: 'var(--sdk-surface, #f8fafc)',
  color: 'var(--sdk-text-muted, #64748b)',
  fontSize: '0.85em',
  fontStyle: 'italic',
  cursor: 'pointer',
};

export const handoffMessageChevron: CSSProperties = {
  fontSize: '0.8em',
  fontStyle: 'normal',
  opacity: 0.9,
};

export const handoffMessageDetail: CSSProperties = {
  borderRadius: '12px',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  backgroundColor: 'var(--sdk-surface, #f8fafc)',
  color: 'var(--sdk-text, #1e293b)',
  fontSize: '0.82em',
  lineHeight: '1.5',
  padding: '10px 12px',
};

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export const streamingContainer: CSSProperties = {
  ...bubbleBase,
  alignSelf: 'flex-start',
  backgroundColor: 'var(--sdk-assistant-bubble, #f1f5f9)',
  color: 'var(--sdk-assistant-bubble-text, #1e293b)',
  borderBottomLeftRadius: '4px',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)',
};

export const streamingCursor: CSSProperties = {
  display: 'inline-block',
  width: '2px',
  height: '1em',
  backgroundColor: 'var(--sdk-primary, #2563eb)',
  marginLeft: '2px',
  verticalAlign: 'text-bottom',
  animation: 'sdk-blink 1s step-end infinite',
};

// ---------------------------------------------------------------------------
// Typing Indicator
// ---------------------------------------------------------------------------

export const typingContainer: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 14px',
  color: 'var(--sdk-text-muted, #64748b)',
  fontSize: '0.85em',
};

export const typingDots: CSSProperties = {
  display: 'flex',
  gap: '3px',
};

export const typingDot: CSSProperties = {
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  backgroundColor: 'var(--sdk-text-muted, #64748b)',
  animation: 'sdk-bounce 1.4s ease-in-out infinite both',
};

export const statusIndicatorContainer: CSSProperties = {
  padding: '2px 14px 8px 14px',
  color: 'var(--sdk-text-muted, #64748b)',
  fontSize: '0.85em',
  lineHeight: '1.45',
};

// ---------------------------------------------------------------------------
// Chat Input
// ---------------------------------------------------------------------------

export const inputContainer: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: '10px',
  padding: '14px 20px',
  borderTop: '1px solid var(--sdk-border, #e2e8f0)',
  backgroundColor: 'var(--sdk-bg, #ffffff)',
};

export const textArea: CSSProperties = {
  flex: 1,
  resize: 'none',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  borderRadius: '12px',
  padding: '10px 14px',
  fontSize: 'inherit',
  fontFamily: 'inherit',
  lineHeight: '1.5',
  color: 'var(--sdk-text, #1e293b)',
  backgroundColor: 'var(--sdk-surface, #f8fafc)',
  outline: 'none',
  minHeight: '40px',
  maxHeight: '120px',
  overflow: 'auto',
  transition: 'border-color 0.15s ease',
};

export const sendButton: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '40px',
  height: '40px',
  borderRadius: '12px',
  border: 'none',
  backgroundColor: 'var(--sdk-primary, #2563eb)',
  color: '#ffffff',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'opacity 0.15s ease, transform 0.1s ease',
};

export const sendButtonDisabled: CSSProperties = {
  ...sendButton,
  opacity: 0.5,
  cursor: 'not-allowed',
};

export const attachButton: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '40px',
  height: '40px',
  borderRadius: '12px',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  backgroundColor: 'transparent',
  color: 'var(--sdk-text-muted, #64748b)',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'border-color 0.15s ease',
};

export const dropZone: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(37, 99, 235, 0.08)',
  border: '2px dashed var(--sdk-primary, #2563eb)',
  borderRadius: 'var(--sdk-radius, 8px)',
  color: 'var(--sdk-primary, #2563eb)',
  fontWeight: 600,
  zIndex: 10,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const actionContainer: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  marginTop: '8px',
};

export const actionButton: CSSProperties = {
  padding: '6px 14px',
  borderRadius: 'var(--sdk-radius, 8px)',
  border: '1px solid var(--sdk-primary, #2563eb)',
  backgroundColor: 'transparent',
  color: 'var(--sdk-primary, #2563eb)',
  cursor: 'pointer',
  fontSize: '0.9em',
};

export const actionSelect: CSSProperties = {
  padding: '6px 10px',
  borderRadius: 'var(--sdk-radius, 8px)',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  backgroundColor: 'var(--sdk-bg, #ffffff)',
  color: 'var(--sdk-text, #1e293b)',
  fontSize: '0.9em',
};

export const actionInput: CSSProperties = {
  padding: '6px 10px',
  borderRadius: 'var(--sdk-radius, 8px)',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  backgroundColor: 'var(--sdk-bg, #ffffff)',
  color: 'var(--sdk-text, #1e293b)',
  fontSize: '0.9em',
  flex: 1,
  minWidth: '120px',
};

// ---------------------------------------------------------------------------
// Markdown Content
// ---------------------------------------------------------------------------

export const markdownContent: CSSProperties = {
  lineHeight: '1.6',
  wordBreak: 'break-word',
};

// ---------------------------------------------------------------------------
// Per-message Feedback
// ---------------------------------------------------------------------------

export const messageFeedbackContainer: CSSProperties = {
  marginTop: '10px',
  paddingTop: '8px',
  borderTop: '1px dashed color-mix(in srgb, var(--sdk-border, #e2e8f0) 80%, transparent)',
};

export const messageFeedbackRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
};

export const messageFeedbackButton: CSSProperties = {
  font: 'inherit',
  fontSize: '14px',
  lineHeight: 1,
  padding: '4px 8px',
  borderRadius: '8px',
  backgroundColor: 'transparent',
  color: 'var(--sdk-assistant-bubble-text, #1e293b)',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  cursor: 'pointer',
  opacity: 0.7,
  transition: 'opacity 0.15s ease, border-color 0.15s ease, background 0.15s ease',
};

export const messageFeedbackUpButton: CSSProperties = {
  opacity: 1,
  borderColor: 'rgba(34, 197, 94, 0.6)',
  backgroundColor: 'rgba(34, 197, 94, 0.1)',
};

export const messageFeedbackDownButton: CSSProperties = {
  opacity: 1,
  borderColor: 'rgba(239, 68, 68, 0.6)',
  backgroundColor: 'rgba(239, 68, 68, 0.1)',
};

export const messageFeedbackSentButton: CSSProperties = {
  cursor: 'default',
};

export const messageFeedbackStatus: CSSProperties = {
  fontSize: '11.5px',
  color: 'var(--sdk-text-muted, #64748b)',
  marginLeft: '4px',
};

export const messageFeedbackErrorStatus: CSSProperties = {
  ...messageFeedbackStatus,
  color: 'var(--sdk-error, #ef4444)',
};

export const messageFeedbackCommentBox: CSSProperties = {
  marginTop: '8px',
  backgroundColor: 'color-mix(in srgb, var(--sdk-surface, #f8fafc) 85%, transparent)',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  borderRadius: '8px',
  padding: '8px',
};

export const messageFeedbackTextarea: CSSProperties = {
  width: '100%',
  resize: 'vertical',
  minHeight: '44px',
  maxHeight: '160px',
  backgroundColor: 'var(--sdk-bg, #ffffff)',
  color: 'var(--sdk-text, #1e293b)',
  border: '1px solid var(--sdk-border, #e2e8f0)',
  borderRadius: '6px',
  padding: '6px 8px',
  font: 'inherit',
  fontSize: '13px',
  outline: 'none',
};

export const messageFeedbackCommentActions: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginTop: '6px',
};

export const messageFeedbackCounter: CSSProperties = {
  flex: 1,
  fontSize: '11px',
  color: 'var(--sdk-text-muted, #64748b)',
};

export const messageFeedbackGhostButton: CSSProperties = {
  border: '1px solid transparent',
  backgroundColor: 'transparent',
  color: 'var(--sdk-text-muted, #64748b)',
  borderRadius: '8px',
  padding: '6px 10px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12px',
};

export const messageFeedbackPrimaryButton: CSSProperties = {
  border: '1px solid var(--sdk-primary, #2563eb)',
  backgroundColor: 'var(--sdk-primary, #2563eb)',
  color: '#ffffff',
  borderRadius: '8px',
  padding: '6px 10px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12px',
  fontWeight: 600,
};

// ---------------------------------------------------------------------------
// Keyframe injection (called once)
// ---------------------------------------------------------------------------

let injected = false;

export function injectKeyframes(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes sdk-blink {
      50% { opacity: 0; }
    }
    @keyframes sdk-bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }
  `;
  document.head.appendChild(style);
}
