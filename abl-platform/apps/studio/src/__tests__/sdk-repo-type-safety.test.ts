import { describe, expectTypeOf, it } from 'vitest';
import {
  createPublicApiKey,
  findActiveSdkChannelById,
  findDebugTokens,
  findPublicApiKeys,
  findWidgetConfig,
  updatePublicApiKey,
  upsertWidgetConfig,
} from '@/repos/sdk-repo';

describe('sdk-repo type safety', () => {
  it('exposes typed public API key filters and records', () => {
    type PublicApiKeyWhere = Parameters<typeof findPublicApiKeys>[0];
    type PublicApiKeyRecord = Awaited<ReturnType<typeof findPublicApiKeys>>[number];
    type PublicApiKeyCreateInput = Parameters<typeof createPublicApiKey>[2];
    type PublicApiKeyUpdateInput = Parameters<typeof updatePublicApiKey>[3];

    expectTypeOf<PublicApiKeyWhere>().toMatchTypeOf<{
      id?: string;
      projectId?: string;
      tenantId?: string;
      keyHash?: string;
      isActive?: boolean;
    }>();

    expectTypeOf<PublicApiKeyRecord['allowedOrigins']>().toEqualTypeOf<string[] | null>();
    expectTypeOf<PublicApiKeyRecord['permissions']>().toEqualTypeOf<{
      chat: boolean;
      voice: boolean;
    } | null>();

    expectTypeOf<PublicApiKeyCreateInput>().toMatchTypeOf<{
      keyPrefix: string;
      keyHash: string;
      name: string;
      allowedOrigins?: string[] | null;
      permissions?: { chat: boolean; voice: boolean } | null;
      expiresAt?: Date | null;
      isActive?: boolean;
    }>();

    expectTypeOf<PublicApiKeyUpdateInput>().toMatchTypeOf<{
      isActive?: boolean;
      lastUsedAt?: Date | null;
      expiresAt?: Date | null;
    }>();
  });

  it('rejects mongo-style operator injection at compile time', () => {
    type PublicApiKeyWhere = Parameters<typeof findPublicApiKeys>[0];

    const safeWhere: PublicApiKeyWhere = {
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      isActive: true,
    };

    expectTypeOf(safeWhere).toEqualTypeOf<PublicApiKeyWhere>();

    // @ts-expect-error unsafe mongo operator objects are not part of the repo contract
    const unsafeWhere: PublicApiKeyWhere = { $where: 'this.isActive === true' };
    void unsafeWhere;
  });

  it('keeps widget, channel, and debug token contracts typed', () => {
    type DebugTokenWhere = Parameters<typeof findDebugTokens>[0];
    type DebugTokenRecord = Awaited<ReturnType<typeof findDebugTokens>>[number];
    type WidgetConfigRecord = NonNullable<Awaited<ReturnType<typeof findWidgetConfig>>>;
    type SdkChannelRecord = NonNullable<Awaited<ReturnType<typeof findActiveSdkChannelById>>>;
    type WidgetUpsertInput = Parameters<typeof upsertWidgetConfig>[2];

    expectTypeOf<DebugTokenWhere['expiresAt']>().toMatchTypeOf<
      Date | { gt?: Date; gte?: Date; lt?: Date; lte?: Date } | undefined
    >();
    expectTypeOf<DebugTokenRecord['scopes']>().toEqualTypeOf<string[]>();
    expectTypeOf<WidgetConfigRecord['tenantId']>().toEqualTypeOf<string>();
    expectTypeOf<SdkChannelRecord['publicApiKeyId']>().toEqualTypeOf<string>();
    expectTypeOf<WidgetUpsertInput['create']>().toMatchTypeOf<{
      channelId: string | null;
      mode: string;
      position: string;
      welcomeMessage: string | null;
      placeholderText: string | null;
      voiceEnabled: boolean;
      chatEnabled: boolean;
    }>();
  });
});
