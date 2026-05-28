/**
 * Agent ABL Parser
 */

import { CstParser, IToken, tokenMatcher } from 'chevrotain';
import * as L from './lexer.js';
import type {
  AgentDocument,
  AgentIdentity,
  AgentContract,
  ToolDefinition,
  ToolParameter,
  Step,
  StepAction,
  Flow,
  Guardrail,
  TestCase,
  CallToolAction,
  RespondAction,
  WaitInputAction,
  GotoAction,
  SignalAction,
  SetStateAction,
  ClassifyIntentAction,
} from '../types/agent.js';
import type { TypeDefinition } from '../types/base.js';
import type { Expression } from '../types/expressions.js';
import { parseExpression } from './expression-parser.js';

export class AgentParser extends CstParser {
  constructor() {
    super(L.allTokens);
    this.performSelfAnalysis();
  }

  // Entry point for agent document
  public agentDocument = this.RULE('agentDocument', () => {
    this.CONSUME(L.AgentKeyword);
    this.CONSUME(L.Identifier); // name
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.identitySection) },
        { ALT: () => this.SUBRULE(this.contractSection) },
        { ALT: () => this.SUBRULE(this.toolsSection) },
        { ALT: () => this.SUBRULE(this.stepsSection) },
        { ALT: () => this.SUBRULE(this.guardrailsSection) },
        { ALT: () => this.SUBRULE(this.testsSection) },
        { ALT: () => this.CONSUME2(L.NewLine) },
      ]);
    });
  });

  // IDENTITY section
  private identitySection = this.RULE('identitySection', () => {
    this.CONSUME(L.IdentityKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.identityProperty);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Identity property
  private identityProperty = this.RULE('identityProperty', () => {
    this.CONSUME(L.Identifier); // property name (role, persona, expertise, limitations)
    this.CONSUME(L.Colon);
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      {
        ALT: () => {
          this.CONSUME(L.LBracket);
          this.OPTION(() => {
            this.AT_LEAST_ONE_SEP({
              SEP: L.Comma,
              DEF: () => this.CONSUME2(L.StringLiteral),
            });
          });
          this.CONSUME(L.RBracket);
        },
      },
    ]);
  });

  // CONTRACT section
  private contractSection = this.RULE('contractSection', () => {
    this.CONSUME(L.ContractKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.contractProperty);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Contract property
  private contractProperty = this.RULE('contractProperty', () => {
    this.CONSUME(L.Identifier); // inputs, outputs
    this.CONSUME(L.Colon);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.contractField);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Contract field
  private contractField = this.RULE('contractField', () => {
    this.CONSUME(L.Identifier); // field name
    this.CONSUME(L.Colon);
    this.SUBRULE(this.typeDefinition);
    this.OPTION(() => {
      this.CONSUME(L.Assignment);
      this.SUBRULE(this.literalValue);
    });
  });

  // Type definition
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
          this.CONSUME(L.LBrace);
          this.MANY_SEP({
            SEP: L.Comma,
            DEF: () => {
              this.CONSUME2(L.Identifier);
              this.CONSUME(L.Colon);
              this.SUBRULE(this.typeDefinition);
            },
          });
          this.CONSUME(L.RBrace);
        },
      },
      { ALT: () => this.CONSUME(L.ArrayType) },
    ]);
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

  // TOOLS section
  private toolsSection = this.RULE('toolsSection', () => {
    this.CONSUME(L.ToolsKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.toolDefinition);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Tool definition
  private toolDefinition = this.RULE('toolDefinition', () => {
    this.CONSUME(L.Identifier); // tool name
    this.CONSUME(L.LParen);
    this.OPTION(() => {
      this.AT_LEAST_ONE_SEP({
        SEP: L.Comma,
        DEF: () => this.SUBRULE(this.toolParameter),
      });
    });
    this.CONSUME(L.RParen);
    this.CONSUME(L.Arrow);
    this.SUBRULE(this.typeDefinition);
    this.CONSUME(L.NewLine);

    // Optional tool properties - use GATE to check next token is Identifier followed by Colon (not LParen)
    this.MANY({
      GATE: () => {
        // Look ahead: tool property is Identifier:value, tool definition is Identifier(...)
        const la1 = this.LA(1);
        const la2 = this.LA(2);
        return tokenMatcher(la1, L.Identifier) && tokenMatcher(la2, L.Colon);
      },
      DEF: () => {
        this.SUBRULE(this.toolProperty);
        this.OPTION2(() => this.CONSUME2(L.NewLine));
      },
    });
  });

  // Tool parameter
  private toolParameter = this.RULE('toolParameter', () => {
    this.CONSUME(L.Identifier); // param name
    this.CONSUME(L.Colon);
    this.SUBRULE(this.typeDefinition);
    this.OPTION(() => {
      this.CONSUME(L.Assignment);
      this.SUBRULE(this.literalValue);
    });
  });

  // Tool property
  private toolProperty = this.RULE('toolProperty', () => {
    this.CONSUME(L.Identifier); // description, on_failure, cacheable, etc.
    this.CONSUME(L.Colon);
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      { ALT: () => this.CONSUME(L.True) },
      { ALT: () => this.CONSUME(L.False) },
      {
        ALT: () => {
          this.CONSUME2(L.Identifier);
          this.OPTION(() => {
            this.CONSUME(L.LParen);
            this.CONSUME3(L.NumberLiteral);
            this.CONSUME(L.RParen);
          });
        },
      },
    ]);
  });

  // STEPS section
  private stepsSection = this.RULE('stepsSection', () => {
    this.CONSUME(L.StepsKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.stepDefinition);
    });
  });

  // Step definition
  private stepDefinition = this.RULE('stepDefinition', () => {
    // Step number (e.g., "1.", "1.1.", "2.")
    this.OR([
      { ALT: () => this.CONSUME(L.StepNumber) },
      { ALT: () => this.CONSUME(L.NumberLiteral) },
    ]);
    this.CONSUME(L.Dot);
    this.CONSUME(L.Identifier); // step name
    this.CONSUME(L.NewLine);

    // Step actions
    this.MANY(() => {
      this.SUBRULE(this.stepAction);
    });
  });

  // Step action
  private stepAction = this.RULE('stepAction', () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.callAction) },
      { ALT: () => this.SUBRULE(this.respondAction) },
      { ALT: () => this.SUBRULE(this.waitInputAction) },
      { ALT: () => this.SUBRULE(this.gotoAction) },
      { ALT: () => this.SUBRULE(this.signalAction) },
      { ALT: () => this.SUBRULE(this.setAction) },
      { ALT: () => this.SUBRULE(this.classifyAction) },
      { ALT: () => this.SUBRULE(this.onSuccessAction) },
      { ALT: () => this.SUBRULE(this.onFailureAction) },
      { ALT: () => this.CONSUME(L.NewLine) },
    ]);
  });

  // CALL action
  private callAction = this.RULE('callAction', () => {
    this.CONSUME(L.Call);
    this.CONSUME(L.Identifier); // tool name
    this.CONSUME(L.LParen);
    this.OPTION(() => {
      this.AT_LEAST_ONE_SEP({
        SEP: L.Comma,
        DEF: () => this.SUBRULE(this.expression),
      });
    });
    this.CONSUME(L.RParen);
    this.OPTION2(() => this.CONSUME(L.NewLine));
  });

  // RESPOND action
  private respondAction = this.RULE('respondAction', () => {
    this.CONSUME(L.Respond);
    this.CONSUME(L.StringLiteral);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // WAIT_INPUT action
  private waitInputAction = this.RULE('waitInputAction', () => {
    this.CONSUME(L.WaitInput);
    this.OPTION(() => this.CONSUME(L.NewLine));

    this.MANY(() => {
      this.SUBRULE(this.waitInputRoute);
    });
  });

  // Wait input route
  private waitInputRoute = this.RULE('waitInputRoute', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(L.Positive);
          this.CONSUME(L.Arrow);
          this.OR2([
            { ALT: () => this.CONSUME(L.NumberLiteral) },
            { ALT: () => this.CONSUME(L.Identifier) },
          ]);
        },
      },
      {
        ALT: () => {
          this.CONSUME2(L.Negative);
          this.CONSUME2(L.Arrow);
          this.OR3([
            { ALT: () => this.CONSUME2(L.NumberLiteral) },
            { ALT: () => this.CONSUME2(L.Identifier) },
          ]);
        },
      },
      {
        ALT: () => {
          this.CONSUME(L.Default);
          this.CONSUME3(L.Arrow);
          this.OR4([
            { ALT: () => this.CONSUME3(L.NumberLiteral) },
            { ALT: () => this.CONSUME3(L.Identifier) },
          ]);
        },
      },
      {
        ALT: () => {
          this.CONSUME(L.Pattern);
          this.CONSUME(L.LParen);
          this.CONSUME(L.StringLiteral);
          this.CONSUME(L.RParen);
          this.CONSUME4(L.Arrow);
          this.OR5([
            { ALT: () => this.CONSUME4(L.NumberLiteral) },
            { ALT: () => this.CONSUME4(L.Identifier) },
          ]);
        },
      },
      {
        ALT: () => {
          this.CONSUME(L.MaxAttempts);
          this.CONSUME(L.Colon);
          this.CONSUME5(L.NumberLiteral);
          this.CONSUME5(L.Arrow);
          this.OR6([
            { ALT: () => this.CONSUME6(L.NumberLiteral) },
            { ALT: () => this.CONSUME5(L.Identifier) },
          ]);
        },
      },
    ]);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // GOTO action
  private gotoAction = this.RULE('gotoAction', () => {
    this.CONSUME(L.Goto);
    this.OR([
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      { ALT: () => this.CONSUME(L.Identifier) },
    ]);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // SIGNAL action
  private signalAction = this.RULE('signalAction', () => {
    this.CONSUME(L.Signal);
    this.CONSUME(L.Colon);
    this.CONSUME(L.Identifier); // signal type
    this.OPTION(() => this.CONSUME(L.NewLine));

    this.OPTION2(() => {
      // MESSAGE: line
      this.CONSUME2(L.Identifier);
      this.CONSUME2(L.Colon);
      this.CONSUME(L.StringLiteral);
    });
    this.OPTION3(() => this.CONSUME2(L.NewLine));
  });

  // SET action
  private setAction = this.RULE('setAction', () => {
    this.CONSUME(L.Set);
    this.CONSUME(L.Identifier);
    this.MANY(() => {
      this.CONSUME(L.Dot);
      this.CONSUME2(L.Identifier);
    });
    this.CONSUME(L.Assignment);
    this.SUBRULE(this.expression);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // CLASSIFY action
  private classifyAction = this.RULE('classifyAction', () => {
    this.CONSUME(L.Classify);
    this.CONSUME(L.Identifier); // what to classify
    this.OPTION(() => this.CONSUME(L.NewLine));

    this.MANY(() => {
      this.SUBRULE(this.classifyRoute);
    });
  });

  // Classify route
  private classifyRoute = this.RULE('classifyRoute', () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(L.Intent);
          this.CONSUME(L.LParen);
          this.AT_LEAST_ONE_SEP({
            SEP: L.Comma,
            DEF: () => this.CONSUME(L.Identifier),
          });
          this.CONSUME(L.RParen);
          this.CONSUME(L.Arrow);
          this.OR2([
            { ALT: () => this.CONSUME(L.NumberLiteral) },
            { ALT: () => this.CONSUME2(L.Identifier) },
          ]);
        },
      },
      {
        ALT: () => {
          this.CONSUME(L.Default);
          this.CONSUME2(L.Arrow);
          this.OR3([
            { ALT: () => this.CONSUME2(L.NumberLiteral) },
            { ALT: () => this.CONSUME3(L.Identifier) },
          ]);
        },
      },
    ]);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // ON_SUCCESS action
  private onSuccessAction = this.RULE('onSuccessAction', () => {
    this.CONSUME(L.OnSuccess);
    this.CONSUME(L.Arrow);
    this.OR([
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      { ALT: () => this.CONSUME(L.Identifier) },
    ]);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // ON_FAILURE action
  private onFailureAction = this.RULE('onFailureAction', () => {
    this.CONSUME(L.OnFailure);
    this.CONSUME(L.Arrow);
    this.OR([
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      { ALT: () => this.CONSUME(L.Identifier) },
    ]);
    this.OPTION(() => this.CONSUME(L.NewLine));
  });

  // Expression
  private expression = this.RULE('expression', () => {
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      { ALT: () => this.CONSUME(L.NumberLiteral) },
      { ALT: () => this.CONSUME(L.True) },
      { ALT: () => this.CONSUME(L.False) },
      { ALT: () => this.CONSUME(L.Null) },
      {
        ALT: () => {
          this.CONSUME(L.Identifier);
          this.MANY(() => {
            this.CONSUME(L.Dot);
            this.CONSUME2(L.Identifier);
          });
        },
      },
    ]);
  });

  // GUARDRAILS section
  private guardrailsSection = this.RULE('guardrailsSection', () => {
    this.CONSUME(L.GuardrailsKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.guardrailDefinition);
    });
  });

  // Guardrail definition
  private guardrailDefinition = this.RULE('guardrailDefinition', () => {
    this.CONSUME(L.Identifier); // guardrail name
    this.CONSUME(L.Colon);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.guardrailProperty);
      this.OPTION(() => this.CONSUME2(L.NewLine));
    });
  });

  // Guardrail property
  private guardrailProperty = this.RULE('guardrailProperty', () => {
    this.CONSUME(L.Identifier); // type, check, action, message
    this.CONSUME(L.Colon);
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      { ALT: () => this.CONSUME2(L.Identifier) },
    ]);
  });

  // TESTS section
  private testsSection = this.RULE('testsSection', () => {
    this.CONSUME(L.TestsKeyword);
    this.CONSUME(L.NewLine);

    this.MANY(() => {
      this.SUBRULE(this.testCase);
    });
  });

  // Test case
  private testCase = this.RULE('testCase', () => {
    this.CONSUME(L.Identifier); // test name
    this.CONSUME(L.Colon);
    this.CONSUME(L.NewLine);

    // Test properties - use GATE to check that Identifier is followed by Colon then value (not newline)
    this.MANY({
      GATE: () => {
        // Look ahead: test property is Identifier:Value (no newline after colon)
        // test case start is Identifier:\n
        const la1 = this.LA(1);
        const la2 = this.LA(2);
        const la3 = this.LA(3);
        return (
          tokenMatcher(la1, L.Identifier) &&
          tokenMatcher(la2, L.Colon) &&
          !tokenMatcher(la3, L.NewLine)
        );
      },
      DEF: () => {
        this.SUBRULE(this.testProperty);
        this.OPTION(() => this.CONSUME2(L.NewLine));
      },
    });
  });

  // Test property
  private testProperty = this.RULE('testProperty', () => {
    this.CONSUME(L.Identifier); // input, expected
    this.CONSUME(L.Colon);
    this.OR([
      { ALT: () => this.CONSUME(L.StringLiteral) },
      {
        ALT: () => {
          this.CONSUME(L.LBrace);
          this.MANY_SEP({
            SEP: L.Comma,
            DEF: () => {
              this.CONSUME2(L.Identifier);
              this.CONSUME2(L.Colon);
              this.OR2([
                { ALT: () => this.CONSUME2(L.StringLiteral) },
                { ALT: () => this.CONSUME(L.NumberLiteral) },
                { ALT: () => this.CONSUME(L.True) },
                { ALT: () => this.CONSUME(L.False) },
              ]);
            },
          });
          this.CONSUME(L.RBrace);
        },
      },
    ]);
  });
}

