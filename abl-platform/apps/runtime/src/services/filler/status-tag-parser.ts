/**
 * Streaming parser for `<status>...</status>` tags in LLM output.
 *
 * The LLM is instructed to emit a brief status message in `<status>` tags before
 * each tool call. This parser intercepts those tags from the stream, strips them
 * from the user-visible output, and extracts the status text for the filler system.
 *
 * Handles tags split across multiple chunks via a small buffer.
 */

const STATUS_OPEN = '<status>';
const STATUS_CLOSE = '</status>';
const MAX_BUFFER = 256;

export interface StatusTagParserResult {
  /** Text that should reach the user (status tags stripped) */
  outputChunk: string;
  /** Extracted status text, if a complete tag was found */
  statusText: string | null;
}

export class StatusTagParser {
  private buffer = '';
  private inTag = false;
  private tagContent = '';

  /**
   * Process a streaming chunk. Returns cleaned output and any extracted status text.
   */
  processChunk(chunk: string): StatusTagParserResult {
    let output = '';
    let statusText: string | null = null;
    const input = this.buffer + chunk;
    this.buffer = '';

    let i = 0;
    while (i < input.length) {
      if (this.inTag) {
        // Inside a <status> tag — accumulate content until </status>
        // The close tag may be split across tagContent (previous chunks) and current input,
        // so search the combined string.
        const remaining = input.slice(i);
        const prevLen = this.tagContent.length;
        const combined = this.tagContent + remaining;
        const closeIdx = combined.indexOf(STATUS_CLOSE);
        if (closeIdx !== -1) {
          statusText = combined.slice(0, closeIdx).trim();
          this.tagContent = '';
          this.inTag = false;
          i = i + (closeIdx + STATUS_CLOSE.length - prevLen);
        } else {
          // No closing tag yet — buffer remaining
          this.tagContent = combined;
          // Safety: if tag content is too large, flush as regular text
          if (this.tagContent.length > MAX_BUFFER) {
            output += STATUS_OPEN + this.tagContent;
            this.tagContent = '';
            this.inTag = false;
          }
          break;
        }
      } else {
        // Outside a tag — look for <status>
        const openIdx = input.indexOf(STATUS_OPEN, i);
        if (openIdx !== -1) {
          // Output everything before the tag
          output += input.slice(i, openIdx);
          this.inTag = true;
          this.tagContent = '';
          i = openIdx + STATUS_OPEN.length;
        } else {
          // Check if the end of input could be a partial "<status>" opening
          const remaining = input.slice(i);
          const partialMatch = findPartialOpenTag(remaining);
          if (partialMatch > 0) {
            output += remaining.slice(0, remaining.length - partialMatch);
            this.buffer = remaining.slice(remaining.length - partialMatch);
          } else {
            output += remaining;
          }
          break;
        }
      }
    }

    return { outputChunk: output, statusText };
  }

  /**
   * Flush any buffered content at end of stream.
   * Returns remaining text that should reach the user.
   */
  flush(): string {
    let flushed = this.buffer;
    if (this.inTag) {
      // Incomplete tag — flush as regular text
      flushed += STATUS_OPEN + this.tagContent;
    }
    this.buffer = '';
    this.tagContent = '';
    this.inTag = false;
    return flushed;
  }
}

/**
 * Check if the end of a string could be a partial `<status>` opening.
 * Returns the length of the partial match (0 if none).
 */
function findPartialOpenTag(text: string): number {
  // Check if text ends with a prefix of "<status>"
  for (let len = Math.min(STATUS_OPEN.length - 1, text.length); len > 0; len--) {
    if (text.endsWith(STATUS_OPEN.slice(0, len))) {
      return len;
    }
  }
  return 0;
}
