/**
 * Parser Tests for DSL Extensions
 *
 * Covers: SET (inline + block), CLEAR, TRANSFORM (FILTER/MAP/SORT_BY/LIMIT),
 * CALL WITH/AS, ON_RESULT parsing.
 */

import { describe, test, expect } from 'vitest';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';

// =============================================================================
// P1: SET as Step Property
// =============================================================================

describe('Parser: SET as Step Property', () => {
  test('should parse inline SET: variable = expression', () => {
    const dsl = `
AGENT: SetInlineTest
GOAL: "Test inline SET"

FLOW:
  start -> next

  start:
      REASONING: false
    SET: attempts = 0
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.set).toBeDefined();
    expect(startStep?.set).toHaveLength(1);
    expect(startStep?.set?.[0]).toEqual({ variable: 'attempts', expression: '0' });
  });

  test('should parse SET with function call expression', () => {
    const dsl = `
AGENT: SetFuncTest
GOAL: "Test SET with function"

FLOW:
  start -> next

  start:
      REASONING: false
    SET: counter = ADD(counter, 1)
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.set?.[0]).toEqual({ variable: 'counter', expression: 'ADD(counter, 1)' });
  });

  test('should parse block-form SET with multiple assignments', () => {
    const dsl = `
AGENT: SetBlockTest
GOAL: "Test block SET"

FLOW:
  start -> next

  start:
      REASONING: false
    SET:
        REASONING: false
      fullName = COALESCE(user.firstName, "Guest")
      maskedCard = MASK(cardNumber, "last4")
      isEligible = true
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.set).toHaveLength(3);
    expect(startStep?.set?.[0]).toEqual({
      variable: 'fullName',
      expression: 'COALESCE(user.firstName, "Guest")',
    });
    expect(startStep?.set?.[1]).toEqual({
      variable: 'maskedCard',
      expression: 'MASK(cardNumber, "last4")',
    });
    expect(startStep?.set?.[2]).toEqual({ variable: 'isEligible', expression: 'true' });
  });

  test('should parse SET with dot-notation variable', () => {
    const dsl = `
AGENT: SetDotTest
GOAL: "Test SET with dots"

FLOW:
  start -> next

  start:
      REASONING: false
    SET: user.name = "John"
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.set?.[0].variable).toBe('user.name');
  });
});

// =============================================================================
// P2: CLEAR as Step Property
// =============================================================================

describe('Parser: CLEAR as Step Property', () => {
  test('should parse CLEAR with comma-separated variables', () => {
    const dsl = `
AGENT: ClearTest
GOAL: "Test CLEAR"

FLOW:
  start -> next

  start:
      REASONING: false
    CLEAR: tempData, scratchPad, rawResponse
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.clear).toEqual(['tempData', 'scratchPad', 'rawResponse']);
  });

  test('should parse CLEAR with single variable', () => {
    const dsl = `
AGENT: ClearSingleTest
GOAL: "Test single CLEAR"

FLOW:
  start -> next

  start:
      REASONING: false
    CLEAR: tempData
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.clear).toEqual(['tempData']);
  });
});

// =============================================================================
// P3: CALL WITH and AS
// =============================================================================

describe('Parser: CALL WITH/AS', () => {
  test('should parse CALL with WITH: block and AS: binding', () => {
    const dsl = `
AGENT: CallWithTest
GOAL: "Test CALL WITH/AS"

TOOLS:
  get_accounts(customerId: string, memberNumber: string, usecase: string) -> object

FLOW:
  start -> next

  start:
      REASONING: false
    CALL: get_accounts
      WITH:
        customerId: session.customerID
        memberNumber: session.memberNumber
        usecase: "GetBalance"
      AS: accountsResult
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.call).toBe('get_accounts');
    expect(startStep?.callWith).toEqual({
      customerId: 'session.customerID',
      memberNumber: 'session.memberNumber',
      usecase: '"GetBalance"',
    });
    expect(startStep?.callAs).toBe('accountsResult');
  });

  test('should parse CALL with only WITH: (no AS:)', () => {
    const dsl = `
AGENT: CallWithOnlyTest
GOAL: "Test CALL WITH only"

TOOLS:
  send_notification(msg: string) -> object

FLOW:
  start -> next

  start:
      REASONING: false
    CALL: send_notification
      WITH:
        msg: "Hello"
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.call).toBe('send_notification');
    expect(startStep?.callWith).toEqual({ msg: '"Hello"' });
    expect(startStep?.callAs).toBeUndefined();
  });

  test('should parse CALL with only AS: (no WITH:)', () => {
    const dsl = `
AGENT: CallAsOnlyTest
GOAL: "Test CALL AS only"

TOOLS:
  get_time() -> string

FLOW:
  start -> next

  start:
      REASONING: false
    CALL: get_time
      AS: currentTime
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.call).toBe('get_time');
    expect(startStep?.callAs).toBe('currentTime');
  });

  test('should parse legacy CALL without WITH/AS (backward compatible)', () => {
    const dsl = `
AGENT: CallLegacyTest
GOAL: "Test legacy CALL"

TOOLS:
  process_input(value: string) -> object

FLOW:
  start -> next

  start:
      REASONING: false
    CALL: process_input(value)
    THEN: next

  next:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const startStep = result.document?.flow?.definitions['start'];
    expect(startStep?.call).toBe('process_input(value)');
    expect(startStep?.callWith).toBeUndefined();
    expect(startStep?.callAs).toBeUndefined();
  });
});