// Create singleton parser instance
const parserInstance = new AgentParser();

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
 * CST Visitor to build AgentDocument from parsed CST
 */
class AgentCstVisitor {
  visit(cst: any): AgentDocument {
    return this.visitAgentDocument(cst);
  }

  private visitAgentDocument(ctx: any): AgentDocument {
    const nameToken = getFirst(ctx, 'Identifier');
    const name = getTokenImage(nameToken);

    const now = new Date();
    const doc: AgentDocument = {
      meta: {
        id: crypto.randomUUID(),
        kind: 'agent',
        version: '1.0.0',
        name,
        createdAt: now,
        updatedAt: now,
      },
      identity: {
        role: '',
        persona: '',
        expertise: [],
        limitations: [],
      },
      contract: {
        inputs: { required: {}, optional: {} },
        outputs: {
          response: 'string',
          signal: { kind: 'enum', values: ['CONTINUE', 'COMPLETE', 'HANDOFF_READY', 'ESCALATE'] },
        },
      },
      tools: [],
      flow: {
        entryPoint: 'START',
        steps: [],
      },
      guardrails: [],
    };

    // Process sections
    for (const section of getAll(ctx, 'identitySection')) {
      doc.identity = this.visitIdentitySection(section);
    }

    for (const section of getAll(ctx, 'contractSection')) {
      const contract = this.visitContractSection(section);
      doc.contract = { ...doc.contract, ...contract };
    }

    for (const section of getAll(ctx, 'toolsSection')) {
      doc.tools = this.visitToolsSection(section);
    }

    for (const section of getAll(ctx, 'stepsSection')) {
      doc.flow.steps = this.visitStepsSection(section);
      if (doc.flow.steps.length > 0) {
        doc.flow.entryPoint = doc.flow.steps[0].name;
      }
    }

    for (const section of getAll(ctx, 'guardrailsSection')) {
      doc.guardrails = this.visitGuardrailsSection(section);
    }

    for (const section of getAll(ctx, 'testsSection')) {
      doc.tests = this.visitTestsSection(section);
    }

    return doc;
  }

