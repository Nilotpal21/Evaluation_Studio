import { NextRequest } from 'next/server';
import { proxyModelCapabilities } from './proxy';

export async function GET(request: NextRequest) {
  return proxyModelCapabilities(request, request.nextUrl.searchParams.get('modelId'));
}