// =============================================================================
// P4: ON_RESULT
// =============================================================================

describe('Parser: ON_RESULT', () => {
  test('should parse ON_RESULT with multiple IF branches and ELSE', () => {
    const dsl = `
AGENT: OnResultTest
GOAL: "Test ON_RESULT"

TOOLS:
  validate_pin(userId: string, pin: string) -> object

FLOW:
  start -> verify

  start:
      REASONING: false
    RESPOND: "Enter PIN"
    THEN: verify

  verify:
      REASONING: false
    CALL: validate_pin
      WITH:
          REASONING: false
        userId: session.userId
        pin: enteredPin
      AS: pinResult
    ON_RESULT:
        REASONING: false
      - IF: pinResult.statusCode == 200
        THEN: success
      - IF: pinResult.statusCode == 401
        RESPOND: "Session expired."
        THEN: re_auth
      - ELSE:
        RESPOND: "Unexpected error"
        THEN: error

  success:
      REASONING: false
    RESPOND: "Verified!"
    THEN: COMPLETE

  re_auth:
      REASONING: false
    RESPOND: "Please log in again"
    THEN: COMPLETE

  error:
      REASONING: false
    RESPOND: "Error occurred"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const verifyStep = result.document?.flow?.definitions['verify'];
    expect(verifyStep?.onResult).toBeDefined();
    expect(verifyStep?.onResult).toHaveLength(3);

    expect(verifyStep?.onResult?.[0].condition).toBe('pinResult.statusCode == 200');
    expect(verifyStep?.onResult?.[0].then).toBe('success');

    expect(verifyStep?.onResult?.[1].condition).toBe('pinResult.statusCode == 401');
    expect(verifyStep?.onResult?.[1].respond).toBe('Session expired.');
    expect(verifyStep?.onResult?.[1].then).toBe('re_auth');

    // ELSE branch has no condition
    expect(verifyStep?.onResult?.[2].condition).toBeUndefined();
    expect(verifyStep?.onResult?.[2].respond).toBe('Unexpected error');
    expect(verifyStep?.onResult?.[2].then).toBe('error');
  });

  test('should parse ON_RESULT with SET in branches', () => {
    const dsl = `
AGENT: OnResultSetTest
GOAL: "Test ON_RESULT SET"

TOOLS:
  check_status() -> object

FLOW:
  start -> check

  start:
      REASONING: false
    RESPOND: "Checking..."
    THEN: check

  check:
      REASONING: false
    CALL: check_status
      AS: statusResult
    ON_RESULT:
        REASONING: false
      - IF: statusResult.ok == true
        SET: verified = true
        THEN: done
      - ELSE:
        SET: verified = false
        THEN: retry

  done:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE

  retry:
      REASONING: false
    RESPOND: "Retrying"
    THEN: check
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const checkStep = result.document?.flow?.definitions['check'];
    expect(checkStep?.onResult?.[0].set).toEqual({ verified: 'true' });
    expect(checkStep?.onResult?.[1].set).toEqual({ verified: 'false' });
  });

  test('should parse ON_RESULT structured respond payloads including actions', () => {
    const dsl = `
AGENT: OnResultStructuredTest
GOAL: "Test ON_RESULT structured payloads"

TOOLS:
  validate_pin() -> object

FLOW:
  start -> verify

  start:
      REASONING: false
    RESPOND: "Enter PIN"
    THEN: verify

  verify:
      REASONING: false
    CALL: validate_pin()
      AS: pinResult
    ON_RESULT:
      - IF: pinResult.statusCode == 401
        RESPOND: "Session expired."
          VOICE:
            plain_text: "Session expired."
          FORMATS:
            MARKDOWN: "### Session expired"
          ACTIONS:
            - BUTTON: "Sign in again" -> sign_in_again
        THEN: re_auth
      - ELSE:
        THEN: COMPLETE

  re_auth:
      REASONING: false
    RESPOND: "Please log in again"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const branch = result.document?.flow?.definitions['verify']?.onResult?.[0];
    expect(branch).toMatchObject({
      respond: 'Session expired.',
      voiceConfig: {
        plainText: 'Session expired.',
      },
      richContent: {
        markdown: '### Session expired',
      },
      actions: {
        elements: [{ id: 'sign_in_again', type: 'button', label: 'Sign in again' }],
      },
      then: 're_auth',
    });
  });
});

// =============================================================================
// P5: TRANSFORM
// =============================================================================

describe('Parser: TRANSFORM', () => {
  test('should parse TRANSFORM with FILTER, MAP, SORT_BY, LIMIT', () => {
    const dsl = `
AGENT: TransformTest
GOAL: "Test TRANSFORM"

FLOW:
  start -> process -> display

  start:
      REASONING: false
    RESPOND: "Welcome"
    THEN: process

  process:
      REASONING: false
    TRANSFORM: result.body.accounts AS acct INTO displayAccounts
      FILTER: acct.paybillEnabled != false
      MAP:
        name: COALESCE(acct.accountNickname, acct.productName)
        number: MASK(acct.accountNumber, "last4")
        balance: FORMAT_CURRENCY(acct.availableBalance, acct.currency)
      SORT_BY: name ASC
      LIMIT: 20
    THEN: display

  display:
      REASONING: false
    RESPOND: "Here are your accounts"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const processStep = result.document?.flow?.definitions['process'];
    expect(processStep?.transform).toBeDefined();
    expect(processStep?.transform?.source).toBe('result.body.accounts');
    expect(processStep?.transform?.itemVar).toBe('acct');
    expect(processStep?.transform?.target).toBe('displayAccounts');
    expect(processStep?.transform?.filter).toBe('acct.paybillEnabled != false');
    expect(processStep?.transform?.map).toEqual({
      name: 'COALESCE(acct.accountNickname, acct.productName)',
      number: 'MASK(acct.accountNumber, "last4")',
      balance: 'FORMAT_CURRENCY(acct.availableBalance, acct.currency)',
    });
    expect(processStep?.transform?.sortBy).toEqual({ field: 'name', order: 'asc' });
    expect(processStep?.transform?.limit).toBe(20);
  });

  test('should parse TRANSFORM with only FILTER (no MAP/SORT_BY/LIMIT)', () => {
    const dsl = `
AGENT: TransformFilterTest
GOAL: "Test TRANSFORM filter only"

FLOW:
  start -> process -> end

  start:
      REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
      REASONING: false
    TRANSFORM: items AS item INTO filtered
      FILTER: item.active == true
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const processStep = result.document?.flow?.definitions['process'];
    expect(processStep?.transform?.source).toBe('items');
    expect(processStep?.transform?.itemVar).toBe('item');
    expect(processStep?.transform?.target).toBe('filtered');
    expect(processStep?.transform?.filter).toBe('item.active == true');
    expect(processStep?.transform?.map).toBeUndefined();
    expect(processStep?.transform?.sortBy).toBeUndefined();
    expect(processStep?.transform?.limit).toBeUndefined();
  });

  test('should parse TRANSFORM with SORT_BY DESC', () => {
    const dsl = `
AGENT: TransformSortTest
GOAL: "Test TRANSFORM sort desc"

FLOW:
  start -> process -> end

  start:
      REASONING: false
    RESPOND: "Start"
    THEN: process

  process:
      REASONING: false
    TRANSFORM: accounts AS acc INTO sorted
      SORT_BY: balance DESC
    THEN: end

  end:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const processStep = result.document?.flow?.definitions['process'];
    expect(processStep?.transform?.sortBy).toEqual({ field: 'balance', order: 'desc' });
  });
});

