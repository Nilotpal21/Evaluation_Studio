# BankNexus

Digital banking assistant with balance inquiry, fund transfer, and transaction history capabilities.

This example is the reference-quality BankNexus bundle for the hardened ABL coordination contract:

- the supervisor bootstraps authenticated customer context at session start
- specialist handoffs use `summary_only` history plus explicit `memory_grants`
- cross-agent workflow state lives in `execution_tree` memory (`workflow.*`)
- human resolution uses `ESCALATE`, not pseudo-human `HANDOFF`
- balance, transfer, and transaction-history specialists all establish their own account context before acting

## Agents

| Agent                | Type       | Description                                                         |
| -------------------- | ---------- | ------------------------------------------------------------------- |
| BankNexus_Supervisor | supervisor | Top-level orchestrator routing to banking specialists               |
| Fund_Transfer        | agent      | Handles fund transfers with validation, limits, fees, and execution |
| Get_Balance          | agent      | Retrieves and displays account balances with formatting             |
| Transaction_History  | agent      | Displays filtered/sorted transaction history with drill-down        |

## Structure

```
banknexus/
  project.json
  agents/
    BankNexus_Supervisor.agent.abl
    fund_transfer.agent.abl
    get_balance.agent.abl
    transaction_history.agent.abl
  config/
    project-settings.json
  environment/
    env-vars.json
  locales/
    en/
      BankNexus_Supervisor.json
      Fund_Transfer.json
      Get_Balance.json
      Transaction_History.json
```

## Environment Variables

None required. All tools use inline definitions within agent DSL files.

## Example assumptions

- `user_id` is available from the authenticated runtime session. The supervisor derives `customer_id` from `user.customer_id` or falls back to `user_id` for demo purposes.
- Specialists receive `customer_id`, `customer_name`, and the current `workflow.default_account_id` from the supervisor.
- Each specialist can refresh account context by calling `get_accounts` before it performs an action that depends on a specific account.
