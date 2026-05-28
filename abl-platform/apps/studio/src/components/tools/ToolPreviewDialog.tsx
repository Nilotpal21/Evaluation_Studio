/**
 * ToolPreviewDialog Component
 *
 * Quick preview modal for tools without navigating to detail page.
 * Shows read-only configuration summary parsed from dslContent.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Edit, Play, Globe, Code2, Server } from 'lucide-react';
import { ToolTypeBadge } from './ToolTypeBadge';
import type { ToolWithVersion } from '../../store/tool-store';

// ─── DSL Parsing Helpers ────────────────────────────────────────────────

function parseDslProperties(dslContent: string): Record<string, string> {
  const props: Record<string, string> = {};
  const lines = dslContent.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      props[key] = value.replace(/^["']|["']$/g, '').trim();
    }
  }

  return props;
}

function parseDslSignatureParams(dslContent: string): Array<{ name: string; type: string }> {
  const firstLine = dslContent.split('\n')[0] || '';
  const parenMatch = firstLine.match(/\(([^)]*)\)/);
  if (!parenMatch || !parenMatch[1].trim()) return [];

  return parenMatch[1].split(',').map((segment) => {
    const trimmed = segment.trim();
    const [name, type] = trimmed
      .replace('?', '')
      .split(':')
      .map((s) => s.trim());
    return { name: name || '', type: type || 'string' };
  });
}

function extractPipeBlock(dslContent: string, key: string): string | null {
  const lines = dslContent.split('\n');
  let capturing = false;
  let baseIndent = 0;
  const codeLines: string[] = [];

  for (const line of lines) {
    if (capturing) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === '' || indent > baseIndent) {
        codeLines.push(indent > baseIndent ? line.slice(baseIndent + 2) : '');
      } else {
        break;
      }
    } else {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(`${key}:`) && trimmed.endsWith('|')) {
        capturing = true;
        baseIndent = line.length - line.trimStart().length;
      }
    }
  }

  return codeLines.length > 0 ? codeLines.join('\n').trimEnd() : null;
}

// ─── Component ──────────────────────────────────────────────────────────

interface ToolPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  tool: ToolWithVersion | null;
  onEdit: (toolId: string) => void;
  onTest: (tool: ToolWithVersion) => void;
}

export function ToolPreviewDialog({ open, onClose, tool, onEdit, onTest }: ToolPreviewDialogProps) {
  const t = useTranslations('tools.preview');

  const parsed = useMemo(() => {
    if (!tool?.dslContent) return null;
    return {
      props: parseDslProperties(tool.dslContent),
      params: parseDslSignatureParams(tool.dslContent),
      code: extractPipeBlock(tool.dslContent, 'code'),
    };
  }, [tool?.dslContent]);

  if (!tool || !parsed) return null;

  const { props, params, code } = parsed;

  const renderConfigPreview = () => {
    switch (tool.toolType) {
      case 'sandbox': {
        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                {t('runtime_label')}
              </label>
              <Badge variant="info">{props.runtime || 'javascript'}</Badge>
            </div>

            {params.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-muted mb-2">
                  {t('parameters_label', { count: params.length })}
                </label>
                <div className="space-y-1">
                  {params.slice(0, 5).map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <code className="font-mono text-foreground">{p.name}</code>
                      <span className="text-muted">: {p.type}</span>
                    </div>
                  ))}
                  {params.length > 5 && (
                    <p className="text-xs text-muted italic">
                      {t('more_params', { count: params.length - 5 })}
                    </p>
                  )}
                </div>
              </div>
            )}

            {code && (
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('code_preview_label')}
                </label>
                <pre className="p-3 rounded-lg bg-background-muted border border-default text-xs font-mono text-foreground overflow-x-auto max-h-64 overflow-y-auto">
                  {code.slice(0, 500)}
                  {code.length > 500 && `\n\n${t('truncated')}`}
                </pre>
              </div>
            )}
          </div>
        );
      }

      case 'http': {
        const endpoint = props.endpoint;
        const method = props.method || 'GET';
        const auth = props.auth;

        if (!endpoint) return <p className="text-sm text-muted">{t('no_config')}</p>;

        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                {t('endpoint_label')}
              </label>
              <div className="flex items-center gap-2">
                <Badge variant="accent">{method}</Badge>
                <code className="text-sm font-mono text-foreground">{endpoint}</code>
              </div>
            </div>

            {auth && auth !== 'none' && (
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('auth_label')}
                </label>
                <Badge variant="warning">{auth}</Badge>
              </div>
            )}

            {params.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-muted mb-2">
                  {t('parameters_label', { count: params.length })}
                </label>
                <div className="space-y-1">
                  {params.slice(0, 5).map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <code className="font-mono text-foreground">{p.name}</code>
                      <span className="text-muted">: {p.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      }

      case 'mcp': {
        const server = props.server;
        const serverTool = props.server_tool;

        if (!server) return <p className="text-sm text-muted">{t('no_config')}</p>;

        return (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                {t('server_url_label')}
              </label>
              <code className="text-sm font-mono text-foreground">{server}</code>
            </div>

            {serverTool && (
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {t('remote_tool_name_label')}
                </label>
                <code className="text-sm font-mono text-foreground">{serverTool}</code>
              </div>
            )}
          </div>
        );
      }

      default:
        return <p className="text-sm text-muted">{t('preview_not_available')}</p>;
    }
  };

  const getTypeIcon = () => {
    switch (tool.toolType) {
      case 'http':
        return <Globe className="w-5 h-5" />;
      case 'sandbox':
        return <Code2 className="w-5 h-5" />;
      case 'mcp':
        return <Server className="w-5 h-5" />;
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={tool.name} maxWidth="2xl">
      <div className="space-y-6">
        {/* Header with type and status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-accent/10 text-accent">
            {getTypeIcon()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <ToolTypeBadge type={tool.toolType} />
            </div>
            <p className="text-sm text-muted">{tool.description || t('no_config')}</p>
          </div>
        </div>

        {/* Configuration Preview */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('configuration_title')}</h3>
          {renderConfigPreview()}
        </div>

        {/* Metadata */}
        <div className="pt-4 border-t border-default">
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-muted">{t('timeout_label')}</span>{' '}
              <span className="text-foreground font-medium">
                {props.timeout ? `${props.timeout}ms` : '30000ms'}
              </span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-default">
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
          <Button
            variant="secondary"
            icon={<Play className="w-4 h-4" />}
            onClick={() => {
              onTest(tool);
              onClose();
            }}
          >
            {t('test')}
          </Button>
          <Button
            variant="primary"
            icon={<Edit className="w-4 h-4" />}
            onClick={() => {
              onEdit(tool.id);
              onClose();
            }}
          >
            {t('edit')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
