/**
 * Streaming PII Buffer
 *
 * Handles PII detection across streaming chunk boundaries using a trailing
 * buffer of 320 characters. This ensures PII patterns that span chunk
 * boundaries (e.g., a phone number split between two chunks) are detected
 * and redacted correctly.
 *
 * Usage:
 *   const buffer = new StreamingPIIBuffer();
 *   for (const chunk of stream) {
 *     const { safeText, detections } = buffer.processChunk(chunk, detectPII);
 *     emit(safeText);
 *   }
 *   const { safeText, detections } = buffer.flush(detectPII);
 *   emit(safeText);
 */

import type { PIIDetection, PIIDetectionResult } from './pii-detector.js';

export interface StreamingPIIChunkResult {
  safeText: string;
  detections: PIIDetection[];
}

export class StreamingPIIBuffer {
  // Max RFC-sized email length so split emails can be reassembled safely.
  private static readonly BUFFER_SIZE = 320;
  private buffer = '';

  /**
   * Process an incoming chunk. Prepends the internal buffer, runs PII
   * detection on the combined text, emits the safe prefix (everything
   * before the trailing BUFFER_SIZE characters), and retains the tail
   * in the internal buffer for the next chunk.
   */
  processChunk(
    chunk: string,
    detector: (text: string) => PIIDetectionResult,
  ): StreamingPIIChunkResult {
    if (chunk.length === 0 && this.buffer.length === 0) {
      return { safeText: '', detections: [] };
    }

    const combined = this.buffer + chunk;

    if (combined.length <= StreamingPIIBuffer.BUFFER_SIZE) {
      // Not enough text to emit anything yet — keep it all in buffer
      this.buffer = combined;
      return { safeText: '', detections: [] };
    }

    // Split into emittable prefix and new buffer tail
    const splitPoint = combined.length - StreamingPIIBuffer.BUFFER_SIZE;
    const toProcess = combined;

    // Run detection on the full combined text
    const result = detector(toProcess);

    if (!result.hasPII) {
      // No PII found — emit prefix as-is, keep tail in buffer
      const safeText = combined.substring(0, splitPoint);
      this.buffer = combined.substring(splitPoint);
      return { safeText, detections: [] };
    }

    // PII found — use the redacted version
    // We need to figure out which detections fall in the emitted prefix vs the buffer.
    // The redacted string may differ in length from the original, so we need to
    // compute the split carefully.

    // Find the last detection that starts before the split point in the original text.
    // Any detection that overlaps the split point must be fully included in the prefix
    // so it gets redacted properly.
    const detections = result.detections;

    // Calculate effective split: if a detection spans the split boundary,
    // extend the prefix to include the full detection.
    let effectiveSplit = splitPoint;
    for (const det of detections) {
      if (det.start < splitPoint && det.end > splitPoint) {
        // Detection spans the boundary — extend prefix to include it
        effectiveSplit = Math.max(effectiveSplit, det.end);
      }
    }

    // Ensure we still keep at least some buffer (but not more than combined length)
    effectiveSplit = Math.min(effectiveSplit, combined.length);

    // Re-run detection on just the prefix portion and just the tail portion
    // to get correct offsets for each segment
    const prefixText = combined.substring(0, effectiveSplit);
    const tailText = combined.substring(effectiveSplit);

    const prefixResult = detector(prefixText);
    this.buffer = tailText;

    return {
      safeText: prefixResult.redacted,
      detections: prefixResult.detections,
    };
  }

  /**
   * Flush any remaining buffered text at the end of the stream.
   * Must be called when the stream ends to process the trailing buffer.
   */
  flush(detector: (text: string) => PIIDetectionResult): StreamingPIIChunkResult {
    if (this.buffer.length === 0) {
      return { safeText: '', detections: [] };
    }

    const result = detector(this.buffer);
    this.buffer = '';

    return {
      safeText: result.redacted,
      detections: result.detections,
    };
  }
}
