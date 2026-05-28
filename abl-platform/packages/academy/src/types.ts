/**
 * Learning Academy — Type Definitions
 *
 * All interfaces for the academy package. Zero ABL dependencies.
 */

// ─── User ────────────────────────────────────────────────────────────────────

export interface AcademyUser {
  userId: string;
  email: string;
  name?: string;
}

// ─── Progress ────────────────────────────────────────────────────────────────

export interface ModuleProgress {
  contentRead: boolean;
  quizAttempts: number;
  quizPassed: boolean;
  bestScore: number;
  lastAttemptDate: Date | null;
  contentVersion: string | null;
}

export interface AcademyProgress {
  _id: string;
  userId: string;
  email: string;
  displayName: string | null;
  selectedPersona: string | null;
  modules: Map<string, ModuleProgress>;
  points: number;
  badges: string[];
  streakDays: string[];
  lastActiveDate: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Convert AcademyProgress to a JSON-safe object.
 * Map<string, ModuleProgress> → Record<string, ModuleProgress>
 * so that JSON.stringify / res.json() serializes modules correctly.
 */
export function serializeProgress(
  progress: AcademyProgress,
): Omit<AcademyProgress, 'modules'> & { modules: Record<string, ModuleProgress> } {
  return {
    ...progress,
    modules: Object.fromEntries(progress.modules),
  };
}

// ─── Quiz ────────────────────────────────────────────────────────────────────

export interface QuizOption {
  id: string;
  text: string;
  correct?: boolean;
}

export interface QuizQuestion {
  id: string;
  type: 'mcq' | 'fill-blank';
  stem: string;
  options?: QuizOption[];
  answer?: string;
  acceptAlternatives?: string[];
  explanation: string;
}

export interface QuizFile {
  moduleId: string;
  passThreshold: number;
  questions: QuizQuestion[];
}

export interface QuizSubmission {
  answers: Array<{ questionId: string; answer: string }>;
}

export interface QuizResult {
  score: number;
  passed: boolean;
  pointsAwarded: number;
  results: Array<{
    questionId: string;
    correct: boolean;
    explanation: string;
  }>;
  newBadges: string[];
  rank: string;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  userId: string;
  displayName: string | null;
  points: number;
  badges: string[];
  selectedPersona: string | null;
}

// ─── Content Configuration ───────────────────────────────────────────────────

export interface AcademySettings {
  quizPassThreshold: number;
  pointsFirstAttempt: number;
  pointsSecondAttempt: number;
  pointsThirdPlusAttempt: number;
  pointsLessonComplete: number;
  pointsCourseComplete: number;
  pointsPathComplete: number;
  questionsPerQuiz: number;
  mcqOptions: number;
}

export interface PersonaConfig {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  level: string;
  badge: string;
}

export interface PersonaCourseMapEntry {
  courses: string[];
  fastTrack: string[];
  estimatedHours: number;
}

export interface BadgeConfig {
  id: string;
  title: string;
  description: string;
  icon: string;
  trigger: string;
}

export interface RankConfig {
  level: number;
  title: string;
  minPoints: number;
  requirePaths?: number;
}

export interface AcademyConfig {
  title: string;
  version: string;
  settings: AcademySettings;
  personas: PersonaConfig[];
  personaCourseMap: Record<string, PersonaCourseMapEntry>;
  badges: BadgeConfig[];
  ranks: RankConfig[];
}

// ─── Course / Module ─────────────────────────────────────────────────────────

export interface Lesson {
  id: string;
  title: string;
  sourceFile: string;
  minutes: number;
}

export interface VideoRef {
  url: string;
  title: string;
  durationSeconds: number;
}

export interface ModuleConfig {
  id: string;
  title: string;
  lessons: Lesson[];
  videos?: Record<string, VideoRef>;
}

export interface CourseCertification {
  required: boolean;
  passCriteria: string;
  badge: string;
}

export interface CourseConfig {
  id: string;
  title: string;
  description: string;
  level: string;
  estimatedMinutes: number;
  prerequisites: string[];
  modules: string[];
  certification: CourseCertification;
}

// ─── Services ────────────────────────────────────────────────────────────────

export interface ContentService {
  getConfig(): Promise<AcademyConfig>;
  getCourses(): Promise<CourseConfig[]>;
  getCourse(courseId: string): Promise<CourseConfig>;
  getModule(moduleId: string): Promise<ModuleConfig>;
  getModuleContent(moduleId: string): Promise<string>;
  /** Returns quiz questions with answers/correct fields stripped */
  getQuiz(moduleId: string): Promise<{ passThreshold: number; questions: QuizQuestion[] }>;
  /** Returns quiz questions with all answer fields intact (server-side only) */
  getQuizInternal(moduleId: string): Promise<QuizFile>;
  getContentVersion(moduleId: string): Promise<string>;
}

export interface ProgressService {
  getProgress(userId: string): Promise<AcademyProgress>;
  markContentRead(userId: string, moduleId: string): Promise<AcademyProgress>;
  submitQuiz(
    userId: string,
    moduleId: string,
    answers: QuizSubmission['answers'],
  ): Promise<QuizResult>;
  setPersona(userId: string, persona: string): Promise<AcademyProgress>;
  resetProgress(userId: string): Promise<void>;
}

export interface GamificationService {
  checkBadges(progress: AcademyProgress): Promise<string[]>;
  updateStreak(userId: string): Promise<AcademyProgress>;
  deriveRank(progress: AcademyProgress): string;
}

export interface LeaderboardService {
  getLeaderboard(limit: number, offset: number): Promise<LeaderboardEntry[]>;
  getUserPosition(userId: string): Promise<number>;
}

export interface AcademyServicesOptions {
  contentRoot?: string;
}

export interface AcademyServices {
  content: ContentService;
  progress: ProgressService;
  gamification: GamificationService;
  leaderboard: LeaderboardService;
}
