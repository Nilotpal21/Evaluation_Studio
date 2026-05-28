/**
 * Supervisor ABL Parser
 */

import { CstParser, IToken } from 'chevrotain';
import * as L from './lexer.js';
import type {
  SupervisorDocument,
  StateSchema,
  AgentRef,
  IntentMapping,
  Policy,
  CommunicationSettings,
  SupervisorBehavior,
} from '../types/supervisor.js';
import type { VariableDefinition, TypeDefinition } from '../types/base.js';
import type { Condition, Expression, ComparisonOperator } from '../types/expressions.js';
import { parseExpression, parseCondition } from './expression-parser.js';

export class SupervisorParser extends CstParser {
  constructor() {
    super(L.allTokens);
    this.performSelfAnalysis();
  }

  // Entry point for supervisor document
  public supervisorDocument = this.RULE('supervisorDocument', () => {
    this.CONSUME(L.SupervisorKeyword);
    this.CONSUME(L.Identifier); // name
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.stateSection) },
        { ALT: () => this.SUBRULE(this.agentsSection) },
        { ALT: () => this.SUBRULE(this.intentsSection) },
        { ALT: () => this.SUBRULE(this.policiesSection) },
        { ALT: () => this.SUBRULE(this.communicationSection) },
        { ALT: () => this.SUBRULE(this.behaviorSection) },
        { ALT: () => this.CONSUME2(L.NewLine) },
      ]);
    });
  });

  // STATE section
  private stateSection = this.RULE('stateSection', () => {
    this.CONSUME(L.StateKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.stateVariable);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Single state variable definition
  private stateVariable = this.RULE('stateVariable', () => {
    this.CONSUME(L.Identifier); // namespace
    this.CONSUME(L.Dot);
    this.CONSUME2(L.Identifier); // variable name
    this.CONSUME(L.Colon);
    this.SUBRULE(this.typeDefinition);
    this.OPTION(() => {
      this.CONSUME(L.Assignment);
      this.SUBRULE(this.literalValue);
    });
  });

  // Type definition (string, number, boolean, enum(...), etc.)
  private typeDefinition = this.RULE('typeDefinition', () => {
    this.OR([
      { ALT: () => this.CONSUME(L.StringType) },
      { ALT: () => this.CONSUME(L.NumberType) },
      { ALT: () => this.CONSUME(L.BooleanType) },
      { ALT: () => this.CONSUME(L.DateType) },
      { ALT: () => this.CONSUME(L.DatetimeType) },
      {
        ALT: () => {
          this.CONSUME(L.EnumType);
          this.CONSUME(L.LParen);
          this.AT_LEAST_ONE_SEP({
            SEP: L.Comma,
            DEF: () => this.CONSUME(L.Identifier),
          });
          this.CONSUME(L.RParen);
        },
      },
      {
        ALT: () => {
          this.CONSUME(L.ArrayType);
        },
      },
    ]);
    // Optional nullable marker
    this.OPTION(() => this.CONSUME(L.Question));
  });

  // Literal value
  private literalValue = this.RULE('literalValue', () => {
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      { ALT: () => this.CONSUME(L.True) },
      { ALT: () => this.CONSUME(L.False) },
      { ALT: () => this.CONSUME(L.Null) },
    ]);
  });

  // AGENTS section
  private agentsSection = this.RULE('agentsSection', () => {
    this.CONSUME(L.AgentsKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.agentRef);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Agent reference
  private agentRef = this.RULE('agentRef', () => {
    this.CONSUME(L.Identifier); // alias
    this.CONSUME(L.Colon);
    this.CONSUME(L.StringLiteral); // file path
    this.OPTION(() => {
      this.CONSUME(L.LBracket);
      this.AT_LEAST_ONE_SEP({
        SEP: L.Comma,
        DEF: () => this.CONSUME2(L.Identifier), // capabilities
      });
      this.CONSUME(L.RBracket);
    });
  });

  // Condition expression
  private condition = this.RULE('condition', () => {
    this.OR([
      { ALT: () => this.CONSUME(L.Asterisk) }, // Wildcard
      { ALT: () => this.SUBRULE(this.booleanExpression) },
    ]);
  });

  // Boolean expression
  private booleanExpression = this.RULE('booleanExpression', () => {
    this.SUBRULE(this.andExpression);
    this.MANY(() => {
      this.CONSUME(L.Or);
      this.SUBRULE2(this.andExpression);
    });
  });

  // AND expression
  private andExpression = this.RULE('andExpression', () => {
    this.SUBRULE(this.unaryExpression);
    this.MANY(() => {
      this.CONSUME(L.And);
      this.SUBRULE2(this.unaryExpression);
    });
  });

  // Unary expression (NOT, EXISTS)
  private unaryExpression = this.RULE('unaryExpression', () => {
    this.OPTION(() => this.CONSUME(L.Not));
    this.SUBRULE(this.comparisonExpression);
  });

  // Comparison expression
  private comparisonExpression = this.RULE('comparisonExpression', () => {
    this.SUBRULE(this.primaryExpression);
    this.OPTION(() => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(L.Is);
            this.OPTION2(() => this.CONSUME(L.Not));
            this.CONSUME(L.Set);
          },
        },
        {
          ALT: () => {
            this.OR2([
              { ALT: () => this.CONSUME(L.Equals) },
              { ALT: () => this.CONSUME(L.NotEquals) },
              { ALT: () => this.CONSUME(L.GreaterThan) },
              { ALT: () => this.CONSUME(L.LessThan) },
              { ALT: () => this.CONSUME(L.GreaterThanOrEqual) },
              { ALT: () => this.CONSUME(L.LessThanOrEqual) },
              { ALT: () => this.CONSUME(L.In) },
              { ALT: () => this.CONSUME(L.Contains) },
              { ALT: () => this.CONSUME(L.Matches) },
            ]);
            this.SUBRULE2(this.primaryExpression);
          },
        },
      ]);
    });
  });

  // Primary expression
  private primaryExpression = this.RULE('primaryExpression', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(L.LParen);
          this.SUBRULE(this.booleanExpression);
          this.CONSUME(L.RParen);
        },
      },
      { ALT: () => this.SUBRULE(this.variableRef) },
      { ALT: () => this.SUBRULE(this.literalValue) },
    ]);
  });

  // Variable reference (e.g., user.is_validated)
  private variableRef = this.RULE('variableRef', () => {
    this.CONSUME(L.Identifier);
    this.MANY(() => {
      this.CONSUME(L.Dot);
      this.CONSUME2(L.Identifier);
    });
  });

  // INTENTS section
  private intentsSection = this.RULE('intentsSection', () => {
    this.CONSUME(L.IntentsKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.intentMapping);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Intent mapping
  private intentMapping = this.RULE('intentMapping', () => {
    this.CONSUME(L.LBracket);
    this.AT_LEAST_ONE_SEP({
      SEP: L.Comma,
      DEF: () => this.CONSUME(L.Identifier),
    });
    this.CONSUME(L.RBracket);
    this.CONSUME(L.Arrow);
    this.CONSUME2(L.Identifier); // agent name
  });

  // POLICIES section
  private policiesSection = this.RULE('policiesSection', () => {
    this.CONSUME(L.PoliciesKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.policy);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Single policy
  private policy = this.RULE('policy', () => {
    this.CONSUME(L.Identifier); // policy name
    this.CONSUME(L.Colon);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.policyRule);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Policy rule
  private policyRule = this.RULE('policyRule', () => {
    this.CONSUME(L.Identifier); // rule type (allowed_when, forbidden_when, etc.)
    this.CONSUME(L.Colon);
    // Use the condition which can parse simple identifiers, string literals,
    // and complex boolean expressions - this avoids ambiguity
    this.SUBRULE(this.policyRuleValue);
  });

  // Policy rule value - handles simple values and conditions
  private policyRuleValue = this.RULE('policyRuleValue', () => {
    this.OR([
      // Asterisk wildcard
      { ALT: () => this.CONSUME(L.Asterisk) },
      // Simple string literal
      { ALT: () => this.CONSUME(L.StringLiteral) },
      // Boolean literals
      { ALT: () => this.CONSUME(L.True) },
      { ALT: () => this.CONSUME(L.False) },
      // Number literal
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      // Identifier or variable reference (can be simple or dotted)
      { ALT: () => this.SUBRULE(this.variableRef) },
    ]);
  });

  // COMMUNICATION section
  private communicationSection = this.RULE('communicationSection', () => {
    this.CONSUME(L.CommunicationKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.communicationSetting);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Communication setting
  private communicationSetting = this.RULE('communicationSetting', () => {
    this.CONSUME(L.Identifier); // setting name
    this.CONSUME(L.Colon);
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      { ALT: () => this.CONSUME2(L.Identifier) },
      {
        ALT: () => {
          this.CONSUME(L.LBracket);
          this.AT_LEAST_ONE_SEP({
            SEP: L.Comma,
            DEF: () => this.CONSUME2(L.StringLiteral),
          });
          this.CONSUME(L.RBracket);
        },
      },
    ]);
  });

  // BEHAVIOR section
  private behaviorSection = this.RULE('behaviorSection', () => {
    this.CONSUME(L.BehaviorKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.behaviorSetting);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Behavior setting
  private behaviorSetting = this.RULE('behaviorSetting', () => {
    this.CONSUME(L.Identifier); // setting name
    this.CONSUME(L.Colon);
    this.OR([
      { ALT: () => this.CONSUME(L.True) },
      { ALT: () => this.CONSUME(L.False) },
      {
        ALT: () => {
          this.CONSUME(L.LBracket);
          this.OPTION(() => {
            this.AT_LEAST_ONE_SEP({
              SEP: L.Comma,
              DEF: () => this.CONSUME(L.StringLiteral),
            });
          });
          this.CONSUME(L.RBracket);
        },
      },
    ]);
  });
}

// Create singleton parser instance
const parserInstance = new SupervisorParser();

// Helper to get token image
function getTokenImage(token: IToken | undefined): string {
  return token?.image ?? '';
}

// Helper to extract string literal value (remove quotes)
function extractStringLiteral(token: IToken | undefined): string {
  if (!token) return '';
  const img = token.image;
  return img.slice(1, -1); // Remove surrounding quotes
}

// Helper to check if CST node has children
function hasChildren(node: any, key: string): boolean {
  return (
    node && node.children && Array.isArray(node.children[key]) && node.children[key].length > 0
  );
}

// Helper to get first child of type
function getFirst(node: any, key: string): any {
  if (hasChildren(node, key)) {
    return node.children[key][0];
  }
  return undefined;
}

// Helper to get all children of type
function getAll(node: any, key: string): any[] {
  if (hasChildren(node, key)) {
    return node.children[key];
  }
  return [];
}

/**
 * CST Visitor to build SupervisorDocument from parsed CST
 */
class SupervisorCstVisitor {
  visit(cst: any): SupervisorDocument {
    return this.visitSupervisorDocument(cst);
  }

  private visitSupervisorDocument(ctx: any): SupervisorDocument {
    const nameToken = getFirst(ctx, 'Identifier');
    const name = getTokenImage(nameToken);

    const now = new Date();
    const doc: SupervisorDocument = {
      meta: {
        id: crypto.randomUUID(),
        kind: 'supervisor',
        version: '1.0.0',
        name,
        createdAt: now,
        updatedAt: now,
      },
      state: {},
      agents: [],
      routing: [],
      policies: [],
      communication: {
        language: 'en',
        formality: 'neutral',
        constraints: [],
      },
      behavior: {
        canRespondDirectly: false,
        allowedDirectActions: [],
        forbiddenActions: [],
      },
    };

    // Process sections
    for (const section of getAll(ctx, 'stateSection')) {
      doc.state = this.visitStateSection(section);
    }

    for (const section of getAll(ctx, 'agentsSection')) {
      doc.agents = this.visitAgentsSection(section);
    }

    for (const section of getAll(ctx, 'intentsSection')) {
      doc.intents = this.visitIntentsSection(section);
    }

    for (const section of getAll(ctx, 'policiesSection')) {
      doc.policies = this.visitPoliciesSection(section);
    }

    for (const section of getAll(ctx, 'communicationSection')) {
      doc.communication = this.visitCommunicationSection(section);
    }

    for (const section of getAll(ctx, 'behaviorSection')) {
      doc.behavior = this.visitBehaviorSection(section);
    }

    return doc;
  }

  private visitStateSection(ctx: any): StateSchema {
    const state: StateSchema = {};

    for (const varCtx of getAll(ctx, 'stateVariable')) {
      const identifiers = getAll(varCtx, 'Identifier');
      if (identifiers.length >= 2) {
        const namespace = getTokenImage(identifiers[0]);
        const varName = getTokenImage(identifiers[1]);

        if (!state[namespace]) {
          state[namespace] = {};
        }

        const typeDef = getFirst(varCtx, 'typeDefinition');
        const typeInfo = this.visitTypeDefinition(typeDef);

        const varDef: VariableDefinition = {
          name: varName,
          type: typeInfo.type,
          required: !typeInfo.nullable,
        };

        // Check for default value
        const literalVal = getFirst(varCtx, 'literalValue');
        if (literalVal) {
          varDef.default = this.visitLiteralValue(literalVal);
        }

        state[namespace][varName] = varDef;
      }
    }

    return state;
  }

  private visitTypeDefinition(ctx: any): { type: TypeDefinition; nullable: boolean } {
    if (!ctx || !ctx.children) return { type: 'string', nullable: false };

    let type: TypeDefinition = 'string';
    const nullable = hasChildren(ctx, 'Question');

    if (hasChildren(ctx, 'StringType')) type = 'string';
    else if (hasChildren(ctx, 'NumberType')) type = 'number';
    else if (hasChildren(ctx, 'BooleanType')) type = 'boolean';
    else if (hasChildren(ctx, 'DateType')) type = 'date';
    else if (hasChildren(ctx, 'DatetimeType')) type = 'datetime';
    else if (hasChildren(ctx, 'ArrayType')) type = { kind: 'array', itemType: 'string' };
    else if (hasChildren(ctx, 'EnumType')) {
      const enumValues = getAll(ctx, 'Identifier').map((t: IToken) => getTokenImage(t));
      type = { kind: 'enum', values: enumValues };
    }

    return { type, nullable };
  }

  private visitLiteralValue(ctx: any): any {
    if (!ctx || !ctx.children) return null;

    if (hasChildren(ctx, 'StringLiteral')) {
      return extractStringLiteral(getFirst(ctx, 'StringLiteral'));
    }
    if (hasChildren(ctx, 'NumberLiteral')) {
      return parseFloat(getTokenImage(getFirst(ctx, 'NumberLiteral')));
    }
    if (hasChildren(ctx, 'True')) return true;
    if (hasChildren(ctx, 'False')) return false;
    if (hasChildren(ctx, 'Null')) return null;

    return null;
  }

  private visitAgentsSection(ctx: any): AgentRef[] {
    const agents: AgentRef[] = [];

    for (const agentCtx of getAll(ctx, 'agentRef')) {
      const alias = getTokenImage(getFirst(agentCtx, 'Identifier'));
      const ref = extractStringLiteral(getFirst(agentCtx, 'StringLiteral'));

      // Get capabilities from remaining identifiers (after the first one which is the alias)
      const allIdentifiers = getAll(agentCtx, 'Identifier');
      const capabilities = allIdentifiers.slice(1).map((t: IToken) => getTokenImage(t));

      agents.push({
        ref,
        alias,
        capabilities,
      });
    }

    return agents;
  }

  private visitCondition(ctx: any): Condition {
    if (!ctx || !ctx.children) {
      return { kind: 'boolean', value: true };
    }

    // Wildcard
    if (hasChildren(ctx, 'Asterisk')) {
      return { kind: 'wildcard' };
    }

    // Boolean expression
    const boolExpr = getFirst(ctx, 'booleanExpression');
    if (boolExpr) {
      return this.visitBooleanExpression(boolExpr);
    }

    return { kind: 'boolean', value: true };
  }

  private visitBooleanExpression(ctx: any): Condition {
    const andExprs = getAll(ctx, 'andExpression');

    if (andExprs.length === 0) {
      return { kind: 'boolean', value: true };
    }

    if (andExprs.length === 1) {
      return this.visitAndExpression(andExprs[0]);
    }

    // Multiple OR'd expressions - chain them with binary OR
    let result = this.visitAndExpression(andExprs[0]);
    for (let i = 1; i < andExprs.length; i++) {
      result = {
        kind: 'binary',
        operator: 'or',
        left: result,
        right: this.visitAndExpression(andExprs[i]),
      };
    }
    return result;
  }

  private visitAndExpression(ctx: any): Condition {
    const unaryExprs = getAll(ctx, 'unaryExpression');

    if (unaryExprs.length === 0) {
      return { kind: 'boolean', value: true };
    }

    if (unaryExprs.length === 1) {
      return this.visitUnaryExpression(unaryExprs[0]);
    }

    // Multiple AND'd expressions - chain them with binary AND
    let result = this.visitUnaryExpression(unaryExprs[0]);
    for (let i = 1; i < unaryExprs.length; i++) {
      result = {
        kind: 'binary',
        operator: 'and',
        left: result,
        right: this.visitUnaryExpression(unaryExprs[i]),
      };
    }
    return result;
  }

  private visitUnaryExpression(ctx: any): Condition {
    const hasNot = hasChildren(ctx, 'Not');
    const compExpr = getFirst(ctx, 'comparisonExpression');
    const inner = this.visitComparisonExpression(compExpr);

    if (hasNot) {
      return { kind: 'unary', operator: 'not', operand: inner };
    }

    return inner;
  }

  private visitComparisonExpression(ctx: any): Condition {
    const primaryExprs = getAll(ctx, 'primaryExpression');

    if (primaryExprs.length === 0) {
      return { kind: 'boolean', value: true };
    }

    const left = this.visitPrimaryExpression(primaryExprs[0]);

    // Check for IS SET / IS NOT SET
    if (hasChildren(ctx, 'Is')) {
      const isNotSet = hasChildren(ctx, 'Not');
      return {
        kind: 'unary',
        operator: isNotSet ? 'empty' : 'exists',
        operand: left,
      };
    }

    // Check for comparison operators
    let operator: ComparisonOperator | null = null;
    if (hasChildren(ctx, 'Equals')) operator = '==';
    else if (hasChildren(ctx, 'NotEquals')) operator = '!=';
    else if (hasChildren(ctx, 'GreaterThan')) operator = '>';
    else if (hasChildren(ctx, 'LessThan')) operator = '<';
    else if (hasChildren(ctx, 'GreaterThanOrEqual')) operator = '>=';
    else if (hasChildren(ctx, 'LessThanOrEqual')) operator = '<=';
    else if (hasChildren(ctx, 'In')) operator = 'in';
    else if (hasChildren(ctx, 'Contains')) operator = 'contains';
    else if (hasChildren(ctx, 'Matches')) operator = 'matches';

    if (operator && primaryExprs.length >= 2) {
      const right = this.visitPrimaryExpression(primaryExprs[1]);
      return {
        kind: 'binary',
        operator,
        left,
        right,
      };
    }

    // Just return the primary expression as a condition
    // A variable by itself means "exists"
    if (left.kind === 'variable') {
      return {
        kind: 'unary',
        operator: 'exists',
        operand: left,
      };
    }

    return left;
  }

  private visitPrimaryExpression(ctx: any): Expression {
    if (!ctx || !ctx.children) {
      return { kind: 'null' };
    }

    // Parenthesized expression
    const boolExpr = getFirst(ctx, 'booleanExpression');
    if (boolExpr) {
      return this.visitBooleanExpression(boolExpr);
    }

    // Variable reference
    const varRef = getFirst(ctx, 'variableRef');
    if (varRef) {
      return this.visitVariableRef(varRef);
    }

    // Literal value
    const literal = getFirst(ctx, 'literalValue');
    if (literal) {
      return this.visitLiteralValueAsExpression(literal);
    }

    return { kind: 'null' };
  }

  private visitVariableRef(ctx: any): Expression {
    const identifiers = getAll(ctx, 'Identifier');
    const path = identifiers.map((t: IToken) => getTokenImage(t));
    return { kind: 'variable', path };
  }

  private visitLiteralValueAsExpression(ctx: any): Expression {
    if (!ctx || !ctx.children) return { kind: 'null' };

    if (hasChildren(ctx, 'StringLiteral')) {
      return { kind: 'string', value: extractStringLiteral(getFirst(ctx, 'StringLiteral')) };
    }
    if (hasChildren(ctx, 'NumberLiteral')) {
      return { kind: 'number', value: parseFloat(getTokenImage(getFirst(ctx, 'NumberLiteral'))) };
    }
    if (hasChildren(ctx, 'True')) return { kind: 'boolean', value: true };
    if (hasChildren(ctx, 'False')) return { kind: 'boolean', value: false };
    if (hasChildren(ctx, 'Null')) return { kind: 'null' };

    return { kind: 'null' };
  }

  private visitIntentsSection(ctx: any): IntentMapping[] {
    const mappings: IntentMapping[] = [];

    for (const mapCtx of getAll(ctx, 'intentMapping')) {
      const identifiers = getAll(mapCtx, 'Identifier');
      // All but the last identifier are intent names, last one is the agent
      const intents = identifiers.slice(0, -1).map((t: IToken) => getTokenImage(t));
      const agentName = getTokenImage(identifiers[identifiers.length - 1]);

      mappings.push({
        intents,
        action: { kind: 'route_to_agent', agent: agentName },
      });
    }

    return mappings;
  }

  private visitPoliciesSection(ctx: any): Policy[] {
    const policies: Policy[] = [];

    for (const policyCtx of getAll(ctx, 'policy')) {
      const name = getTokenImage(getFirst(policyCtx, 'Identifier'));
      const rules: Policy['rules'] = {};

      for (const ruleCtx of getAll(policyCtx, 'policyRule')) {
        const ruleName = getTokenImage(getFirst(ruleCtx, 'Identifier'));
        const valueCtx = getFirst(ruleCtx, 'policyRuleValue');

        if (ruleName === 'allowed_when' || ruleName === 'allowedWhen') {
          rules.allowedWhen = this.visitPolicyRuleValueAsCondition(valueCtx);
        } else if (ruleName === 'forbidden_when' || ruleName === 'forbiddenWhen') {
          rules.forbiddenWhen = this.visitPolicyRuleValueAsCondition(valueCtx);
        } else if (ruleName === 'trigger_signal' || ruleName === 'triggerSignal') {
          rules.triggerSignal = this.visitPolicyRuleValueAsString(valueCtx);
        }
      }

      policies.push({ name, rules });
    }

    return policies;
  }

  private visitPolicyRuleValueAsCondition(ctx: any): Condition {
    if (!ctx || !ctx.children) {
      return { kind: 'boolean', value: true };
    }

    const varRef = getFirst(ctx, 'variableRef');
    if (varRef) {
      const expr = this.visitVariableRef(varRef);
      return {
        kind: 'unary',
        operator: 'exists',
        operand: expr,
      };
    }

    return { kind: 'boolean', value: true };
  }

  private visitPolicyRuleValueAsString(ctx: any): string {
    if (!ctx || !ctx.children) return '';

    if (hasChildren(ctx, 'StringLiteral')) {
      return extractStringLiteral(getFirst(ctx, 'StringLiteral'));
    }

    const varRef = getFirst(ctx, 'variableRef');
    if (varRef) {
      const identifiers = getAll(varRef, 'Identifier');
      return identifiers.map((t: IToken) => getTokenImage(t)).join('.');
    }

    return '';
  }

  private visitCommunicationSection(ctx: any): CommunicationSettings {
    const settings: CommunicationSettings = {
      language: 'en',
      formality: 'neutral',
      constraints: [],
    };

    for (const settingCtx of getAll(ctx, 'communicationSetting')) {
      const name = getTokenImage(getFirst(settingCtx, 'Identifier'));

      if (hasChildren(settingCtx, 'StringLiteral')) {
        const value = extractStringLiteral(getFirst(settingCtx, 'StringLiteral'));
        if (name === 'language') settings.language = value;
      } else {
        const identifiers = getAll(settingCtx, 'Identifier');
        if (identifiers.length >= 2) {
          const value = getTokenImage(identifiers[1]);
          if (name === 'formality') settings.formality = value as any;
        }
      }
    }

    return settings;
  }

  private visitBehaviorSection(ctx: any): SupervisorBehavior {
    const behavior: SupervisorBehavior = {
      canRespondDirectly: false,
      allowedDirectActions: [],
      forbiddenActions: [],
    };

    for (const settingCtx of getAll(ctx, 'behaviorSetting')) {
      const name = getTokenImage(getFirst(settingCtx, 'Identifier'));

      if (hasChildren(settingCtx, 'True')) {
        if (name === 'can_respond_directly') behavior.canRespondDirectly = true;
      } else if (hasChildren(settingCtx, 'False')) {
        if (name === 'can_respond_directly') behavior.canRespondDirectly = false;
      } else if (hasChildren(settingCtx, 'LBracket')) {
        const strings = getAll(settingCtx, 'StringLiteral');
        const values = strings.map((t: IToken) => extractStringLiteral(t));
        if (name === 'allowed_actions') behavior.allowedDirectActions = values;
        if (name === 'forbidden_actions') behavior.forbiddenActions = values;
      }
    }

    return behavior;
  }
}

// Singleton visitor
const supervisorVisitor = new SupervisorCstVisitor();

/**
 * Parse supervisor ABL text to document
 */
export function parseSupervisor(text: string): {
  document: SupervisorDocument | null;
  errors: Array<{ message: string; line?: number; column?: number }>;
} {
  const { tokens, errors: lexErrors } = L.tokenize(text);

  if (lexErrors.length > 0) {
    return {
      document: null,
      errors: lexErrors.map((e) => ({
        message: e.message,
        line: e.line,
        column: e.column,
      })),
    };
  }

  parserInstance.input = tokens;
  const cst = parserInstance.supervisorDocument();

  if (parserInstance.errors.length > 0) {
    return {
      document: null,
      errors: parserInstance.errors.map((e) => ({
        message: L.formatParserError(text, e),
        line: e.token?.startLine,
        column: e.token?.startColumn,
      })),
    };
  }

  // Use the CST visitor to build the document
  const document = supervisorVisitor.visit(cst);

  return { document, errors: [] };
}
