import { describe, it, expect } from 'vitest';
import {
  routeDocument,
  normalizeMimeType,
  detectMimeTypeFromExtension,
  isSupportedUploadType,
} from '../document-routing.js';

describe('document-routing', () => {
  // ── normalizeMimeType ─────────────────────────────────────────────────

  describe('normalizeMimeType', () => {
    it('returns null for null input', () => {
      expect(normalizeMimeType(null)).toBeNull();
    });

    it('passes through full MIME types', () => {
      expect(normalizeMimeType('application/pdf')).toBe('application/pdf');
      expect(normalizeMimeType('text/html')).toBe('text/html');
      expect(normalizeMimeType('image/png')).toBe('image/png');
    });

    it('lowercases MIME types', () => {
      expect(normalizeMimeType('Application/PDF')).toBe('application/pdf');
      expect(normalizeMimeType('TEXT/HTML')).toBe('text/html');
    });

    it('strips MIME parameters', () => {
      expect(normalizeMimeType('application/pdf; charset=utf-8')).toBe('application/pdf');
      expect(normalizeMimeType('text/html; charset=ISO-8859-1')).toBe('text/html');
    });

    it('resolves bare extensions to MIME types', () => {
      expect(normalizeMimeType('pdf')).toBe('application/pdf');
      expect(normalizeMimeType('docx')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(normalizeMimeType('html')).toBe('text/html');
      expect(normalizeMimeType('png')).toBe('image/png');
      expect(normalizeMimeType('csv')).toBe('text/csv');
    });

    it('resolves extensions with leading dot', () => {
      expect(normalizeMimeType('.pdf')).toBe('application/pdf');
      expect(normalizeMimeType('.docx')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    });

    it('handles case-insensitive extensions', () => {
      expect(normalizeMimeType('PDF')).toBe('application/pdf');
      expect(normalizeMimeType('DOCX')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    });

    it('returns null for unknown extensions', () => {
      expect(normalizeMimeType('xyz')).toBeNull();
      expect(normalizeMimeType('rar')).toBeNull();
    });
  });

  // ── routeDocument ─────────────────────────────────────────────────────

  describe('routeDocument', () => {
    it('routes PDFs to docling', () => {
      expect(routeDocument('application/pdf')).toBe('docling');
    });

    it('routes Office docs to docling', () => {
      expect(
        routeDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ).toBe('docling');
      expect(routeDocument('application/msword')).toBe('docling');
      expect(
        routeDocument('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      ).toBe('docling');
    });

    it('routes images to docling', () => {
      expect(routeDocument('image/png')).toBe('docling');
      expect(routeDocument('image/jpeg')).toBe('docling');
      expect(routeDocument('image/tiff')).toBe('docling');
    });

    it('routes HTML to docling', () => {
      expect(routeDocument('text/html')).toBe('docling');
    });

    it('routes plain text to legacy', () => {
      expect(routeDocument('text/plain')).toBe('legacy');
      expect(routeDocument('text/markdown')).toBe('legacy');
    });

    it('routes CSV/Excel to structured', () => {
      expect(routeDocument('text/csv')).toBe('structured');
      expect(routeDocument('application/csv')).toBe('structured');
      expect(
        routeDocument('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      ).toBe('structured');
    });

    it('routes JSON to json-chunking', () => {
      expect(routeDocument('application/json')).toBe('json-chunking');
    });

    it('defaults unknown types to docling', () => {
      expect(routeDocument('application/octet-stream')).toBe('docling');
      expect(routeDocument(null)).toBe('docling');
    });

    // Short-form / bare extension routing
    it('routes bare extensions correctly', () => {
      expect(routeDocument('pdf')).toBe('docling');
      expect(routeDocument('docx')).toBe('docling');
      expect(routeDocument('pptx')).toBe('docling');
      expect(routeDocument('html')).toBe('docling');
      expect(routeDocument('png')).toBe('docling');
      expect(routeDocument('txt')).toBe('legacy');
      expect(routeDocument('md')).toBe('legacy');
      expect(routeDocument('csv')).toBe('structured');
      expect(routeDocument('json')).toBe('json-chunking');
      expect(routeDocument('xlsx')).toBe('structured');
    });

    it('routes case-insensitive bare extensions', () => {
      expect(routeDocument('PDF')).toBe('docling');
      expect(routeDocument('Html')).toBe('docling');
    });

    it('routes MIME types with parameters', () => {
      expect(routeDocument('application/pdf; charset=utf-8')).toBe('docling');
      expect(routeDocument('text/plain; charset=utf-8')).toBe('legacy');
    });
  });

  // ── detectMimeTypeFromExtension ───────────────────────────────────────

  describe('detectMimeTypeFromExtension', () => {
    it('detects MIME from filename', () => {
      expect(detectMimeTypeFromExtension('report.pdf')).toBe('application/pdf');
      expect(detectMimeTypeFromExtension('slides.pptx')).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      expect(detectMimeTypeFromExtension('notes.txt')).toBe('text/plain');
    });

    it('handles uppercase extensions', () => {
      expect(detectMimeTypeFromExtension('REPORT.PDF')).toBe('application/pdf');
    });

    it('returns null for unknown extensions', () => {
      expect(detectMimeTypeFromExtension('archive.rar')).toBeNull();
      expect(detectMimeTypeFromExtension('noext')).toBeNull();
    });
  });

  // ── isSupportedUploadType ─────────────────────────────────────────────

  describe('isSupportedUploadType', () => {
    it('accepts known MIME types', () => {
      expect(isSupportedUploadType('application/pdf')).toBe(true);
      expect(isSupportedUploadType('text/plain')).toBe(true);
      expect(isSupportedUploadType('text/csv')).toBe(true);
      expect(isSupportedUploadType('application/json')).toBe(true);
    });

    it('accepts bare extensions', () => {
      expect(isSupportedUploadType('pdf')).toBe(true);
      expect(isSupportedUploadType('docx')).toBe(true);
      expect(isSupportedUploadType('txt')).toBe(true);
    });

    it('rejects unknown types', () => {
      expect(isSupportedUploadType('application/octet-stream')).toBe(false);
      expect(isSupportedUploadType('rar')).toBe(false);
      expect(isSupportedUploadType('zip')).toBe(false);
    });
  });
});
