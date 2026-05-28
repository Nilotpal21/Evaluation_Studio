/**
 * File Extension Registry
 *
 * Three-layer file extension filtering:
 * 1. Platform denylist — never sync (executables, binaries) — non-configurable
 * 2. Connector defaults — sensible allowlist per connector type — overridable
 * 3. User configuration — custom allowlist or denylist — full control
 *
 * Evaluation: platform denylist always wins → user config → connector defaults.
 */

// ─── Platform Denylist (Never Sync) ─────────────────────────────────────

/**
 * Extensions that are NEVER synced regardless of user configuration.
 * Security-sensitive executables, binaries, and system files.
 */
const PLATFORM_DENYLIST: ReadonlySet<string> = new Set([
  // Executables
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'msi',
  'msp',
  'scr',
  'cpl',
  'inf',
  'reg',
  'ps1',
  'vbs',
  'wsf',
  'ws',
  // Compiled binaries
  'sys',
  'drv',
  'ocx',
  'class',
  'jar',
  'pyc',
  'pyo',
  'so',
  'dylib',
  'o',
  'obj',
  'lib',
  'a',
  // Disk images & installers
  'iso',
  'img',
  'dmg',
  'deb',
  'rpm',
  'apk',
  'ipa',
  // Potentially malicious
  'lnk',
  'pif',
  'application',
  'hta',
  'crt',
  'cer',
]);

// ─── Connector Defaults ─────────────────────────────────────────────────

/**
 * Default supported extensions per connector type.
 * Used when user doesn't configure any file extension filters.
 */
const CONNECTOR_DEFAULTS: Record<string, ReadonlySet<string>> = {
  sharepoint: new Set([
    // Documents
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
    // Text
    'txt',
    'csv',
    'tsv',
    'rtf',
    'md',
    'markdown',
    'rst',
    'log',
    // Web
    'html',
    'htm',
    'xhtml',
    'xml',
    'json',
    'yaml',
    'yml',
    // Code (for documentation)
    'sql',
    // Email
    'eml',
    'msg',
  ]),
  // Future connectors can add their own defaults
  jira: new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'png', 'jpg', 'jpeg']),
  confluence: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'html']),
};

// ─── Types ──────────────────────────────────────────────────────────────

export interface FileExtensionConfig {
  /** Filtering mode: allowlist includes only listed extensions, denylist excludes listed extensions */
  mode: 'allowlist' | 'denylist';
  /** Extensions to include or exclude (without leading dot) */
  extensions: string[];
}

export interface FileExtensionCheckResult {
  allowed: boolean;
  reason?: string;
  /** Which layer blocked/allowed: 'platform_denylist' | 'user_config' | 'connector_default' */
  source: 'platform_denylist' | 'user_config' | 'connector_default';
}

// ─── Registry ───────────────────────────────────────────────────────────

export class FileExtensionRegistry {
  private readonly connectorType: string;
  private readonly userConfig: FileExtensionConfig | null;
  private readonly connectorDefaults: ReadonlySet<string>;

  constructor(connectorType: string, userConfig?: FileExtensionConfig) {
    this.connectorType = connectorType;
    this.userConfig = userConfig ?? null;
    this.connectorDefaults = CONNECTOR_DEFAULTS[connectorType] ?? new Set();
  }

  /**
   * Check if a file extension is allowed.
   *
   * Evaluation order:
   * 1. Platform denylist (always wins, blocks dangerous files)
   * 2. User configuration (if provided, overrides connector defaults)
   * 3. Connector defaults (fallback when no user config)
   */
  check(filenameOrExtension: string): FileExtensionCheckResult {
    const ext = this.extractExtension(filenameOrExtension);

    // No extension — allow (some SharePoint items have no extension)
    if (!ext) {
      return { allowed: true, source: 'connector_default' };
    }

    // Layer 1: Platform denylist (always blocks)
    if (PLATFORM_DENYLIST.has(ext)) {
      return {
        allowed: false,
        reason: `Extension '.${ext}' is blocked by platform security policy`,
        source: 'platform_denylist',
      };
    }

    // Layer 2: User configuration (if provided)
    if (this.userConfig && this.userConfig.extensions.length > 0) {
      const normalizedUserExtensions = new Set(
        this.userConfig.extensions.map((e) => e.toLowerCase().replace(/^\./, '')),
      );

      if (this.userConfig.mode === 'allowlist') {
        if (normalizedUserExtensions.has(ext)) {
          return { allowed: true, source: 'user_config' };
        }
        return {
          allowed: false,
          reason: `Extension '.${ext}' not in user allowlist`,
          source: 'user_config',
        };
      } else {
        // denylist mode
        if (normalizedUserExtensions.has(ext)) {
          return {
            allowed: false,
            reason: `Extension '.${ext}' is in user denylist`,
            source: 'user_config',
          };
        }
        return { allowed: true, source: 'user_config' };
      }
    }

    // Layer 3: Connector defaults (no user config → use defaults)
    if (this.connectorDefaults.size > 0) {
      if (this.connectorDefaults.has(ext)) {
        return { allowed: true, source: 'connector_default' };
      }
      return {
        allowed: false,
        reason: `Extension '.${ext}' not in default supported types for ${this.connectorType}`,
        source: 'connector_default',
      };
    }

    // No defaults configured — allow everything not in platform denylist
    return { allowed: true, source: 'connector_default' };
  }

  /**
   * Extract normalized extension from filename or raw extension string.
   * Returns lowercase extension without dot, or empty string if none.
   */
  private extractExtension(input: string): string {
    const trimmed = input.trim().toLowerCase();

    // If input contains a dot, extract extension from filename
    const lastDot = trimmed.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < trimmed.length - 1) {
      return trimmed.slice(lastDot + 1);
    }

    // If input has no dot, treat it as a raw extension
    if (trimmed.length > 0 && !trimmed.includes('/') && !trimmed.includes('\\')) {
      return trimmed.replace(/^\./, '');
    }

    return '';
  }

  /**
   * Get the effective extension list (for display/debugging).
   */
  getEffectiveConfig(): {
    platformDenylist: string[];
    connectorDefaults: string[];
    userConfig: FileExtensionConfig | null;
  } {
    return {
      platformDenylist: [...PLATFORM_DENYLIST].sort(),
      connectorDefaults: [...this.connectorDefaults].sort(),
      userConfig: this.userConfig,
    };
  }
}
