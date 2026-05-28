// Mongoose query/mutation surface that must always carry a tenant scope.
// The original ABLP-574 set covered only 5 methods; route handlers in this
// repo also use findOneAndUpdate, findOneAndDelete, findOneAndReplace,
// updateMany, deleteMany, replaceOne, countDocuments, count, distinct, and
// aggregate. A reviewer flagged the gap because those are exactly the
// patterns that mutate or fan-out reads, and missing them lets unscoped
// writes slip through the lint lane.
const TARGET_METHODS = new Set([
  // Reads
  'find',
  'findOne',
  'findById',
  'count',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'exists',
  'aggregate',
  // Single-doc mutations
  'updateOne',
  'replaceOne',
  'deleteOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'findOneAndRemove',
  'findByIdAndUpdate',
  'findByIdAndDelete',
  'findByIdAndRemove',
  // Multi-doc mutations
  'updateMany',
  'deleteMany',
  'remove',
  // Bulk
  'bulkWrite',
]);

const GLOBAL_OR_USER_SCOPED_MODELS = new Set([
  'Deal',
  'DebugToken',
  'EmailVerificationToken',
  'Organization',
  'OrgMember',
  'PasswordResetToken',
  'PublicApiKey',
  'RefreshToken',
  'Tenant',
  'TenantMember',
  'ToolTestEndpoint',
  'User',
  'WorkspaceInvitation',
]);

const PROJECT_JOIN_MODELS = new Set([
  'AgentOwnership',
  'AgentModelConfig',
  'ModelConfig',
  'Project',
  'ProjectAgent',
  'ProjectMember',
]);

const OWNERSHIP_KEYS = new Set(['createdBy', 'ownerId', 'tenantId', 'userId']);
const PROJECT_JOIN_HELPERS = [
  'findProjectByIdAndTenant(',
  'requireProjectAccess(',
  'requireProjectPermission(',
];
const PROJECT_QUERY_SNIPPETS = ['Project.find(', 'Project.findOne('];

function isDatabaseModule(moduleName) {
  return (
    moduleName === '@agent-platform/database' || moduleName === '@agent-platform/database/models'
  );
}

function isFunctionNode(node) {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression'
  );
}

function unwrapExpression(node) {
  if (!node) {
    return null;
  }

  switch (node.type) {
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
      return unwrapExpression(node.expression);
    case 'ChainExpression':
      return unwrapExpression(node.expression);
    default:
      return node;
  }
}

function getPropertyName(property) {
  if (property.type !== 'Property') {
    return null;
  }

  if (!property.computed && property.key.type === 'Identifier') {
    return property.key.name;
  }

  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value;
  }

  return null;
}

function objectHasKey(node, keyName) {
  const target = unwrapExpression(node);
  if (!target) {
    return false;
  }

  if (target.type === 'ObjectExpression') {
    return target.properties.some((property) => {
      if (property.type === 'Property') {
        if (getPropertyName(property) === keyName) {
          return true;
        }
        return objectHasKey(property.value, keyName);
      }

      if (property.type === 'SpreadElement') {
        return objectHasKey(property.argument, keyName);
      }

      return false;
    });
  }

  if (target.type === 'ArrayExpression') {
    return target.elements.some((element) => element && objectHasKey(element, keyName));
  }

  return false;
}

function objectHasAnyKey(node, keyNames) {
  return [...keyNames].some((keyName) => objectHasKey(node, keyName));
}

// When the filter is a variable reference (not an inline object literal), look
// up its declaration via the scope manager and return the initial object
// expression — plus any direct property assignments that add ownership keys
// later (`filter.tenantId = ...` or `filter['tenantId'] = ...`). This handles
// the common pattern of dynamically composing a filter object with conditional
// branches before passing it to the query.
function resolveIdentifierFilter(identifier, sourceCode) {
  const scope = sourceCode.getScope ? sourceCode.getScope(identifier) : null;
  if (!scope) {
    return null;
  }

  let currentScope = scope;
  let variable = null;
  while (currentScope && !variable) {
    variable = currentScope.variables.find((v) => v.name === identifier.name) ?? null;
    currentScope = currentScope.upper;
  }

  if (!variable || variable.defs.length === 0) {
    return null;
  }

  const def = variable.defs[0];
  if (def.type !== 'Variable') {
    return null;
  }

  // Recurse so that variables initialised with a ternary or builder call also
  // benefit from those handlers — `const filter = isAdmin ? {...} : {...}` is
  // a common pattern in this codebase.
  const resolvedInit = resolveFilterExpression(def.node?.init, sourceCode);
  if (resolvedInit?.type !== 'ObjectExpression') {
    return null;
  }

  // Clone properties so we can append synthesised ones from later assignments
  // without mutating the AST.
  const properties = [...resolvedInit.properties];
  for (const reference of variable.references) {
    if (reference.identifier === identifier) continue;
    const refNode = reference.identifier;
    const parent = refNode.parent;
    if (
      parent?.type === 'MemberExpression' &&
      parent.object === refNode &&
      parent.parent?.type === 'AssignmentExpression' &&
      parent.parent.left === parent &&
      parent.parent.operator === '='
    ) {
      const keyNode = parent.property;
      let keyName = null;
      if (!parent.computed && keyNode.type === 'Identifier') {
        keyName = keyNode.name;
      } else if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') {
        keyName = keyNode.value;
      }
      if (keyName) {
        properties.push({
          type: 'Property',
          key: { type: 'Identifier', name: keyName },
          value: parent.parent.right,
          computed: false,
          method: false,
          shorthand: false,
          kind: 'init',
        });
      }
    }
  }

  return {
    type: 'ObjectExpression',
    properties,
  };
}

