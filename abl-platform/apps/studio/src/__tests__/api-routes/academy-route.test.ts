import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetAuthenticatedUser = vi.hoisted(() => vi.fn());
const mockSetCurrentAuditContext = vi.hoisted(() => vi.fn());
const mockGetAcademyServices = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

vi.mock('@/services/audit-service', () => ({
  setCurrentAuditContext: (...args: unknown[]) => mockSetCurrentAuditContext(...args),
}));

vi.mock('@/lib/academy-service', () => ({
  getAcademyServices: (...args: unknown[]) => mockGetAcademyServices(...args),
}));

function makeRequest(path: string, init: RequestInit = {}) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    ...init,
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('Studio Academy API routes', () => {
  const mockConfig = {
    title: 'Academy',
    version: '1.0.0',
    settings: {},
    personas: [],
    personaCourseMap: {},
    badges: [],
    ranks: [],
  };

  const mockServices = {
    content: {
      getConfig: vi.fn(),
      getCourses: vi.fn(),
      getCourse: vi.fn(),
      getModule: vi.fn(),
      getModuleContent: vi.fn(),
      getQuiz: vi.fn(),
    },
    progress: {
      getProgress: vi.fn(),
      setPersona: vi.fn(),
      resetProgress: vi.fn(),
      submitQuiz: vi.fn(),
      markContentRead: vi.fn(),
    },
    leaderboard: {
      getLeaderboard: vi.fn(),
    },
    gamification: {
      updateStreak: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      tenantId: 'tenant-1',
      permissions: [],
    });
    mockGetAcademyServices.mockResolvedValue(mockServices);
    mockServices.content.getConfig.mockResolvedValue(mockConfig);
    mockServices.content.getCourses.mockResolvedValue([{ id: 'course-1', title: 'Course 1' }]);
    mockServices.progress.getProgress.mockResolvedValue({
      _id: 'progress-1',
      userId: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      selectedPersona: null,
      modules: new Map(),
      points: 10,
      badges: [],
      streakDays: [],
      lastActiveDate: null,
      _v: 0,
      createdAt: new Date('2026-05-19T00:00:00.000Z'),
      updatedAt: new Date('2026-05-19T00:00:00.000Z'),
    });
    mockServices.progress.setPersona.mockResolvedValue({
      _id: 'progress-1',
      userId: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      selectedPersona: 'agent-builder',
      modules: new Map(),
      points: 10,
      badges: [],
      streakDays: [],
      lastActiveDate: null,
      _v: 0,
      createdAt: new Date('2026-05-19T00:00:00.000Z'),
      updatedAt: new Date('2026-05-19T00:00:00.000Z'),
    });
    mockServices.progress.resetProgress.mockResolvedValue(undefined);
    mockServices.progress.submitQuiz.mockResolvedValue({
      score: 1,
      passed: true,
      pointsAwarded: 100,
      results: [],
      newBadges: [],
      rank: 'Explorer',
    });
    mockServices.progress.markContentRead.mockResolvedValue({
      _id: 'progress-1',
      userId: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      selectedPersona: null,
      modules: new Map(),
      points: 20,
      badges: [],
      streakDays: [],
      lastActiveDate: null,
      _v: 0,
      createdAt: new Date('2026-05-19T00:00:00.000Z'),
      updatedAt: new Date('2026-05-19T00:00:00.000Z'),
    });
    mockServices.leaderboard.getLeaderboard.mockResolvedValue([
      { userId: 'user-1', displayName: 'Test User', points: 10, badges: [], selectedPersona: null },
    ]);
    mockServices.gamification.updateStreak.mockResolvedValue({
      _id: 'progress-1',
      userId: 'user-1',
      email: 'test@example.com',
      displayName: 'Test User',
      selectedPersona: null,
      modules: new Map(),
      points: 10,
      badges: [],
      streakDays: [],
      lastActiveDate: '2026-05-19',
      _v: 0,
      createdAt: new Date('2026-05-19T00:00:00.000Z'),
      updatedAt: new Date('2026-05-19T00:00:00.000Z'),
    });
  });

  test('GET /api/academy/config returns config and courses', async () => {
    const { GET } = await import('@/app/api/academy/[...path]/route');

    const response = await GET(makeRequest('/api/academy/config'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.config).toEqual(mockConfig);
    expect(body.data.courses).toHaveLength(1);
    expect(mockGetAuthenticatedUser).toHaveBeenCalled();
  });

  test('GET /api/academy/progress returns serialized progress', async () => {
    const { GET } = await import('@/app/api/academy/[...path]/route');

    const response = await GET(makeRequest('/api/academy/progress'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.userId).toBe('user-1');
    expect(body.data.modules).toEqual({});
  });

  test('PATCH /api/academy/progress/persona updates persona', async () => {
    const { PATCH } = await import('@/app/api/academy/[...path]/route');

    const response = await PATCH(
      makeRequest('/api/academy/progress/persona', {
        method: 'PATCH',
        body: JSON.stringify({ persona: 'agent-builder' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.selectedPersona).toBe('agent-builder');
    expect(mockServices.progress.setPersona).toHaveBeenCalledWith('user-1', 'agent-builder');
  });

  test('GET /api/academy/leaderboard parses search params through zod coercion', async () => {
    const { GET } = await import('@/app/api/academy/[...path]/route');

    const response = await GET(makeRequest('/api/academy/leaderboard?limit=5&offset=10'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(mockServices.leaderboard.getLeaderboard).toHaveBeenCalledWith(5, 10);
  });

  test('GET /api/academy/courses/:courseId returns 404 for missing course', async () => {
    mockServices.content.getCourse.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const { GET } = await import('@/app/api/academy/[...path]/route');

    const response = await GET(makeRequest('/api/academy/courses/missing-course'));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
