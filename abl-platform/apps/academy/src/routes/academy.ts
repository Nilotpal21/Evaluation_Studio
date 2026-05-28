/**
 * Academy Routes
 *
 * Express Router with all Learning Academy endpoints.
 * All routes require authentication (userId from req.user).
 * Mounted at /api/v1/academy/ in server.ts.
 */

import { Router, type IRouter } from 'express';
import { createLogger } from '@agent-platform/shared-observability';
import {
  quizSubmissionSchema,
  personaSelectionSchema,
  leaderboardQuerySchema,
  moduleIdSchema,
  courseIdSchema,
  serializeProgress,
} from '@agent-platform/academy';
import { getAcademyServices } from '../lib/db.js';

const log = createLogger('academy-routes');
const router: IRouter = Router();

/**
 * Extract userId from authenticated request.
 * Auth middleware populates req.user.
 */
function getUserId(req: Express.Request): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req as any).user;
  if (!user?.id) {
    throw new Error('User not authenticated');
  }
  return user.id;
}

// ─── GET /config ──────────────────────────────────────────────────────────────
// Returns academy configuration and course list.
router.get('/config', async (req, res, next) => {
  try {
    const services = getAcademyServices();
    const [config, courses] = await Promise.all([
      services.content.getConfig(),
      services.content.getCourses(),
    ]);
    res.json({ success: true, data: { config, courses } });
  } catch (err) {
    log.error('Failed to get academy config', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// ─── GET /courses ────────────────────────────────────────────────────────────
// Returns the full course catalog.
router.get('/courses', async (req, res, next) => {
  try {
    const services = getAcademyServices();
    const courses = await services.content.getCourses();
    res.json({ success: true, data: courses });
  } catch (err) {
    log.error('Failed to get courses', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// ─── GET /courses/:courseId ──────────────────────────────────────────────────
// Returns a single course by ID. Returns 404 if the course file is missing.
router.get('/courses/:courseId', async (req, res, next) => {
  try {
    const parsed = courseIdSchema.safeParse(req.params.courseId);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid course ID' },
      });
      return;
    }

    const services = getAcademyServices();
    try {
      const course = await services.content.getCourse(parsed.data);
      res.json({ success: true, data: course });
    } catch (loadErr) {
      // fs.readFile throws ENOENT when course JSON doesn't exist → translate to 404
      if (
        loadErr &&
        typeof loadErr === 'object' &&
        (loadErr as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Course not found' },
        });
        return;
      }
      throw loadErr;
    }
  } catch (err) {
    log.error('Failed to get course', {
      error: err instanceof Error ? err.message : String(err),
      courseId: req.params.courseId,
    });
    next(err);
  }
});

// ─── GET /modules/:moduleId ──────────────────────────────────────────────────
// Returns a single module by ID. Returns 404 if the module file is missing.
router.get('/modules/:moduleId', async (req, res, next) => {
  try {
    const parsed = moduleIdSchema.safeParse(req.params.moduleId);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid module ID' },
      });
      return;
    }

    const services = getAcademyServices();
    try {
      const mod = await services.content.getModule(parsed.data);
      res.json({ success: true, data: mod });
    } catch (loadErr) {
      if (
        loadErr &&
        typeof loadErr === 'object' &&
        (loadErr as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Module not found' },
        });
        return;
      }
      throw loadErr;
    }
  } catch (err) {
    log.error('Failed to get module', {
      error: err instanceof Error ? err.message : String(err),
      moduleId: req.params.moduleId,
    });
    next(err);
  }
});

