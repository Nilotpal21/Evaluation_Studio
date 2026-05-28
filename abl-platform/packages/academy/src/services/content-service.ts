/**
 * Learning Academy — Content Service
 *
 * Loads academy configuration, courses, modules, and quizzes from the
 * content/ directory. Uses the content-loader for caching and hashing.
 *
 * Key behavior:
 * - getQuiz() strips answer/correct/acceptAlternatives fields (client-safe)
 * - getQuizInternal() returns full data (server-side grading only)
 * - getContentVersion() returns SHA-256 of quiz.json for version tracking
 */

import { join } from 'node:path';
import { loadJson, loadMarkdown, getContentHash } from '../content/content-loader.js';
import type {
  ContentService,
  AcademyConfig,
  CourseConfig,
  ModuleConfig,
  QuizQuestion,
  QuizFile,
} from '../types.js';

export function createContentService(contentRoot: string): ContentService {
  function configPath(): string {
    return join(contentRoot, 'academy.json');
  }

  function coursePath(courseId: string): string {
    return join(contentRoot, 'courses', `${courseId}.json`);
  }

  function modulePath(moduleId: string): string {
    return join(contentRoot, 'modules', moduleId, 'module.json');
  }

  function moduleContentPath(moduleId: string): string {
    return join(contentRoot, 'modules', moduleId, 'content.md');
  }

  function quizPath(moduleId: string): string {
    return join(contentRoot, 'modules', moduleId, 'quiz.json');
  }

  /**
   * Strip sensitive fields from quiz questions for client responses.
   * Removes: correct (from options), answer, acceptAlternatives
   */
  function stripAnswers(questions: QuizQuestion[]): QuizQuestion[] {
    return questions.map((q) => {
      const stripped: QuizQuestion = {
        id: q.id,
        type: q.type,
        stem: q.stem,
        explanation: '', // Don't send explanation before answering
      };

      if (q.type === 'mcq' && q.options) {
        stripped.options = q.options.map(({ id, text }) => ({ id, text }));
      }

      return stripped;
    });
  }

  return {
    async getConfig(): Promise<AcademyConfig> {
      return loadJson<AcademyConfig>(configPath());
    },

    async getCourses(): Promise<CourseConfig[]> {
      const config = await loadJson<AcademyConfig>(configPath());
      // Load all course files referenced in the persona course map
      const courseIds = new Set<string>();
      for (const entry of Object.values(config.personaCourseMap)) {
        for (const id of entry.courses) {
          courseIds.add(id);
        }
      }

      const courses: CourseConfig[] = [];
      for (const id of courseIds) {
        const course = await loadJson<CourseConfig>(coursePath(id));
        courses.push(course);
      }
      return courses;
    },

    async getCourse(courseId: string): Promise<CourseConfig> {
      return loadJson<CourseConfig>(coursePath(courseId));
    },

    async getModule(moduleId: string): Promise<ModuleConfig> {
      return loadJson<ModuleConfig>(modulePath(moduleId));
    },

    async getModuleContent(moduleId: string): Promise<string> {
      return loadMarkdown(moduleContentPath(moduleId));
    },

    async getQuiz(moduleId: string): Promise<{ passThreshold: number; questions: QuizQuestion[] }> {
      const quiz = await loadJson<QuizFile>(quizPath(moduleId));
      return {
        passThreshold: quiz.passThreshold,
        questions: stripAnswers(quiz.questions),
      };
    },

    async getQuizInternal(moduleId: string): Promise<QuizFile> {
      return loadJson<QuizFile>(quizPath(moduleId));
    },

    async getContentVersion(moduleId: string): Promise<string> {
      return getContentHash(quizPath(moduleId));
    },
  };
}
