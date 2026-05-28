import { createHash } from 'crypto';
import type { CompilerOptions } from '@abl/compiler';
import { compileABLtoIR } from '@abl/compiler';
import { parseAgentBasedABL, type AgentBasedDocument } from '@abl/core';
import { computeSourceHash } from '@agent-platform/shared';
import {
  buildAgentCompanionHashInput,
  type AgentPromptLibraryRefSnapshot,
} from './agent-companion-metadata.js';

export type ProjectAgentDraftValidationStatus = 'valid' | 'warning' | 'error';

export interface ProjectAgentDraftState {
  recordName: string;
  dslContent: string | null;
  systemPromptLibraryRef?: AgentPromptLibraryRefSnapshot | null;
}

export interface ProjectAgentDraftDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  source: string;
}

export interface ProjectAgentDraftRecordDiagnostics {
  errors?: readonly string[];
  warnings?: readonly string[];
}

export interface ProjectAgentDraftMetadata {
  recordName: string;
  declaredName?: string;
  sourceHash: string | null;
  dslValidationStatus: ProjectAgentDraftValidationStatus | null;
  dslDiagnostics: ProjectAgentDraftDiagnostic[];
  errors: string[];
  warnings: string[];
}

export interface EvaluateProjectAgentDraftMetadataInput {
  agents: readonly ProjectAgentDraftState[];
  compilerOptions?: CompilerOptions;
  contextDocuments?: readonly AgentBasedDocument[];
  contextErrors?: readonly string[];
  contextWarnings?: readonly string[];
  recordDiagnostics?: ReadonlyMap<string, ProjectAgentDraftRecordDiagnostics>;
  diagnosticSource: string;
}

export interface ProjectAgentDeclaredNameValidation {
  ok: boolean;
  code?: 'AGENT_DSL_NAME_MISMATCH';
  recordName: string;
  declaredName?: string;
  message?: string;
}

export interface ProjectAgentDeclaredNameRewrite {
  ok: boolean;
  code?: 'AGENT_DSL_NAME_MISMATCH';
  recordName: string;
  declaredName?: string;
  message?: string;
  dslContent?: string | null;
}

interface MutableProjectAgentDraftMetadata {
  recordName: string;
  declaredName?: string;
  sourceHash: string | null;
  errors: string[];
  warnings: string[];
  names: Set<string>;
  document?: AgentBasedDocument;
  hasDslContent: boolean;
}

interface CompilationMessage {
  agent?: string;
  message: string;
  referenced_agent?: string;
}

interface ProjectAgentDraftHashInput {
  recordName: string;
  dslContent: string | null;
  systemPromptLibraryRef?: unknown;
}

