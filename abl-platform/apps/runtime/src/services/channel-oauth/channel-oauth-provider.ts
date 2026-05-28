/**
 * Channel OAuth Provider Interface
 *
 * Each channel that supports OAuth implements this interface.
 * The ChannelOAuthService delegates to providers for channel-specific logic.
 */

/** Result returned by a provider after successful OAuth code exchange */
export interface ChannelOAuthResult {
  /** Credentials to encrypt and store in ChannelConnection (e.g. { bot_token, signing_secret }) */
  credentials: Record<string, string>;

  /** External identifier for the connection (e.g. "T123ABC:A456XYZ" for Slack) */
  externalIdentifier: string;

  /** Suggested display name (e.g. "Slack - My Workspace") */
  displayName: string;

  /** Extra metadata for the Studio connection form */
  metadata: Record<string, unknown>;
}

/** Interface that each OAuth-capable channel must implement */
export interface ChannelOAuthProvider {
  /** Channel type identifier — must match ChannelConnection.channelType */
  readonly channelType: string;

  /** Build the provider-specific authorization URL */
  buildAuthorizeUrl(state: string, redirectUri: string): string;

  /** Exchange the authorization code for credentials + metadata */
  exchangeCode(code: string, redirectUri: string): Promise<ChannelOAuthResult>;
}
