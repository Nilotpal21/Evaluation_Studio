import { z } from 'zod';
import {
  EVAL_LIST_DEFAULT_PAGE_SIZE,
  EVAL_LIST_MAX_PAGE_SIZE,
} from '@agent-platform/database/constants/eval-limits';

const evalListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return EVAL_LIST_DEFAULT_PAGE_SIZE;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) return EVAL_LIST_DEFAULT_PAGE_SIZE;
      return Math.min(parsed, EVAL_LIST_MAX_PAGE_SIZE);
    }),
  search: z.string().trim().min(1).optional(),
});

export function parseEvalListQuery(searchParams: URLSearchParams) {
  return evalListQuerySchema.parse({
    cursor: searchParams.get('cursor') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
    search: searchParams.get('search')?.trim() || undefined,
  });
}
