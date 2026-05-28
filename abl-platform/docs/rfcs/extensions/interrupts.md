# Agent Blueprint Language (ABL) Extension: Interrupt Handling

> **Extension Status**: 🔶 Design Complete / Not Implemented
> **Parser Support**: ❌ Not parsed
> **Runtime Support**: ❌ Not implemented
> **Tests**: None

## Overview

The Interrupt Handling Extension provides sophisticated control over how conversations handle interruptions, task switching, and resumption. This is **optional** and should be enabled when your system requires:

- Mid-flow task switching
- Priority-based interrupt handling
- Conversation hold and resume patterns
- Graceful context preservation during interrupts

## Enabling This Extension

In your project configuration:

```yaml
# project.config.yaml
extensions:
  interrupts:
    enabled: true
    default_priority: 'task'
    allow_user_interrupt: true
```

---

## 1. Interrupt Configuration

### Supervisor-Level Defaults

Configure default interrupt behavior for all agents:

```
SUPERVISOR: CustomerSupport
VERSION: 1.0.0

INTERRUPT_POLICY:
  default_priority: task | node | global
  user_interrupts: allow | restrict | block
  system_interrupts: always_allow
  max_pending_tasks: 3
  hold_timeout_minutes: 30
```

### Agent-Level Overrides

Override interrupt policy at the agent level:

```
AGENT: PaymentProcessor
VERSION: 1.0.0

INTERRUPT_POLICY:
  priority: node           # This agent's tasks take priority over node-level
  allow_interrupts: false  # Cannot be interrupted once started
  interruptible_steps:     # Exception: these steps CAN be interrupted
    - WAIT_CONFIRMATION
    - SHOW_SUMMARY
```

---

## 2. Priority Levels

### Priority Types

| Priority | Description                        | Use Case                     |
| -------- | ---------------------------------- | ---------------------------- |
| `global` | Highest - interrupts everything    | System alerts, security      |
| `task`   | Task-level - can interrupt nodes   | New user intents, escalation |
| `node`   | Node-level - only interrupts lower | Current step continuation    |

### Priority in Routing

```
ROUTING:
| Pri | Condition              | Target          | Flags     | Interrupt |
|-----|------------------------|-----------------|-----------|-----------|
| 0   | system.security_alert  | Security_Agent  |           | global    |
| 1   | user.wants_escalation  | Escalation      | set_active| task      |
| 2   | *                      | ?intent_match   |           | node      |
```

---

## 3. Hold Options

When a task is interrupted, define what happens to the current context:

### Hold Behaviors

```
INTERRUPT_POLICY:
  on_hold:
    action: preserve | discard | queue
    notify_user: true | false
    preserve_data:
      - context.form_data
      - context.collected_entities
    expiry_minutes: 30
```

### Hold Actions

| Action     | Description                                     |
| ---------- | ----------------------------------------------- |
| `preserve` | Save current state, allow resume later          |
| `discard`  | Abandon current task, no resume possible        |
| `queue`    | Queue current task, auto-resume after interrupt |

### Example: Preserving Form Data

```
AGENT: DataCollector
VERSION: 1.0.0

INTERRUPT_POLICY:
  on_hold:
    action: preserve
    notify_user: true
    notify_message: "I'll save your progress. Let me know when you're ready to continue."
    preserve_data:
      - context.form_fields.*
      - context.validation_state
    expiry_minutes: 60
```

---

## 4. Resume Options

Configure how interrupted tasks resume:

### Resume Behaviors

```
INTERRUPT_POLICY:
  on_resume:
    action: confirm | continue | restart
    notify_user: true
    resume_message: "Would you like to continue where we left off?"
    context_refresh: true
```

### Resume Actions

| Action     | Description                       |
| ---------- | --------------------------------- |
| `confirm`  | Ask user before resuming          |
| `continue` | Automatically resume at last step |
| `restart`  | Start the task from beginning     |

### Example: Confirmation-Based Resume

```
AGENT: BookingFlow
VERSION: 1.0.0

INTERRUPT_POLICY:
  on_resume:
    action: confirm
    confirmation:
      message: "Before the interruption, you were booking a flight to ${context.destination}. Continue?"
      options:
        continue: "Yes, continue"
        restart: "Start over"
        cancel: "Never mind"
    on_timeout: restart
    timeout_minutes: 5
```

