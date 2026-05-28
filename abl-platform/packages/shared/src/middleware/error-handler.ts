import type { ErrorRequestHandler, Request } from 'express';
import { ZodError } from 'zod';
import { ErrorCodes, errorToResponse, toErrorResponse } from '../errors.js';

export interface NormalizedHttpError {
  statusCode: number;
  code: string;
  message: string;
}

export interface ExpressErrorHandlerOptions<TBody = ReturnType<typeof toErrorResponse>> {
  logError?: (error: unknown, req: Request, normalized: NormalizedHttpError) => void;
  serialize?: (normalized: NormalizedHttpError, error: unknown, req: Request) => TBody;
}

export function normalizeExpressError(error: unknown): NormalizedHttpError {
  if (error instanceof ZodError) {
    return {
      statusCode: ErrorCodes.VALIDATION_ERROR.statusCode,
      code: ErrorCodes.VALIDATION_ERROR.code,
      message: formatZodError(error),
    };
  }

  const { statusCode, body } = errorToResponse(error);
  return {
    statusCode,
    code: body.error.code,
    message: body.error.message,
  };
}

export function createExpressErrorHandler<TBody = ReturnType<typeof toErrorResponse>>(
  options: ExpressErrorHandlerOptions<TBody> = {},
): ErrorRequestHandler {
  const serialize =
    options.serialize ??
    ((normalized: NormalizedHttpError) =>
      toErrorResponse(normalized.code, normalized.message) as TBody);

  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const normalized = normalizeExpressError(error);
    options.logError?.(error, req, normalized);
    res.status(normalized.statusCode).json(serialize(normalized, error, req));
  };
}

function formatZodError(error: ZodError): string {
  const messages = error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });

  return messages.length > 0 ? messages.join('; ') : error.message;
}
