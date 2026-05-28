import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  ExitCriteriaNotMetError,
  SessionBusyError,
  SessionNotFoundError,
  SessionArchivedError,
  SessionAlreadyExistsError,
  LoopDetectedError,
  FileNotFoundError,
  FileTooLargeError,
  FileCorruptError,
  SessionFileQuotaError,
  classifyToolError,
  type ErrorCategory,
} from '../../types/errors.js';

describe('errors', () => {
  describe('InvalidTransitionError', () => {
    it('creates error with from and to state', () => {
      const error = new InvalidTransitionError('INTERVIEW', 'BUILD');

      expect(error.name).toBe('InvalidTransitionError');
      expect(error.message).toBe('Invalid transition: INTERVIEW -> BUILD');
      expect(error.from).toBe('INTERVIEW');
      expect(error.to).toBe('BUILD');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('ExitCriteriaNotMetError', () => {
    it('creates error with phase name', () => {
      const error = new ExitCriteriaNotMetError('BLUEPRINT');

      expect(error.name).toBe('ExitCriteriaNotMetError');
      expect(error.message).toBe('Exit criteria not met for phase: BLUEPRINT');
      expect(error.phase).toBe('BLUEPRINT');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SessionBusyError', () => {
    it('creates error with standard message', () => {
      const error = new SessionBusyError();

      expect(error.name).toBe('SessionBusyError');
      expect(error.message).toContain('already streaming');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SessionNotFoundError', () => {
    it('creates error with session ID', () => {
      const error = new SessionNotFoundError('sess-123');

      expect(error.name).toBe('SessionNotFoundError');
      expect(error.message).toBe('Session not found: sess-123');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SessionArchivedError', () => {
    it('creates error with session ID', () => {
      const error = new SessionArchivedError('sess-456');

      expect(error.name).toBe('SessionArchivedError');
      expect(error.message).toBe('Session is archived: sess-456');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SessionAlreadyExistsError', () => {
    it('creates error with tenant and user ID', () => {
      const error = new SessionAlreadyExistsError('tenant-1', 'user-1');

      expect(error.name).toBe('SessionAlreadyExistsError');
      expect(error.message).toContain('already exists');
      expect(error.tenantId).toBe('tenant-1');
      expect(error.userId).toBe('user-1');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('LoopDetectedError', () => {
    it('creates error with specialist and tool name', () => {
      const error = new LoopDetectedError('abl-construct-expert', 'read_agent');

      expect(error.name).toBe('LoopDetectedError');
      expect(error.message).toContain('Loop detected');
      expect(error.message).toContain('abl-construct-expert');
      expect(error.message).toContain('read_agent');
      expect(error.specialist).toBe('abl-construct-expert');
      expect(error.toolName).toBe('read_agent');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('FileNotFoundError', () => {
    it('creates error with blob ID', () => {
      const error = new FileNotFoundError('blob-abc123');

      expect(error.name).toBe('FileNotFoundError');
      expect(error.message).toBe('File not found: blob-abc123');
      expect(error.blobId).toBe('blob-abc123');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('FileTooLargeError', () => {
    it('creates error with file details', () => {
      const error = new FileTooLargeError('document.pdf', 15_000_000, 10_000_000);

      expect(error.name).toBe('FileTooLargeError');
      expect(error.message).toContain('document.pdf');
      expect(error.message).toContain('15000000');
      expect(error.message).toContain('10000000');
      expect(error.fileName).toBe('document.pdf');
      expect(error.actualSize).toBe(15_000_000);
      expect(error.maxSize).toBe(10_000_000);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('FileCorruptError', () => {
    it('creates error with file name and reason', () => {
      const error = new FileCorruptError('image.jpg', 'Invalid JPEG header');

      expect(error.name).toBe('FileCorruptError');
      expect(error.message).toContain('image.jpg');
      expect(error.message).toContain('Invalid JPEG header');
      expect(error.fileName).toBe('image.jpg');
      expect(error.reason).toBe('Invalid JPEG header');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SessionFileQuotaError', () => {
    it('creates error with session and quota details', () => {
      const error = new SessionFileQuotaError('sess-789', 25_000_000, 20_000_000);

      expect(error.name).toBe('SessionFileQuotaError');
      expect(error.message).toContain('sess-789');
      expect(error.message).toContain('25000000');
      expect(error.message).toContain('20000000');
      expect(error.sessionId).toBe('sess-789');
      expect(error.requestedTotal).toBe(25_000_000);
      expect(error.quota).toBe(20_000_000);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('classifyToolError', () => {
    describe('rate_limited category', () => {
      it('classifies "rate limit" as rate_limited', () => {
        const error = new Error('Rate limit exceeded');
        expect(classifyToolError(error)).toBe('rate_limited');
      });

      it('classifies "429" as rate_limited', () => {
        const error = new Error('HTTP 429 Too Many Requests');
        expect(classifyToolError(error)).toBe('rate_limited');
      });

      it('classifies "too many requests" as rate_limited', () => {
        const error = new Error('Too many requests, slow down');
        expect(classifyToolError(error)).toBe('rate_limited');
      });

      it('is case insensitive', () => {
        expect(classifyToolError(new Error('RATE LIMIT'))).toBe('rate_limited');
        expect(classifyToolError(new Error('Too Many Requests'))).toBe('rate_limited');
      });
    });

    describe('retriable category', () => {
      it('classifies "timeout" as retriable', () => {
        const error = new Error('Request timeout');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "ECONNRESET" as retriable', () => {
        const error = new Error('socket error ECONNRESET');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "ECONNREFUSED" as retriable', () => {
        const error = new Error('Connection refused ECONNREFUSED');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "EPIPE" as retriable', () => {
        const error = new Error('EPIPE: broken pipe');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "socket hang up" as retriable', () => {
        const error = new Error('socket hang up');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "network" as retriable', () => {
        const error = new Error('network error occurred');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "ETIMEDOUT" as retriable', () => {
        const error = new Error('ETIMEDOUT connection timed out');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "503" as retriable', () => {
        const error = new Error('HTTP 503 Service Unavailable');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "502" as retriable', () => {
        const error = new Error('502 Bad Gateway');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "500" as retriable', () => {
        const error = new Error('500 Internal Server Error');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('classifies "internal server error" as retriable', () => {
        const error = new Error('Internal server error occurred');
        expect(classifyToolError(error)).toBe('retriable');
      });

      it('is case insensitive for retriable errors', () => {
        expect(classifyToolError(new Error('TIMEOUT'))).toBe('retriable');
        expect(classifyToolError(new Error('Socket Hang Up'))).toBe('retriable');
        expect(classifyToolError(new Error('Internal Server Error'))).toBe('retriable');
      });
    });

    describe('permanent category', () => {
      it('classifies validation errors as permanent', () => {
        const error = new Error('Invalid input: field required');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('classifies 400 errors as permanent', () => {
        const error = new Error('400 Bad Request');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('classifies 401 errors as permanent', () => {
        const error = new Error('401 Unauthorized');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('classifies 403 errors as permanent', () => {
        const error = new Error('403 Forbidden');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('classifies 404 errors as permanent', () => {
        const error = new Error('404 Not Found');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('classifies generic errors as permanent', () => {
        const error = new Error('Something went wrong');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('classifies string errors as permanent', () => {
        expect(classifyToolError('generic error string')).toBe('permanent');
      });

      it('classifies unknown objects as permanent', () => {
        expect(classifyToolError({ code: 'UNKNOWN' })).toBe('permanent');
      });

      it('classifies null as permanent', () => {
        expect(classifyToolError(null)).toBe('permanent');
      });

      it('classifies undefined as permanent', () => {
        expect(classifyToolError(undefined)).toBe('permanent');
      });
    });

    describe('edge cases', () => {
      it('handles errors with multiple signals', () => {
        // Should match first pattern (rate_limited)
        const error = new Error('429 rate limit with timeout');
        expect(classifyToolError(error)).toBe('rate_limited');
      });

      it('handles non-Error objects', () => {
        const errorObj = { message: 'timeout occurred' };
        // Non-Error objects are stringified as "[object Object]" which doesn't match patterns
        expect(classifyToolError(errorObj)).toBe('permanent');
      });

      it('handles empty error message', () => {
        const error = new Error('');
        expect(classifyToolError(error)).toBe('permanent');
      });

      it('handles errors with no message property', () => {
        const error = { code: 'CUSTOM_ERROR' };
        expect(classifyToolError(error)).toBe('permanent');
      });
    });
  });
});
