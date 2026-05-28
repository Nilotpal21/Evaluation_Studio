import type { ChannelType, SendResult } from '../../channels/types.js';
import type { RuntimeErrorEnvelope } from '../execution/runtime-error-envelope.js';

export type ChannelDeliveryFailureCategory = 'configuration' | 'metadata' | 'provider' | 'network';

export type ChannelDeliveryFailureCode =
  | 'CHANNEL_DELIVERY_CONFIGURATION'
  | 'CHANNEL_DELIVERY_METADATA'
  | 'CHANNEL_PROVIDER_REJECTED'
  | 'CHANNEL_PROVIDER_UNAVAILABLE'
  | 'CHANNEL_DELIVERY_TIMEOUT'
  | 'CHANNEL_DELIVERY_FAILED';

export interface ChannelDeliveryDiagnostic {
  source: 'channel_delivery';
  category: ChannelDeliveryFailureCategory;
  severity: 'error';
  code: ChannelDeliveryFailureCode;
  message: string;
  channelType: ChannelType;
  provider: string;
  httpStatus?: number;
  providerErrorCode?: string;
  retryable: boolean;
  errorEnvelope: RuntimeErrorEnvelope;
}

export interface BuildChannelDeliveryFailureParams {
  channelType: ChannelType;
  provider: string;
  category: ChannelDeliveryFailureCategory;
  code: ChannelDeliveryFailureCode;
  operatorMessage: string;
  httpStatus?: number;
  providerErrorCode?: string;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BuildChannelDeliveryLogContextParams {
  channelType: ChannelType;
  provider: string;
  httpStatus?: number;
  providerErrorCode?: string;
  code?: ChannelDeliveryFailureCode;
  errorName?: string;
}

const DELIVERY_FAILED_CUSTOMER_MESSAGE =
  "I'm having trouble delivering that response. Please try again.";

const DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE =
  'This channel is not fully configured for response delivery. Please contact support.';

function customerMessageForCategory(category: ChannelDeliveryFailureCategory): string {
  return category === 'configuration'
    ? DELIVERY_CONFIGURATION_CUSTOMER_MESSAGE
    : DELIVERY_FAILED_CUSTOMER_MESSAGE;
}

function buildOperatorHint(params: BuildChannelDeliveryFailureParams): string {
  const details = [
    `${params.provider} delivery failed for ${params.channelType}`,
    `category=${params.category}`,
    params.httpStatus !== undefined ? `httpStatus=${params.httpStatus}` : undefined,
    params.providerErrorCode ? `providerErrorCode=${params.providerErrorCode}` : undefined,
  ].filter(Boolean);

  return `${details.join(', ')}. ${params.operatorMessage}`;
}

export function buildChannelDeliveryLogContext(
  params: BuildChannelDeliveryLogContextParams,
): Record<string, unknown> {
  return {
    channelType: params.channelType,
    provider: params.provider,
    ...(params.httpStatus !== undefined ? { httpStatus: params.httpStatus } : {}),
    ...(params.providerErrorCode ? { providerErrorCode: params.providerErrorCode } : {}),
    ...(params.code ? { code: params.code } : {}),
    ...(params.errorName ? { errorName: params.errorName } : {}),
  };
}

export function getChannelDeliveryErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function readNonEmptyDeliveryMetadataString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildChannelDeliveryFailure(params: BuildChannelDeliveryFailureParams): SendResult {
  const customerMessage = customerMessageForCategory(params.category);
  const errorEnvelope: RuntimeErrorEnvelope = {
    code: params.code,
    category: 'runtime',
    severity: 'error',
    customer_message: customerMessage,
    operator_hint: buildOperatorHint(params),
  };
  const diagnostic: ChannelDeliveryDiagnostic = {
    source: 'channel_delivery',
    category: params.category,
    severity: 'error',
    code: params.code,
    message: errorEnvelope.operator_hint,
    channelType: params.channelType,
    provider: params.provider,
    ...(params.httpStatus !== undefined ? { httpStatus: params.httpStatus } : {}),
    ...(params.providerErrorCode ? { providerErrorCode: params.providerErrorCode } : {}),
    retryable: params.retryable ?? params.category === 'network',
    errorEnvelope,
  };

  return {
    success: false,
    error: customerMessage,
    metadata: {
      ...params.metadata,
      channelDiagnostic: diagnostic,
      errorEnvelope,
    },
  };
}
