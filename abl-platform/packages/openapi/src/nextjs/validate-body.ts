import { type ZodSchema, type ZodError } from 'zod';

interface JsonRequestLike {
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function validationIssueMessages(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export async function validateBody<T>(
  request: JsonRequestLike,
  schema: ZodSchema<T>,
): Promise<{ success: true; data: T } | { success: false; response: Response }> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: jsonResponse(
        {
          success: false,
          errors: [{ code: 'VALIDATION_ERROR', msg: 'Invalid JSON body' }],
        },
        400,
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      response: jsonResponse(
        {
          success: false,
          errors: validationIssueMessages(parsed.error).map((msg) => ({
            code: 'VALIDATION_ERROR',
            msg,
          })),
        },
        400,
      ),
    };
  }

  return { success: true, data: parsed.data };
}