function resolveFilterExpression(node, sourceCode) {
  const expression = unwrapExpression(node);
  if (!expression) {
    return null;
  }

  if (expression.type === 'ObjectExpression') {
    return expression;
  }

  if (expression.type === 'Identifier') {
    return resolveIdentifierFilter(expression, sourceCode);
  }

  // Ternary `isAdmin ? {...} : {...}` — accept only if BOTH branches are
  // ObjectExpressions; intersect their property keys (so a key only counts as
  // present if both branches supply it). Returning the synthesised object lets
  // downstream checks (ownership scope, project-join keys) inspect the
  // guaranteed-present keys without us re-implementing them here.
  if (expression.type === 'ConditionalExpression') {
    const consequent = unwrapExpression(expression.consequent);
    const alternate = unwrapExpression(expression.alternate);
    if (consequent?.type === 'ObjectExpression' && alternate?.type === 'ObjectExpression') {
      const altKeys = new Set(
        alternate.properties
          .map((prop) => (prop.type === 'Property' ? getPropertyName(prop) : null))
          .filter((key) => key !== null),
      );
      return {
        type: 'ObjectExpression',
        properties: consequent.properties.filter(
          (prop) => prop.type === 'Property' && altKeys.has(getPropertyName(prop) ?? ''),
        ),
      };
    }
    return null;
  }

  // `Model.find(buildFooFilter({ tenantId, projectId, ... }))` — peek at the
  // first ObjectExpression argument of the builder call. If it carries an
  // ownership key, treat the resulting filter as scoped. The builder function
  // is trusted to forward those keys into its return value.
  if (expression.type === 'CallExpression') {
    for (const arg of expression.arguments) {
      const argExpr = unwrapExpression(arg);
      if (argExpr?.type === 'ObjectExpression' && hasTenantOrOwnershipScope(argExpr)) {
        return argExpr;
      }
    }
    return null;
  }

  return null;
}

function getObjectPropertyValue(node, keyName) {
  const target = unwrapExpression(node);
  if (target?.type !== 'ObjectExpression') {
    return null;
  }

  for (const property of target.properties) {
    if (property.type === 'Property' && getPropertyName(property) === keyName) {
      return unwrapExpression(property.value);
    }
  }

  return null;
}

function hasTenantOrOwnershipScope(node) {
  return objectHasKey(node, 'tenantId') || objectHasAnyKey(node, OWNERSHIP_KEYS);
}

function getReturnedObjectFromMapCallback(callback) {
  if (!isFunctionNode(callback)) {
    return null;
  }

  const body = unwrapExpression(callback.body);
  if (body?.type === 'ObjectExpression') {
    return body;
  }

  if (body?.type !== 'BlockStatement') {
    return null;
  }

  for (const statement of body.body) {
    if (statement.type === 'ReturnStatement') {
      const returned = unwrapExpression(statement.argument);
      return returned?.type === 'ObjectExpression' ? returned : null;
    }
  }

  return null;
}

function resolveStaticArrayElements(node) {
  const expression = unwrapExpression(node);
  if (!expression) {
    return null;
  }

  if (expression.type === 'ArrayExpression') {
    return expression.elements.filter(Boolean).map(unwrapExpression);
  }

  if (
    expression.type === 'CallExpression' &&
    expression.callee.type === 'MemberExpression' &&
    !expression.callee.computed &&
    expression.callee.property.type === 'Identifier' &&
    expression.callee.property.name === 'map'
  ) {
    const returned = getReturnedObjectFromMapCallback(unwrapExpression(expression.arguments[0]));
    return returned ? [returned] : null;
  }

  return null;
}

function aggregateHasTenantScope(node) {
  const stages = resolveStaticArrayElements(node);
  const firstStage = stages?.[0];
  if (!firstStage || firstStage.type !== 'ObjectExpression') {
    return false;
  }

  const matchStage = getObjectPropertyValue(firstStage, '$match');
  return !!matchStage && hasTenantOrOwnershipScope(matchStage);
}

function bulkOperationHasTenantScope(operation) {
  if (!operation || operation.type !== 'ObjectExpression') {
    return false;
  }

  for (const property of operation.properties) {
    if (property.type !== 'Property') {
      return false;
    }

    const operationName = getPropertyName(property);
    const operationBody = unwrapExpression(property.value);
    if (operationBody?.type !== 'ObjectExpression') {
      return false;
    }

    if (operationName === 'insertOne') {
      const document = getObjectPropertyValue(operationBody, 'document');
      return !!document && hasTenantOrOwnershipScope(document);
    }

    if (
      operationName === 'updateOne' ||
      operationName === 'updateMany' ||
      operationName === 'deleteOne' ||
      operationName === 'deleteMany' ||
      operationName === 'replaceOne'
    ) {
      const filter = getObjectPropertyValue(operationBody, 'filter');
      return !!filter && hasTenantOrOwnershipScope(filter);
    }

    return false;
  }

  return false;
}