  private visitIdentitySection(ctx: any): AgentIdentity {
    const identity: AgentIdentity = {
      role: '',
      persona: '',
      expertise: [],
      limitations: [],
    };

    for (const propCtx of getAll(ctx, 'identityProperty')) {
      const name = getTokenImage(getFirst(propCtx, 'Identifier'));

      if (hasChildren(propCtx, 'StringLiteral')) {
        const value = extractStringLiteral(getFirst(propCtx, 'StringLiteral'));
        if (name === 'role') identity.role = value;
        else if (name === 'persona') identity.persona = value;
      } else if (hasChildren(propCtx, 'LBracket')) {
        const strings = getAll(propCtx, 'StringLiteral');
        const values = strings.map((t: IToken) => extractStringLiteral(t));
        if (name === 'expertise') identity.expertise = values;
        else if (name === 'limitations') identity.limitations = values;
      }
    }

    return identity;
  }

  private visitContractSection(ctx: any): Partial<AgentContract> {
    const contract: Partial<AgentContract> = {};

    for (const propCtx of getAll(ctx, 'contractProperty')) {
      const name = getTokenImage(getFirst(propCtx, 'Identifier'));

      if (name === 'inputs' || name === 'params') {
        contract.inputs = this.visitContractInputs(propCtx);
      } else if (name === 'outputs' || name === 'returns') {
        contract.outputs = this.visitContractOutputs(propCtx);
      }
    }

    return contract;
  }