describe('Parser: Canonical invocation surfaces', () => {
  test('should parse ON_INPUT branch CALL WITH/AS into callSpec', () => {
    const dsl = `
AGENT: BranchCallSpecTest
GOAL: "Test branch tool invocation parsing"

TOOLS:
  lookup_member(memberId: string) -> object

FLOW:
  start -> done

  start:
      REASONING: false
    RESPOND: "Checking"
    ON_INPUT:
      - IF: input contains "check"
        CALL: lookup_member
          WITH:
            memberId: session.member_id
          AS: memberLookup
        THEN: done
      - ELSE:
        THEN: COMPLETE

  done:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const branch = result.document?.flow?.definitions['start'].onInput?.[0];
    expect(branch).toMatchObject({
      call: 'lookup_member',
      callSpec: {
        tool: 'lookup_member',
        with: { memberId: 'session.member_id' },
        as: 'memberLookup',
      },
    });
  });

  test('should parse ON_INPUT structured respond payloads including actions', () => {
    const dsl = `
AGENT: OnInputStructuredTest
GOAL: "Test ON_INPUT structured payloads"

FLOW:
  start -> done

  start:
      REASONING: false
    RESPOND: "Checking"
    ON_INPUT:
      - IF: input contains "check"
        RESPOND: "Choose an option"
          VOICE:
            plain_text: "Choose an option"
          FORMATS:
            MARKDOWN: "### Choose an option"
          ACTIONS:
            - BUTTON: "Done" -> done
        THEN: done
      - ELSE:
        THEN: COMPLETE

  done:
      REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const branch = result.document?.flow?.definitions['start'].onInput?.[0];
    expect(branch).toMatchObject({
      respond: 'Choose an option',
      voiceConfig: {
        plainText: 'Choose an option',
      },
      richContent: {
        markdown: '### Choose an option',
      },
      actions: {
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      },
      then: 'done',
    });
  });

  test('should parse ON_SUCCESS and ON_FAILURE structured payloads including actions', () => {
    const dsl = `
AGENT: CallBranchStructuredTest
GOAL: "Test call result branch structured payloads"

TOOLS:
  validate_pin() -> object

FLOW:
  start -> verify

  start:
      REASONING: false
    RESPOND: "Checking"
    THEN: verify

  verify:
      REASONING: false
    CALL: validate_pin()
      AS: pinResult
    ON_SUCCESS:
      - IF: pinResult.statusCode == 202
        RESPOND: "Need confirmation"
          VOICE:
            plain_text: "Need confirmation"
          FORMATS:
            MARKDOWN: "### Need confirmation"
          ACTIONS:
            - BUTTON: "Confirm" -> confirm_pin
        THEN: confirm
    ON_FAILURE:
      RESPOND: "Try again"
        ACTIONS:
          - BUTTON: "Retry" -> retry_pin
      THEN: retry

  confirm:
      REASONING: false
    RESPOND: "Confirmed"
    THEN: COMPLETE

  retry:
      REASONING: false
    RESPOND: "Retrying"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const verifyStep = result.document?.flow?.definitions['verify'];
    expect(verifyStep?.onSuccess?.branches?.[0]).toMatchObject({
      respond: 'Need confirmation',
      voiceConfig: {
        plainText: 'Need confirmation',
      },
      richContent: {
        markdown: '### Need confirmation',
      },
      actions: {
        elements: [{ id: 'confirm_pin', type: 'button', label: 'Confirm' }],
      },
      then: 'confirm',
    });
    expect(verifyStep?.onFailure).toMatchObject({
      respond: 'Try again',
      actions: {
        elements: [{ id: 'retry_pin', type: 'button', label: 'Retry' }],
      },
      then: 'retry',
    });
  });

  test('should parse HOOKS CALL WITH/AS into callSpec', () => {
    const dsl = `
AGENT: HookCallSpecTest
GOAL: "Test hooks tool invocation parsing"

HOOKS:
  before_turn:
    CALL: audit_turn
      WITH:
        turnId: session.turn_id
      AS: auditResult
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document?.hooks?.before_turn).toMatchObject({
      call: 'audit_turn',
      callSpec: {
        tool: 'audit_turn',
        with: { turnId: 'session.turn_id' },
        as: 'auditResult',
      },
    });
  });

  test('should parse HOOKS RESPOND structured payloads including actions', () => {
    const dsl = `
AGENT: HookStructuredRespondTest
GOAL: "Parse structured hook respond payloads"

HOOKS:
  after_turn:
    RESPOND: "Choose next step"
      VOICE:
        plain_text: "Choose next step"
      FORMATS:
        markdown: "### Choose next step"
      ACTIONS:
        - BUTTON: "Done" -> done
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);
    expect(result.document?.hooks?.after_turn).toMatchObject({
      respond: 'Choose next step',
      actions: {
        elements: [{ id: 'done', type: 'button', label: 'Done' }],
      },
      richContent: {
        markdown: '### Choose next step',
      },
      voiceConfig: {
        plainText: 'Choose next step',
      },
    });
  });

  test('should parse DIGRESSIONS and SUB_INTENTS CALL WITH/AS into callSpec', () => {
    const dsl = `
AGENT: InterruptCallSpecTest
GOAL: "Test ordered interrupt invocation parsing"

TOOLS:
  audit_selection(selected: string) -> object
  refresh_options(userId: string) -> object

FLOW:
  start -> done

  start:
    REASONING: false
    RESPOND: "Choose"
    DIGRESSIONS:
      - INTENT: help
        DO:
          - CALL: audit_selection
            WITH:
              selected: session.selected_agent
            AS: auditResult
          - RESUME
    SUB_INTENTS:
      - INTENT: "show more"
        CALL: refresh_options
          WITH:
            userId: session.user_id
          AS: moreOptions
        RESUME: true
    THEN: done

  done:
    REASONING: false
    RESPOND: "Done"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const step = result.document?.flow?.definitions['start'];
    expect(step?.digressions?.[0]?.do?.[0]).toMatchObject({
      call: 'audit_selection',
      callSpec: {
        tool: 'audit_selection',
        with: { selected: 'session.selected_agent' },
        as: 'auditResult',
      },
    });
    expect(step?.subIntents?.[0]).toMatchObject({
      call: 'refresh_options',
      callSpec: {
        tool: 'refresh_options',
        with: { userId: 'session.user_id' },
        as: 'moreOptions',
      },
    });
  });
});

