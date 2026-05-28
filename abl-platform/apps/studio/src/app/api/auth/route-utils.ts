import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/get-client-ip';

export function authError(message: string, status: number, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: message }, { status, headers });
}

export function getAuthRouteClientIp(request: NextRequest): string {
  return getClientIp(request);
}

export async function parseOptionalJsonBody<T>(request: NextRequest): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
