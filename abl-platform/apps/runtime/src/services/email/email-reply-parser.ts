/**
 * Email Reply Parser
 *
 * Extracts only the latest reply from an email, stripping:
 * - Quoted text ("On ... wrote:", "> " prefixed lines)
 * - Email signatures ("--", "Sent from my iPhone", etc.)
 * - Forwarded message headers
 */

import EmailReplyParser from 'email-reply-parser';

/**
 * Extract the visible reply text from an email body.
 * Returns the original text if parsing yields an empty result.
 */
export function extractReplyText(text: string | null | undefined): string {
  if (!text) return '';

  try {
    const parser = new EmailReplyParser();
    const visibleText = parser.parseReply(text).trim();

    // Fallback: if parser strips everything, return original
    return visibleText || text.trim();
  } catch {
    // If parser throws on malformed input, return original text
    return text.trim();
  }
}
