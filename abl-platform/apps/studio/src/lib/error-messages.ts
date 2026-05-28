/**
 * User-Friendly Error Messages
 *
 * Transforms technical error messages into user-friendly descriptions
 * with actionable recovery steps.
 */

export interface ErrorContext {
  code?: string;
  url?: string;
  operation?: string;
  statusCode?: number;
  resetAt?: string | Date; // For circuit breaker: when the block will be lifted
}

export interface FriendlyError {
  title: string;
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  documentation?: string;
  technical?: string; // Original error for developers
}

/**
 * Convert technical error into user-friendly format
 */
export function getFriendlyError(error: Error | string, context?: ErrorContext): FriendlyError {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const technicalDetails = typeof error === 'string' ? error : error.stack || error.message;

  // Network errors
  if (errorMessage.includes('Failed to fetch') || errorMessage.includes('Network request failed')) {
    return {
      title: 'Connection Error',
      message: 'Unable to reach the server. Please check your internet connection.',
      action: {
        label: 'Retry',
        onClick: () => window.location.reload(),
      },
      technical: technicalDetails,
    };
  }

  // Timeout errors
  if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
    return {
      title: 'Request Timeout',
      message:
        'The server took too long to respond. This may be due to high load or a slow connection.',
      action: {
        label: 'Try Again',
        onClick: () => window.location.reload(),
      },
      technical: technicalDetails,
    };
  }

  // Authentication errors
  if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
    return {
      title: 'Authentication Required',
      message: 'Your session has expired. Please sign in again.',
      action: {
        label: 'Sign In',
        onClick: () => (window.location.href = '/login'),
      },
      technical: technicalDetails,
    };
  }

  // Permission errors
  if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
    return {
      title: 'Access Denied',
      message:
        "You don't have permission to perform this action. Contact your administrator if you need access.",
      documentation: '/docs/permissions',
      technical: technicalDetails,
    };
  }

  // Not found errors
  if (errorMessage.includes('404') || errorMessage.includes('not found')) {
    return {
      title: 'Resource Not Found',
      message: context?.url
        ? `The resource at ${context.url} could not be found.`
        : 'The requested resource could not be found.',
      technical: technicalDetails,
    };
  }

  // Server errors
  if (errorMessage.includes('500') || errorMessage.includes('Internal Server Error')) {
    return {
      title: 'Server Error',
      message:
        'Something went wrong on our end. Our team has been notified and is working on a fix.',
      action: {
        label: 'Report Issue',
        onClick: () =>
          window.open('https://github.com/anthropics/abl-platform/issues/new', '_blank'),
      },
      technical: technicalDetails,
    };
  }

  // Crawl-specific errors
  if (context?.code === 'PROFILE_FAILED') {
    return {
      title: 'Site Analysis Failed',
      message: context?.url
        ? `Could not analyze ${context.url}. The site may be blocking automated access or temporarily unavailable.`
        : 'Could not analyze the website. The site may be blocking automated access.',
      action: {
        label: 'Try Different URL',
        onClick: () => {},
      },
      documentation: '/docs/troubleshooting/crawl-errors#profile-failed',
      technical: technicalDetails,
    };
  }

  if (context?.code === 'CRAWL_TIMEOUT') {
    return {
      title: 'Crawl Timeout',
      message:
        'The crawl operation took too long to complete. Try reducing the number of pages or depth.',
      documentation: '/docs/crawl-limits',
      technical: technicalDetails,
    };
  }

  if (context?.code === 'SITE_UNREACHABLE') {
    return {
      title: 'Site Unreachable',
      message: context?.url
        ? `Cannot reach ${context.url}. Check that the URL is correct and the site is online.`
        : 'Cannot reach the website. Check that the URL is correct and the site is online.',
      action: {
        label: 'Check URL',
        onClick: () => {
          if (context?.url && /^https?:\/\//i.test(context.url)) {
            window.open(context.url, '_blank', 'noopener,noreferrer');
          }
        },
      },
      technical: technicalDetails,
    };
  }

  if (context?.code === 'RATE_LIMITED') {
    return {
      title: 'Rate Limit Exceeded',
      message: 'Too many requests. Please wait a moment before trying again.',
      action: {
        label: 'Wait and Retry',
        onClick: () => setTimeout(() => window.location.reload(), 5000),
      },
      documentation: '/docs/rate-limits',
      technical: technicalDetails,
    };
  }

  if (context?.code === 'INVALID_URL') {
    return {
      title: 'Invalid URL',
      message: 'The URL format is invalid. Make sure it starts with http:// or https://.',
      documentation: '/docs/url-format',
      technical: technicalDetails,
    };
  }

  if (context?.code === 'DUPLICATE_CONTENT') {
    return {
      title: 'Content Already Indexed',
      message: 'This content has already been indexed. No need to crawl again.',
      technical: technicalDetails,
    };
  }

  // Circuit breaker error
  if (context?.code === 'CIRCUIT_BREAKER_OPEN') {
    const resetTime = context?.resetAt
      ? new Date(context.resetAt).toLocaleTimeString()
      : 'a few minutes';

    return {
      title: 'Site Temporarily Blocked',
      message: context?.url
        ? `${context.url} has been temporarily blocked due to repeated failures. The block will be automatically lifted at ${resetTime}.`
        : `This site has been temporarily blocked due to repeated failures. Please try again in a few minutes.`,
      action: {
        label: 'Try Anyway',
        onClick: () => {}, // Will be wired to force retry flag
      },
      documentation: '/docs/troubleshooting/circuit-breaker',
      technical: technicalDetails,
    };
  }

  // WebSocket errors
  if (errorMessage.includes('WebSocket')) {
    return {
      title: 'Real-Time Connection Lost',
      message: 'Lost connection to live updates. Refresh the page to reconnect.',
      action: {
        label: 'Reconnect',
        onClick: () => window.location.reload(),
      },
      technical: technicalDetails,
    };
  }

  // Validation errors
  if (errorMessage.includes('validation') || errorMessage.includes('invalid')) {
    return {
      title: 'Invalid Input',
      message: errorMessage,
      technical: technicalDetails,
    };
  }

  // Generic fallback
  return {
    title: 'Something Went Wrong',
    message: errorMessage || 'An unexpected error occurred. Please try again.',
    action: {
      label: 'Retry',
      onClick: () => window.location.reload(),
    },
    technical: technicalDetails,
  };
}

