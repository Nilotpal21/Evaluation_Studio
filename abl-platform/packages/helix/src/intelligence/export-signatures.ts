import { Node, Project, ts, type ExportedDeclarations } from 'ts-morph';

const MAX_INTERFACE_PROPERTIES = 3;
const MAX_ENUM_MEMBERS = 4;
const MAX_SIGNATURE_CHARS = 140;

export function extractExportSignatures(filePath: string, content: string): Record<string, string> {
  if (!content.trim()) {
    return {};
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  });
  const sourceFile = project.createSourceFile(filePath, content, { overwrite: true });
  const signatures: Record<string, string> = {};

  for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) {
    const signature = declarations
      .map((declaration) => buildExportSignature(exportName, declaration))
      .find((candidate) => Boolean(candidate));
    if (signature) {
      signatures[exportName] = signature;
    }
  }

  return signatures;
}

function buildExportSignature(
  exportName: string,
  declaration: ExportedDeclarations,
): string | undefined {
  if (Node.isFunctionDeclaration(declaration)) {
    const displayName = declaration.getName() ?? exportName;
    return truncateSignature(
      `${exportName === 'default' ? 'default ' : ''}function ${displayName}${formatParameters(declaration.getParameters().map((parameter) => parameter.getText()))}${formatReturnType(declaration.getReturnTypeNode()?.getText())}`,
    );
  }

  if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (
      initializer &&
      (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
    ) {
      return truncateSignature(
        `const ${declaration.getName()}${formatParameters(initializer.getParameters().map((parameter) => parameter.getText()))}${formatReturnType(initializer.getReturnTypeNode()?.getText())}`,
      );
    }

    const typeText = declaration.getType().getBaseTypeOfLiteralType().getText(declaration);
    return truncateSignature(`const ${declaration.getName()}: ${normalizeWhitespace(typeText)}`);
  }

  if (Node.isClassDeclaration(declaration)) {
    const displayName = declaration.getName() ?? 'default';
    const extendsClause = declaration.getExtends()?.getText();
    const implementsClause = declaration.getImplements().map((entry) => entry.getText());
    return truncateSignature(
      [
        `${exportName === 'default' ? 'default ' : ''}class ${displayName}`,
        extendsClause ? `extends ${normalizeWhitespace(extendsClause)}` : undefined,
        implementsClause.length > 0
          ? `implements ${implementsClause.map(normalizeWhitespace).join(', ')}`
          : undefined,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  if (Node.isInterfaceDeclaration(declaration)) {
    const properties = declaration
      .getProperties()
      .slice(0, MAX_INTERFACE_PROPERTIES)
      .map((property) => normalizeWhitespace(property.getText().replace(/;$/, '')));
    const remainder = declaration.getProperties().length - properties.length;
    return truncateSignature(
      `interface ${declaration.getName()} { ${properties.join('; ')}${remainder > 0 ? `; +${remainder} more` : ''} }`,
    );
  }

  if (Node.isTypeAliasDeclaration(declaration)) {
    return truncateSignature(
      `type ${declaration.getName()} = ${normalizeWhitespace(declaration.getTypeNode()?.getText() ?? declaration.getType().getText(declaration))}`,
    );
  }

  if (Node.isEnumDeclaration(declaration)) {
    const members = declaration
      .getMembers()
      .slice(0, MAX_ENUM_MEMBERS)
      .map((member) => member.getName());
    const remainder = declaration.getMembers().length - members.length;
    return truncateSignature(
      `enum ${declaration.getName()} { ${members.join(', ')}${remainder > 0 ? `, +${remainder} more` : ''} }`,
    );
  }

  return truncateSignature(normalizeWhitespace(stripExportKeyword(declaration.getText())));
}

function formatParameters(parameters: string[]): string {
  return `(${parameters.map(normalizeWhitespace).join(', ')})`;
}

function formatReturnType(returnType: string | undefined): string {
  const normalized = returnType ? normalizeWhitespace(returnType) : '';
  return normalized ? `: ${normalized}` : '';
}

function stripExportKeyword(value: string): string {
  return value.replace(/^export\s+default\s+/, 'default ').replace(/^export\s+/, '');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateSignature(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized.length <= MAX_SIGNATURE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_SIGNATURE_CHARS - 3)}...`;
}
