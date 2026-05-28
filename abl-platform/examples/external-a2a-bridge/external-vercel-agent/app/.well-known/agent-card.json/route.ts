import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function firstHeaderValue(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const first = value
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return first ?? null;
}

function normalizeConfiguredBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeHost(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized.startsWith('localhost') ||
    normalized.startsWith('127.0.0.1') ||
    normalized.startsWith('[::1]')
  );
}

function resolveBaseUrl(request: NextRequest): string {
  const configured = normalizeConfiguredBaseUrl(process.env.PUBLIC_BASE_URL);
  if (configured) {
    return configured;
  }

  const host = normalizeHost(firstHeaderValue(request.headers.get('host')));
  const forwardedHost = normalizeHost(firstHeaderValue(request.headers.get('x-forwarded-host')));
  const resolvedHost =
    host && isLoopbackHost(host)
      ? host
      : (forwardedHost ?? host ?? normalizeHost(request.nextUrl.host));
  const forwardedProto = firstHeaderValue(request.headers.get('x-forwarded-proto'));

  if (resolvedHost) {
    const protocol =
      forwardedProto?.replace(/:$/, '') ||
      (isLoopbackHost(resolvedHost)
        ? 'http'
        : request.nextUrl.protocol.replace(/:$/, '') || 'https');
    return `${protocol}://${resolvedHost}`;
  }

  return request.nextUrl.origin.replace(/\/$/, '');
}

export async function GET(request: NextRequest) {
  const baseUrl = resolveBaseUrl(request);

  return NextResponse.json({
    name: 'Hosted Vercel Agent',
    description:
      'Externally hosted A2A agent built with Next.js and the Vercel AI SDK. Demonstrates multi-turn context exchange plus file delivery back into the platform.',
    url: `${baseUrl}/api/a2a`,
    version: '1.0.0',
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'collaborative_planning',
        name: 'Collaborative Planning',
        description:
          'Carries long-running planning conversations by relying on forwarded history and can call a platform-hosted agent back for research help.',
        tags: ['planning', 'context', 'handoff'],
      },
      {
        id: 'platform_file_delivery',
        name: 'Platform File Delivery',
        description:
          'Packages the current collaboration as a Markdown file and sends it into a platform-hosted agent using an inline A2A file part.',
        tags: ['attachments', 'files', 'a2a'],
      },
    ],
  });
}