/**
 * Get HTTP status-specific error
 */
export function getHttpError(statusCode: number, context?: ErrorContext): FriendlyError {
  const statusErrors: Record<number, FriendlyError> = {
    400: {
      title: 'Bad Request',
      message: 'The request was invalid. Please check your input and try again.',
      technical: `HTTP ${statusCode}`,
    },
    401: {
      title: 'Authentication Required',
      message: 'Your session has expired. Please sign in again.',
      action: {
        label: 'Sign In',
        onClick: () => (window.location.href = '/login'),
      },
      technical: `HTTP ${statusCode}`,
    },
    403: {
      title: 'Access Denied',
      message: "You don't have permission to access this resource.",
      technical: `HTTP ${statusCode}`,
    },
    404: {
      title: 'Not Found',
      message: context?.url
        ? `Resource not found: ${context.url}`
        : 'The requested resource was not found.',
      technical: `HTTP ${statusCode}`,
    },
    429: {
      title: 'Too Many Requests',
      message: 'Rate limit exceeded. Please wait a moment before trying again.',
      technical: `HTTP ${statusCode}`,
    },
    500: {
      title: 'Server Error',
      message: 'Internal server error. Our team has been notified.',
      technical: `HTTP ${statusCode}`,
    },
    502: {
      title: 'Service Unavailable',
      message: 'The service is temporarily unavailable. Please try again in a moment.',
      technical: `HTTP ${statusCode}`,
    },
    503: {
      title: 'Service Unavailable',
      message: 'The service is currently under maintenance. Please try again later.',
      technical: `HTTP ${statusCode}`,
    },
  };

  return (
    statusErrors[statusCode] || {
      title: 'Request Failed',
      message: `Request failed with status ${statusCode}. Please try again.`,
      technical: `HTTP ${statusCode}`,
    }
  );
}
