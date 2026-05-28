-- force-reset.lua
--
-- Manually forces a circuit breaker into a target state.
-- Used by ops teams for emergency overrides.
--
-- KEYS[1] = breaker:{level}:{key}:state
-- KEYS[2] = breaker:{level}:{key}:failures
-- KEYS[3] = breaker:{level}:{key}:successes
-- KEYS[4] = breaker:{level}:{key}:half_open_count
-- KEYS[5] = breaker:{level}:{key}:opened_at
--
-- ARGV[1] = target state: 'CLOSED', 'OPEN', or 'HALF_OPEN'
-- ARGV[2] = current timestamp (ms)
-- ARGV[3] = reset timeout (ms, for OPEN TTL)
--
-- Returns: {new_state, 'forced'}

local state_key     = KEYS[1]
local failures_key  = KEYS[2]
local successes_key = KEYS[3]
local half_open_key = KEYS[4]
local opened_at_key = KEYS[5]

local target_state  = ARGV[1]
local now           = tonumber(ARGV[2])
local reset_timeout = tonumber(ARGV[3])

if target_state == 'CLOSED' then
  -- Force close: wipe all tracking data
  redis.call('SET', state_key, 'CLOSED')
  redis.call('DEL', failures_key)
  redis.call('DEL', successes_key)
  redis.call('DEL', half_open_key)
  redis.call('DEL', opened_at_key)
  return {'CLOSED', 'forced'}

elseif target_state == 'OPEN' then
  -- Force open: set state + timestamp, add safety TTL
  redis.call('SET', state_key, 'OPEN')
  redis.call('SET', opened_at_key, tostring(now))
  local ttl_ms = reset_timeout * 2
  redis.call('PEXPIRE', state_key, ttl_ms)
  redis.call('PEXPIRE', opened_at_key, ttl_ms)
  return {'OPEN', 'forced'}

elseif target_state == 'HALF_OPEN' then
  -- Force half-open: allow probes through
  redis.call('DEL', failures_key)
  redis.call('DEL', successes_key)
  redis.call('SET', state_key, 'HALF_OPEN')
  redis.call('SET', half_open_key, '0')
  redis.call('SET', opened_at_key, tostring(now))
  return {'HALF_OPEN', 'forced'}
end

return {'UNKNOWN', 'invalid_target_state'}