  private visitContractInputs(ctx: any): AgentContract['inputs'] {
    const inputs: AgentContract['inputs'] = { required: {}, optional: {} };

    for (const fieldCtx of getAll(ctx, 'contractField')) {
      const name = getTokenImage(getFirst(fieldCtx, 'Identifier'));
      const typeDef = getFirst(fieldCtx, 'typeDefinition');
      const typeInfo = this.visitTypeDefinition(typeDef);

      if (typeInfo.nullable) {
        inputs.optional[name] = typeInfo.type;
      } else {
        inputs.required[name] = typeInfo.type;
      }
    }

    return inputs;
  }

  private visitContractOutputs(ctx: any): AgentContract['outputs'] {
    const outputs: AgentContract['outputs'] = {
      response: 'string',
      signal: { kind: 'enum', values: ['CONTINUE', 'COMPLETE', 'HANDOFF_READY', 'ESCALATE'] },
    };

    for (const fieldCtx of getAll(ctx, 'contractField')) {
      const name = getTokenImage(getFirst(fieldCtx, 'Identifier'));
      const typeDef = getFirst(fieldCtx, 'typeDefinition');
      const typeInfo = this.visitTypeDefinition(typeDef);

      if (name === 'response') outputs.response = typeInfo.type;
      else if (name === 'signal') {
        if (typeof typeInfo.type === 'object' && typeInfo.type.kind === 'enum') {
          outputs.signal = typeInfo.type;
        }
      } else if (name === 'state_updates' || name === 'stateUpdates')
        outputs.stateUpdates = typeInfo.type;
      else if (name === 'handoff_metadata' || name === 'handoffMetadata')
        outputs.handoffMetadata = typeInfo.type;
    }

    return outputs;
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
    } else if (hasChildren(ctx, 'LBrace')) {
      // Object type
      const properties: Record<string, TypeDefinition> = {};
      // Note: nested type definitions would need recursive parsing
      type = { kind: 'object', properties };
    }

