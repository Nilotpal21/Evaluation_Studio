/**
 * SDKTheme — Type definition for theming the SDK UI components.
 *
 * All values map to CSS custom properties (--sdk-*) on the wrapper div.
 */

export interface SDKTheme {
  /** Primary accent color (buttons, links). Default: '#2563eb' */
  primaryColor: string;
  /** Primary hover state color. Default: '#1d4ed8' */
  primaryHoverColor: string;
  /** Main background color. Default: '#ffffff' */
  backgroundColor: string;
  /** Surface/card background color. Default: '#f8fafc' */
  surfaceColor: string;
  /** Primary text color. Default: '#1e293b' */
  textColor: string;
  /** Secondary/muted text color. Default: '#64748b' */
  textMutedColor: string;
  /** Border color. Default: '#e2e8f0' */
  borderColor: string;
  /** User message bubble background. Default: '#2563eb' */
  userBubbleColor: string;
  /** User message bubble text. Default: '#ffffff' */
  userBubbleTextColor: string;
  /** Assistant message bubble background. Default: '#f1f5f9' */
  assistantBubbleColor: string;
  /** Assistant message bubble text. Default: '#1e293b' */
  assistantBubbleTextColor: string;
  /** Error color. Default: '#ef4444' */
  errorColor: string;
  /** Warning color. Default: '#f59e0b' */
  warningColor: string;
  /** Border radius in px. Default: '8px' */
  borderRadius: string;
  /** Font family. Default: 'system-ui, -apple-system, sans-serif' */
  fontFamily: string;
  /** Base font size. Default: '14px' */
  fontSize: string;
}
