import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { diagnoseTranscriptFailure } from '@/lib/abl-package-analysis';
import { transcriptDiagnosisSchema, type TranscriptDiagnosisBody } from '../_shared';

export const POST = withRouteHandler<TranscriptDiagnosisBody>(
  {
    bodySchema: transcriptDiagnosisSchema,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    return NextResponse.json({
      success: true,
      diagnosis: diagnoseTranscriptFailure(ctx.body.transcript, ctx.body.files),
    });
  },
);