// =============================================================================
// COMBINED: All constructs in one agent
// =============================================================================

describe('Parser: Combined DSL extensions', () => {
  test('should parse a complete agent using SET, CLEAR, CALL WITH/AS, ON_RESULT, TRANSFORM', () => {
    const dsl = `
AGENT: GetBalance
GOAL: "Retrieve and display account balances"

TOOLS:
  get_accounts(customerId: string, memberNumber: string, usecase: string) -> object

FLOW:
  start -> fetch -> transform -> display -> done

  start:
      REASONING: false
    SET: attempts = 0
    THEN: fetch

  fetch:
      REASONING: false
    SET: attempts = ADD(attempts, 1)
    CALL: get_accounts
      WITH:
          REASONING: false
        customerId: session.customerID
        memberNumber: session.memberNumber
        usecase: "GetBalance"
      AS: apiResult
    ON_RESULT:
        REASONING: false
      - IF: apiResult.statusCode == 200
        THEN: transform
      - IF: apiResult.statusCode == 401
        RESPOND: "Session expired."
        THEN: COMPLETE
      - ELSE:
        RESPOND: "Unable to fetch accounts."
        THEN: COMPLETE

  transform:
      REASONING: false
    TRANSFORM: apiResult.body.accounts AS acct INTO displayAccounts
      FILTER: acct.paybillEnabled != false
      MAP:
          REASONING: false
        name: COALESCE(acct.accountNickname, acct.productName)
        number: MASK(acct.accountNumber, "last4")
      SORT_BY: name ASC
      LIMIT: 20
    SET: accountCount = LENGTH(displayAccounts)
    THEN: display

  display:
      REASONING: false
    CHECK: accountCount > 0
      TRUE: show
      FALSE: no_accounts

  show:
      REASONING: false
    RESPOND: "Here are your accounts."
    CLEAR: apiResult, displayAccounts
    THEN: done

  no_accounts:
      REASONING: false
    RESPOND: "No eligible accounts found."
    THEN: done

  done:
      REASONING: false
    RESPOND: "Is there anything else?"
    THEN: COMPLETE
`;

    const result = parseAgentBasedABL(dsl);
    expect(result.errors).toHaveLength(0);

    const defs = result.document?.flow?.definitions;
    expect(defs).toBeDefined();

    // start: SET
    expect(defs!['start'].set).toHaveLength(1);
    expect(defs!['start'].set?.[0].variable).toBe('attempts');

    // fetch: SET + CALL WITH/AS + ON_RESULT
    expect(defs!['fetch'].set).toHaveLength(1);
    expect(defs!['fetch'].call).toBe('get_accounts');
    expect(defs!['fetch'].callWith).toBeDefined();
    expect(defs!['fetch'].callAs).toBe('apiResult');
    expect(defs!['fetch'].onResult).toHaveLength(3);

    // transform: TRANSFORM + SET
    expect(defs!['transform'].transform?.source).toBe('apiResult.body.accounts');
    expect(defs!['transform'].set).toHaveLength(1);
    expect(defs!['transform'].set?.[0].expression).toBe('LENGTH(displayAccounts)');

    // show: CLEAR
    expect(defs!['show'].clear).toEqual(['apiResult', 'displayAccounts']);
  });
});
