// apps/runtime/src/__tests__/e2e/ai4hc-payer/fixtures/provider-metadata.ts

/**
 * Provider and member test fixtures for AI4HC Payer E2E tests.
 * Data sourced from live Kore.ai Data Tables (bots.kore.ai).
 *
 * Data Tables API:
 *   Base URL: https://bots.kore.ai/api/public/tables
 *   Tables: providerinfo, memberinfo, eligibilitymembersinfo, claiminfo,
 *           dependentinfo, eligibilitydependentsinfo, preauthorizationservices
 */

/** Real providers from providerinfo table */
export const TEST_PROVIDERS = {
  /** Provider 1: PID=485736201, NPI=1922032772, zip=32003, taxonomy=207NE5471X */
  PROVIDER_1: {
    providerId: '485736201',
    npiId: '1922032772',
    zipCode: 32003,
    taxonomyCode: '207NE5471X',
    medicaidId: 58964123,
  },
  /** Provider 2: PID=567890198, NPI=1811921661, zip=32901, taxonomy=207BR4638X */
  PROVIDER_2: {
    providerId: '567890198',
    npiId: '1811921661',
    zipCode: 32901,
    taxonomyCode: '207BR4638X',
    medicaidId: 77367241,
  },
  /** Invalid format (too short) */
  INVALID_SHORT_ID: '12345',
  /** Non-existent but valid 9-digit format */
  NONEXISTENT_PROVIDER_ID: '999999999',
} as const;

/** Real members from eligibilitymembersinfo + claiminfo tables */
export const TEST_MEMBERS = {
  /** Member 7823564: Medical Care Plan (Active), has Paid claims */
  MEMBER_WITH_PLAN: '7823564',
  /** Member 8934675: Medical Care Plan + Family Care Plan (both Active), has Paid claims */
  MEMBER_MULTI_PLAN: '8934675',
  /** Member 7823566: Dental Care Plan (Active), has Denied claims ($11,500) */
  MEMBER_WITH_DENIED_CLAIMS: '7823566',
  /** Member 7823565: has Submitted claims ($1,200) */
  MEMBER_WITH_SUBMITTED_CLAIMS: '7823565',
  /** Member 7823588: Medical + Family + Dental (Active), has Denied claims */
  MEMBER_TRIPLE_PLAN: '7823588',
  /** Non-existent member */
  NONEXISTENT_MEMBER: '9999999',
} as const;

/** Real claim data samples from claiminfo table */
export const TEST_CLAIMS = {
  /** Denied claim: member 7823566, amount $11,500 */
  DENIED_CLAIM: {
    memberId: '7823566',
    claimNumber: '6392231048266',
    claimStatus: 'Denied',
    claimAmount: '11500',
  },
  /** Paid claim: member 8934675, amount $200 */
  PAID_CLAIM: {
    memberId: '8934675',
    claimNumber: '6008166253775',
    claimStatus: 'Paid',
    claimAmount: '200',
  },
  /** Submitted claim: member 7823565, amount $1,200 */
  SUBMITTED_CLAIM: {
    memberId: '7823565',
    claimNumber: '7662610712205',
    claimStatus: 'Submitted',
    claimAmount: '1200',
  },
} as const;

/** Expected provider data after successful authentication */
export interface ProviderProfile {
  providerId: number;
  npiId: number;
  taxonomyCode: string;
  medicaidId: number;
  zipCode: number;
}

/** Data Tables API config */
export const DATA_TABLES_CONFIG = {
  baseUrl: 'https://bots.kore.ai/api/public/tables',
  token:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkhDUGF5ZXIiLCJhcHBJZCI6ImNzLWEwMjdmMjc1LTVmMzAtNTNhMS1hY2MxLWRmYWVhMTc5MTRhMiJ9.I9LShNlVzSgWejTOhYGvbkTk555yfryuxwszuswH1Yw',
  tables: [
    'providerinfo',
    'memberinfo',
    'eligibilitymembersinfo',
    'claiminfo',
    'dependentinfo',
    'eligibilitydependentsinfo',
    'preauthorizationservices',
  ],
} as const;
