/**
 * Web Worker — Image Resize (B03 Multimodality)
 *
 * Resizes images to fit within maxDim while preserving aspect ratio.
 * Uses OffscreenCanvas (available in Worker contexts).
 *
 * Message:  { type: 'resize', imageData: ArrayBuffer, maxDim: number, mimeType: string }
 * Response: { type: 'resized', base64: string, width: number, height: number }
 *       or: { type: 'passthrough', width: number, height: number }  (no resize needed)
 *       or: { type: 'error', message: string }
 */

/* eslint-disable no-restricted-globals */
self.onmessage = async function (e) {
  const { type, imageData, maxDim, mimeType } = e.data;
  if (type !== 'resize') return;

  try {
    const blob = new Blob([imageData], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;

    // No resize needed — signal passthrough so caller uses original file
    if (width <= maxDim && height <= maxDim) {
      bitmap.close();
      self.postMessage({ type: 'passthrough', width, height });
      return;
    }

    // Calculate new dimensions preserving aspect ratio
    const scale = maxDim / Math.max(width, height);
    const newWidth = Math.round(width * scale);
    const newHeight = Math.round(height * scale);

    const canvas = new OffscreenCanvas(newWidth, newHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      self.postMessage({
        type: 'error',
        message: 'Failed to get 2d context from OffscreenCanvas',
      });
      return;
    }
    ctx.drawImage(bitmap, 0, 0, newWidth, newHeight);
    bitmap.close();

    // Convert to blob then to base64 via ArrayBuffer
    const outputType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    const quality = outputType === 'image/jpeg' ? 0.85 : undefined;
    const resultBlob = await canvas.convertToBlob({
      type: outputType,
      quality,
    });

    // FileReaderSync is available in dedicated workers but not all environments.
    // Use arrayBuffer() + manual base64 encoding as a more portable approach.
    const arrayBuf = await resultBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    self.postMessage({
      type: 'resized',
      base64,
      width: newWidth,
      height: newHeight,
      outputMimeType: outputType,
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
