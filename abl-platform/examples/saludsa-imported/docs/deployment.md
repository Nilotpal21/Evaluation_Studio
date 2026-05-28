# Deployment Guide

## Prerequisites

- ABL runtime environment
- Tool implementations for all defined tools

## Tool Implementations Required

The following tools need backend implementations:

### `saludsa_mcp_server_validate_otp`

- **Description**: Validate OTP using only user-provided OTP; other parameters are fixed in the code
- **Parameters**: `codigo_otp_generado: string`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_password_reset`

- **Description**: This tool reset the password of the user
- **Parameters**: `codigo_tarea: string (optional)`, `password_reset_type: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_validate_task_eligibility`

- **Description**: Checks eligibility for a given business task and updates Zendesk for eligible and ineligible cases
- **Parameters**: `codigo_tarea: string`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_update_zendesk_ticket`

- **Description**: Updates an existing Zendesk ticket using field mappings and business logic
- **Parameters**: `usecase: string`, `channel: string (optional)`, `transfer_type: string (optional)`, `transfer_reason: string (optional)`, `lpd_accept: boolean (optional)`, `requerimientos_samy: string (optional)`, `region: string (optional)`, `subject: string (optional)`, `note: string (optional)`, `public_note: string (optional)`, `status: string (optional)`, `client_id: string (optional)`, `client_name: string (optional)`, `client_email: string (optional)`, `client_phone: string (optional)`, `requester_name: string (optional)`, `requester_email: string (optional)`, `new_ticket: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_validateoutofhours`

- **Description**: This tool validates after-hours service based on the queue
- **Parameters**: `codigo_tarea: string`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_send_email_template`

- **Description**: Send email template to the user
- **Parameters**: `use_case_name: string`, `codigo_tarea: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_pending_payments`

- **Description**: Gets pending payment amounts with full classification and account holder data
- **Parameters**: `channel: string (optional)`, `contract_id: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_steps_for_refund`

- **Description**: steps for refund
- **Parameters**: `channel: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_get_security_questions`

- **Description**: Returns one random security question based on user role (Holder, Beneficiary, or Payer)
- **Parameters**: `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_sending_contracts`

- **Description**: sending contracts
- **Parameters**: `channel: string (optional)`, `contract_id: string (optional)`, `is_auth_qverified: boolean (optional)`, `inbound_number: string (optional)`, `outbound_number: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_validar_elegibilidad_tarea`

- **Description**: Checks eligibility for a given business task using parameters from ConsultarParametroByTarea
- **Parameters**: `codigo_tarea: string`, `is_pcacertificate_required: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_contract_status`

- **Description**: contracts status
- **Parameters**: `channel: string (optional)`, `is_auth_qverified: boolean (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_resend_refund_settlement`

- **Description**: Resends the settlement for a settled refund envelope
- **Parameters**: `envelope_number: string`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_prioritize_refund_zendesk`

- **Description**: Marks a delayed refund case as priority in Zendesk using the envelope number
- **Parameters**: `envelope_number: string`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_check_refund_status`

- **Description**: Gets refund status using envelope number, amount, or date across all user contracts
- **Parameters**: `channel: string (optional)`, `envelope_number: string (optional)`, `amount: number (optional)`, `date: string (optional)`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_check_coverage_eligibility`

- **Description**: This tool used to check the eligibility for the coverage or travel.
- **Parameters**: `codigo_tarea: string (optional)`, `certificate_type: string`, `session_id: string`
- **Returns**: `object`

### `saludsa_mcp_server_get_coverage_certificate`

- **Description**: This tool used to get the coverage or travel certificate based on eligibility
- **Parameters**: `certificate_type: string`, `contract_number: string (optional)`, `beneficiary_name: string (optional)`, `start_date: string (optional)`, `end_date: string (optional)`, `channel: string (optional)`, `inbound_number: string (optional)`, `outbound_number: string (optional)`, `session_id: string`
- **Returns**: `object`

## Loading the Project

1. Point your ABL runtime to the project directory
2. The supervisor file is the entry point
3. Ensure all tool implementations are registered

## Testing

1. Start with simple test messages
2. Verify routing (for multi-agent systems)
3. Test error handling paths
4. Verify tool integrations
