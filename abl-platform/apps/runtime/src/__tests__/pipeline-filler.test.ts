import { describe, test, expect, vi } from 'vitest';
import { generatePipelineFiller } from '../services/filler/pipeline-filler.js';
import type { LanguageModel } from 'ai';

// Mock the 'ai' module's generateText
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

function makeMockModel(): LanguageModel {
  return { modelId: 'test-model' } as unknown as LanguageModel;
}

describe('generatePipelineFiller', () => {
  test('generates contextual filler from user message', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Searching for red sneakers under 500 AED',
    } as any);

    const result = await generatePipelineFiller(
      makeMockModel(),
      'Show me red sneakers under 500 AED',
    );
    expect(result).toBe('Searching for red sneakers under 500 AED...');
  });

  test('strips surrounding quotes from LLM output', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '“Looking up the return policy”',
    } as any);

    const result = await generatePipelineFiller(
      makeMockModel(),
      'What is the return policy for clothing?',
    );
    expect(result).toBe('Looking up the return policy...');
  });

  test('preserves existing trailing ellipsis', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Searching for products...',
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Show me products');
    expect(result).toBe('Searching for products...');
  });

  test('uses localized punctuation for non-English generated fillers', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '確認中です...',
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), '予約を確認して', {
      locale: 'ja-JP',
    });

    expect(result).toBe('確認中です。');
  });

  test('returns null on timeout/error', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('timeout'));

    const result = await generatePipelineFiller(makeMockModel(), 'Hi');
    expect(result).toBeNull();
  });

  test('returns null for empty LLM response', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '' } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Hi');
    expect(result).toBeNull();
  });

  test('returns null for overly long response (>100 chars)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'A'.repeat(101),
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Hi');
    expect(result).toBeNull();
  });

  test('allows longer custom prompt output and preserves punctuation', async () => {
    const customFiller = "I'm checking your appointments now. I'll share the details shortly.";
    mockGenerateText.mockResolvedValueOnce({
      text: customFiller,
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'What are my appointments?', {
      promptOverride: 'Generate a 9 second spoken filler for {userMessage}',
    });

    expect(result).toBe(customFiller);
    const lastCall = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1];
    const args = lastCall![0] as any;
    expect(args.maxOutputTokens).toBe(90);
  });

  test('adds language hint to custom prompt overrides without language placeholders', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Revisando ahora.',
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Consulta mi cita', {
      promptOverride: 'Generate a brief spoken filler for {userMessage}',
      language: 'Spanish',
      locale: 'es-MX',
    });

    expect(result).toBe('Revisando ahora.');
    const lastCall = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1];
    const args = lastCall![0] as any;
    expect(args.prompt).toContain('Target language: Spanish, locale: es-MX.');
  });

  test('adds neutral voice guidance for generated voice fillers', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Checking your appointment',
    } as any);

    await generatePipelineFiller(makeMockModel(), 'Check my appointment', {
      isVoiceChannel: true,
    });

    const lastCall = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1];
    const args = lastCall![0] as any;
    expect(args.prompt).toContain(
      'Voice channel: keep the status conversational, brief, and easy to say aloud.',
    );
    expect(args.prompt).toContain(
      'Use light, context-appropriate warmth from the user message, such as calm confidence or gentle reassurance when it clearly fits.',
    );
    expect(args.prompt).toContain('Do not over-apologize, perform empathy, or invent commitments.');
  });

  test('adds generic guidance for stance acknowledgments without static examples', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'I hear you, checking the next step',
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), "I don't want to restart", {
      isVoiceChannel: true,
    });

    expect(result).toBe('I hear you, checking the next step...');
    const lastCall = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1];
    const args = lastCall![0] as any;
    expect(args.prompt).toContain('Treat this as an acknowledgment, not a summary');
    expect(args.prompt).toContain(
      'When the user is objecting, correcting, confused, or asking why',
    );
    expect(args.prompt).toContain('Avoid logical paraphrases of the user');
    expect(args.prompt).not.toContain('Do not say:');
    expect(args.prompt).not.toContain('Status: I hear you, checking the next step.');
  });

  test('adds voice guidance to custom prompt overrides without context placeholders', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Checking your appointment.',
    } as any);

    await generatePipelineFiller(makeMockModel(), 'Check my appointment', {
      promptOverride: 'Generate a brief spoken filler for {userMessage}',
      isVoiceChannel: true,
    });

    const lastCall = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1];
    const args = lastCall![0] as any;
    expect(args.prompt).toContain(
      'Voice channel: keep the status conversational, brief, and easy to say aloud.',
    );
  });

  test('strips reasoning tags before applying custom prompt length limits', async () => {
    const customFiller = "I'm checking the available details now and reviewing what is available.";
    mockGenerateText.mockResolvedValueOnce({
      text: `<think>${'reasoning '.repeat(80)}</think>${customFiller}`,
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Cancel my appointment', {
      promptOverride: 'Custom prompt for {userMessage}',
    });

    expect(result).toBe(customFiller);
  });

  test('keeps natural custom prompt wording that contains need', async () => {
    const customFiller = 'I need a moment to check that.';
    mockGenerateText.mockResolvedValueOnce({
      text: customFiller,
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Check my appointment', {
      promptOverride: 'Custom prompt for {userMessage}',
    });

    expect(result).toBe(customFiller);
  });

  test('compacts long custom prompt output around useful conversational sentences', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: [
        'Here is the requested filler response.',
        'I am checking the available account details and reviewing what information is visible right now.',
        'I am continuing to look through the current account records and checking what is available.',
        'This extra commentary should not be included because it pushes the text beyond the spoken filler budget.',
      ].join(' '),
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Cancel my appointment', {
      promptOverride: 'Custom prompt for {userMessage}',
    });

    expect(result).toContain('I am checking the available account details');
    expect(result).not.toContain('Here is the requested filler response');
    expect(result!.length).toBeLessThanOrEqual(320);
  });

  test('returns null instead of emitting meta-only custom prompt reasoning', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: [
        "It's a service request, so I should proceed with the filler paragraph.",
        'The required static sentence is "Please stay connected while I review the information."',
        'I need to add one or two procedural sentences.',
      ].join(' '),
    } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Cancel my appointment', {
      promptOverride: 'Custom prompt for {userMessage}',
    });

    expect(result).toBeNull();
  });

  test('returns null for NONE response (greetings)', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'NONE' } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Hi');
    expect(result).toBeNull();
  });

  test('returns null for lowercase none response', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'none' } as any);

    const result = await generatePipelineFiller(makeMockModel(), 'Hello there');
    expect(result).toBeNull();
  });

  test('passes correct prompt parameters to generateText', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: 'On it' } as any);

    await generatePipelineFiller(makeMockModel(), 'Show me shoes');

    const lastCall = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1];
    const args = lastCall![0] as any;
    expect(args.maxOutputTokens).toBe(30);
    expect(args.temperature).toBe(0);
    expect(args.prompt).toContain('Show me shoes');
  });
});
