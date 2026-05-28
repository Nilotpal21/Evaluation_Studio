export interface GQLVar {
  name: string;
  type: string;
  required: boolean;
  isList: boolean;
}

// Matches the first operation signature in a document: query/mutation/subscription OpName($var: ...)
// Known limitation: only the first operation is parsed. Multi-operation documents are not
// supported in the Shopify canvas — the run() handler sends a single operation per request.
const OP_SIGNATURE_RE = /(?:query|mutation|subscription)\s+\w*\s*\(([^)]*)\)/;

// Matches both scalar ($var: Type!) and list ($var: [Type!]!) variable declarations.
// Groups: 1=varName, 2=listItemType (if list), 3=scalarType (if scalar), 4=outer non-null (!)
const VAR_RE = /\$(\w+)\s*:\s*(?:\[([A-Za-z_]\w*)!?\]|([A-Za-z_]\w*))(!?)/g;

/**
 * Extracts variable declarations from a GraphQL operation definition.
 * Only reads the operation signature — not every $var usage in the body.
 */
export function parseVariableDeclarations(query: string): GQLVar[] {
  const match = OP_SIGNATURE_RE.exec(query);
  if (!match) return [];

  const vars: GQLVar[] = [];
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(match[1])) !== null) {
    const isList = m[2] !== undefined;
    vars.push({
      name: m[1],
      type: isList ? m[2] : m[3],
      required: m[4] === '!',
      isList,
    });
  }
  return vars;
}

/**
 * Returns all variable names referenced in the query body (after stripping
 * the operation signature). Used to detect undeclared variable usage.
 */
export function findUsedVariables(query: string): string[] {
  const body = query.replace(OP_SIGNATURE_RE, '');
  return [...body.matchAll(/\$(\w+)/g)].map((m) => m[1]);
}
