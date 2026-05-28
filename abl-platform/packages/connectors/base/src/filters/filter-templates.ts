/**
 * Filter Templates
 *
 * Pre-built filter configurations for common use cases.
 * Users can start from a template and customize.
 */

import type { AdvancedFilterConfig, FilterCondition } from './advanced-filter-evaluator.js';
import type { FileExtensionConfig } from './file-extension-registry.js';
import type { FolderPathConfig } from './folder-path-matcher.js';

// ─── Types ──────────────────────────────────────────────────────────────

export interface FilterTemplate {
  /** Unique template identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this template does */
  description: string;
  /** Which connector types this template applies to (empty = all) */
  connectorTypes: string[];
  /** Template category for UI grouping */
  category: 'common' | 'security' | 'performance' | 'compliance';
  /** The filter values this template applies */
  filters: {
    contentCategories?: string[];
    fileExtensions?: FileExtensionConfig;
    maxFileSizeBytes?: number;
    modifiedAfter?: string; // Relative date expression: "now-90d", "now-1y"
    folderPaths?: FolderPathConfig;
    advancedFilters?: Omit<AdvancedFilterConfig, 'enabled'>;
  };
}

// ─── Built-in Templates ─────────────────────────────────────────────────

export const FILTER_TEMPLATES: FilterTemplate[] = [
  {
    id: 'office-documents',
    name: 'Office Documents Only',
    description:
      'Sync only Microsoft Office and PDF documents. Excludes images, videos, archives, and other non-document files.',
    connectorTypes: ['sharepoint', 'confluence'],
    category: 'common',
    filters: {
      fileExtensions: {
        mode: 'allowlist',
        extensions: [
          'pdf',
          'doc',
          'docx',
          'xls',
          'xlsx',
          'ppt',
          'pptx',
          'odt',
          'ods',
          'odp',
          'rtf',
        ],
      },
    },
  },
  {
    id: 'recent-content',
    name: 'Recent Content (Last 90 Days)',
    description:
      'Only sync documents modified in the last 90 days. Reduces sync time and storage for active content.',
    connectorTypes: [],
    category: 'performance',
    filters: {
      modifiedAfter: 'now-90d',
    },
  },
  {
    id: 'recent-content-1y',
    name: 'Last Year Content',
    description:
      'Only sync documents modified in the last year. Good balance between coverage and performance.',
    connectorTypes: [],
    category: 'performance',
    filters: {
      modifiedAfter: 'now-365d',
    },
  },
  {
    id: 'exclude-archives',
    name: 'Exclude Archive Folders',
    description:
      'Skip common archive, backup, and trash folder patterns. Reduces noise in search results.',
    connectorTypes: ['sharepoint'],
    category: 'common',
    filters: {
      folderPaths: {
        include: [],
        exclude: [
          '/Archive/**',
          '/Archived/**',
          '/Backup/**',
          '/Old/**',
          '/Trash/**',
          '/Recycle Bin/**',
        ],
      },
    },
  },
  {
    id: 'small-files-only',
    name: 'Skip Large Files (>50MB)',
    description:
      'Exclude files larger than 50MB. Large files are often media, CAD drawings, or data exports that are slow to process.',
    connectorTypes: [],
    category: 'performance',
    filters: {
      maxFileSizeBytes: 50 * 1024 * 1024,
    },
  },
  {
    id: 'text-searchable',
    name: 'Text-Searchable Documents',
    description:
      'Focus on documents that contain searchable text: Office docs, PDFs, text files, HTML, and Markdown.',
    connectorTypes: ['sharepoint'],
    category: 'common',
    filters: {
      fileExtensions: {
        mode: 'allowlist',
        extensions: [
          'pdf',
          'doc',
          'docx',
          'xls',
          'xlsx',
          'ppt',
          'pptx',
          'txt',
          'csv',
          'md',
          'html',
          'htm',
          'rtf',
          'xml',
          'json',
          'odt',
          'ods',
          'odp',
          'eml',
          'msg',
        ],
      },
    },
  },
  {
    id: 'exclude-media',
    name: 'Exclude Media Files',
    description:
      'Skip images, videos, and audio files. Useful when you only need document content for search.',
    connectorTypes: [],
    category: 'common',
    filters: {
      fileExtensions: {
        mode: 'denylist',
        extensions: [
          'jpg',
          'jpeg',
          'png',
          'gif',
          'bmp',
          'svg',
          'webp',
          'ico',
          'tiff',
          'tif',
          'mp4',
          'avi',
          'mov',
          'wmv',
          'flv',
          'mkv',
          'webm',
          'm4v',
          'mp3',
          'wav',
          'wma',
          'aac',
          'flac',
          'ogg',
          'm4a',
          'zip',
          'rar',
          '7z',
          'tar',
          'gz',
          'bz2',
        ],
      },
    },
  },
  {
    id: 'files-and-pages',
    name: 'Files and SharePoint Pages',
    description: 'Sync both document library files AND SharePoint site pages/news posts.',
    connectorTypes: ['sharepoint'],
    category: 'common',
    filters: {
      contentCategories: ['files', 'pages'],
    },
  },
];

// ─── Template Utilities ─────────────────────────────────────────────────

/**
 * Get templates applicable to a specific connector type.
 */
export function getTemplatesForConnector(connectorType: string): FilterTemplate[] {
  return FILTER_TEMPLATES.filter(
    (t) => t.connectorTypes.length === 0 || t.connectorTypes.includes(connectorType),
  );
}

/**
 * Get a template by ID.
 */
export function getTemplateById(id: string): FilterTemplate | undefined {
  return FILTER_TEMPLATES.find((t) => t.id === id);
}

/**
 * Resolve relative date expressions to absolute dates.
 *
 * Supported formats:
 * - "now-90d" → 90 days ago
 * - "now-1y" → 1 year ago
 * - "now-6m" → 6 months ago
 * - ISO date string → as-is
 */
export function resolveRelativeDate(expr: string): Date | null {
  if (!expr) return null;

  const relativeMatch = /^now-(\d+)([dmy])$/i.exec(expr);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const now = new Date();

    switch (unit) {
      case 'd':
        now.setDate(now.getDate() - amount);
        return now;
      case 'm':
        now.setMonth(now.getMonth() - amount);
        return now;
      case 'y':
        now.setFullYear(now.getFullYear() - amount);
        return now;
      default:
        return null;
    }
  }

  // Try parsing as ISO date
  const parsed = new Date(expr);
  return isNaN(parsed.getTime()) ? null : parsed;
}
