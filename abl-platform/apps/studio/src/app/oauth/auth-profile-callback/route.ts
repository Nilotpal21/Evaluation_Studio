import { NextRequest, NextResponse } from 'next/server';
import { clearOAuthCsrfCookie } from '@/app/api/auth-profiles/oauth/_oauth-state-service';
import {
  abandonAuthProfileOAuthCallback,
  finalizeAuthProfileOAuthCallback,
  type OAuthCallbackFinalizationResult,
} from '@/app/api/auth-profiles/oauth/_oauth-callback-finalizer';

const MESSAGE_TYPE = 'auth-profile-oauth-callback';
const CALLBACK_STORAGE_PREFIX = 'auth-profile-oauth-callback:';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
}

function buildPayload(params: {
  state: string | null;
  result?: OAuthCallbackFinalizationResult;
  error?: string;
  errorCode?: string;
}): Record<string, unknown> {
  if (params.result?.success) {
    return {
      type: MESSAGE_TYPE,
      success: true,
      exchanged: true,
      state: params.state,
      callbackResult: params.result.data,
    };
  }

  return {
    type: MESSAGE_TYPE,
    success: false,
    ...(params.state ? { state: params.state } : {}),
    error: params.error ?? params.result?.message ?? 'OAuth authorization failed',
    errorCode: params.errorCode ?? params.result?.code ?? 'OAUTH_CALLBACK_FAILED',
  };
}

function htmlResponse(params: {
  request: NextRequest;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  clearCsrf?: boolean;
  status?: number;
}): NextResponse {
  const targetOrigin = new URL(params.request.url).origin;
  const state = typeof params.payload.state === 'string' ? params.payload.state : null;
  const payloadJson = safeJson(params.payload);
  const targetOriginJson = safeJson(targetOrigin);
  const storageKeyJson = safeJson(state ? `${CALLBACK_STORAGE_PREFIX}${state}` : null);
  const title = escapeHtml(params.title);
  const message = escapeHtml(params.message);

  const response = new NextResponse(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
    main { width: min(360px, calc(100vw - 32px)); text-align: center; padding: 28px; border: 1px solid #e5e7eb; border-radius: 16px; background: #ffffff; box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12); }
    h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.4; }
    p { margin: 0; font-size: 13px; line-height: 1.5; color: #4b5563; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
  <script>
    (function () {
      var payload = ${payloadJson};
      var targetOrigin = ${targetOriginJson};
      var storageKey = ${storageKeyJson};
      try {
        if (storageKey) {
          window.localStorage.setItem(storageKey, JSON.stringify(payload));
        }
      } catch (_) {}
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, targetOrigin);
        }
      } catch (_) {}
      window.setTimeout(function () {
        try { window.close(); } catch (_) {}
      }, 150);
    })();
  </script>
</body>
</html>`,
    {
      status: params.status ?? 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    },
  );

  if (params.clearCsrf) {
    clearOAuthCsrfCookie(response);
  }

  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const searchParams = request.nextUrl.searchParams;
  const state = searchParams.get('state');
  const providerError = searchParams.get('error');
  const providerErrorDescription = searchParams.get('error_description');
  const code = searchParams.get('code');

  if (providerError) {
    const error = providerErrorDescription || providerError;
    if (state) {
      const result = await abandonAuthProfileOAuthCallback({
        request,
        state,
        errorCode: providerError,
        message: error,
      });
      if (result.success) {
        return htmlResponse({
          request,
          title: 'Authorization complete',
          message: 'This window will close automatically.',
          payload: buildPayload({ state, result }),
          clearCsrf: true,
        });
      }
      return htmlResponse({
        request,
        title: 'Authorization failed',
        message: result.message,
        payload: buildPayload({ state, result }),
        clearCsrf: result.stateData !== undefined,
        status: result.status,
      });
    }

    return htmlResponse({
      request,
      title: 'Authorization failed',
      message: error,
      payload: buildPayload({ state, error, errorCode: providerError }),
    });
  }

  if (!code || !state) {
    return htmlResponse({
      request,
      title: 'Authorization failed',
      message: 'Missing OAuth code or state. Please restart authorization.',
      payload: buildPayload({
        state,
        error: 'Missing OAuth code or state. Please restart authorization.',
        errorCode: 'MISSING_CODE_OR_STATE',
      }),
      status: 400,
    });
  }

  const result = await finalizeAuthProfileOAuthCallback({
    request,
    code,
    state,
    requireCsrfCookie: false,
  });

  if (!result.success) {
    return htmlResponse({
      request,
      title: 'Authorization failed',
      message: result.message,
      payload: buildPayload({ state, result }),
      status: result.status,
    });
  }

  return htmlResponse({
    request,
    title: 'Authorization complete',
    message: 'This window will close automatically.',
    payload: buildPayload({ state, result }),
    clearCsrf: true,
  });
}
