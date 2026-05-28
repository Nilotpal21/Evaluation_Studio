import { NextRequest } from 'next/server';
import { proxyModelCapabilities } from '../proxy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> },
) {
  const { modelId } = await params;
  return proxyModelCapabilities(request, modelId);
}
