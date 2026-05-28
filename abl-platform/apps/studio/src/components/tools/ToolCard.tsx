/**
 * ToolCard Component
 *
 * Card display for tools in list view.
 * Features: hover animations, inline actions, navigation.
 */

import { useState } from 'react';
import {
  MoreVertical,
  Edit,
  Play,
  Copy,
  Trash2,
  Eye,
  Server,
  Clock,
  User,
  Code,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { springs, STAGGER_DELAY } from '../../lib/animation';
import { ToolTypeBadge } from './ToolTypeBadge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type { ToolWithVersion } from '../../store/tool-store';
import type { VariableNamespace } from '../../api/variable-namespaces';

// ─── Time helpers ────────────────────────────────────────────────────────────

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

// ─── MCP helpers ─────────────────────────────────────────────────────────────

function getMcpDisplayInfo(tool: ToolWithVersion) {
  if (tool.toolType !== 'mcp') return null;
  const parts = tool.name.split('__');
  if (parts.length < 2) return null;
  return { serverName: parts[0], toolDisplayName: parts.slice(1).join('__') };
}

interface ToolCardProps {
  tool: ToolWithVersion;
  index?: number;
  variableNamespaces?: VariableNamespace[];
  onEdit: (toolId: string) => void;
  onTest: (tool: ToolWithVersion) => void;
  onPreview: (tool: ToolWithVersion) => void;
  onDuplicate: (toolId: string) => void;
  onDelete: (toolId: string) => void;
}

export function ToolCard({
  tool,
  index = 0,
  variableNamespaces = [],
  onEdit,
  onTest,
  onPreview,
  onDuplicate,
  onDelete,
}: ToolCardProps) {
  const t = useTranslations('tools.card');
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleCardClick = () => {
    onEdit(tool.id);
  };

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(!menuOpen);
  };

  const handleActionClick = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    setMenuOpen(false);
    action();
  };

  const lastUpdated = (() => {
    if (!tool.updatedAt) return 'N/A';
    const diff = Date.now() - new Date(tool.updatedAt).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < SECONDS_PER_MINUTE) return t('just_now');
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    if (minutes < 60) return t('minutes_ago', { minutes });
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    if (hours < 24) return t('hours_ago', { hours });
    const days = Math.floor(seconds / SECONDS_PER_DAY);
    return t('days_ago', { days });
  })();
  const mcpInfo = getMcpDisplayInfo(tool);

  return (
    <>
      <motion.div
        data-testid={`tool-row-${tool.id}`}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...springs.default, delay: index * STAGGER_DELAY }}
        whileTap={{ scale: 0.98 }}
        onClick={handleCardClick}
        className={`relative rounded-2xl border border-default bg-background-elevated card-hover transition-default cursor-pointer group ${menuOpen ? 'z-30' : ''}`}
      >
        {/* Card Content */}
        <div className="p-4">
          {/* Header: Tool Name + Type Badge + Menu */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold text-foreground truncate">
                {mcpInfo ? mcpInfo.toolDisplayName : tool.name}
              </h3>
              <ToolTypeBadge type={tool.toolType} className="shrink-0" />
            </div>

            {/* Three-dot menu */}
            <div className="relative shrink-0 ml-2">
              <button
                onClick={handleMenuClick}
                className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
              >
                <MoreVertical className="w-4 h-4" />
              </button>

              <AnimatePresence>
                {menuOpen && (
                  <>
                    {/* Backdrop */}
                    <div
                      className="fixed inset-0 z-10"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen(false);
                      }}
                    />

                    {/* Dropdown Menu */}
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95, y: -4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.95, y: -4 }}
                      transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                      className="absolute right-0 top-full mt-1 z-20 w-40 rounded-lg border border-default bg-background-elevated shadow-xl overflow-hidden origin-top-right"
                    >
                      <button
                        onClick={(e) => handleActionClick(e, () => onPreview(tool))}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-fast text-left"
                      >
                        <Eye className="w-4 h-4 text-muted" />
                        {t('menu_preview')}
                      </button>
                      <button
                        onClick={(e) =>
                          handleActionClick(e, () => {
                            navigator.clipboard.writeText(tool.name);
                            toast.success(t('copied_toast'));
                          })
                        }
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-fast text-left"
                      >
                        <Code className="w-4 h-4 text-muted" />
                        {t('menu_copy_name')}
                      </button>
                      <button
                        onClick={(e) => handleActionClick(e, () => onEdit(tool.id))}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-fast text-left"
                      >
                        <Edit className="w-4 h-4 text-muted" />
                        {t('menu_edit')}
                      </button>
                      {tool.toolType !== 'searchai' && (
                        <button
                          onClick={(e) => handleActionClick(e, () => onTest(tool))}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-fast text-left"
                        >
                          <Play className="w-4 h-4 text-muted" />
                          {t('menu_test')}
                        </button>
                      )}
                      {tool.toolType !== 'searchai' && (
                        <button
                          onClick={(e) => handleActionClick(e, () => onDuplicate(tool.id))}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-fast text-left"
                        >
                          <Copy className="w-4 h-4 text-muted" />
                          {t('menu_duplicate')}
                        </button>
                      )}
                      {tool.toolType !== 'searchai' && (
                        <>
                          <div className="border-t border-default" />
                          <button
                            onClick={(e) => handleActionClick(e, () => setDeleteOpen(true))}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error-subtle transition-fast text-left"
                          >
                            <Trash2 className="w-4 h-4" />
                            {t('menu_delete')}
                          </button>
                        </>
                      )}
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Description */}
          <p className="text-sm text-muted line-clamp-2 min-h-[2.5rem]">
            {tool.description || t('no_description')}
          </p>

          {/* Namespace badges */}
          {tool.variableNamespaceIds?.length > 0 && variableNamespaces.length > 0 && (
            <div className="mt-2 flex items-center gap-1 flex-wrap">
              {tool.variableNamespaceIds
                .map((id) => variableNamespaces.find((ns) => ns.id === id))
                .filter(Boolean)
                .slice(0, 3)
                .map((ns) => (
                  <span
                    key={ns!.id}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-background-muted text-xs text-muted"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: ns!.color || 'var(--color-muted)' }}
                    />
                    <span className="truncate max-w-[60px]">{ns!.displayName}</span>
                  </span>
                ))}
              {tool.variableNamespaceIds.length > 3 && (
                <span className="text-xs text-muted">+{tool.variableNamespaceIds.length - 3}</span>
              )}
            </div>
          )}

          {/* Footer: Last Updated + Source */}
          <div className="mt-3 pt-3 border-t border-default flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Clock className="w-3 h-3" />
              {lastUpdated}
            </span>
            {mcpInfo ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted truncate ml-2">
                <Server className="w-3 h-3" />
                {mcpInfo.serverName}
              </span>
            ) : tool.createdBy ? (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted truncate ml-2"
                title={t('created_by')}
              >
                <User className="w-3 h-3" />
                {tool.createdBy}
              </span>
            ) : null}
          </div>
        </div>
      </motion.div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          onDelete(tool.id);
          setDeleteOpen(false);
        }}
        title={t('delete_title')}
        description={t('delete_description', { name: tool.name })}
        confirmLabel={t('menu_delete')}
        variant="danger"
      />
    </>
  );
}
