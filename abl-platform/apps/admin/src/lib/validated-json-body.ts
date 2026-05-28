import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { ZodType } from 'zod';

type ValidatedJsonSuccess<T> = {
  success: true;
  data: T;
};

type ValidatedJsonFailure = {
  success: false;
  response: NextResponse;
};

export type ValidatedJsonResult<T> = ValidatedJsonSuccess<T> | ValidatedJsonFailure;

function invalidRequestBodyResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
      },
    },
    { status: 400 },
  );
}

async function readRequestText(request: NextRequest): Promise<string | null> {
  try {
    return await request.text();
  } catch {
    return null;
  }
}

function parseJsonBody(rawBody: string): unknown {
  return JSON.parse(rawBody);
}

export async function readValidatedJsonBody<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<ValidatedJsonResult<T>> {
  const rawBody = await readRequestText(request);
  if (rawBody == null || rawBody.trim().length === 0) {
    return {
      success: false,
      response: invalidRequestBodyResponse(),
    };
  }

  let body: unknown;
  try {
    body = parseJsonBody(rawBody);
  } catch {
    return {
      success: false,
      response: invalidRequestBodyResponse(),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: invalidRequestBodyResponse(),
    };
  }

  return {
    success: true,
    data: parsed.data,
  };
}

export async function readOptionalValidatedJsonBody<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<ValidatedJsonResult<T | undefined>> {
  const rawBody = await readRequestText(request);
  if (rawBody == null || rawBody.trim().length === 0) {
    return {
      success: true,
      data: undefined,
    };
  }

  let body: unknown;
  try {
    body = parseJsonBody(rawBody);
  } catch {
    return {
      success: false,
      response: invalidRequestBodyResponse(),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: invalidRequestBodyResponse(),
    };
  }

  return {
    success: true,
    data: parsed.data,
  };
}