function hasDslContent(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableStringifyHashPayload(value: Record<string, unknown>): string {
  return JSON.stringify(value, (_key, currentValue) =>
    currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
      ? Object.fromEntries(Object.entries(currentValue as Record<string, unknown>).sort())
      : currentValue,
  );
}

function buildProjectAgentDraftHashContent(input: ProjectAgentDraftHashInput): string | null {
  if (!hasDslContent(input.dslContent)) {
    return null;
  }

  const companionHashInput = buildAgentCompanionHashInput({
    systemPromptLibraryRef: input.systemPromptLibraryRef ?? null,
  });
  if (!companionHashInput) {
    return input.dslContent;
  }

  return stableStringifyHashPayload({
    dslContent: input.dslContent,
    companion: companionHashInput,
  });
}

function computeTruncatedSourceHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export function computeProjectAgentDraftSourceHash(
  input: ProjectAgentDraftHashInput,
): string | null {
  const hashContent = buildProjectAgentDraftHashContent(input);
  if (!hashContent) {
    return null;
  }

  return computeSourceHash(hashContent);
}

export function computeProjectAgentDraftArtifactSourceHash(
  input: ProjectAgentDraftHashInput,
): string | null {
  const hashContent = buildProjectAgentDraftHashContent(input);
  if (!hashContent) {
    return null;
  }

  return computeTruncatedSourceHash(hashContent);
}

function formatParseIssue(issue: { line?: number; message: string }): string {
  return `Line ${issue.line ?? '?'}: ${issue.message}`;
}

export function validateProjectAgentDraftDeclaredName(input: {
  recordName: string;
  dslContent: string | null;
}): ProjectAgentDeclaredNameValidation {
  if (!hasDslContent(input.dslContent)) {
    return { ok: true, recordName: input.recordName };
  }

  const parseResult = parseAgentBasedABL(input.dslContent);
  const declaredName = parseResult.document?.name;
  if (!declaredName) {
    return { ok: true, recordName: input.recordName };
  }

  if (declaredName === input.recordName) {
    return { ok: true, recordName: input.recordName, declaredName };
  }

  return {
    ok: false,
    code: 'AGENT_DSL_NAME_MISMATCH',
    recordName: input.recordName,
    declaredName,
    message: `Agent DSL declares "${declaredName}" but this record is "${input.recordName}". Use the rename flow to change agent identity.`,
  };
}

export function rewriteProjectAgentDraftDeclaredName(input: {
  recordName: string;
  nextName: string;
  dslContent: string | null;
}): ProjectAgentDeclaredNameRewrite {
  if (!hasDslContent(input.dslContent)) {
    return { ok: true, recordName: input.recordName, dslContent: input.dslContent };
  }

  const validation = validateProjectAgentDraftDeclaredName({
    recordName: input.recordName,
    dslContent: input.dslContent,
  });
  if (!validation.ok) {
    return {
      ...validation,
      ok: false,
      dslContent: input.dslContent,
    };
  }

  if (!validation.declaredName) {
    return { ok: true, recordName: input.recordName, dslContent: input.dslContent };
  }

  const nextName = input.nextName.trim();
  const headerPattern = /^(\s*(?:AGENT|SUPERVISOR):\s*)(["']?)([^\s"']+)(\2)(.*)$/im;
  const dslContent = input.dslContent.replace(
    headerPattern,
    (_match, prefix: string, quote: string, _name: string, closingQuote: string, suffix: string) =>
      `${prefix}${quote}${nextName}${closingQuote}${suffix}`,
  );

  return {
    ok: true,
    recordName: input.recordName,
    declaredName: validation.declaredName,
    dslContent,
  };
}

function pushUnique(target: string[], message: string): void {
  if (!target.includes(message)) {
    target.push(message);
  }
}

function formatCompilationMessage(entry: CompilationMessage, defaultAgentName: string): string {
  return `${entry.agent ?? defaultAgentName}: ${entry.message}`;
}

function shouldAssignCompilationMessage(
  metadata: MutableProjectAgentDraftMetadata,
  entry: CompilationMessage,
): boolean {
  if (!entry.agent) {
    return true;
  }

  if (metadata.names.has(entry.agent)) {
    return true;
  }

  return typeof entry.referenced_agent === 'string' && metadata.names.has(entry.referenced_agent);
}

function toDraftDiagnostics(input: {
  diagnosticSource: string;
  errors: readonly string[];
  warnings: readonly string[];
}): ProjectAgentDraftDiagnostic[] {
  return [
    ...input.errors.map((message) => ({
      severity: 'error' as const,
      message,
      source: input.diagnosticSource,
    })),
    ...input.warnings.map((message) => ({
      severity: 'warning' as const,
      message,
      source: input.diagnosticSource,
    })),
  ];
}

export function evaluateProjectAgentDraftMetadata(
  input: EvaluateProjectAgentDraftMetadataInput,
): Map<string, ProjectAgentDraftMetadata> {
  const metadataByRecord = new Map<string, MutableProjectAgentDraftMetadata>();
  const declaredNameOwners = new Map<string, string[]>();
  const compilableDocuments: AgentBasedDocument[] = [];

  for (const agent of input.agents) {
    const metadata: MutableProjectAgentDraftMetadata = {
      recordName: agent.recordName,
      sourceHash: computeProjectAgentDraftSourceHash(agent),
      errors: [],
      warnings: [],
      names: new Set([agent.recordName]),
      hasDslContent: hasDslContent(agent.dslContent),
    };

    metadataByRecord.set(agent.recordName, metadata);

    if (!hasDslContent(agent.dslContent)) {
      continue;
    }

    const parseResult = parseAgentBasedABL(agent.dslContent);
    if (!parseResult.document?.name) {
      for (const issue of parseResult.errors ?? []) {
        pushUnique(metadata.errors, formatParseIssue(issue));
      }
      if (metadata.errors.length === 0) {
        pushUnique(metadata.errors, `Agent "${agent.recordName}" is missing a valid agent header.`);
      }
      continue;
    }

    metadata.document = parseResult.document;
    metadata.declaredName = parseResult.document.name;

    const declaredNameValidation = validateProjectAgentDraftDeclaredName({
      recordName: agent.recordName,
      dslContent: agent.dslContent,
    });
    if (!declaredNameValidation.ok) {
      metadata.document = undefined;
      pushUnique(
        metadata.errors,
        declaredNameValidation.message ??
          `Agent DSL declares "${declaredNameValidation.declaredName}" but this record is "${agent.recordName}".`,
      );
      for (const issue of parseResult.errors ?? []) {
        pushUnique(metadata.warnings, formatParseIssue(issue));
      }
      for (const issue of parseResult.warnings ?? []) {
        pushUnique(metadata.warnings, formatParseIssue(issue));
      }
      continue;
    }

    metadata.names.add(parseResult.document.name);
    compilableDocuments.push(parseResult.document);

    for (const issue of parseResult.errors ?? []) {
      pushUnique(metadata.warnings, formatParseIssue(issue));
    }
    for (const issue of parseResult.warnings ?? []) {
      pushUnique(metadata.warnings, formatParseIssue(issue));
    }

    declaredNameOwners.set(parseResult.document.name, [
      ...(declaredNameOwners.get(parseResult.document.name) ?? []),
      agent.recordName,
    ]);
  }

  let hasDuplicateDeclaredNames = false;
  for (const [declaredName, owners] of declaredNameOwners.entries()) {
    if (owners.length < 2) {
      continue;
    }
    hasDuplicateDeclaredNames = true;
    const ownerList = owners.join(', ');
    for (const owner of owners) {
      const metadata = metadataByRecord.get(owner);
      if (!metadata) {
        continue;
      }
      pushUnique(
        metadata.errors,
        `Agent name "${declaredName}" is declared by multiple drafts: ${ownerList}.`,
      );
    }
  }

  const activeMetadata = [...metadataByRecord.values()].filter((entry) => entry.hasDslContent);
  for (const [recordName, diagnostics] of input.recordDiagnostics?.entries() ?? []) {
    const metadata = metadataByRecord.get(recordName);
    if (!metadata) {
      continue;
    }

    for (const message of diagnostics.errors ?? []) {
      pushUnique(metadata.errors, message);
    }
    for (const message of diagnostics.warnings ?? []) {
      pushUnique(metadata.warnings, message);
    }
  }

  for (const message of input.contextErrors ?? []) {
    for (const metadata of activeMetadata) {
      pushUnique(metadata.errors, message);
    }
  }
  for (const message of input.contextWarnings ?? []) {
    for (const metadata of activeMetadata) {
      pushUnique(metadata.warnings, message);
    }
  }

  if (
    compilableDocuments.length + (input.contextDocuments?.length ?? 0) > 0 &&
    !hasDuplicateDeclaredNames &&
    (input.contextErrors?.length ?? 0) === 0
  ) {
    try {
      const output = compileABLtoIR(
        [...compilableDocuments, ...(input.contextDocuments ?? [])],
        input.compilerOptions,
      );
      const compilationErrors = (output.compilation_errors ?? []) as CompilationMessage[];
      const compilationWarnings = (output.compilation_warnings ?? []) as CompilationMessage[];

      for (const metadata of activeMetadata) {
        if (!metadata.document) {
          continue;
        }
        const defaultAgentName = metadata.declaredName ?? metadata.recordName;
        for (const entry of compilationErrors) {
          if (shouldAssignCompilationMessage(metadata, entry)) {
            pushUnique(metadata.errors, formatCompilationMessage(entry, defaultAgentName));
          }
        }
        for (const entry of compilationWarnings) {
          if (shouldAssignCompilationMessage(metadata, entry)) {
            pushUnique(metadata.warnings, formatCompilationMessage(entry, defaultAgentName));
          }
        }
      }
    } catch (error) {
      const message = `Project draft compilation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      for (const metadata of activeMetadata) {
        pushUnique(metadata.errors, message);
      }
    }
  }

  return new Map(
    [...metadataByRecord.entries()].map(([recordName, metadata]) => {
      const status: ProjectAgentDraftValidationStatus | null = metadata.hasDslContent
        ? metadata.errors.length > 0
          ? 'error'
          : metadata.warnings.length > 0
            ? 'warning'
            : 'valid'
        : null;

      return [
        recordName,
        {
          recordName,
          declaredName: metadata.declaredName,
          sourceHash: metadata.sourceHash,
          dslValidationStatus: status,
          dslDiagnostics: toDraftDiagnostics({
            diagnosticSource: input.diagnosticSource,
            errors: metadata.errors,
            warnings: metadata.warnings,
          }),
          errors: [...metadata.errors],
          warnings: [...metadata.warnings],
        },
      ];
    }),
  );
}
