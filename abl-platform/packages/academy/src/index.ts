/**
 * Learning Academy — Package Barrel Export
 *
 * Zero @agent-platform/* dependencies.
 */

// Factory
export { createAcademyServices } from './factory.js';

// Storage
export type { AcademyStoragePort } from './storage/storage-port.js';
export {
  createMongooseAcademyStorage,
  MongooseAcademyStorage,
} from './storage/mongoose-storage.js';

// Ports
export type { AcademyAuthPort } from './ports.js';

// Serialization
export { serializeProgress } from './types.js';

// Types
export type {
  AcademyUser,
  AcademyProgress,
  ModuleProgress,
  QuizOption,
  QuizQuestion,
  QuizFile,
  QuizSubmission,
  QuizResult,
  LeaderboardEntry,
  AcademyConfig,
  AcademySettings,
  PersonaConfig,
  PersonaCourseMapEntry,
  BadgeConfig,
  RankConfig,
  Lesson,
  VideoRef,
  CourseConfig,
  CourseCertification,
  ModuleConfig,
  ContentService,
  ProgressService,
  GamificationService,
  LeaderboardService,
  AcademyServices,
  AcademyServicesOptions,
} from './types.js';

// Content
export { createContentService } from './services/content-service.js';
export { resolveContentRoot, clearContentCaches } from './content/content-loader.js';

// Quiz
export { gradeQuiz, type GradeResult } from './quiz/quiz-grader.js';

// Services
export { createProgressService, clearRateLimits } from './services/progress-service.js';
export {
  createGamificationService,
  deriveRankFromPoints,
  longestConsecutiveStreak,
} from './services/gamification-service.js';
export { createLeaderboardService } from './services/leaderboard-service.js';

// Validation
export {
  quizSubmissionSchema,
  personaSelectionSchema,
  leaderboardQuerySchema,
  moduleIdSchema,
  courseIdSchema,
  type QuizSubmissionInput,
  type PersonaSelectionInput,
  type LeaderboardQueryInput,
} from './validation/schemas.js';

// Schema (for direct model access if needed)
export {
  getAcademyProgressModel,
  type AcademyProgressDocument,
} from './schemas/academy-progress.schema.js';