---

## 5. Step-Level Interrupt Control

Override interrupt behavior for specific steps:

```
STEPS:
  1. COLLECT_PAYMENT
     INTERRUPT:
       enabled: false
       reason: "Payment collection cannot be interrupted"
     CALL process_payment(amount, method)
     ON_SUCCESS → 2
     ON_ERROR → ERROR

  2. CONFIRM_PAYMENT
     INTERRUPT:
       enabled: true
       on_hold: preserve
       on_resume: continue
     RESPOND "Payment successful! Your confirmation number is ${result.confirmation}"
     → NEXT

  3. WAIT_FEEDBACK
     INTERRUPT:
       enabled: true
       priority: node
       on_hold:
         action: discard
         notify_user: false
     RESPOND "How was your experience?"
     WAIT_INPUT → 4
```

---

## 6. Interrupt Signals

Agents can signal their interrupt preferences:

```
STEPS:
  1. CRITICAL_OPERATION
     SET interrupt.block = true
     CALL critical_system_update()
     SET interrupt.block = false
     → 2

  2. OPTIONAL_STEP
     SIGNAL: ALLOW_INTERRUPT
     RESPOND "Anything else I can help with?"
     WAIT_INPUT → 3
```

### Standard Interrupt Signals

| Signal              | Description                      |
| ------------------- | -------------------------------- |
| `BLOCK_INTERRUPT`   | Temporarily block all interrupts |
| `ALLOW_INTERRUPT`   | Explicitly allow interrupts      |
| `QUEUE_INTERRUPT`   | Queue incoming interrupts        |
| `PRIORITY_ESCALATE` | Increase current task priority   |

---

## 7. Interrupt Types

### Developer-Initiated Interrupts

Triggered by system or business logic:

```
STEPS:
  1. CHECK_STATUS
     CALL check_system_status()
     CONDITION: result.needs_interrupt
       TRUE → 1.1
       FALSE → 2

  1.1. TRIGGER_INTERRUPT
     INTERRUPT:
       type: developer
       priority: task
       target_agent: System_Alert
       message: "Important system update"
       on_complete: resume
     → PAUSE
```

### User-Initiated Interrupts

Handling when users change topic mid-conversation:

```
SUPERVISOR: CustomerSupport

INTERRUPT_POLICY:
  user_initiated:
    detect_change: true  # Use intent detection to spot topic changes
    change_indicators:
      - patterns: [actually, wait, never mind, different question]
      - intent_shift: true
    on_change:
      confirm: "I notice you might have a different question. Would you like to switch topics?"
      options:
        switch: Continue with new topic
        stay: Stay on current topic
```

---

## 8. Context During Interrupts

### State Preservation

```
INTERRUPT_POLICY:
  context:
    preserve_on_interrupt:
      - user.*                    # All user data
      - context.collected_*       # All collected entities
      - session.preferences       # User preferences
    clear_on_interrupt:
      - context.temp_*            # Temporary variables
      - context.validation_errors # Validation state
```

### Context Merging on Resume

```
INTERRUPT_POLICY:
  on_resume:
    context_merge:
      strategy: prefer_newer | prefer_original | merge_deep
      conflict_resolution: newer_wins | original_wins | prompt_user
```

---

## 9. Monitoring and Analytics

Track interrupt patterns:

```
INTERRUPT_POLICY:
  analytics:
    track_interrupts: true
    track_metrics:
      - interrupt_rate
      - resume_rate
      - abandonment_rate
      - avg_hold_duration
    alert_thresholds:
      interrupt_rate_high: 0.3  # Alert if >30% conversations interrupted
      resume_rate_low: 0.5      # Alert if <50% interrupted tasks resume
```

---

## 10. Channel-Specific Behavior

Different channels may need different interrupt handling:

```
INTERRUPT_POLICY:
  channels:
    voice:
      allow_barge_in: true      # User can interrupt bot speech
      barge_in_sensitivity: medium
      hold_music: true
      max_hold_minutes: 5

    chat:
      allow_type_ahead: true    # User can type while bot responds
      queue_user_messages: true
      max_queue_size: 5

    web:
      background_tab: preserve  # Keep context if user switches tabs
      tab_timeout_minutes: 30
```

