import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { ZodError } from 'zod';
import type { RouteRegistry } from '../registry.js';
import type { HttpMethod, RouteSchema } from '../types.js';
import { expressPathToOpenAPI, pathParamsSchema } from '../shared/schema-utils.js';

export interface OpenAPIRouterOptions {
  /** Base path prefix for all routes (e.g. `/api/v1/chat`) */
  basePath?: string;
  /** Default tags applied to all routes in this router */
  tags?: string[];
  /**
   * When enabled, validates request params/query/body with route Zod schemas
   * and attaches parsed values to `res.locals.openapi.validated`.
   */
  validateRequests?: boolean;
  /**
   * Optional route-level compatibility hook for preserving bespoke validation
   * responses while migrating to helper-based request parsing.
   */
  onValidationError?: (error: ZodError, req: Request, res: Response, next: NextFunction) => void;
  /**
   * When enabled, wraps route handlers so rejected promises flow into `next(err)`
   * under Express 4 without changing default behavior for existing routes.
   */
  wrapAsyncHandlers?: boolean;
}

export interface OpenAPIValidatedRequestData {
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

export interface OpenAPIResponseLocals {
  validated?: OpenAPIValidatedRequestData;
}

declare global {
  namespace Express {
    interface Locals {
      openapi?: OpenAPIResponseLocals;
    }
  }
}

export interface OpenAPIRouter {
  /** The underlying Express Router — mount this with `app.use()` */
  router: Router;
  /**
   * Register a route with both Express and the OpenAPI registry.
   * Schemas are optional — routes without schemas still appear in the spec.
   */
  route(
    method: HttpMethod,
    path: string,
    schema: RouteSchema | undefined,
    ...handlers: RequestHandler[]
  ): void;
}

/**
 * Read validated OpenAPI request data without reaching into `res.locals` directly.
 */
export function getValidatedRequestData(
  response: Pick<Response, 'locals'>,
): OpenAPIValidatedRequestData | undefined {
  return response.locals.openapi?.validated;
}

/**
 * Create an Express Router that auto-registers routes in the OpenAPI registry.
 */
export function createOpenAPIRouter(
  registry: RouteRegistry,
  options: OpenAPIRouterOptions = {},
): OpenAPIRouter {
  const router = Router({ mergeParams: true });
  const {
    basePath = '',
    tags,
    validateRequests = false,
    onValidationError,
    wrapAsyncHandlers = false,
  } = options;

  function route(
    method: HttpMethod,
    path: string,
    schema: RouteSchema | undefined,
    ...handlers: RequestHandler[]
  ): void {
    // Register in OpenAPI with full path
    const fullPath = basePath + path;
    const openApiPath = expressPathToOpenAPI(fullPath);
    const mergedSchema: RouteSchema = {
      ...schema,
      tags: schema?.tags ?? tags,
    };
    registry.registerRoute(method, openApiPath, mergedSchema);

    // Register in Express
    const validationHandler = validateRequests
      ? createValidationHandler(mergedSchema, openApiPath, onValidationError)
      : undefined;
    const routeHandlers = wrapAsyncHandlers ? handlers.map(wrapAsyncHandler) : handlers;
    const expressHandlers = validationHandler
      ? [validationHandler, ...routeHandlers]
      : routeHandlers;
    router[method](path, ...expressHandlers);
  }

  return { router, route };
}

function wrapAsyncHandler(handler: RequestHandler): RequestHandler {
  return function wrappedAsyncHandler(req, res, next): void {
    try {
      const result = handler(req, res, next) as unknown;
      if (isPromiseLike(result)) {
        void result.catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

function createValidationHandler(
  schema: RouteSchema | undefined,
  openApiPath: string,
  onValidationError: OpenAPIRouterOptions['onValidationError'],
): RequestHandler | undefined {
  const paramsSchema = schema?.params ?? pathParamsSchema(openApiPath);
  const querySchema = schema?.query;
  const bodySchema = schema?.body;

  if (!paramsSchema && !querySchema && !bodySchema) {
    return undefined;
  }

  return function validateOpenAPIRequest(req, res, next): void {
    const validated: OpenAPIValidatedRequestData = {};

    if (paramsSchema) {
      const paramsResult = paramsSchema.safeParse(req.params);
      if (!paramsResult.success) {
        handleValidationError(paramsResult.error, req, res, next, onValidationError);
        return;
      }
      validated.params = paramsResult.data;
    }

    if (querySchema) {
      const queryResult = querySchema.safeParse(req.query);
      if (!queryResult.success) {
        handleValidationError(queryResult.error, req, res, next, onValidationError);
        return;
      }
      validated.query = queryResult.data;
    }

    if (bodySchema) {
      const bodyResult = bodySchema.safeParse(req.body);
      if (!bodyResult.success) {
        handleValidationError(bodyResult.error, req, res, next, onValidationError);
        return;
      }
      validated.body = bodyResult.data;
    }

    res.locals.openapi = {
      ...res.locals.openapi,
      validated: {
        ...res.locals.openapi?.validated,
        ...validated,
      },
    };
    next();
  };
}

function handleValidationError(
  error: ZodError,
  req: Request,
  res: Response,
  next: NextFunction,
  onValidationError: OpenAPIRouterOptions['onValidationError'],
): void {
  if (onValidationError) {
    onValidationError(error, req, res, next);
    return;
  }

  next(error);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function' &&
    'catch' in value &&
    typeof value.catch === 'function'
  );
}