    return { type, nullable };
  }

  private visitToolsSection(ctx: any): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const toolCtx of getAll(ctx, 'toolDefinition')) {
      const name = getTokenImage(getFirst(toolCtx, 'Identifier'));
      const params = this.visitToolParameters(toolCtx);
      const returnType = this.visitTypeDefinition(getFirst(toolCtx, 'typeDefinition'));

      const tool: ToolDefinition = {
        id: crypto.randomUUID(),
        name,
        description: '',
        parameters: params,
        returns: returnType.type,
      };

      // Parse tool properties
      for (const propCtx of getAll(toolCtx, 'toolProperty')) {
        const propName = getTokenImage(getFirst(propCtx, 'Identifier'));

        if (propName === 'description') {
          if (hasChildren(propCtx, 'StringLiteral')) {
            tool.description = extractStringLiteral(getFirst(propCtx, 'StringLiteral'));
          }
        } else if (propName === 'cacheable') {
          if (hasChildren(propCtx, 'True')) tool.cacheable = true;
          else if (hasChildren(propCtx, 'False')) tool.cacheable = false;
        } else if (propName === 'on_failure') {
          // Parse failure handling
          const allIdentifiers = getAll(propCtx, 'Identifier');
          if (allIdentifiers.length >= 2) {
            const strategy = getTokenImage(allIdentifiers[1]);
            tool.errorHandling = {
              onFailure: strategy as any,
            };
            // Check for retry count
            const numbers = getAll(propCtx, 'NumberLiteral');
            if (numbers.length > 0) {
              tool.errorHandling.maxRetries = parseInt(getTokenImage(numbers[0]), 10);
            }
          }
        }
      }

      tools.push(tool);
    }

    return tools;
  }

  private visitToolParameters(ctx: any): ToolParameter[] {
    const params: ToolParameter[] = [];

    for (const paramCtx of getAll(ctx, 'toolParameter')) {
      const name = getTokenImage(getFirst(paramCtx, 'Identifier'));
      const typeDef = getFirst(paramCtx, 'typeDefinition');
      const typeInfo = this.visitTypeDefinition(typeDef);

      const param: ToolParameter = {
        name,
        type: typeInfo.type,
        required: !typeInfo.nullable,
      };

      // Check for default value
      const literalCtx = getFirst(paramCtx, 'literalValue');
      if (literalCtx) {
        param.default = this.visitLiteralValue(literalCtx);
        param.required = false;
      }

      params.push(param);
    }

    return params;
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

  private visitStepsSection(ctx: any): Step[] {
    const steps: Step[] = [];

    for (const stepCtx of getAll(ctx, 'stepDefinition')) {
      const step = this.visitStepDefinition(stepCtx);
      if (step) steps.push(step);
    }

    return steps;
  }

  private visitStepDefinition(ctx: any): Step | null {
    // Get step number
    let stepNum = 1;
    const stepNumToken = getFirst(ctx, 'StepNumber');
    const numLitToken = getFirst(ctx, 'NumberLiteral');

    if (stepNumToken) {
      stepNum = parseFloat(getTokenImage(stepNumToken));
    } else if (numLitToken) {
      stepNum = parseFloat(getTokenImage(numLitToken));
    }

    // Get step name
    const name = getTokenImage(getFirst(ctx, 'Identifier'));

    // Collect actions, handling ON_SUCCESS/ON_FAILURE specially
    const actions: StepAction[] = [];
    let lastCallAction: CallToolAction | null = null;

    for (const actionCtx of getAll(ctx, 'stepAction')) {
      // Check for ON_SUCCESS - apply to last call action
      const onSuccessCtx = getFirst(actionCtx, 'onSuccessAction');
      if (onSuccessCtx && lastCallAction) {
        const target = this.getOnSuccessFailureTarget(onSuccessCtx);
        lastCallAction.onSuccess = target;
        continue;
      }

      // Check for ON_FAILURE - apply to last call action
      const onFailureCtx = getFirst(actionCtx, 'onFailureAction');
      if (onFailureCtx && lastCallAction) {
        const target = this.getOnSuccessFailureTarget(onFailureCtx);
        lastCallAction.onFailure = target;
        continue;
      }

      const action = this.visitStepAction(actionCtx);
      if (action) {
        actions.push(action);
        // Track call_tool actions for ON_SUCCESS/ON_FAILURE association
        if (action.kind === 'call_tool') {
          lastCallAction = action as CallToolAction;
        }
      }
    }

    // If multiple actions, wrap in multi_step
    let mainAction: StepAction;
    if (actions.length === 0) {
      mainAction = { kind: 'respond', message: { kind: 'string', value: '' } };
    } else if (actions.length === 1) {
      mainAction = actions[0];
    } else {
      mainAction = { kind: 'multi_step', steps: actions };
    }

    return {
      id: crypto.randomUUID(),
      number: stepNum,
      name,
      action: mainAction,
    };
  }

  private getOnSuccessFailureTarget(ctx: any): string {
    const numToken = getFirst(ctx, 'NumberLiteral');
    if (numToken) return getTokenImage(numToken);
    const idToken = getFirst(ctx, 'Identifier');
    if (idToken) return getTokenImage(idToken);
    return '';
  }

  private visitStepAction(ctx: any): StepAction | null {
    if (!ctx || !ctx.children) return null;

    // Check for different action types
    const callCtx = getFirst(ctx, 'callAction');
    if (callCtx) return this.visitCallAction(callCtx);

    const respondCtx = getFirst(ctx, 'respondAction');
    if (respondCtx) return this.visitRespondAction(respondCtx);

    const waitCtx = getFirst(ctx, 'waitInputAction');
    if (waitCtx) return this.visitWaitInputAction(waitCtx);

    const gotoCtx = getFirst(ctx, 'gotoAction');
    if (gotoCtx) return this.visitGotoAction(gotoCtx);

    const signalCtx = getFirst(ctx, 'signalAction');
    if (signalCtx) return this.visitSignalAction(signalCtx);

    const setCtx = getFirst(ctx, 'setAction');
    if (setCtx) return this.visitSetAction(setCtx);

    const classifyCtx = getFirst(ctx, 'classifyAction');
    if (classifyCtx) return this.visitClassifyAction(classifyCtx);

    return null;
  }

  private visitCallAction(ctx: any): CallToolAction {
    const toolName = getTokenImage(getFirst(ctx, 'Identifier'));
    const params: Record<string, Expression> = {};

    // Parse expressions passed to the call
    for (const exprCtx of getAll(ctx, 'expression')) {
      const expr = this.visitExpression(exprCtx);
      // Expression arguments - map positionally for now
      // In real implementation, would handle named parameters
    }

    return {
      kind: 'call_tool',
      tool: toolName,
      params,
    };
  }

  private visitRespondAction(ctx: any): RespondAction {
    const message = extractStringLiteral(getFirst(ctx, 'StringLiteral'));
    return {
      kind: 'respond',
      message: { kind: 'string', value: message },
    };
  }

  private visitWaitInputAction(ctx: any): WaitInputAction {
    const routes: Record<string, string> = {};
    let maxAttempts: number | undefined;
    let onMaxExceeded: string | undefined;

    for (const routeCtx of getAll(ctx, 'waitInputRoute')) {
      if (hasChildren(routeCtx, 'Positive')) {
        const target = this.getRouteTarget(routeCtx);
        routes['positive'] = target;
      } else if (hasChildren(routeCtx, 'Negative')) {
        const target = this.getRouteTarget(routeCtx);
        routes['negative'] = target;
      } else if (hasChildren(routeCtx, 'Default')) {
        const target = this.getRouteTarget(routeCtx);
        routes['default'] = target;
      } else if (hasChildren(routeCtx, 'Pattern')) {
        const pattern = extractStringLiteral(getFirst(routeCtx, 'StringLiteral'));
        const target = this.getRouteTarget(routeCtx);
        routes[`pattern:${pattern}`] = target;
      } else if (hasChildren(routeCtx, 'MaxAttempts')) {
        const numbers = getAll(routeCtx, 'NumberLiteral');
        if (numbers.length >= 2) {
          maxAttempts = parseInt(getTokenImage(numbers[0]), 10);
          onMaxExceeded = getTokenImage(numbers[1]);
        }
      }
    }

    return {
      kind: 'wait_input',
      routes,
      maxAttempts,
      onMaxExceeded,
    };
  }

  private getRouteTarget(ctx: any): string {
    const numToken = getAll(ctx, 'NumberLiteral');
    const idToken = getAll(ctx, 'Identifier');

    // Return last number or identifier as target
    if (numToken.length > 0) {
      return getTokenImage(numToken[numToken.length - 1]);
    }
    if (idToken.length > 0) {
      return getTokenImage(idToken[idToken.length - 1]);
    }
    return '';
  }

  private visitGotoAction(ctx: any): GotoAction {
    let target = '';
    const numToken = getFirst(ctx, 'NumberLiteral');
    const idToken = getFirst(ctx, 'Identifier');

    if (numToken) target = getTokenImage(numToken);
    else if (idToken) target = getTokenImage(idToken);

    return { kind: 'goto', target };
  }

  private visitSignalAction(ctx: any): SignalAction {
    const identifiers = getAll(ctx, 'Identifier');
    const signal = identifiers.length > 0 ? getTokenImage(identifiers[0]) : 'COMPLETE';

    let message: Expression | undefined;
    const stringToken = getFirst(ctx, 'StringLiteral');
    if (stringToken) {
      message = { kind: 'string', value: extractStringLiteral(stringToken) };
    }

    return { kind: 'signal', signal, message };
  }

  private visitSetAction(ctx: any): SetStateAction {
    const updates: Record<string, Expression> = {};
    const identifiers = getAll(ctx, 'Identifier');
    const path = identifiers.map((t: IToken) => getTokenImage(t)).join('.');

    const exprCtx = getFirst(ctx, 'expression');
    const value = this.visitExpression(exprCtx);

    updates[path] = value;

    return { kind: 'set_state', updates };
  }

  private visitClassifyAction(ctx: any): ClassifyIntentAction {
    const intents: Record<string, string> = {};
    let defaultTarget: string | undefined;

    for (const routeCtx of getAll(ctx, 'classifyRoute')) {
      if (hasChildren(routeCtx, 'Intent')) {
        const intentNames = getAll(routeCtx, 'Identifier')
          .slice(0, -1)
          .map((t: IToken) => getTokenImage(t));
        const target = this.getRouteTarget(routeCtx);
        for (const intent of intentNames) {
          intents[intent] = target;
        }
      } else if (hasChildren(routeCtx, 'Default')) {
        defaultTarget = this.getRouteTarget(routeCtx);
      }
    }

    return { kind: 'classify_intent', intents, default: defaultTarget };
  }

  private visitExpression(ctx: any): Expression {
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

    // Variable reference
    if (hasChildren(ctx, 'Identifier')) {
      const identifiers = getAll(ctx, 'Identifier');
      const path = identifiers.map((t: IToken) => getTokenImage(t));
      return { kind: 'variable', path };
    }

    return { kind: 'null' };
  }

  private visitGuardrailsSection(ctx: any): Guardrail[] {
    const guardrails: Guardrail[] = [];

    for (const grCtx of getAll(ctx, 'guardrailDefinition')) {
      const name = getTokenImage(getFirst(grCtx, 'Identifier'));
      const guardrail: Guardrail = {
        name,
        type: 'input',
        check: { kind: 'boolean', value: true },
        action: 'block',
      };

      for (const propCtx of getAll(grCtx, 'guardrailProperty')) {
        const propName = getTokenImage(getFirst(propCtx, 'Identifier'));

        if (propName === 'type' || propName === 'kind') {
          const allIds = getAll(propCtx, 'Identifier');
          if (allIds.length >= 2) {
            guardrail.type = getTokenImage(allIds[1]) as any;
          }
        } else if (propName === 'action') {
          const allIds = getAll(propCtx, 'Identifier');
          if (allIds.length >= 2) {
            guardrail.action = getTokenImage(allIds[1]) as any;
          }
        } else if (propName === 'check') {
          if (hasChildren(propCtx, 'StringLiteral')) {
            guardrail.check = extractStringLiteral(getFirst(propCtx, 'StringLiteral'));
          }
        } else if (propName === 'message' || propName === 'msg') {
          if (hasChildren(propCtx, 'StringLiteral')) {
            guardrail.message = extractStringLiteral(getFirst(propCtx, 'StringLiteral'));
          }
        }
      }

      guardrails.push(guardrail);
    }

    return guardrails;
  }

  private visitTestsSection(ctx: any): TestCase[] {
    const tests: TestCase[] = [];

    for (const testCtx of getAll(ctx, 'testCase')) {
      const name = getTokenImage(getFirst(testCtx, 'Identifier'));
      const testCase: TestCase = {
        name,
        input: '',
        expected: {},
      };

      for (const propCtx of getAll(testCtx, 'testProperty')) {
        const propName = getTokenImage(getFirst(propCtx, 'Identifier'));

        if (propName === 'input') {
          if (hasChildren(propCtx, 'StringLiteral')) {
            testCase.input = extractStringLiteral(getFirst(propCtx, 'StringLiteral'));
          }
        } else if (propName === 'expected') {
          // Parse expected properties
        }
      }

      tests.push(testCase);
    }

    return tests;
  }
}

// Singleton visitor
const agentVisitor = new AgentCstVisitor();

/**
 * Parse agent ABL text to document
 */
export function parseAgent(text: string): {
  document: AgentDocument | null;
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
  const cst = parserInstance.agentDocument();

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
  const document = agentVisitor.visit(cst);

  return { document, errors: [] };
}
