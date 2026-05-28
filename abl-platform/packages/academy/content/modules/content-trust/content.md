# Content & Trust

> **Estimated time**: 17 minutes | **Prerequisites**: Operations & Deployment

## Learning Objectives

After completing this module, you will be able to:

- Describe the major rich content types and how they adapt to different delivery channels
- Explain how carousel content works, including channel-specific rendering like WhatsApp
- Understand VOICE blocks and how SSML enables precise speech control
- Describe the TEMPLATES block for reusable, multi-format content definitions
- Explain the BYOK envelope encryption model and how crypto-shredding supports compliance

## Rich Content: Adapting to Every Channel

When an agent responds to a user, the response needs to look right on whatever platform the user is on -- a web browser, a WhatsApp message, a Slack workspace, a Microsoft Teams conversation, or a voice call. The Agent Platform solves this by allowing agents to define **multiple format variants** of the same response, with the runtime automatically selecting the right one for the delivery channel.

### How Rich Content Works

A single agent response can include:

- **Plain text** -- the universal fallback that works everywhere
- **Markdown** -- formatted text with tables and headers for web channels
- **Adaptive Cards** -- structured interactive content for Microsoft Teams
- **Slack Block Kit** -- formatted messages for Slack workspaces
- **WhatsApp interactive messages** -- buttons and lists for WhatsApp
- **HTML** -- web-specific formatting
- **Carousels** -- scrollable card collections across supported channels
- **Voice configuration** -- speech-optimized output for phone calls

The runtime selects the format that matches the connected channel. If a channel-specific format is not provided, it falls back to the plain text response.

### Carousel Content

> **Key Concept**: A **carousel** is a scrollable collection of cards, each with a title, subtitle, optional image, and action buttons. Carousels are ideal for presenting options -- product selections, hotel listings, flight choices, or service packages. The user can scroll horizontally through the cards and click buttons to make selections. Carousels render natively on web channels and adapt to platform-specific formats on messaging channels like **WhatsApp**, where they appear as interactive list messages with structured button options.

What makes carousels powerful for business:

- **Product showcases** -- Display multiple products with images, prices, and "Buy Now" buttons
- **Search results** -- Show hotel, flight, or service options side by side
- **Menu navigation** -- Present category options with visual icons and descriptions
- **Comparison views** -- Let users browse and select from structured alternatives

Each card in a carousel can include a title, subtitle, image URL, a default action URL (opened when the card is tapped), and one or more action buttons that trigger agent flow steps.

### WhatsApp-Specific Content

WhatsApp supports its own interactive message formats. For WhatsApp channels, agents can deliver:

- **Button messages** -- Up to 3 quick-reply buttons for simple choices
- **List messages** -- Expandable lists with sections, rows, and descriptions for more complex selections
- **Media messages** -- Images, documents, audio, and video

These WhatsApp-specific blocks ensure your agent delivers a native experience on the platform rather than falling back to plain text.

## Voice Content: VOICE Blocks and SSML

Voice channels require a fundamentally different approach to content delivery. What reads well on screen often sounds wrong when spoken aloud. The platform addresses this with dedicated voice configuration that can accompany any response.

### VOICE Blocks

> **Key Concept**: **VOICE blocks** provide voice-optimized output alongside the standard text response. A VOICE block can include three types of content: **SSML markup** for precise speech control with TTS engines, **natural language instructions** for AI voice platforms (like "speak slowly and clearly, emphasizing the confirmation number"), and **plain text** optimized for speech (spelling out abbreviations, using spoken numbers instead of digits). The runtime uses VOICE content when the session is on a voice channel, falling back to the standard text response for non-voice channels.

### SSML: Precise Speech Control

> **Key Concept**: **SSML (Speech Synthesis Markup Language)** gives you precise control over how text-to-speech engines pronounce content. This is critical for business information that must be communicated accurately over the phone -- confirmation numbers, currency amounts, dates, and account numbers. SSML tags let you control pronunciation of special content (dates, currency, spelled-out characters), speech rate and pitch, pauses between segments, and emphasis on important words.