// ─── GET /progress ────────────────────────────────────────────────────────────
// Returns the authenticated user's progress.
router.get('/progress', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const services = getAcademyServices();
    const progress = await services.progress.getProgress(userId);
    res.json({ success: true, data: serializeProgress(progress) });
  } catch (err) {
    log.error('Failed to get progress', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// ─── PATCH /progress/persona ──────────────────────────────────────────────────
// Sets the user's selected persona (learning path).
router.patch('/progress/persona', async (req, res, next) => {
  try {
    const parsed = personaSelectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const userId = getUserId(req);
    const services = getAcademyServices();
    const progress = await services.progress.setPersona(userId, parsed.data.persona);
    res.json({ success: true, data: serializeProgress(progress) });
  } catch (err) {
    log.error('Failed to set persona', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// ─── POST /progress/reset ─────────────────────────────────────────────────────
// Resets the user's progress to initial state.
router.post('/progress/reset', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const services = getAcademyServices();
    await services.progress.resetProgress(userId);
    res.json({ success: true, data: null });
  } catch (err) {
    log.error('Failed to reset progress', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// ─── GET /modules/:moduleId/content ───────────────────────────────────────────
// Returns the markdown content of a specific module.
router.get('/modules/:moduleId/content', async (req, res, next) => {
  try {
    const parsed = moduleIdSchema.safeParse(req.params.moduleId);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid module ID' },
      });
      return;
    }

    const services = getAcademyServices();
    const content = await services.content.getModuleContent(parsed.data);
    res.json({ success: true, data: { content } });
  } catch (err) {
    log.error('Failed to get module content', {
      error: err instanceof Error ? err.message : String(err),
      moduleId: req.params.moduleId,
    });
    next(err);
  }
});

// ─── GET /modules/:moduleId/quiz ──────────────────────────────────────────────
// Returns quiz questions (answers stripped) for the module.
router.get('/modules/:moduleId/quiz', async (req, res, next) => {
  try {
    const parsed = moduleIdSchema.safeParse(req.params.moduleId);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid module ID' },
      });
      return;
    }

    const services = getAcademyServices();
    const quiz = await services.content.getQuiz(parsed.data);
    res.json({ success: true, data: quiz });
  } catch (err) {
    log.error('Failed to get quiz', {
      error: err instanceof Error ? err.message : String(err),
      moduleId: req.params.moduleId,
    });
    next(err);
  }
});

// ─── POST /modules/:moduleId/quiz ─────────────────────────────────────────────
// Submits quiz answers and returns graded results.
router.post('/modules/:moduleId/quiz', async (req, res, next) => {
  try {
    const moduleIdParsed = moduleIdSchema.safeParse(req.params.moduleId);
    if (!moduleIdParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid module ID' },
      });
      return;
    }

    const bodyParsed = quizSubmissionSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: bodyParsed.error.message },
      });
      return;
    }

    const userId = getUserId(req);
    const services = getAcademyServices();
    const result = await services.progress.submitQuiz(
      userId,
      moduleIdParsed.data,
      bodyParsed.data.answers,
    );
    res.json({ success: true, data: result });
  } catch (err) {
    log.error('Failed to submit quiz', {
      error: err instanceof Error ? err.message : String(err),
      moduleId: req.params.moduleId,
    });
    next(err);
  }
});

// ─── POST /modules/:moduleId/read ─────────────────────────────────────────────
// Marks a module's content as read by the user.
router.post('/modules/:moduleId/read', async (req, res, next) => {
  try {
    const parsed = moduleIdSchema.safeParse(req.params.moduleId);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid module ID' },
      });
      return;
    }

    const userId = getUserId(req);
    const services = getAcademyServices();
    const progress = await services.progress.markContentRead(userId, parsed.data);
    res.json({ success: true, data: serializeProgress(progress) });
  } catch (err) {
    log.error('Failed to mark content read', {
      error: err instanceof Error ? err.message : String(err),
      moduleId: req.params.moduleId,
    });
    next(err);
  }
});

// ─── GET /leaderboard ─────────────────────────────────────────────────────────
// Returns the global leaderboard with pagination.
router.get('/leaderboard', async (req, res, next) => {
  try {
    const parsed = leaderboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
      return;
    }

    const services = getAcademyServices();
    const leaderboard = await services.leaderboard.getLeaderboard(
      parsed.data.limit,
      parsed.data.offset,
    );
    res.json({ success: true, data: leaderboard });
  } catch (err) {
    log.error('Failed to get leaderboard', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

// ─── POST /streak ─────────────────────────────────────────────────────────────
// Records a streak check-in for the current day.
router.post('/streak', async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const services = getAcademyServices();
    const progress = await services.gamification.updateStreak(userId);
    res.json({ success: true, data: serializeProgress(progress) });
  } catch (err) {
    log.error('Failed to update streak', {
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

export default router;
