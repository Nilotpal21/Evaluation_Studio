import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@agent-platform/shared-observability';
import {
  courseIdSchema,
  leaderboardQuerySchema,
  moduleIdSchema,
  personaSelectionSchema,
  quizSubmissionSchema,
  serializeProgress,
} from '@agent-platform/academy';
import { getAuthenticatedUser } from '@/lib/auth';
import { getAcademyServices } from '@/lib/academy-service';
import { setCurrentAuditContext } from '@/services/audit-service';

const log = createLogger('studio-academy-api');

type AcademyErrorCode = 'UNAUTHORIZED' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR';

function academySuccess<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

function academyError(status: number, code: AcademyErrorCode, message: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: { code, message },
    },
    { status },
  );
}

function getAcademyPathSegments(request: NextRequest): string[] {
  return request.nextUrl.pathname.split('/').filter(Boolean).slice(2);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function getRequestBody(
  request: NextRequest,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: academyError(400, 'VALIDATION_ERROR', 'Invalid JSON body'),
    };
  }
}

async function getUserOrUnauthorized(request: NextRequest) {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    return academyError(401, 'UNAUTHORIZED', 'Unauthorized');
  }

  setCurrentAuditContext({
    requestId:
      request.headers.get('x-request-id') ?? request.headers.get('x-correlation-id') ?? undefined,
    tenantId: user.tenantId,
    userId: user.id,
  });

  return user;
}

async function handleConfig(request: NextRequest): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    const [config, courses] = await Promise.all([
      services.content.getConfig(),
      services.content.getCourses(),
    ]);
    return academySuccess({ config, courses });
  } catch (error) {
    log.error('Failed to load academy config', {
      error: error instanceof Error ? error.message : String(error),
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to load academy config');
  }
}

async function handleCourses(request: NextRequest, courseId?: string): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    if (!courseId) {
      const courses = await services.content.getCourses();
      return academySuccess(courses);
    }

    const parsed = courseIdSchema.safeParse(courseId);
    if (!parsed.success) {
      return academyError(400, 'VALIDATION_ERROR', 'Invalid course ID');
    }

    try {
      const course = await services.content.getCourse(parsed.data);
      return academySuccess(course);
    } catch (error) {
      if (isNotFoundError(error)) {
        return academyError(404, 'NOT_FOUND', 'Course not found');
      }
      throw error;
    }
  } catch (error) {
    log.error('Failed to load academy courses', {
      error: error instanceof Error ? error.message : String(error),
      courseId,
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to load academy courses');
  }
}

async function handleModule(request: NextRequest, moduleId: string): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    const parsed = moduleIdSchema.safeParse(moduleId);
    if (!parsed.success) {
      return academyError(400, 'VALIDATION_ERROR', 'Invalid module ID');
    }

    try {
      const mod = await services.content.getModule(parsed.data);
      return academySuccess(mod);
    } catch (error) {
      if (isNotFoundError(error)) {
        return academyError(404, 'NOT_FOUND', 'Module not found');
      }
      throw error;
    }
  } catch (error) {
    log.error('Failed to load academy module', {
      error: error instanceof Error ? error.message : String(error),
      moduleId,
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to load academy module');
  }
}

async function handleModuleContent(request: NextRequest, moduleId: string): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    const parsed = moduleIdSchema.safeParse(moduleId);
    if (!parsed.success) {
      return academyError(400, 'VALIDATION_ERROR', 'Invalid module ID');
    }

    try {
      const content = await services.content.getModuleContent(parsed.data);
      return academySuccess({ content });
    } catch (error) {
      if (isNotFoundError(error)) {
        return academyError(404, 'NOT_FOUND', 'Module not found');
      }
      throw error;
    }
  } catch (error) {
    log.error('Failed to load academy module content', {
      error: error instanceof Error ? error.message : String(error),
      moduleId,
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to load academy module content');
  }
}

async function handleModuleQuiz(
  request: NextRequest,
  moduleId: string,
  method: 'GET' | 'POST',
): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    const parsed = moduleIdSchema.safeParse(moduleId);
    if (!parsed.success) {
      return academyError(400, 'VALIDATION_ERROR', 'Invalid module ID');
    }

    if (method === 'GET') {
      try {
        const quiz = await services.content.getQuiz(parsed.data);
        return academySuccess(quiz);
      } catch (error) {
        if (isNotFoundError(error)) {
          return academyError(404, 'NOT_FOUND', 'Module not found');
        }
        throw error;
      }
    }

    const bodyResult = await getRequestBody(request);
    if (!bodyResult.ok) return bodyResult.response;

    const submission = quizSubmissionSchema.safeParse(bodyResult.body);
    if (!submission.success) {
      return academyError(400, 'VALIDATION_ERROR', submission.error.message);
    }

    const result = await services.progress.submitQuiz(
      auth.id,
      parsed.data,
      submission.data.answers,
    );
    return academySuccess(result);
  } catch (error) {
    log.error('Failed to process academy module quiz', {
      error: error instanceof Error ? error.message : String(error),
      moduleId,
      method,
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to process academy module quiz');
  }
}

async function handleProgress(
  request: NextRequest,
  action: 'GET' | 'persona' | 'reset',
): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();

    if (action === 'GET') {
      const progress = await services.progress.getProgress(auth.id);
      return academySuccess(serializeProgress(progress));
    }

    if (action === 'persona') {
      const bodyResult = await getRequestBody(request);
      if (!bodyResult.ok) return bodyResult.response;

      const parsed = personaSelectionSchema.safeParse(bodyResult.body);
      if (!parsed.success) {
        return academyError(400, 'VALIDATION_ERROR', parsed.error.message);
      }

      const progress = await services.progress.setPersona(auth.id, parsed.data.persona);
      return academySuccess(serializeProgress(progress));
    }

    await services.progress.resetProgress(auth.id);
    return academySuccess(null);
  } catch (error) {
    log.error('Failed to process academy progress', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to process academy progress');
  }
}

