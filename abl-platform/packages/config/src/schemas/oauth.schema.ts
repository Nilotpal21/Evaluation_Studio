import { z } from 'zod';

export const GoogleOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

/** Validate that a URL string uses https and points to an allowed OAuth provider host */
const oauthUrl = (allowedHosts: string[], defaultUrl: string) =>
  z
    .string()
    .default(defaultUrl)
    .refine(
      (val) => {
        // Allow the default template URLs with {tenant} placeholder
        if (val === defaultUrl) return true;
        try {
          const parsed = new URL(val.replace('{tenant}', 'placeholder'));
          return (
            parsed.protocol === 'https:' && allowedHosts.some((h) => parsed.hostname.endsWith(h))
          );
        } catch {
          return false;
        }
      },
      {
        message: `URL must use HTTPS and point to an allowed OAuth provider host (${allowedHosts.join(', ')})`,
      },
    );

export const MicrosoftOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tenantId: z.string().default('common'),
  authorizeUrl: oauthUrl(
    ['login.microsoftonline.com', 'login.microsoft.com'],
    'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
  ),
  tokenUrl: oauthUrl(
    ['login.microsoftonline.com', 'login.microsoft.com'],
    'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  ),
  profileUrl: oauthUrl(['graph.microsoft.com'], 'https://graph.microsoft.com/v1.0/me'),
  scope: z.string().default('openid email profile User.Read'),
  stateCookieTtlSeconds: z.coerce.number().int().default(600),
});

export const LinkedInOAuthConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  authorizeUrl: oauthUrl(
    ['linkedin.com', 'www.linkedin.com'],
    'https://www.linkedin.com/oauth/v2/authorization',
  ),
  tokenUrl: oauthUrl(
    ['linkedin.com', 'www.linkedin.com'],
    'https://www.linkedin.com/oauth/v2/accessToken',
  ),
  profileUrl: oauthUrl(
    ['linkedin.com', 'api.linkedin.com'],
    'https://api.linkedin.com/v2/userinfo',
  ),
  scope: z.string().default('openid profile email'),
  stateCookieTtlSeconds: z.coerce.number().int().default(600),
});

export const OAuthConfigSchema = z.object({
  google: GoogleOAuthConfigSchema.default({}),
  microsoft: MicrosoftOAuthConfigSchema.default({}),
  linkedin: LinkedInOAuthConfigSchema.default({}),
});

export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;