Common SSML use cases in business:

| Scenario             | What SSML Does                                                       | Why It Matters                              |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| Confirmation numbers | Reads character by character: "W-R-2-0-2-4-8-8-4-3-1"                | Prevents misheard reference codes           |
| Currency amounts     | Pronounces "$50,000 USD" correctly as a monetary value               | Avoids ambiguity with large numbers         |
| Dates                | Reads "12/15/2025" as "December fifteenth, two thousand twenty-five" | Prevents confusion between date formats     |
| Pauses               | Inserts natural breaks between information segments                  | Gives the caller time to absorb information |
| Pace control         | Slows down for important details, speeds up for routine information  | Matches natural conversational rhythm       |

SSML is supported by all major TTS engines including Google, Azure, and Amazon Polly. For AI voice platforms (OpenAI Realtime, Gemini Live), natural language instructions achieve similar results through style guidance rather than markup.

## Templates: Reusable Multi-Format Content

> **Key Concept**: The **TEMPLATES block** defines reusable, named response definitions with **multi-format variants** and dynamic interpolation. A single template can include a default text version, a Markdown version for web display, an HTML version for email, an Adaptive Card version for Teams, and voice instructions for phone channels. Templates are referenced from any agent response, making them the standard approach for content that appears in multiple places or across multiple channels.

### Why Templates Matter for Business

Templates solve several practical problems:

- **Consistency** -- A booking confirmation looks the same whether it is displayed in a web widget, sent via WhatsApp, or read over the phone
- **Maintainability** -- Update the template in one place and the change applies everywhere it is referenced
- **Localization readiness** -- Template structures make it straightforward to add language variants later
- **Channel optimization** -- Each format variant is tailored to its platform, avoiding the "one size fits none" problem

### Template Interpolation

Templates support dynamic values using the `{{variable_name}}` syntax and conditional sections using `{{#if variable}}...{{/if}}`. This means a single booking confirmation template can adapt to whether the customer has a loyalty tier, whether fees apply, and what information is available -- all without duplicating the template.

### Example: A Booking Confirmation Template

A well-designed template might include:

- **Default** -- Plain text with key facts formatted for readability
- **Markdown** -- A formatted table with headers for web display
- **HTML** -- A styled card layout for email delivery
- **Voice instructions** -- Guidance to congratulate the user and read the hotel name and total clearly

The agent references this template with a single line, and the runtime selects the right format for the delivery channel.

## Encryption and Data Protection

Trust is the foundation of any enterprise platform that handles sensitive data. The Agent Platform implements a comprehensive encryption architecture designed to meet the strictest compliance requirements.

### Envelope Encryption: How BYOK Works

> **Key Concept**: **BYOK (Bring Your Own Key) envelope encryption** uses a two-layer key hierarchy. Your organization provides a **Key Encryption Key (KEK)** -- a master key that stays in your own cloud Key Management Service (AWS KMS, Azure Key Vault, or GCP Cloud KMS). The platform generates **Data Encryption Keys (DEKs)** that encrypt your actual data. DEKs are themselves encrypted ("wrapped") by your KEK before storage. This means the platform never has access to your raw master key, and you can **revoke access at any time** by revoking the KEK in your cloud provider.

The layered approach provides several security guarantees:

- **Key custody** -- You own and control the master encryption key
- **Scope isolation** -- Each unique combination of tenant, project, and environment gets its own independent DEK, so a compromise in one scope does not affect others
- **Automatic rotation** -- DEKs rotate automatically based on time (default: every 24 hours) or usage ceiling (default: approximately 1 billion operations)
- **Independent audit trail** -- Your cloud provider logs every key usage event

### Crypto-Shredding: Compliance Erasure

