/**
 * TDD lock tests for buildReaskPrompt — Slice 2 [ABLP-413]
 *
 * Tests the pure function that generates regeneration prompts for output
 * guardrail reask. The prompt MUST NOT embed raw violation details (prevents
 * the LLM from using violation text as bypass hints).
 */

import { describe, it, expect } from 'vitest';
import { buildReaskPrompt, type ReaskViolationInfo } from '../services/execution/reask-executor.js';

describe('buildReaskPrompt', () => {
  const baseViolation: ReaskViolationInfo = {
    guardrailName: 'pii-check',
    kind: 'output',
    action: 'reask',
  };

  it('should return a non-empty string instruction', () => {
    const prompt = buildReaskPrompt(baseViolation, 1);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should NOT embed the guardrail name in the prompt (prevents bypass hints)', () => {
    const prompt = buildReaskPrompt(baseViolation, 1);
    expect(prompt).not.toContain('pii-check');
  });

  it('should NOT embed raw violation message text', () => {
    const violation: ReaskViolationInfo = {
      ...baseViolation,
      message: 'SSN 123-45-6789 detected in output',
    };
    const prompt = buildReaskPrompt(violation, 1);
    expect(prompt).not.toContain('SSN');
    expect(prompt).not.toContain('123-45-6789');
    expect(prompt).not.toContain('detected in output');
  });

  it('should NOT embed secret-bearing violation details', () => {
    const violation: ReaskViolationInfo = {
      ...baseViolation,
      message: 'API key sk-proj-abc123def exposed',
      category: 'credential_leak',
    };
    const prompt = buildReaskPrompt(violation, 1);
    expect(prompt).not.toContain('sk-proj-abc123def');
    expect(prompt).not.toContain('API key');
    expect(prompt).not.toContain('credential_leak');
  });

  it('should use abstract category language (e.g., "policy violation")', () => {
    const prompt = buildReaskPrompt(baseViolation, 1);
    // Should contain generic policy language, not specific rule names
    const hasAbstractLanguage =
      prompt.includes('policy') ||
      prompt.includes('guideline') ||
      prompt.includes('content') ||
      prompt.includes('violation');
    expect(hasAbstractLanguage).toBe(true);
  });

  it('should produce different prompts for different attempt numbers (escalating urgency)', () => {
    const prompt1 = buildReaskPrompt(baseViolation, 1);
    const prompt2 = buildReaskPrompt(baseViolation, 2);
    const prompt3 = buildReaskPrompt(baseViolation, 3);

    // At minimum, attempt 1 and attempt 3 should differ
    expect(prompt1).not.toBe(prompt3);
    // All should be non-empty
    expect(prompt1.length).toBeGreaterThan(0);
    expect(prompt2.length).toBeGreaterThan(0);
    expect(prompt3.length).toBeGreaterThan(0);
  });

  it('should handle violation with undefined/null optional fields gracefully', () => {
    const minimalViolation: ReaskViolationInfo = {
      guardrailName: 'test',
      kind: 'output',
      action: 'reask',
      // message, category intentionally omitted
    };
    const prompt = buildReaskPrompt(minimalViolation, 1);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should handle attempt number 0 without error', () => {
    // Edge case: attempt 0 should not throw
    const prompt = buildReaskPrompt(baseViolation, 0);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