---

## Best Practices

1. **Critical operations should block interrupts**: Payment, authentication, data submission
2. **Use confirmation for resumption**: Users may forget context after interrupts
3. **Set reasonable hold timeouts**: 30-60 minutes is typical
4. **Preserve essential data only**: Don't over-persist temporary state
5. **Notify users appropriately**: Let them know their progress is saved
6. **Test interrupt scenarios**: Include in your test suite
7. **Monitor abandonment**: High interrupt abandonment may indicate UX issues

---

## Compatibility

This extension is compatible with:

- Core Agent Blueprint Language (ABL) v1.0+
- Scheduling Extension (for time-based interrupt policies)

---

## Example: Complete Interrupt-Aware Agent

```
AGENT: FlightBooking
VERSION: 1.0.0
DESCRIPTION: Flight booking with full interrupt support

INTERRUPT_POLICY:
  priority: task
  allow_interrupts: true
  on_hold:
    action: preserve
    notify_user: true
    notify_message: "No problem! I'll save your booking progress."
    preserve_data:
      - context.search_params
      - context.selected_flights
      - context.passenger_info
    expiry_minutes: 60
  on_resume:
    action: confirm
    resume_message: |
      Welcome back! You were booking a flight:
      - From: ${context.search_params.origin}
      - To: ${context.search_params.destination}
      - Date: ${context.search_params.date}
      Would you like to continue?

STEPS:
  1. GET_SEARCH_PARAMS
     INTERRUPT:
       enabled: true
       on_hold: preserve
     RESPOND "Where would you like to fly?"
     WAIT_INPUT → 2

  2. SEARCH_FLIGHTS
     INTERRUPT:
       enabled: false
       reason: "Searching flights..."
     CALL search_flights(params)
     ON_SUCCESS → 3
     ON_ERROR → ERROR

  3. SELECT_FLIGHT
     INTERRUPT:
       enabled: true
     RESPOND template("flight_options", flights: result.flights)
     WAIT_INPUT → 4

  4. COLLECT_PASSENGER_INFO
     INTERRUPT:
       enabled: true
       on_hold:
         action: preserve
         preserve_data:
           - context.passenger_info.*
     CALL collect_passenger_details()
     → 5

  5. PROCESS_PAYMENT
     INTERRUPT:
       enabled: false
       reason: "Processing payment - cannot be interrupted"
     CALL process_payment()
     ON_SUCCESS → 6
     ON_ERROR → PAYMENT_ERROR

  6. CONFIRM_BOOKING
     RESPOND "Booking confirmed! Reference: ${result.confirmation}"
     SIGNAL: COMPLETE
```

---

## Implementation Status

| Component            | Status             | Notes                       |
| -------------------- | ------------------ | --------------------------- |
| ABL syntax design    | ✅ Complete        | Documented above            |
| Parser support       | ❌ Not implemented | INTERRUPT_POLICY not parsed |
| IR schema            | ❌ Not defined     | Need `InterruptPolicy` type |
| Context preservation | ❌ Not implemented | Session state save/restore  |
| Resume logic         | ❌ Not implemented | Confirmation flow needed    |
| Priority handling    | ❌ Not implemented | Interrupt queue system      |

### What's Needed to Implement

1. **Parser**: Parse `INTERRUPT_POLICY` blocks at supervisor, agent, and step levels
2. **IR Schema**: Define `InterruptPolicy`, `HoldConfig`, `ResumeConfig` types
3. **Runtime**: Implement interrupt detection, context save, and resume
4. **Session storage**: Persist held contexts with TTL

### Priority

**Medium** - Important for production deployments where users switch topics mid-flow.

---

## Test Coverage

No tests exist for this extension yet. When implemented:

- [ ] Interrupt detection (topic change)
- [ ] Context preservation on hold
- [ ] Resume with confirmation
- [ ] Priority-based interrupt handling
- [ ] Hold timeout/expiry
- [ ] Step-level interrupt blocking
