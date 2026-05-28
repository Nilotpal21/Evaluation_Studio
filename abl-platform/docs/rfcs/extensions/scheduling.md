# Agent Blueprint Language (ABL) Extension: Scheduling Constraints

> **Extension Status**: 🔶 Design Complete / Not Implemented
> **Parser Support**: ❌ Not parsed
> **Runtime Support**: ❌ Not implemented
> **Tests**: None

## Overview

The Scheduling Extension provides time-based availability constraints for agent orchestration. This is **optional** and should be enabled when your system requires:

- Business hours-based routing
- Shift-based agent availability
- Time-zone aware handoffs
- Holiday/maintenance window handling

## Enabling This Extension

In your project configuration:

```yaml
# project.config.yaml
extensions:
  scheduling:
    enabled: true
    timezone: 'America/New_York'
```

In the analyzer configuration:

```typescript
const analyzer = createAnalyzer({
  projectConfig: {
    scheduleConstraints: {
      enabled: true,
      scheduleVariables: ['schedule.unavailable', 'outside_hours'],
      timeGatedActionTypes: ['agent_handoff', 'system_action'],
    },
  },
});
```

## State Variables

When using scheduling, add these to your supervisor's STATE section:

```
STATE:
  # Core scheduling variables
  schedule.unavailable     : boolean [source: system]
  schedule.current_shift   : string? [source: system]
  schedule.next_available  : datetime? [source: system]

  # Optional granular variables
  schedule.is_holiday      : boolean = false [source: system]
  schedule.is_maintenance  : boolean = false [source: system]
```

## Generic Variable Names

Instead of domain-specific names like `transfer.outside_business_hours`, use generic names:

| ❌ Domain-Specific                | ✅ Generic               |
| --------------------------------- | ------------------------ |
| `transfer.outside_business_hours` | `schedule.unavailable`   |
| `transfer.business_hours`         | `schedule.available`     |
| `handoff.after_hours`             | `schedule.outside_hours` |

## Routing with Schedule Checks

```
ROUTING:
| Pri | Condition                                    | Target              | Flags  |
|-----|----------------------------------------------|---------------------|--------|
| 0   | escalation.pending AND NOT schedule.unavailable | @agent_handoff   | silent |
| 0   | escalation.pending AND schedule.unavailable    | Unavailable_Handler | silent |
```

## Policy Configuration

```
POLICIES:
  escalation:
    description: "Rules for escalating to human agents"
    allowed_when: schedule.unavailable == false
    forbidden_when: schedule.unavailable == true
    on_forbidden_action: route_to_unavailable_handler
    on_forbidden_message: |
      Our team is currently unavailable.
      We'll be back ${schedule.next_available}.
```

## Schedule Configuration (Runtime)

The schedule is defined in runtime configuration, not in the DSL:

```yaml
# config/schedule.yaml
schedule:
  timezone: 'America/New_York'

  weekly:
    monday: { start: '09:00', end: '17:00' }
    tuesday: { start: '09:00', end: '17:00' }
    wednesday: { start: '09:00', end: '17:00' }
    thursday: { start: '09:00', end: '17:00' }
    friday: { start: '09:00', end: '17:00' }
    saturday: null # unavailable
    sunday: null # unavailable

  holidays:
    - date: '2024-12-25'
      name: 'Christmas Day'
    - date: '2024-01-01'
      name: "New Year's Day"

  maintenance_windows:
    - start: '2024-03-15T02:00:00'
      end: '2024-03-15T04:00:00'
      reason: 'Scheduled maintenance'
```

## Unavailable Handler Pattern

Create an agent to handle requests when scheduled resources are unavailable:

```
AGENT: Unavailable_Handler
VERSION: 1.0.0
DESCRIPTION: Handles requests when scheduled resources are unavailable

STEPS:
  1. EXPLAIN_UNAVAILABILITY
     RESPOND "We're currently unavailable. ${schedule.next_available ? 'We\\'ll be back ' + format_datetime(schedule.next_available) + '.' : ''}"
     → 2

  2. OFFER_OPTIONS
     RESPOND "Would you like to:\n1. Leave a message\n2. Get help from our self-service options\n3. Come back later"
     WAIT_INPUT
       PATTERN("1|message") → 3
       PATTERN("2|self|help") → 4
       PATTERN("3|later") → 5
       DEFAULT → 5

  3. COLLECT_MESSAGE
     RESPOND "Please leave your message and we'll respond when we're back."
     WAIT_INPUT → 3.1

  3.1. CONFIRM_MESSAGE
     RESPOND "Message received. We'll follow up as soon as possible."
     SIGNAL: COMPLETE

  4. SELF_SERVICE
     SET conversation.active_agent = "FAQ_Handler"
     SIGNAL: COMPLETE

  5. END
     RESPOND "Thank you for understanding. Please check back during our available hours."
     SIGNAL: COMPLETE
```

## Analyzer Rule: CONF005

The `CONF005` (Schedule Constraint Conflicts) rule is **disabled by default**. Enable it in projects that use this extension:

```typescript
// This rule checks that time-gated actions consider schedule availability
const analyzer = createAnalyzer({
  projectConfig: {
    scheduleConstraints: {
      enabled: true, // Enable CONF005 checks
      scheduleVariables: ['schedule.unavailable', 'schedule.is_holiday'],
      timeGatedActionTypes: ['agent_handoff', 'system_action'],
    },
  },
});
```

## Best Practices

1. **Keep schedule logic in configuration, not DSL**: The DSL checks variables; the runtime populates them
2. **Use generic variable names**: Makes your DSL portable across industries
3. **Always have an unavailable handler**: Don't leave users hanging
4. **Provide next-available time when possible**: Sets expectations
5. **Consider multiple schedules**: Different resources may have different availability

## Examples

### Basic Usage

```
ROUTING:
| Pri | Condition                | Target           | Flags |
|-----|--------------------------|------------------|-------|
| 0   | schedule.unavailable     | Unavailable_Handler | |
| 1   | escalation.pending       | @agent_handoff   | |
```

### Shift-Based Routing

```
STATE:
  schedule.current_shift : enum(day, evening, night, none) [source: system]

ROUTING:
| Pri | Condition                          | Target            | Flags |
|-----|-----------------------------------|-------------------|-------|
| 0   | schedule.current_shift == "none"   | Unavailable_Handler | |
| 1   | schedule.current_shift == "night"  | Night_Support     | |
| 2   | *                                  | Day_Support       | |
```

---

## Implementation Status

| Component             | Status             | Notes                      |
| --------------------- | ------------------ | -------------------------- |
| ABL syntax design     | ✅ Complete        | Documented above           |
| Parser support        | ❌ Not implemented | Requires grammar extension |
| IR schema             | ❌ Not defined     | Need `ScheduleConfig` type |
| Runtime execution     | ❌ Not implemented | Requires schedule service  |
| Analyzer rule CONF005 | 🔶 Designed        | Rule disabled by default   |

### What's Needed to Implement

1. **Parser**: Add STATE variable parsing with `[source: system]` annotations
2. **IR Schema**: Define `ScheduleConfig` and `SchedulePolicy` types
3. **Runtime**: Implement `ScheduleService` to populate schedule variables
4. **Config**: Add schedule.yaml loading at startup

### Priority

**Low** - This is an enterprise feature for business hours handling. Core flow execution is more important.

---

## Test Coverage

No tests exist for this extension yet. When implemented:

- [ ] Schedule variable population
- [ ] Business hours checking
- [ ] Holiday detection
- [ ] Unavailable handler routing
- [ ] Timezone handling
