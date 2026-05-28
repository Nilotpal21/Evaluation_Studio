/**
 * McpServerCard Component
 *
 * Card display for MCP servers in the Tools page MCP tab.
 * Shows server name, transport, connection status, tool count, and actions.
 */

import { useState } from 'react';
import { MoreVertical, Edit, Zap, Trash2, ExternalLink, Wrench, Clock } from 'lucide-react';
import { motion } from 'framer-motion';
import { TransportBadge, ConnectionStatusBadge } from './McpServerStatusBadge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type { McpServer } from '../../api/mcp-servers';

// ─── Time helpers ────────────────────────────────────────────────────────────

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < SECONDS_PER_MINUTE) return 'just now';
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  return `${days}d ago`;
}

interface McpServerCardProps {
  server: McpServer;
  onViewDetails: (serverId: string) => void;
  onEdit: (server: McpServer) => void;
  onTest: (serverId: string) => void;
  onDelete: (serverId: string) => void;
}

export function McpServerCard({
  server,
  onViewDetails,
  onEdit,
  onTest,
  onDelete,
}: McpServerCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleCardClick = () => {
    onViewDetails(server.id);
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

  const lastConnected = server.lastConnectionAt
    ? formatRelativeTime(server.lastConnectionAt)
    : null;

  return (
    <>
      <motion.div
        whileTap={{ scale: 0.98 }}
        onClick={handleCardClick}
        className={`relative rounded-2xl border border-default bg-background-elevated card-hover transition-default cursor-pointer group ${menuOpen ? 'z-30' : ''}`}
      >
        <div className="p-4">
          {/* Header: Server Name + Badges + Menu */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-base font-semibold text-foreground truncate">{server.name}</h3>
              <TransportBadge transport={server.transport} />
              <ConnectionStatusBadge status={server.lastConnectionStatus} />
            </div>
            <div className="relative shrink-0 ml-2">
              <button
                onClick={handleMenuClick}
                className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded transition-default"
              >
                <MoreVertical className="w-4 h-4" />
              </button>

              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuOpen(false);
                    }}
                  />
                  <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-lg border border-default bg-background-elevated shadow-xl overflow-hidden">
                    <button
                      onClick={(e) => handleActionClick(e, () => onViewDetails(server.id))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-default text-left"
                    >
                      <ExternalLink className="w-4 h-4" />
                      View Details
                    </button>
                    <button
                      onClick={(e) => handleActionClick(e, () => onEdit(server))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-default text-left"
                    >
                      <Edit className="w-4 h-4" />
                      Edit
                    </button>
                    <button
                      onClick={(e) => handleActionClick(e, () => onTest(server.id))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-background-muted transition-default text-left"
                    >
                      <Zap className="w-4 h-4" />
                      Test Connection
                    </button>
                    <div className="border-t border-default" />
                    <button
                      onClick={(e) => handleActionClick(e, () => setDeleteOpen(true))}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-error hover:bg-error-subtle transition-default text-left"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* URL */}
          <p className="text-sm text-muted truncate min-h-[1.25rem]">
            {server.url || 'No URL configured'}
          </p>

          {/* Footer: Tool Count + Last Connected */}
          <div className="mt-3 pt-3 border-t border-default flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Wrench className="w-3 h-3" />
              {server.discoveredToolCount} tool{server.discoveredToolCount !== 1 ? 's' : ''}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Clock className="w-3 h-3" />
              {lastConnected ? lastConnected : 'Never tested'}
            </span>
          </div>
        </div>
      </motion.div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          onDelete(server.id);
          setDeleteOpen(false);
        }}
        title="Delete MCP Server"
        description={
          server.discoveredToolCount > 0
            ? `Are you sure you want to delete "${server.name}"? This will also remove ${server.discoveredToolCount} imported tool${server.discoveredToolCount !== 1 ? 's' : ''} from this server. This action cannot be undone.`
            : `Are you sure you want to delete "${server.name}"? This action cannot be undone.`
        }
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
