/**
 * Lua Script Definitions for the Circuit Breaker.
 *
 * Scripts are loaded from disk at module init via top-level `await`, then
 * exposed as `LuaScript` constants for `runLuaScript()` from
 * `@agent-platform/redis`. We do NOT call `redis.defineCommand` — that path
 * is incompatible with `Cluster` and bypasses the cluster-aware error wrapping
 * (CROSSSLOT detection, NOSCRIPT handling) provided by `runLuaScript`.
 *
 * `numberOfKeys` matches the original `defineCommand` declarations.
 */

import type { LuaScript } from '@agent-platform/redis';
import {
  CHECK_STATE_LUA,
  FORCE_RESET_LUA,
  RECORD_FAILURE_LUA,
  RECORD_SUCCESS_LUA,
} from './generated-lua.js';

export const BREAKER_RECORD_FAILURE: LuaScript = {
  name: 'breakerRecordFailure',
  body: RECORD_FAILURE_LUA,
  numberOfKeys: 5,
};

export const BREAKER_RECORD_SUCCESS: LuaScript = {
  name: 'breakerRecordSuccess',
  body: RECORD_SUCCESS_LUA,
  numberOfKeys: 5,
};

export const BREAKER_CHECK_STATE: LuaScript = {
  name: 'breakerCheckState',
  body: CHECK_STATE_LUA,
  numberOfKeys: 3,
};

export const BREAKER_FORCE_RESET: LuaScript = {
  name: 'breakerForceReset',
  body: FORCE_RESET_LUA,
  numberOfKeys: 5,
};