function bulkWriteHasTenantScope(node) {
  const operations = resolveStaticArrayElements(node);
  return !!operations?.length && operations.every(bulkOperationHasTenantScope);
}

function hasApprovedProjectJoin(node, sourceCode) {
  const enclosingFunction = [...sourceCode.getAncestors(node)].reverse().find(isFunctionNode);
  if (!enclosingFunction) {
    return false;
  }

  const functionText = sourceCode.getText(enclosingFunction);
  if (PROJECT_JOIN_HELPERS.some((helper) => functionText.includes(helper))) {
    return true;
  }

  return (
    PROJECT_QUERY_SNIPPETS.some((snippet) => functionText.includes(snippet)) &&
    functionText.includes('tenantId')
  );
}

function collectDynamicImportBindings(node, modelBindings) {
  if (node.id?.type !== 'ObjectPattern') {
    return;
  }

  const init = unwrapExpression(node.init);
  const importTarget =
    init?.type === 'AwaitExpression'
      ? unwrapExpression(init.argument)
      : init?.type === 'ImportExpression'
        ? init
        : null;

  if (
    importTarget?.type !== 'ImportExpression' ||
    importTarget.source.type !== 'Literal' ||
    typeof importTarget.source.value !== 'string' ||
    !isDatabaseModule(importTarget.source.value)
  ) {
    return;
  }

  for (const property of node.id.properties) {
    if (property.type === 'Property' && property.value.type === 'Identifier') {
      modelBindings.add(property.value.name);
    }
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require explicit tenantId on Studio Mongoose queries unless the model is global/user-scoped or uses an approved project-join pattern.',
    },
    schema: [],
    messages: {
      missingTenantId:
        'Studio server-side {{model}}.{{method}}() queries must include tenantId in the filter or use an approved project-join helper. Studio does not inject tenant scope via AsyncLocalStorage.',
      missingTenantIdFindById:
        'Studio server-side {{model}}.findById() is not allowed here because it cannot express tenantId. Use findOne({_id, tenantId}) or an approved project-join helper.',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    const modelBindings = new Set();

    return {
      ImportDeclaration(node) {
        if (!isDatabaseModule(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && /^[A-Z]/.test(specifier.local.name)) {
            modelBindings.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        collectDynamicImportBindings(node, modelBindings);
      },
      CallExpression(node) {
        if (node.callee.type !== 'MemberExpression' || node.callee.computed) {
          return;
        }

        const object = node.callee.object;
        const property = node.callee.property;
        if (object.type !== 'Identifier' || property.type !== 'Identifier') {
          return;
        }

        const modelName = object.name;
        const methodName = property.name;
        if (!modelBindings.has(modelName) || !TARGET_METHODS.has(methodName)) {
          return;
        }

        if (GLOBAL_OR_USER_SCOPED_MODELS.has(modelName)) {
          return;
        }

        if (methodName === 'findById' || methodName.startsWith('findByIdAnd')) {
          if (PROJECT_JOIN_MODELS.has(modelName) && hasApprovedProjectJoin(node, sourceCode)) {
            return;
          }
          context.report({
            node,
            messageId: 'missingTenantIdFindById',
            data: { model: modelName },
          });
          return;
        }

        if (methodName === 'estimatedDocumentCount') {
          context.report({
            node,
            messageId: 'missingTenantId',
            data: { model: modelName, method: methodName },
          });
          return;
        }

        if (methodName === 'aggregate') {
          if (aggregateHasTenantScope(node.arguments[0])) {
            return;
          }
          context.report({
            node,
            messageId: 'missingTenantId',
            data: { model: modelName, method: methodName },
          });
          return;
        }

        if (methodName === 'bulkWrite') {
          if (bulkWriteHasTenantScope(node.arguments[0])) {
            return;
          }
          context.report({
            node,
            messageId: 'missingTenantId',
            data: { model: modelName, method: methodName },
          });
          return;
        }

        const filterArgumentIndex = methodName === 'distinct' ? 1 : 0;
        const filter = resolveFilterExpression(node.arguments[filterArgumentIndex], sourceCode);
        if (!filter) {
          context.report({
            node,
            messageId: 'missingTenantId',
            data: { model: modelName, method: methodName },
          });
          return;
        }

        if (hasTenantOrOwnershipScope(filter)) {
          return;
        }

        if (
          PROJECT_JOIN_MODELS.has(modelName) &&
          (objectHasKey(filter, 'projectId') ||
            objectHasKey(filter, '_id') ||
            hasApprovedProjectJoin(node, sourceCode))
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'missingTenantId',
          data: { model: modelName, method: methodName },
        });
      },
    };
  },
};
