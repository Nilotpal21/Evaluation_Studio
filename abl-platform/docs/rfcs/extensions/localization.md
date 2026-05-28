# Agent Blueprint Language (ABL) Extension: Localization

> **Extension Status**: 🔶 Design Complete / Not Implemented
> **Parser Support**: ❌ Not parsed
> **Runtime Support**: ❌ Not implemented
> **Tests**: None

## Overview

The Localization Extension provides multi-language and regional customization for agent conversations. This is **optional** and should be enabled when your system requires:

- Multi-language support
- Regional formatting (dates, currencies)
- Cultural communication norms (formality, pronouns)
- Locale-specific content

## Enabling This Extension

In your project configuration:

```yaml
# project.config.yaml
extensions:
  localization:
    enabled: true
    default_locale: 'en-US'
    supported_locales:
      - 'en-US'
      - 'es-ES'
      - 'fr-FR'
```

## Dynamic Locale Detection

Locales should be detected from session context, not hardcoded in DSL:

```
STATE:
  session.locale           : string = "en-US" [source: system]
  session.timezone         : string? [source: system]
  session.detected_language: string? [source: system]
```

## Communication Settings (Generic)

Instead of hardcoding language-specific settings in DSL:

```
# ❌ Don't hardcode in DSL
COMMUNICATION:
  language: es-EC
  pronouns:
    use: usted
    avoid: tú, vos
  vocabulary:
    prefer: [por favor, gracias]
```

Use dynamic configuration:

```
# ✅ Reference locale from session
COMMUNICATION:
  language: ${session.locale}
  formality: ${config.formality_by_locale[session.locale]}
  constraints:
    - Be culturally appropriate for the user's locale
```

## Locale Configuration (Runtime)

Define locale-specific settings in runtime configuration:

```yaml
# config/locales/es-EC.yaml
locale: es-EC
display_name: 'Español (Ecuador)'

communication:
  formality: formal
  pronouns:
    preferred: 'usted'
    avoid: ['tú', 'vos']
  greetings:
    morning: 'Buenos días'
    afternoon: 'Buenas tardes'
    evening: 'Buenas noches'

formatting:
  date_format: 'DD/MM/YYYY'
  time_format: 'HH:mm'
  currency: 'USD'
  currency_symbol: '$'
  decimal_separator: ','
  thousands_separator: '.'

vocabulary:
  prefer:
    - 'por favor'
    - 'gracias'
    - 'permítame'
    - 'con gusto'
  avoid:
    - 'ok'
    - 'cool'
    - 'hey'
```

```yaml
# config/locales/en-US.yaml
locale: en-US
display_name: 'English (US)'

communication:
  formality: neutral
  pronouns:
    preferred: 'you'
  greetings:
    morning: 'Good morning'
    afternoon: 'Good afternoon'
    evening: 'Good evening'

formatting:
  date_format: 'MM/DD/YYYY'
  time_format: 'h:mm A'
  currency: 'USD'
  currency_symbol: '$'
  decimal_separator: '.'
  thousands_separator: ','

vocabulary:
  prefer: []
  avoid: []
```

## Response Templates

Store localized responses in template files, not in DSL:

```
# ✅ Use template references
STEPS:
  1. GREET
     RESPOND template("greeting", locale: session.locale)
     → NEXT

  2. ASK_INPUT
     RESPOND template("request_info", locale: session.locale, field: "email")
     WAIT_INPUT → 3
```

Template files:

```yaml
# templates/en-US/greeting.yaml
greeting: "Hello! Welcome to our service. How can I help you today?"

# templates/es-EC/greeting.yaml
greeting: "¡Hola! Bienvenido a nuestro servicio. ¿En qué puedo ayudarle hoy?"
```

## Document Validation Patterns

For region-specific document validation, use configurable patterns:

```yaml
# config/identity/patterns.yaml
document_patterns:
  ecuador:
    cedula:
      pattern: '^\d{10}$'
      description: '10-digit Ecuadorian ID'
    passport:
      pattern: '^[A-Z]{1,2}\d{6,9}$'
      description: 'Ecuadorian passport'

  usa:
    ssn:
      pattern: '^\d{3}-\d{2}-\d{4}$'
      description: 'Social Security Number'
    drivers_license:
      pattern: '^[A-Z0-9]{5,20}$'
      description: "State-issued driver's license"

  generic:
    email:
      pattern: '^[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}$'
      description: 'Email address'
    phone:
      pattern: '^\+?[\d\s-]{10,15}$'
      description: 'Phone number'
```

