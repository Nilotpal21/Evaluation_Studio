import { describe, it, expect } from 'vitest';
import {
  DESTINATION_REGISTRY,
  isDestinationId,
  type DestinationId,
} from '../../pipeline/contracts/destination-contract.js';

describe('DestinationContract / DESTINATION_REGISTRY', () => {
  it('exposes exactly the four known destinations', () => {
    const ids = Object.keys(DESTINATION_REGISTRY).sort();
    expect(ids).toEqual(['callback', 'clickhouse', 'mongodb', 'none']);
  });

  it('marks only clickhouse as previewable', () => {
    expect(DESTINATION_REGISTRY.clickhouse.previewable).toBe(true);
    expect(DESTINATION_REGISTRY.mongodb.previewable).toBe(false);
    expect(DESTINATION_REGISTRY.callback.previewable).toBe(false);
    expect(DESTINATION_REGISTRY.none.previewable).toBe(false);
  });

  it('validates ClickHouse table format as database.table', () => {
    const regex = DESTINATION_REGISTRY.clickhouse.table.regex!;
    expect(regex.test('abl_platform.conversation_sentiment')).toBe(true);
    expect(regex.test('test_custom_politeness')).toBe(false);
    expect(regex.test('abl_platform.')).toBe(false);
    expect(regex.test('.foo')).toBe(false);
  });

  it('validates MongoDB collection format as bare identifier', () => {
    const regex = DESTINATION_REGISTRY.mongodb.table.regex!;
    expect(regex.test('test_custom_politeness')).toBe(true);
    expect(regex.test('abl_platform.conversation_sentiment')).toBe(false);
  });

  it('requires outputSchema only for ClickHouse', () => {
    expect(DESTINATION_REGISTRY.clickhouse.requiresOutputSchema).toBe(true);
    expect(DESTINATION_REGISTRY.mongodb.requiresOutputSchema).toBe(false);
  });

  it('does not require table or collection for shared custom result destinations', () => {
    expect(DESTINATION_REGISTRY.clickhouse.table.required).toBe(false);
    expect(DESTINATION_REGISTRY.mongodb.table.required).toBe(false);
  });

  it('isDestinationId narrows only for known IDs', () => {
    expect(isDestinationId('clickhouse')).toBe(true);
    expect(isDestinationId('postgres')).toBe(false);
    expect(isDestinationId(undefined)).toBe(false);
  });

  it('DestinationId literal union contains all registry keys', () => {
    const _typeCheck: DestinationId = 'clickhouse';
    expect(_typeCheck).toBe('clickhouse');
  });
});
