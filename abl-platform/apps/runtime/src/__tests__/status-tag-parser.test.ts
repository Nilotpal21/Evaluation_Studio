import { describe, test, expect } from 'vitest';
import { StatusTagParser } from '../services/filler/status-tag-parser.js';

describe('StatusTagParser', () => {
  test('extracts status tag and strips from output', () => {
    const parser = new StatusTagParser();
    const result = parser.processChunk('<status>Searching for red sneakers</status>');
    expect(result.statusText).toBe('Searching for red sneakers');
    expect(result.outputChunk).toBe('');
  });

  test('passes through text without status tags', () => {
    const parser = new StatusTagParser();
    const result = parser.processChunk('Here are some results for you.');
    expect(result.statusText).toBeNull();
    expect(result.outputChunk).toBe('Here are some results for you.');
  });

  test('strips tag and preserves surrounding text', () => {
    const parser = new StatusTagParser();
    const result = parser.processChunk(
      'Sure! <status>Looking up your order</status>Let me check that.',
    );
    expect(result.statusText).toBe('Looking up your order');
    expect(result.outputChunk).toBe('Sure! Let me check that.');
  });

  test('handles tag split across two chunks', () => {
    const parser = new StatusTagParser();

    const r1 = parser.processChunk('<sta');
    expect(r1.statusText).toBeNull();
    expect(r1.outputChunk).toBe('');

    const r2 = parser.processChunk('tus>Checking policies</status>');
    expect(r2.statusText).toBe('Checking policies');
    expect(r2.outputChunk).toBe('');
  });

  test('handles closing tag split across chunks', () => {
    const parser = new StatusTagParser();

    const r1 = parser.processChunk('<status>Looking up products</sta');
    expect(r1.statusText).toBeNull();

    const r2 = parser.processChunk('tus>Here are the results.');
    expect(r2.statusText).toBe('Looking up products');
    expect(r2.outputChunk).toBe('Here are the results.');
  });

  test('handles content split across chunks inside tag', () => {
    const parser = new StatusTagParser();

    const r1 = parser.processChunk('<status>Searching for');
    expect(r1.statusText).toBeNull();
    expect(r1.outputChunk).toBe('');

    const r2 = parser.processChunk(' red sneakers</status>');
    expect(r2.statusText).toBe('Searching for red sneakers');
    expect(r2.outputChunk).toBe('');
  });

  test('flushes incomplete tag as regular text', () => {
    const parser = new StatusTagParser();

    parser.processChunk('<status>Incomplete tag without closing');
    const flushed = parser.flush();
    expect(flushed).toBe('<status>Incomplete tag without closing');
  });

  test('flushes partial opening tag as regular text', () => {
    const parser = new StatusTagParser();

    const r1 = parser.processChunk('Hello <statu');
    // Partial "<statu" is buffered
    expect(r1.outputChunk).toBe('Hello ');

    const flushed = parser.flush();
    expect(flushed).toBe('<statu');
  });

  test('handles multiple status tags in one chunk (uses last)', () => {
    const parser = new StatusTagParser();
    const result = parser.processChunk('<status>First</status>text<status>Second</status>more');
    // Both tags extracted, last one wins in statusText return
    // But the parser returns the last extracted status text
    expect(result.statusText).toBe('Second');
    expect(result.outputChunk).toBe('textmore');
  });

  test('trims whitespace from extracted status text', () => {
    const parser = new StatusTagParser();
    const result = parser.processChunk('<status>  Searching for products  </status>');
    expect(result.statusText).toBe('Searching for products');
  });

  test('handles empty status tag gracefully', () => {
    const parser = new StatusTagParser();
    const result = parser.processChunk('<status></status>rest');
    expect(result.statusText).toBe('');
    expect(result.outputChunk).toBe('rest');
  });

  test('handles chunk that is just the opening tag', () => {
    const parser = new StatusTagParser();

    const r1 = parser.processChunk('<status>');
    expect(r1.statusText).toBeNull();
    expect(r1.outputChunk).toBe('');

    const r2 = parser.processChunk('Looking it up</status>Done.');
    expect(r2.statusText).toBe('Looking it up');
    expect(r2.outputChunk).toBe('Done.');
  });
});
