import { describe, expect, it } from 'vitest';

import {
  getProjectNameFromWidgetAnswer,
  isProjectNameWidgetPayload,
  normalizeProjectNameWidgetAnswer,
} from '@/lib/arch-ai/processors/widget-answer-capture';

describe('widget answer capture', () => {
  it('recognizes project-name questions from text and select widgets', () => {
    expect(
      isProjectNameWidgetPayload({
        widgetType: 'TextInput',
        question: 'What should we call this project?',
      }),
    ).toBe(true);
    expect(
      isProjectNameWidgetPayload({
        widgetType: 'SingleSelect',
        question: 'Project Name',
      }),
    ).toBe(true);
  });

  it('normalizes custom project-name answers', () => {
    expect(normalizeProjectNameWidgetAnswer('Custom: DisputeFlow AI')).toBe('DisputeFlow AI');
    expect(normalizeProjectNameWidgetAnswer('  DisputeFlow AI  ')).toBe('DisputeFlow AI');
    expect(normalizeProjectNameWidgetAnswer('x')).toBeNull();
  });

  it('captures a project-name answer only when the spec does not already have one', () => {
    const payload = {
      widgetType: 'TextInput',
      question: 'What should we name your project?',
    };

    expect(
      getProjectNameFromWidgetAnswer({
        payload,
        answer: 'DisputeFlow AI',
      }),
    ).toBe('DisputeFlow AI');

    expect(
      getProjectNameFromWidgetAnswer({
        payload,
        answer: 'Different Name',
        currentProjectName: 'DisputeFlow AI',
      }),
    ).toBeNull();
  });

  it('does not treat other interview questions as project names', () => {
    expect(
      getProjectNameFromWidgetAnswer({
        payload: {
          widgetType: 'TextInput',
          question: 'Which workflows should the bot handle?',
        },
        answer: 'chargebacks and evidence collection',
      }),
    ).toBeNull();
  });
});