Reference in DSL using generic patterns:

```
STEPS:
  1. REQUEST_ID
     RESPOND template("request_id", locale: session.locale)
     WAIT_INPUT
       PATTERN(config.document_patterns[session.region].primary.pattern) → 2
       DEFAULT → 1.1
```

## Locale-Aware Formatting

Use formatting functions that respect locale:

```
STEPS:
  1. SHOW_BALANCE
     CALL get_balance(user_id)
     ON_SUCCESS → 1.1

  1.1. PRESENT_BALANCE
     RESPOND template("balance_display",
       amount: format_currency(result.balance, session.locale),
       due_date: format_date(result.due_date, session.locale)
     )
```

## Multi-Language Intent Patterns

For intent matching, include patterns for all supported languages:

```
INTENT_MAPPINGS:
  help:
    patterns:
      en: [help, assist, support, question]
      es: [ayuda, asistencia, soporte, pregunta]
      fr: [aide, assistance, support, question]
    route_to: FAQ_Handler

  goodbye:
    patterns:
      en: [bye, goodbye, thanks, done]
      es: [adiós, gracias, chao, hasta luego]
      fr: [au revoir, merci, à bientôt]
    route_to: Farewell_Handler
```

Or use a semantic intent classifier that handles multiple languages:

```
ROUTING:
| Pri | Condition      | Target        | Flags |
|-----|----------------|---------------|-------|
| 3   | user.authenticated | ?semantic_intent | |

INTENT_MAPPINGS:
  help:
    semantic: true  # Uses LLM-based classification
    route_to: FAQ_Handler
```

## Best Practices

1. **Never hardcode language in DSL**: Use `${session.locale}` references
2. **Keep translations in template files**: Easier to maintain and update
3. **Use locale-aware formatting functions**: `format_date()`, `format_currency()`
4. **Support language detection**: Let the system detect from user input
5. **Plan for fallback**: What happens if a template is missing for a locale?
6. **Consider right-to-left languages**: If supporting Arabic, Hebrew, etc.

## Fallback Strategy

Configure fallback behavior when localized content is unavailable:

```yaml
# project.config.yaml
extensions:
  localization:
    fallback_strategy: 'parent_then_default'
    # Options:
    # - "default": Always fall back to default_locale
    # - "parent": es-EC → es → default
    # - "parent_then_default": Try parent first, then default
    # - "error": Fail if exact locale not found
```

## Example: Locale-Aware Greeting Agent

```
AGENT: Greeter
VERSION: 1.0.0
DESCRIPTION: Greets users in their preferred language

STEPS:
  1. GREET
     RESPOND template("welcome",
       locale: session.locale,
       greeting: time_based_greeting(session.locale)
     )
     WAIT_INPUT → 2

  2. DETECT_LANGUAGE
     CONDITION: session.detected_language != session.locale
       TRUE  → 2.1
       FALSE → 3

  2.1. OFFER_LANGUAGE_SWITCH
     RESPOND template("language_switch_offer",
       detected: session.detected_language,
       current: session.locale
     )
     WAIT_INPUT
       POSITIVE → 2.2
       NEGATIVE → 3

  2.2. SWITCH_LANGUAGE
     SET session.locale = session.detected_language
     RESPOND template("language_switched", locale: session.locale)
     → 3

  3. CONTINUE
     SIGNAL: COMPLETE
```

---

## Implementation Status

| Component          | Status             | Notes                                |
| ------------------ | ------------------ | ------------------------------------ |
| ABL syntax design  | ✅ Complete        | Documented above                     |
| Parser support     | ❌ Not implemented | Requires grammar extension           |
| IR schema          | ❌ Not defined     | Need `LocaleConfig` type             |
| Template loading   | ❌ Not implemented | Requires template service            |
| Language detection | ❌ Not implemented | LLM-based or library                 |
| Format functions   | ❌ Not implemented | `format_date()`, `format_currency()` |

### What's Needed to Implement

1. **Template system**: Load locale-specific response templates
2. **Session variables**: `session.locale`, `session.detected_language`
3. **Format helpers**: Locale-aware date/currency/number formatting
4. **Language detection**: Optional LLM-based or library-based detection

### Priority

**Low** - Single-language deployments work without this. Multi-language support is enterprise feature.

---

## Test Coverage

No tests exist for this extension yet. When implemented:

- [ ] Locale detection from session
- [ ] Template loading by locale
- [ ] Fallback chain (es-EC → es → en)
- [ ] Format functions with locale
- [ ] Language switch mid-conversation
