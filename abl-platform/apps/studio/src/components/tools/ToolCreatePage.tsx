/**
 * ToolCreatePage Component
 *
 * Multi-step wizard for creating tools - type is pre-selected from URL query param.
 * Renders the appropriate wizard based on tool type.
 */

import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useToolStore, type ToolType } from '../../store/tool-store';
import { createTool } from '../../api/tools';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { HttpToolWizard } from './wizard/HttpToolWizard';
import { SandboxToolWizard } from './wizard/SandboxToolWizard';
import { McpToolWizard } from './wizard/McpToolWizard';
import { getProjectScopedReturnTo } from './return-navigation';
import {
  buildHttpCreatePayload,
  buildSandboxCreatePayload,
  buildMcpCreatePayload,
} from './form-adapters';
import type { HttpConfig } from './HttpConfigForm';
import type { SandboxConfig } from './SandboxConfigForm';
import type { McpConfig } from './McpConfigForm';

export function ToolCreatePage() {
  const { currentProject } = useProjectStore();
  const { navigate } = useNavigationStore();
  const { addTool } = useToolStore();

  const projectId = currentProject?.id;
  const [toolType, setToolType] = useState<ToolType | null>(null);
  const [submitErrors, setSubmitErrors] = useState<string[]>([]);

  // Read ?type query param - redirect back if not provided
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const typeParam = params.get('type');

    if (!typeParam || !['http', 'sandbox', 'mcp', 'lambda'].includes(typeParam)) {
      // No valid type provided, redirect back to tools list
      if (projectId) {
        navigate(`/projects/${projectId}/tools`);
      }
      return;
    }

    setToolType(typeParam as ToolType);
  }, [projectId, navigate]);

  const clearErrors = useCallback(() => setSubmitErrors([]), []);

  const navigateAfterCreate = useCallback(
    (fallbackPath: string) => {
      if (!projectId) return;

      navigate(getProjectScopedReturnTo(projectId) ?? fallbackPath, { replace: true });
    },
    [projectId, navigate],
  );

  const handleCancel = () => {
    if (!projectId) return;
    navigateAfterCreate(`/projects/${projectId}/tools`);
  };

  const handleHttpSubmit = async (data: {
    name: string;
    description: string;
    httpConfig: HttpConfig;
  }) => {
    if (!projectId) return;
    setSubmitErrors([]);
    try {
      const payload = buildHttpCreatePayload(data.name, data.description, data.httpConfig);
      const result = await createTool(projectId, payload);
      addTool(result.tool);
      navigateAfterCreate(`/projects/${projectId}/tools/${result.tool.id}`);
    } catch (err: unknown) {
      setSubmitErrors(sanitizeErrors(err, 'Failed to create tool'));
    }
  };

  const handleSandboxSubmit = async (data: {
    name: string;
    description: string;
    sandboxConfig: SandboxConfig;
  }) => {
    if (!projectId) return;
    setSubmitErrors([]);
    try {
      const payload = buildSandboxCreatePayload(data.name, data.description, data.sandboxConfig);
      const result = await createTool(projectId, payload);
      addTool(result.tool);
      navigateAfterCreate(`/projects/${projectId}/tools/${result.tool.id}`);
    } catch (err: unknown) {
      setSubmitErrors(sanitizeErrors(err, 'Failed to create tool'));
    }
  };

  const handleMcpSubmit = async (data: {
    name: string;
    description: string;
    mcpConfig: McpConfig;
  }) => {
    if (!projectId) return;
    setSubmitErrors([]);
    try {
      const payload = buildMcpCreatePayload(data.name, data.description, data.mcpConfig);
      const result = await createTool(projectId, payload);
      addTool(result.tool);
      navigateAfterCreate(`/projects/${projectId}/tools/${result.tool.id}`);
    } catch (err: unknown) {
      setSubmitErrors(sanitizeErrors(err, 'Failed to create tool'));
    }
  };

  // Don't render until we have a valid tool type
  if (!toolType) {
    return null;
  }

  // Render the appropriate wizard based on tool type
  switch (toolType) {
    case 'http':
      return (
        <HttpToolWizard
          onCancel={handleCancel}
          onSubmit={handleHttpSubmit}
          projectId={projectId}
          submitErrors={submitErrors}
          onClearErrors={clearErrors}
        />
      );
    case 'sandbox':
      return (
        <SandboxToolWizard
          onCancel={handleCancel}
          onSubmit={handleSandboxSubmit}
          submitErrors={submitErrors}
          onClearErrors={clearErrors}
        />
      );
    case 'mcp':
      return (
        <McpToolWizard
          onCancel={handleCancel}
          onSubmit={handleMcpSubmit}
          submitErrors={submitErrors}
          onClearErrors={clearErrors}
        />
      );
    default:
      return null;
  }
}
