import { vi } from 'vitest';

// Allow Next.js server-only modules to load in route/unit tests outside Next.
vi.mock('server-only', () => ({}));