async function handleLeaderboard(request: NextRequest): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    const parsed = leaderboardQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    if (!parsed.success) {
      return academyError(400, 'VALIDATION_ERROR', parsed.error.message);
    }

    const leaderboard = await services.leaderboard.getLeaderboard(
      parsed.data.limit,
      parsed.data.offset,
    );
    return academySuccess(leaderboard);
  } catch (error) {
    log.error('Failed to load academy leaderboard', {
      error: error instanceof Error ? error.message : String(error),
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to load academy leaderboard');
  }
}

async function handleStreak(request: NextRequest): Promise<NextResponse> {
  const auth = await getUserOrUnauthorized(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const services = await getAcademyServices();
    const progress = await services.gamification.updateStreak(auth.id);
    return academySuccess(serializeProgress(progress));
  } catch (error) {
    log.error('Failed to update academy streak', {
      error: error instanceof Error ? error.message : String(error),
    });
    return academyError(500, 'INTERNAL_ERROR', 'Failed to update academy streak');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const segments = getAcademyPathSegments(request);
  const [head, second, third] = segments;

  if (head === 'config' && segments.length === 1) return handleConfig(request);
  if (head === 'courses' && segments.length === 1) return handleCourses(request);
  if (head === 'courses' && segments.length === 2) return handleCourses(request, second);
  if (head === 'modules' && second && segments.length === 2) return handleModule(request, second);
  if (head === 'modules' && second && third === 'content')
    return handleModuleContent(request, second);
  if (head === 'modules' && second && third === 'quiz')
    return handleModuleQuiz(request, second, 'GET');
  if (head === 'progress' && segments.length === 1) return handleProgress(request, 'GET');
  if (head === 'leaderboard' && segments.length === 1) return handleLeaderboard(request);

  return academyError(404, 'NOT_FOUND', 'Academy route not found');
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const segments = getAcademyPathSegments(request);
  const [head, second] = segments;

  if (head === 'progress' && second === 'persona' && segments.length === 2) {
    return handleProgress(request, 'persona');
  }

  return academyError(404, 'NOT_FOUND', 'Academy route not found');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const segments = getAcademyPathSegments(request);
  const [head, second, third] = segments;

  if (head === 'progress' && second === 'reset' && segments.length === 2) {
    return handleProgress(request, 'reset');
  }
  if (head === 'modules' && second && third === 'quiz') {
    return handleModuleQuiz(request, second, 'POST');
  }
  if (head === 'modules' && second && third === 'read') {
    const auth = await getUserOrUnauthorized(request);
    if (auth instanceof NextResponse) return auth;

    try {
      const services = await getAcademyServices();
      const parsed = moduleIdSchema.safeParse(second);
      if (!parsed.success) {
        return academyError(400, 'VALIDATION_ERROR', 'Invalid module ID');
      }

      const progress = await services.progress.markContentRead(auth.id, parsed.data);
      return academySuccess(serializeProgress(progress));
    } catch (error) {
      log.error('Failed to mark academy content as read', {
        error: error instanceof Error ? error.message : String(error),
        moduleId: second,
      });
      return academyError(500, 'INTERNAL_ERROR', 'Failed to mark academy content as read');
    }
  }
  if (head === 'streak' && segments.length === 1) {
    return handleStreak(request);
  }

  return academyError(404, 'NOT_FOUND', 'Academy route not found');
}
