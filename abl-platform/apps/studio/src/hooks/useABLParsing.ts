/**
 * ABL Parsing Hook
 *
 * Provides parse, compile, and save functionality for the ABL editor.
 * Uses the language service diagnostics route for tiered validation.
 */

import { useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { useEditorStore } from '../store/editor-store';
import { sanitizeError } from '../lib/sanitize-error';
import { apiFetch } from '../lib/api-client';
import type { Diagnostic } from '@abl/language-service';

const DEBOUNCE_MS = 500;
const DIAGNOSTICS_DEBOUNCE_MS = 1000;

interface DiagnosticsResponse {
  success: boolean;
  diagnostics: Diagnostic[];
  error?: string;
}

interface CompileResponse {
  success: boolean;
  ir?: unknown;
  errors: string[];
  error?: string;
}

interface SaveResponse {
  success: boolean;
  savedPath?: string;
  error?: string;
}

function buildCompilePath(projectId?: string, agentName?: string): string {
  if (projectId && agentName) {
    return `/api/projects/${projectId}/agents/${encodeURIComponent(agentName)}/compile`;
  }

  return '/api/abl/compile';
}

export function useABLParsing(projectId?: string, agentName?: string) {
  const {
    dslContent,
    currentFilePath,
    setParseErrors,
    setParseWarnings,
    setIsParsingLive,
    setCompiledIR,
    setCompileErrors,
    setIsCompiling,
    setIsSaving,
    setSaveError,
    setDiagnostics,
    markSaved,
  } = useEditorStore();

  const parseTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const diagnosticsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Parse ABL content via the diagnostics route (Tier 2).
   */
  const parseABL = useCallback(
    async (content: string) => {
      if (!content.trim()) {
        setParseErrors([]);
        setParseWarnings([]);
        setDiagnostics([]);
        return;
      }

      setIsParsingLive(true);

      try {
        const response = await apiFetch('/api/abl/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dsl: content, tier: 2 }),
        });

        const result: DiagnosticsResponse = await response.json();

        const diagnostics = result.diagnostics ?? [];
        setDiagnostics(diagnostics);

        // Map diagnostics to ParseError format for backward compatibility
        const errors = diagnostics
          .filter((d) => d.severity === 'error')
          .map((d) => ({ line: d.line, column: d.column, message: d.message }));
        const warnings = diagnostics
          .filter((d) => d.severity === 'warning')
          .map((d) => ({ line: d.line, column: d.column, message: d.message }));

        setParseErrors(errors);
        setParseWarnings(warnings);
      } catch (error) {
        if (process.env.NODE_ENV === 'development')
          console.error('[useABLParsing] Parse error:', error);
        setParseErrors([
          {
            line: 1,
            column: 1,
            message: sanitizeError(error, 'Failed to parse ABL'),
          },
        ]);
      } finally {
        setIsParsingLive(false);
      }
    },
    [setParseErrors, setParseWarnings, setIsParsingLive, setDiagnostics],
  );

  /**
   * Fetch Tier 2 diagnostics from the language service.
   * Catches errors silently — diagnostics are advisory, not critical.
   */
  const fetchDiagnostics = useCallback(
    async (content: string) => {
      if (!content.trim()) {
        setDiagnostics([]);
        return;
      }

      try {
        const response = await apiFetch('/api/abl/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dsl: content }),
        });

        const result: DiagnosticsResponse = await response.json();
        setDiagnostics(result.diagnostics ?? []);
      } catch {
        // Diagnostics are advisory — silently ignore errors
      }
    },
    [setDiagnostics],
  );

  /**
   * Debounced live diagnostics fetch - runs on a separate 1s debounce
   */
  const fetchDiagnosticsLive = useCallback(
    (content: string) => {
      if (diagnosticsTimeoutRef.current) {
        clearTimeout(diagnosticsTimeoutRef.current);
      }

      diagnosticsTimeoutRef.current = setTimeout(() => {
        fetchDiagnostics(content);
      }, DIAGNOSTICS_DEBOUNCE_MS);
    },
    [fetchDiagnostics],
  );

  /**
   * Debounced live parsing - call this on content change
   */
  const parseLive = useCallback(
    (content: string) => {
      if (parseTimeoutRef.current) {
        clearTimeout(parseTimeoutRef.current);
      }

      parseTimeoutRef.current = setTimeout(() => {
        parseABL(content);
      }, DEBOUNCE_MS);

      // Also trigger diagnostics on a separate, longer debounce
      fetchDiagnosticsLive(content);
    },
    [parseABL, fetchDiagnosticsLive],
  );

  /**
   * Compile ABL to IR (also runs Tier 3 diagnostics)
   */
  const compileABL = useCallback(async () => {
    if (!dslContent.trim()) {
      setCompileErrors(['No ABL content to compile']);
      return;
    }

    setIsCompiling(true);
    setCompileErrors([]);
    setCompiledIR(null);

    try {
      // Run Tier 3 diagnostics
      const diagResponse = await apiFetch('/api/abl/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dsl: dslContent,
          tier: 3,
          ...(projectId && { projectId }),
          ...(agentName && { agentName }),
        }),
      });
      const diagResult: DiagnosticsResponse = await diagResponse.json();
      setDiagnostics(diagResult.diagnostics ?? []);

      // Also run full compile for IR output
      const response = await apiFetch(buildCompilePath(projectId, agentName), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          projectId && agentName
            ? { dsl: dslContent }
            : { dsl: dslContent, ...(projectId && { projectId }) },
        ),
      });

      const result: CompileResponse = await response.json();

      if (result.success && result.ir) {
        setCompiledIR(result.ir);
        setCompileErrors([]);
        toast.success('Compilation successful');
      } else {
        const errors = result.errors || [result.error || 'Compilation failed'];
        setCompileErrors(errors);
        setCompiledIR(null);
        toast.error(`Compilation failed: ${errors[0]}`);
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development')
        console.error('[useABLParsing] Compile error:', error);
      const msg = sanitizeError(error, 'Failed to compile ABL');
      setCompileErrors([msg]);
      toast.error(msg);
    } finally {
      setIsCompiling(false);
    }
  }, [
    agentName,
    dslContent,
    projectId,
    setIsCompiling,
    setCompileErrors,
    setCompiledIR,
    setDiagnostics,
  ]);

  /**
   * Save ABL to file
   */
  const saveABL = useCallback(async () => {
    if (!currentFilePath) {
      setSaveError('No file path specified');
      return false;
    }

    if (!dslContent.trim()) {
      setSaveError('No ABL content to save');
      return false;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const response = await apiFetch('/api/abl/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: currentFilePath,
          dsl: dslContent,
        }),
      });

      const result: SaveResponse = await response.json();

      if (result.success) {
        markSaved();
        return true;
      } else {
        setSaveError(result.error || 'Failed to save file');
        return false;
      }
    } catch (error) {
      if (process.env.NODE_ENV === 'development')
        console.error('[useABLParsing] Save error:', error);
      setSaveError(sanitizeError(error, 'Failed to save ABL'));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [currentFilePath, dslContent, setIsSaving, setSaveError, markSaved]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (parseTimeoutRef.current) {
        clearTimeout(parseTimeoutRef.current);
      }
      if (diagnosticsTimeoutRef.current) {
        clearTimeout(diagnosticsTimeoutRef.current);
      }
    };
  }, []);

  return {
    parseABL,
    parseLive,
    fetchDiagnosticsLive,
    compileABL,
    saveABL,
  };
}
