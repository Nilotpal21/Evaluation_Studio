# SDLC Log: abl-lsp — Phase 3: HLD

- **Date**: 2026-03-23
- **Phase**: High-Level Design
- **Artifact**: `docs/specs/abl-lsp.hld.md`
- **Status**: COMPLETE

## Architecture Decisions

### ADR-1: Three-Layer Architecture (Editor → Protocol → Service)

- **Decision**: Maintain the existing three-layer separation
- **Rationale**: Already implemented and working. `@abl/language-service` is editor-agnostic (pure functions), `@abl/lsp-server` adapts to LSP protocol, `kore-abl` is VS Code-specific. Studio already imports language-service directly.
- **Alternatives rejected**: In-process service (ties to VS Code), single monolithic package (loses reusability)

### ADR-2: Adapter Pattern for LSP Type Conversion

- **Decision**: Keep dedicated adapter files per feature (diagnostics, completions, symbols, hover)
- **Rationale**: Clean separation of concerns. 1-based vs 0-based position conversion is isolated. String enums to numeric enums mapping is centralized.
- **Impact**: New features (go-to-definition, references, code actions) each get their own adapter file

### ADR-3: CompileFn Injection for Tier 3 Diagnostics

- **Decision**: Keep the existing injection pattern rather than bundling @abl/compiler
- **Rationale**: @abl/compiler has heavy dependencies (CEL runtime, platform constructs). Injection keeps language-service lightweight (~50KB vs ~2MB bundled compiler).
- **Trade-off**: Tier 3 diagnostics not available in standalone VS Code unless user configures a compile command

### ADR-4: Workspace Scanner with Regex Extraction

- **Decision**: Keep regex-based agent/tool name extraction instead of full parse
- **Rationale**: Full parsing each workspace file would be slow (100 files x parse time). Regex extraction for `agent:` and `tools:` lines is fast and sufficient for completions.
- **Trade-off**: Won't catch all edge cases (e.g., agent name in a comment)

### ADR-5: Configuration via VS Code Settings

- **Decision**: Add `abl.*` settings in extension contributes.configuration, read via LSP workspace/configuration
- **Rationale**: Standard VS Code pattern. Users expect feature toggles in Settings UI.
- **Impact**: Requires changes to both extension (contributes) and LSP server (configuration handler)

## Cross-Cutting Concerns Addressed

All 12 concerns from the design-quality-gate skill are addressed:

1. Performance — debounce, caching, MAX_FILES cap
2. Error Handling — try-catch at every boundary
3. Extensibility — registry pattern for keywords, functions, completions
4. Security — no eval, no network, no credentials, file extension filtering
5. Observability — output channel, structured logging, source tags
6. Testing — three-tier strategy (unit, integration, E2E)
7. Deployment — esbuild bundling, vsce packaging, standalone binary
8. Backward Compatibility — dual format support, auto-detection
9. Configuration — VS Code settings with LSP workspace/configuration
10. Internationalization — deferred but architecture supports it
11. Accessibility — VS Code built-in, TextMate scopes map to themes
12. Data Model — all in-memory, bounded, lifecycle-managed

## Audit Findings

- No critical findings
- HLD grounded in actual package structure, existing code, and tested patterns
