export type ReferenceKind = 'memory' | 'gather_field' | 'tool' | 'agent' | 'cel_var';

export interface ProjectAgentReferenceSource {
  name: string;
  dslContent: string;
}

export interface ProjectReference {
  kind: ReferenceKind;
  sourceAgent: string;
  targetAgent?: string;
  fieldName?: string;
  toolName?: string;
  variableName?: string;
  section?: string;
  evidence: string;
}

export interface ReferenceParseError {
  sourceAgent: string;
  message: string;
}

export interface ReferenceQueryResult {
  references: ProjectReference[];
  summary: string;
  parseErrors?: ReferenceParseError[];
}