> **Key Concept**: **Crypto-shredding** is the ability to permanently destroy all data associated with a tenant or contact by deleting their encryption keys, without needing to locate and delete individual records. When a DEK is destroyed, all data encrypted by that key becomes permanently unreadable. This supports GDPR right-to-erasure requirements, tenant deletion (all data becomes unrecoverable without modifying individual records), and environment decommissioning (destroy staging DEKs to ensure no test data survives).

The DEK lifecycle follows NIST SP 800-57 standards:

| Status           | Behavior                                                                      |
| ---------------- | ----------------------------------------------------------------------------- |
| **Active**       | Used for new encryptions and decryptions                                      |
| **Decrypt only** | Rotated -- can decrypt existing data but no new encryptions                   |
| **Destroyed**    | Wrapped DEK zeroed -- data encrypted by this key is permanently unrecoverable |

### FIPS 140-3 Level 3 Compliance

> **Key Concept**: For organizations with the highest security requirements, the platform supports **FIPS 140-3 Level 3** compliance through **Azure Managed HSM**. FIPS 140-3 Level 3 means the encryption keys are protected by hardware security modules (HSMs) that are tamper-evident and tamper-resistant, with physical security mechanisms that prevent unauthorized access to the key material. This is the standard required by many government agencies, financial institutions, and healthcare organizations.

The platform supports four compliance levels:

| Level          | Description                                        | Requirement                                                  |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------ |
| **Standard**   | Software-protected keys with configurable rotation | Default -- suitable for most use cases                       |
| **PCI DSS**    | Payment card industry compliance                   | Requires cloud KMS provider, enforced rotation               |
| **HIPAA**      | Healthcare data protection                         | Requires cloud KMS provider, mandatory audit logging         |
| **FIPS 140-3** | Highest security certification                     | Requires HSM-backed keys (Azure Managed HSM or AWS CloudHSM) |

### What Gets Encrypted

| Data Category      | Encryption Method                         |
| ------------------ | ----------------------------------------- |
| Data in transit    | TLS encryption for all communication      |
| Data at rest       | Two-layer envelope encryption (DEK + KEK) |
| Credential storage | Per-tenant AES-256-GCM encryption         |
| Session state      | Tenant-scoped DEK encryption              |
| Analytics data     | Field-level encryption in ClickHouse      |
| Queue payloads     | Encrypted before enqueuing in Redis       |

## Putting It All Together: A Business Scenario

Consider a financial services company deploying agents across web, mobile, WhatsApp, and phone channels:

1. **Rich content** -- Customers see investment portfolio summaries as Adaptive Cards in Teams, carousels on the web widget, and interactive lists on WhatsApp
2. **Voice** -- Phone callers hear account balances read with SSML precision ("your balance is forty-two thousand, three hundred and fifty dollars"), with natural pauses between information segments
3. **Templates** -- Transaction confirmation templates are defined once and rendered appropriately on every channel
4. **Encryption** -- All customer data is encrypted with BYOK keys managed in the company's Azure Key Vault
5. **Compliance** -- FIPS 140-3 Level 3 via Azure Managed HSM satisfies regulatory requirements, and crypto-shredding ensures clean data erasure when customers exercise their right to be forgotten

## Key Takeaways

- Carousel rich content presents scrollable cards with images and action buttons, rendering natively on web and adapting to WhatsApp-specific interactive formats
- BYOK envelope encryption keeps your master key in your own cloud KMS while the platform manages data encryption keys -- you can revoke access at any time by revoking the KEK
- VOICE blocks with SSML provide precise control over how information is spoken on voice channels -- critical for confirmation numbers, currency, and dates
- FIPS 140-3 Level 3 compliance via Azure Managed HSM meets the highest security certification requirements using tamper-resistant hardware security modules
- The TEMPLATES block creates reusable, multi-format content definitions that render appropriately on every channel while maintaining consistency and simplifying maintenance

## What's Next

You have completed the core modules of the Learning Academy. Review the **Reference & Community** section for additional resources, or explore the platform hands-on in Studio.
