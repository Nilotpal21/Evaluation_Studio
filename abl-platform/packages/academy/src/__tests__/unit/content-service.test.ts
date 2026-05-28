import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { createContentService } from '../../services/content-service.js';
import { clearContentCaches } from '../../content/content-loader.js';
import type { ContentService } from '../../types.js';

const CONTENT_ROOT = join(import.meta.dirname, '..', '..', '..', 'content');

let service: ContentService;

beforeAll(() => {
  service = createContentService(CONTENT_ROOT);
});

beforeEach(() => {
  clearContentCaches();
});

describe('getConfig', () => {
  it('returns academy configuration', async () => {
    const config = await service.getConfig();
    expect(config.title).toBe('Agent Platform Learning Academy');
    expect(config.settings.quizPassThreshold).toBe(0.8);
    expect(config.personas).toHaveLength(3);
    expect(config.badges.length).toBeGreaterThan(0);
    expect(config.ranks.length).toBeGreaterThan(0);
  });

  it('contains all three persona IDs', async () => {
    const config = await service.getConfig();
    const ids = config.personas.map((p) => p.id);
    expect(ids).toContain('agent-builder');
    expect(ids).toContain('agent-architect');
    expect(ids).toContain('business-analyst');
  });

  it('has persona course map for all personas', async () => {
    const config = await service.getConfig();
    expect(config.personaCourseMap['agent-builder']).toBeDefined();
    expect(config.personaCourseMap['agent-architect']).toBeDefined();
    expect(config.personaCourseMap['business-analyst']).toBeDefined();
  });
});

describe('getCourses', () => {
  it('returns all unique courses from persona maps', async () => {
    const courses = await service.getCourses();
    expect(courses.length).toBeGreaterThanOrEqual(10);

    // Verify structure
    for (const course of courses) {
      expect(course.id).toBeDefined();
      expect(course.title).toBeDefined();
      expect(course.modules).toBeInstanceOf(Array);
      expect(course.modules.length).toBeGreaterThan(0);
    }
  });
});

describe('getCourse', () => {
  it('loads a specific course', async () => {
    const course = await service.getCourse('abl-language');
    expect(course.id).toBe('abl-language');
    expect(course.title).toContain('ABL');
    expect(course.modules).toBeInstanceOf(Array);
    expect(course.certification).toBeDefined();
  });

  it('throws for non-existent course', async () => {
    await expect(service.getCourse('nonexistent')).rejects.toThrow();
  });
});

describe('getModule', () => {
  it('loads a specific module', async () => {
    const mod = await service.getModule('getting-started');
    expect(mod.id).toBe('getting-started');
    expect(mod.title).toBeDefined();
    expect(mod.lessons).toBeInstanceOf(Array);
  });

  it('returns videos map when module has video entries', async () => {
    const mod = await service.getModule('getting-started');
    expect(mod.videos).toBeDefined();
    expect(mod.videos!['what-is-agent-platform']).toBeDefined();

    const video = mod.videos!['what-is-agent-platform'];
    expect(video.url).toContain('youtube.com/embed/');
    expect(video.title).toBeDefined();
    expect(typeof video.durationSeconds).toBe('number');
    expect(video.durationSeconds).toBeGreaterThan(0);
  });

  it('returns undefined videos for modules without video entries', async () => {
    const mod = await service.getModule('abl-basics');
    expect(mod.videos).toBeUndefined();
  });

  it('loads all 40 modules without errors', async () => {
    // Get all module IDs from all courses
    const courses = await service.getCourses();
    const moduleIds = new Set<string>();
    for (const course of courses) {
      for (const id of course.modules) {
        moduleIds.add(id);
      }
    }

    expect(moduleIds.size).toBe(40);

    for (const id of moduleIds) {
      const mod = await service.getModule(id);
      expect(mod.id).toBe(id);
      expect(mod.title).toBeDefined();
    }
  });
});

describe('getModuleContent', () => {
  it('returns markdown content', async () => {
    const content = await service.getModuleContent('getting-started');
    expect(content).toContain('#');
    expect(content.length).toBeGreaterThan(100);
  });
});

describe('getQuiz', () => {
  it('returns quiz with stripped answers', async () => {
    const quiz = await service.getQuiz('getting-started');
    expect(quiz.passThreshold).toBe(0.8);
    expect(quiz.questions.length).toBeGreaterThan(0);

    for (const q of quiz.questions) {
      expect(q.id).toBeDefined();
      expect(q.type).toMatch(/^(mcq|fill-blank)$/);
      expect(q.stem).toBeDefined();

      // Answers must be stripped
      if (q.type === 'mcq' && q.options) {
        for (const opt of q.options) {
          expect(opt).not.toHaveProperty('correct');
        }
      }
      expect(q.answer).toBeUndefined();
      expect(q.acceptAlternatives).toBeUndefined();

      // Explanation should be empty (not revealed before answering)
      expect(q.explanation).toBe('');
    }
  });
});

describe('getQuizInternal', () => {
  it('returns quiz with full answer data', async () => {
    const quiz = await service.getQuizInternal('getting-started');
    expect(quiz.moduleId).toBe('getting-started');
    expect(quiz.passThreshold).toBe(0.8);
    expect(quiz.questions.length).toBeGreaterThan(0);

    // Should have at least one MCQ with correct option
    const mcqs = quiz.questions.filter((q) => q.type === 'mcq');
    expect(mcqs.length).toBeGreaterThan(0);
    for (const mcq of mcqs) {
      const hasCorrect = mcq.options?.some((o) => o.correct === true);
      expect(hasCorrect).toBe(true);
    }

    // Should have at least one fill-blank with answer
    const fillBlanks = quiz.questions.filter((q) => q.type === 'fill-blank');
    expect(fillBlanks.length).toBeGreaterThan(0);
    for (const fb of fillBlanks) {
      expect(fb.answer).toBeDefined();
      expect(typeof fb.answer).toBe('string');
    }
  });
});

describe('getContentVersion', () => {
  it('returns consistent SHA-256 hash', async () => {
    const hash = await service.getContentVersion('getting-started');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Same call returns same hash
    clearContentCaches();
    const hash2 = await service.getContentVersion('getting-started');
    expect(hash).toBe(hash2);
  });

  it('returns different hashes for different modules', async () => {
    const h1 = await service.getContentVersion('getting-started');
    const h2 = await service.getContentVersion('abl-basics');
    expect(h1).not.toBe(h2);
  });
});
