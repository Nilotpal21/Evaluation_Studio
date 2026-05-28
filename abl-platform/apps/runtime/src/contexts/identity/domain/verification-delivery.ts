/**
 * Verification Delivery Service Port
 *
 * Defines the port interface for delivering verification codes (OTP, magic-link tokens)
 * to end users via various channels (email, SMS). Implementations are provided as
 * adapters in the infrastructure layer.
 *
 * This is a pure interface file with no external dependencies — following the hexagonal
 * architecture pattern where domain ports are dependency-free.
 */

export interface VerificationDeliveryService {
  /**
   * Deliver a verification code to the specified recipient.
   *
   * @param channel - The delivery channel ('email' or 'sms')
   * @param to - The recipient address (email address or phone number)
   * @param code - The verification code or magic-link token to deliver
   * @returns Result indicating whether delivery succeeded, with optional error message
   */
  deliverCode(
    channel: 'email' | 'sms',
    to: string,
    code: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ delivered: boolean; error?: string }>;
}
