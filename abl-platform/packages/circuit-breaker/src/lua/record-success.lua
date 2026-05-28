-- record-success.lua
--
-- Atomically records a success and checks if the circuit should close
-- (when in HALF_OPEN state).
--
-- KEYS[1] = breaker:{level}:{key}:successes      (sorted set)
-- KEYS[2] = breaker:{level}:{key}:state            (string)
-- KEYS[3] = breaker:{level}:{key}:failures        (sorted set)
-- KEYS[4] = breaker:{level}:{key}:half_open_count (string/counter)
-- KEYS[5] = breaker:{level}:{key}:opened_at        (string)
--
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = window start timestamp (now - monitorWindow)
-- ARGV[3] = success threshold (for HALF_OPEN → CLOSED transition)
-- ARGV[4] = unique nonce (counter to avoid member collision in same ms)
--
-- Returns: {state, success_count}

local successes_key    = KEYS[1]
local state_key        = KEYS[2]
local failures_key     = KEYS[3]
local half_open_key    = KEYS[4]
local opened_at_key    = KEYS[5]

local now              = tonumber(ARGV[1])
local window_start     = tonumber(ARGV[2])
local success_threshold = tonumber(ARGV[3])
local nonce            = ARGV[4] or '0'

-- 1. Record the success (nonce ensures uniqueness within same ms)
redis.call('ZADD', successes_key, now, tostring(now) .. ':' .. nonce)

-- 2. Trim old entries
redis.call('ZREMRANGEBYSCORE', successes_key, '-inf', window_start)

-- 3. Get current state
local state = redis.call('GET', state_key) or 'CLOSED'
local success_count = redis.call('ZCARD', successes_key)

-- 4. If HALF_OPEN, check for recovery
if state == 'HALF_OPEN' then
  -- Decrement the half-open concurrent counter
  local current = tonumber(redis.call('GET', half_open_key) or '0')
  if current > 0 then
    redis.call('DECR', half_open_key)
  end

  -- Count successes since the circuit was opened
  -- (only recent successes count toward recovery)
  local opened_at = tonumber(redis.call('GET', opened_at_key) or '0')
  local recent_successes = redis.call('ZCOUNT', successes_key, opened_at, '+inf')

  if recent_successes >= success_threshold then
    -- Circuit recovered — close it
    redis.call('SET', state_key, 'CLOSED')
    -- Clean up all tracking data for fresh start
    redis.call('DEL', failures_key)
    redis.call('DEL', successes_key)
    redis.call('DEL', half_open_key)
    redis.call('DEL', opened_at_key)
    return {'CLOSED', recent_successes}
  end
end

return {state, success_count}
