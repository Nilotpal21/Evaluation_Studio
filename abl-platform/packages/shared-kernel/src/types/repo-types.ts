/**
 * Repository Types
 *
 * Generic types for repository layer responses: pagination, results, errors.
 */

// Generic pagination structure
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

// Result wrapper for operations
export interface ErrorResult {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T> = { success: true; data: T } | { success: false; error: ErrorResult };
