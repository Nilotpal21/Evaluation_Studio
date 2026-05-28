/**
 * POST /api/template-install/project
 *
 * Create a new project from a project template.
 * 1. Validates auth (requireTenantAuth + project:create permission)
 * 2. Fetches bundle server-side from template-store
 * 3. Creates new project via createProject()
 * 4. Imports bundle via applyStudioLayeredImportV2 with conflictStrategy: 'replace'
 * 5. Notifies template-store of install event (fire-and-forget)
 * 6. Returns 201 with project info + applied counts + provisioning report
 */

export const maxDuration = 120; // seconds — import can be slow for large bundles
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { hasPermission } from '@/lib/permission-resolver';
import { errorJson, ErrorCode, handleApiError } from '@/lib/api-response';
import { createProject } from '@/services/project-service';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import {
  applyStudioLayeredImportV2,
  previewStudioLayeredImportV2,
} from '@/lib/project-import/layered-import-support';
import type { ImportPreviewV2 } from '@agent-platform/project-io';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';
import {
  ProjectInstallBodySchema,
  fetchTemplateBundle,
  notifyInstallEvent,
  fetchTemplatePrerequisites,
} from '@/lib/template-install';
import { AppError } from '@agent-platform/shared/errors';

const log = createLogger('template-install-project');

export async function POST(request: NextRequest) {
  // 1. Auth
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  if (!hasPermission(user.permissions ?? [], 'project:create')) {
    return errorJson(
      'Forbidden: missing required permission (project:create)',
      403,
      ErrorCode.FORBIDDEN,
    );
  }

  // 2. Parse + validate body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson('Invalid JSON body', 400, ErrorCode.VALIDATION_ERROR);
  }

  const parsed = ProjectInstallBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorJson(
      parsed.error.issues.map((i) => i.message),
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const { templateSlug, version, projectName, projectSlug, description } = parsed.data;
  const authorization = request.headers.get('authorization') ?? '';

  try {
    // 3. Fetch bundle server-side (pass tenantId for tenant-scoped templates)
    const files = await fetchTemplateBundle(templateSlug, version, authorization, user.tenantId);

    // 4. Create project
    const project = await createProject({
      name: projectName,
      slug: projectSlug,
      description,
      ownerId: user.id,
      tenantId: user.tenantId,
    });

    // 5. Import bundle into the new project
    // For template installs into a fresh empty project, we auto-acknowledge
    // all non-blocking issues (the user already chose to install the template).
    // We run preview first, then apply with the same digest + auto-acknowledged IDs.
    const fileMap = new Map(Object.entries(files));

    // Step 5a: Preview
    const previewResult = await previewStudioLayeredImportV2({
      files: fileMap,
      projectId: project.id,
      tenantId: user.tenantId,
      userId: user.id,
      conflictStrategy: 'replace',
    });

    const preview = previewResult.preview as ImportPreviewV2 | undefined;

    if (preview?.hasBlockingIssues) {
      const blockingIssues = preview.issues?.filter((i) => i.blocking);
      log.error('Template preview has blocking issues', {
        projectId: project.id,
        templateSlug,
        blockingIssues: blockingIssues?.slice(0, 10),
      });
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'IMPORT_BLOCKED',
            message: 'Template bundle has blocking validation issues',
            blockingIssues: blockingIssues?.slice(0, 10),
          },
          project: { id: project.id, name: project.name, slug: project.slug },
        },
        { status: 400 },
      );
    }

    // Step 5b: Auto-acknowledge all non-blocking issues and apply
    // Pass the preview digest so applyStudioLayeredImportV2's internal
    // re-preview matches (same project state = same digest).
    const acknowledgedIssueIds = (preview?.issues ?? [])
      .filter((i) => !i.blocking && i.id)
      .map((i) => i.id);

    log.info('Auto-acknowledging non-blocking issues for template install', {
      projectId: project.id,
      templateSlug,
      issueCount: acknowledgedIssueIds.length,
      previewDigest: preview?.previewDigest,
    });

    const importResult = await applyStudioLayeredImportV2({
      files: fileMap,
      projectId: project.id,
      tenantId: user.tenantId,
      userId: user.id,
      conflictStrategy: 'replace',
      previewDigest: preview?.previewDigest,
      acknowledgedIssueIds,
    });

    if (!importResult.success) {
      // Import failed — the project was created but empty.
      // Log detailed info including blocking issues from the preview
      const blockingIssues = importResult.preview?.issues?.filter(
        (i: { blocking?: boolean }) => i.blocking,
      );
      const allIssues = importResult.preview?.issues;

      log.error('Template import failed after project creation', {
        projectId: project.id,
        templateSlug,
        error: importResult.error,
        stage: importResult.stage,
        blockingIssueCount: blockingIssues?.length ?? 0,
        blockingIssues: blockingIssues?.slice(0, 10),
        allIssueCount: allIssues?.length ?? 0,
        syntaxErrors: importResult.preview?.syntaxErrors?.slice(0, 5),
        warnings: importResult.warnings?.slice(0, 5),
      });

      return NextResponse.json(
        {
          success: false,
          error: {
            code: importResult.error?.code ?? 'IMPORT_FAILED',
            message: importResult.error?.message ?? 'Template import failed',
            blockingIssues: blockingIssues?.slice(0, 10),
            syntaxErrors: importResult.preview?.syntaxErrors?.slice(0, 5),
          },
          project: { id: project.id, name: project.name, slug: project.slug },
        },
        { status: 500 },
      );
    }

    // 6. Fetch prerequisites for provisioning report
    const provisioningRequired = await fetchTemplatePrerequisites(templateSlug, authorization);

    // 7. Model cache invalidation (if model policies were changed)
    const applied = importResult.applied;
    if ((applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0) {
      await notifyRuntimeModelConfigChanged({
        tenantId: user.tenantId,
        authorization,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Model cache invalidation failed', { error: message });
      });
    }

    // 8. Notify template-store of install event (fire-and-forget)
    notifyInstallEvent({
      slug: templateSlug,
      version,
      userId: user.id,
      tenantId: user.tenantId,
      projectId: project.id,
      authorization,
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Install event notification failed', { error: message });
    });

    // 9. Audit log (fire-and-forget)
    logAuditEvent({
      userId: user.id,
      tenantId: user.tenantId,
      action: AuditActions.PROJECT_CREATED,
      ip: request.headers.get('x-forwarded-for') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
      metadata: {
        projectId: project.id,
        resourceType: 'project',
        resourceId: project.id,
        name: project.name,
        source: 'template-install',
        templateSlug,
        templateVersion: version,
      },
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Audit log failed', { projectId: project.id, error: message });
    });

    log.info('Project template installed', {
      projectId: project.id,
      templateSlug,
      version,
      created: applied.created,
      toolsCreated: applied.toolsCreated,
    });

    return NextResponse.json(
      {
        success: true,
        project: { id: project.id, name: project.name, slug: project.slug },
        applied,
        entryAgentName: importResult.entryAgentName ?? null,
        provisioningRequired,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof AppError) {
      return errorJson(err.message, err.statusCode ?? 500, err.code);
    }
    return handleApiError(err, 'TemplateInstall.project');
  }
}
