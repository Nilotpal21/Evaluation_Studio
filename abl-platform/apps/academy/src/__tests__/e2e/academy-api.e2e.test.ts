/**
 * Academy API — End-to-End Tests
 *
 * Exercises the real Express app + MongoDB via HTTP.
 * No mocks, no direct DB access — API-only interaction.
 *
 * Scenarios:
 * 1. Auth enforcement — unauthenticated requests rejected
 * 2. Config & courses — public-read endpoint returns course list
 * 3. Progress lifecycle — read content, check progress, earn points
 * 4. Quiz grading — fetch quiz (answers stripped), submit answers, verify grade
 * 5. Persona selection — set and verify learning path
 * 6. Leaderboard — multiple users earn points, ordering verified
 * 7. Streak tracking — daily check-in updates streak
 * 8. Progress reset — full reset returns to initial state
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  startAcademyHarness,
  mintToken,
  authHeaders,
  type AcademyHarness,
} from './helpers/academy-harness.js';
import { clearRateLimits, clearContentCaches } from '@agent-platform/academy';

let harness: AcademyHarness;
let baseUrl: string;

beforeAll(async () => {
  harness = await startAcademyHarness();
  baseUrl = harness.baseUrl;
}, 60_000);

afterAll(async () => {
  await harness?.close();
}, 30_000);

beforeEach(async () => {
  // Clear all collections between tests
  const collections = Object.values(mongoose.connection.collections);
  for (const collection of collections) {
    await collection.deleteMany({});
  }
  clearRateLimits();
  clearContentCaches();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function api(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/v1/academy${path}`, options);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ─── 1. Auth Enforcement ───────────────────────────────────────────────────

describe('auth enforcement', () => {
  it('rejects unauthenticated GET /config with 401', async () => {
    const { status } = await api('/config');
    expect(status).toBe(401);
  });

  it('rejects unauthenticated GET /progress with 401', async () => {
    const { status } = await api('/progress');
    expect(status).toBe(401);
  });

  it('rejects unauthenticated POST /streak with 401', async () => {
    const { status } = await api('/streak', { method: 'POST' });
    expect(status).toBe(401);
  });

  it('rejects requests with an invalid JWT', async () => {
    const { status } = await api('/config', {
      headers: authHeaders('invalid.jwt.token'),
    });
    expect(status).toBe(401);
  });

  it('accepts requests with a valid JWT', async () => {
    const token = mintToken('auth-test-user');
    const { status, body } = await api('/config', {
      headers: authHeaders(token),
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

// ─── 2. Config & Courses ───────────────────────────────────────────────────

describe('GET /config', () => {
  it('returns academy config with courses list', async () => {
    const token = mintToken('config-user');
    const { status, body } = await api('/config', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty('config');
    expect(data).toHaveProperty('courses');

    // Courses should be a non-empty array
    const courses = data.courses as unknown[];
    expect(Array.isArray(courses)).toBe(true);
    expect(courses.length).toBeGreaterThan(0);

    // Each course should have required fields
    const course = courses[0] as Record<string, unknown>;
    expect(course).toHaveProperty('id');
    expect(course).toHaveProperty('title');
    expect(course).toHaveProperty('modules');
  });
});

// ─── 3. Progress Lifecycle ─────────────────────────────────────────────────

describe('progress lifecycle', () => {
  const userId = 'progress-lifecycle-user';
  let token: string;

  beforeAll(() => {
    token = mintToken(userId);
  });

  it('returns initial progress (zero points, no modules)', async () => {
    const { status, body } = await api('/progress', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data.userId).toBe(userId);
    expect(data.points).toBe(0);
    expect(data.badges).toEqual([]);
  });

  it('marks module content as read and awards points', async () => {
    const { status, body } = await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data.points as number).toBeGreaterThan(0);
  });

  it('reflects read status via points increase in progress', async () => {
    // Mark read
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    // Fetch progress — verify points increased (Map serializes as {} in JSON,
    // so we verify read status via points instead of module map)
    const { body } = await api('/progress', {
      headers: authHeaders(token),
    });

    const data = body.data as Record<string, unknown>;
    expect(data.points as number).toBeGreaterThan(0);
  });

  it('accumulates points across multiple modules', async () => {
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { body } = await api('/modules/agent-configuration/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    const data = body.data as Record<string, unknown>;
    // Two modules read → cumulative points
    expect(data.points as number).toBeGreaterThanOrEqual(20);
  });

  it('user isolation — different users have independent progress', async () => {
    const otherToken = mintToken('other-progress-user');

    // User A reads a module
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    // User B should start with zero points
    const { body } = await api('/progress', {
      headers: authHeaders(otherToken),
    });
    const data = body.data as Record<string, unknown>;
    expect(data.points).toBe(0);
    expect(data.userId).toBe('other-progress-user');
  });
});

// ─── 4. Quiz Grading ──────────────────────────────────────────────────────

describe('quiz flow', () => {
  const userId = 'quiz-flow-user';
  let token: string;

  beforeAll(() => {
    token = mintToken(userId);
  });

  it('GET /modules/:id/quiz returns questions without correct answers', async () => {
    const { status, body } = await api('/modules/abl-basics/quiz', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    const questions = data.questions as Array<Record<string, unknown>>;
    expect(questions.length).toBeGreaterThan(0);

    // Verify answers are stripped for MCQ questions
    for (const q of questions) {
      if (q.type === 'mcq') {
        const options = q.options as Array<Record<string, unknown>>;
        for (const opt of options) {
          expect(opt).not.toHaveProperty('correct');
        }
      }
      // Fill-blank questions should not expose the answer
      if (q.type === 'fill-blank') {
        expect(q).not.toHaveProperty('answer');
        expect(q).not.toHaveProperty('acceptAlternatives');
      }
    }
  });

  it('POST /modules/:id/quiz grades answers and returns results', async () => {
    // First, get the quiz to know question IDs
    const quizRes = await api('/modules/abl-basics/quiz', {
      headers: authHeaders(token),
    });
    const quizData = quizRes.body.data as Record<string, unknown>;
    const questions = quizData.questions as Array<Record<string, unknown>>;

    // Submit deliberately wrong answers to test grading
    // Schema: answers is Array<{ questionId, answer }>
    const answers = questions.map((q) => ({
      questionId: q.id as string,
      answer: 'wrong-answer',
    }));

    const { status, body } = await api('/modules/abl-basics/quiz', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ answers }),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const result = body.data as Record<string, unknown>;
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('results');
    // Wrong answers should not pass (threshold is 80%)
    expect(result.passed).toBe(false);
  });

  it('awards points and badge for passing quiz', async () => {
    // Get quiz questions to construct correct answers
    const quizRes = await api('/modules/abl-basics/quiz', {
      headers: authHeaders(token),
    });
    const quizData = quizRes.body.data as Record<string, unknown>;
    const questions = quizData.questions as Array<Record<string, unknown>>;

    // We need the real answers from the quiz file. Since we know the content:
    // ab-q1: MCQ correct=a, ab-q2: fill-blank answer=".agent.abl",
    // ab-q3: MCQ correct=b, ab-q4: MCQ correct=b, ab-q5: fill-blank answer="runtime"
    // Schema: answers is Array<{ questionId, answer }>
    const answers = [
      { questionId: 'ab-q1', answer: 'a' },
      { questionId: 'ab-q2', answer: '.agent.abl' },
      { questionId: 'ab-q3', answer: 'b' },
      { questionId: 'ab-q4', answer: 'b' },
      { questionId: 'ab-q5', answer: 'runtime' },
    ];

    const { status, body } = await api('/modules/abl-basics/quiz', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ answers }),
    });

    expect(status).toBe(200);

    const result = body.data as Record<string, unknown>;
    expect(result.passed).toBe(true);
    expect(result.score as number).toBeGreaterThanOrEqual(0.8);

    // Verify points and badge were awarded via progress
    const progressRes = await api('/progress', {
      headers: authHeaders(token),
    });
    const progress = progressRes.body.data as Record<string, unknown>;
    expect(progress.points as number).toBeGreaterThan(0);

    const badges = progress.badges as string[];
    expect(badges.length).toBeGreaterThan(0);
  });

  it('rejects quiz submission with missing answers', async () => {
    const { status, body } = await api('/modules/abl-basics/quiz', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({}),
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });
});

// ─── 5. Persona Selection ──────────────────────────────────────────────────

describe('persona selection', () => {
  const userId = 'persona-user';
  let token: string;

  beforeAll(() => {
    token = mintToken(userId);
  });

  it('sets persona and returns updated progress', async () => {
    const { status, body } = await api('/progress/persona', {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ persona: 'agent-builder' }),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(data.selectedPersona).toBe('agent-builder');
  });

  it('persists persona across requests', async () => {
    // Set persona
    await api('/progress/persona', {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ persona: 'business-analyst' }),
    });

    // Fetch progress
    const { body } = await api('/progress', {
      headers: authHeaders(token),
    });

    const data = body.data as Record<string, unknown>;
    expect(data.selectedPersona).toBe('business-analyst');
  });

  it('rejects invalid persona with 400', async () => {
    const { status, body } = await api('/progress/persona', {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ persona: '' }),
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });
});

// ─── 6. Leaderboard ───────────────────────────────────────────────────────

describe('leaderboard', () => {
  it('returns leaderboard sorted by points descending', async () => {
    const tokenA = mintToken('leaderboard-user-a');
    const tokenB = mintToken('leaderboard-user-b');

    // User A reads one module (10 points)
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(tokenA),
    });

    // User B reads two modules (20 points)
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(tokenB),
    });
    await api('/modules/agent-configuration/read', {
      method: 'POST',
      headers: authHeaders(tokenB),
    });

    // Fetch leaderboard
    const token = mintToken('leaderboard-viewer');
    const { status, body } = await api('/leaderboard?limit=10&offset=0', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // data is the leaderboard array directly
    const entries = body.data as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(2);

    // First entry should have more points than second
    expect(entries[0].points as number).toBeGreaterThanOrEqual(entries[1].points as number);
  });

  it('respects limit and offset parameters', async () => {
    const token = mintToken('leaderboard-pagination');
    // Seed a user so leaderboard isn't empty
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    const { status, body } = await api('/leaderboard?limit=1&offset=0', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    const entries = body.data as Array<Record<string, unknown>>;
    expect(entries.length).toBeLessThanOrEqual(1);
  });
});

// ─── 7. Streak Tracking ───────────────────────────────────────────────────

describe('streak', () => {
  const userId = 'streak-user';
  let token: string;

  beforeAll(() => {
    token = mintToken(userId);
  });

  it('records a streak check-in', async () => {
    // Create progress doc first (upsert-on-read)
    await api('/progress', { headers: authHeaders(token) });

    const { status, body } = await api('/streak', {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // updateStreak returns the full AcademyProgress object
    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty('streakDays');
    expect(data).toHaveProperty('lastActiveDate');
  });

  it('streak is reflected in progress', async () => {
    // Create progress doc first
    await api('/progress', { headers: authHeaders(token) });

    // Check-in
    await api('/streak', {
      method: 'POST',
      headers: authHeaders(token),
    });

    // Fetch progress
    const { body } = await api('/progress', {
      headers: authHeaders(token),
    });

    const data = body.data as Record<string, unknown>;
    expect(data).toHaveProperty('streakDays');
  });
});

// ─── 8. Progress Reset ────────────────────────────────────────────────────

describe('progress reset', () => {
  const userId = 'reset-user';
  let token: string;

  beforeAll(() => {
    token = mintToken(userId);
  });

  it('resets all progress to initial state', async () => {
    // Earn some progress first
    await api('/modules/abl-basics/read', {
      method: 'POST',
      headers: authHeaders(token),
    });

    // Verify points were earned
    const beforeReset = await api('/progress', {
      headers: authHeaders(token),
    });
    expect((beforeReset.body.data as Record<string, unknown>).points as number).toBeGreaterThan(0);

    // Reset
    const { status, body } = await api('/progress/reset', {
      method: 'POST',
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify reset
    const afterReset = await api('/progress', {
      headers: authHeaders(token),
    });
    const data = afterReset.body.data as Record<string, unknown>;
    expect(data.points).toBe(0);
    expect(data.badges).toEqual([]);
  });
});

// ─── 9. Module Content ────────────────────────────────────────────────────

describe('module content', () => {
  it('returns markdown content for a valid module', async () => {
    const token = mintToken('content-user');
    const { status, body } = await api('/modules/abl-basics/content', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const data = body.data as Record<string, unknown>;
    expect(typeof data.content).toBe('string');
    expect((data.content as string).length).toBeGreaterThan(0);
  });

  it('returns 500 for non-existent module (valid ID but no content file)', async () => {
    const token = mintToken('content-user');
    const { status } = await api('/modules/nonexistent-module-xyz/content', {
      headers: authHeaders(token),
    });

    // Module ID passes validation but content file doesn't exist → server error
    expect(status).toBe(500);
  });
});

// ─── 10. 404 for Unknown Routes ───────────────────────────────────────────

describe('unknown routes', () => {
  it('returns 404 for unregistered paths', async () => {
    const res = await fetch(`${baseUrl}/api/v1/academy/nonexistent`, {
      headers: authHeaders(mintToken('x')),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for paths outside /api/v1/academy', async () => {
    const res = await fetch(`${baseUrl}/some/random/path`);
    expect(res.status).toBe(404);
  });
});

// ─── 11. Courses Catalog ──────────────────────────────────────────────────

describe('courses catalog', () => {
  it('GET /courses returns the full catalog', async () => {
    const token = mintToken('courses-list');
    const { status, body } = await api('/courses', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const courses = body.data as Array<Record<string, unknown>>;
    expect(Array.isArray(courses)).toBe(true);
    expect(courses.length).toBeGreaterThan(0);

    const foundations = courses.find((c) => c.id === 'platform-foundations');
    expect(foundations).toBeDefined();
    expect(foundations).toHaveProperty('title');
    expect(foundations).toHaveProperty('modules');
    expect(Array.isArray(foundations!.modules)).toBe(true);
  });

  it('GET /courses/:courseId returns a single course', async () => {
    const token = mintToken('course-get');
    const { status, body } = await api('/courses/platform-foundations', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const course = body.data as Record<string, unknown>;
    expect(course.id).toBe('platform-foundations');
    expect(Array.isArray(course.modules)).toBe(true);
  });

  it('GET /courses/:courseId returns 404 for an unknown course', async () => {
    const token = mintToken('course-404');
    const { status, body } = await api('/courses/definitely-not-a-real-course', {
      headers: authHeaders(token),
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect((body.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('GET /courses/:courseId returns 400 for an oversized course ID', async () => {
    const token = mintToken('course-400');
    const oversized = 'a'.repeat(200);
    const { status, body } = await api(`/courses/${oversized}`, {
      headers: authHeaders(token),
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect((body.error as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('GET /modules/:moduleId returns a single module', async () => {
    const token = mintToken('module-get');
    const { status, body } = await api('/modules/abl-basics', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const mod = body.data as Record<string, unknown>;
    expect(mod.id).toBe('abl-basics');
    expect(mod).toHaveProperty('title');
  });

  it('GET /modules/:moduleId returns 404 for an unknown module', async () => {
    const token = mintToken('module-404');
    const { status, body } = await api('/modules/no-such-module-xyz', {
      headers: authHeaders(token),
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect((body.error as { code: string }).code).toBe('NOT_FOUND');
  });

  it('GET /modules/:moduleId returns videos map when present in module.json', async () => {
    const token = mintToken('module-video');
    const { status, body } = await api('/modules/getting-started', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const mod = body.data as Record<string, unknown>;
    expect(mod.videos).toBeDefined();

    const videos = mod.videos as Record<
      string,
      { url: string; title: string; durationSeconds: number }
    >;
    expect(videos['what-is-agent-platform']).toBeDefined();
    expect(videos['what-is-agent-platform'].url).toContain('youtube.com/embed/');
    expect(typeof videos['what-is-agent-platform'].title).toBe('string');
    expect(typeof videos['what-is-agent-platform'].durationSeconds).toBe('number');
  });

  it('GET /modules/:moduleId omits videos when module has none', async () => {
    const token = mintToken('module-no-video');
    const { status, body } = await api('/modules/abl-basics', {
      headers: authHeaders(token),
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const mod = body.data as Record<string, unknown>;
    expect(mod.videos).toBeUndefined();
  });

  it('GET /courses rejects unauthenticated requests with 401', async () => {
    const { status } = await api('/courses');
    expect(status).toBe(401);
  });
});
