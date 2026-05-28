-- record-failure.lua
--
-- Atomically records a failure and checks if the circuit should open.
--
-- KEYS[1] = breaker:{level}:{key}:failures      (sorted set)
-- KEYS[2] = breaker:{level}:{key}:successes     (sorted set)
-- KEYS[3] = breaker:{level}:{key}:state          (string)
-- KEYS[4] = breaker:{level}:{key}:opened_at      (string)
-- KEYS[5] = breaker:{level}:{key}:half_open_count (string)
--
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = error identifier (for unique sorted set members)
-- ARGV[3] = window start timestamp (now - monitorWindow)
-- ARGV[4] = failure threshold (absolute count)
-- ARGV[5] = failure rate threshold (percentage, 0-100)
-- ARGV[6] = minimum request count (for rate calculation)
-- ARGV[7] = reset timeout (ms, for TTL safety net)
--
-- Returns: {state, failure_count, total_count, failure_rate}

local failures_key  = KEYS[1]
local successes_key = KEYS[2]
local state_key     = KEYS[3]
local opened_at_key = KEYS[4]
local half_open_key = KEYS[5]

local now             = tonumber(ARGV[1])
local error_id        = ARGV[2]
local window_start    = tonumber(ARGV[3])
local fail_threshold  = tonumber(ARGV[4])
local rate_threshold  = tonumber(ARGV[5])
local min_requests    = tonumber(ARGV[6])
local reset_timeout   = tonumber(ARGV[7])

-- 1. Record the failure (unique member = timestamp:error_id)
local member = tostring(now) .. ':' .. error_id
redis.call('ZADD', failures_key, now, member)

-- 2. Trim entries outside the monitoring window
redis.call('ZREMRANGEBYSCORE', failures_key, '-inf', window_start)
redis.call('ZREMRANGEBYSCORE', successes_key, '-inf', window_start)

-- 3. Count failures and total in window
local failure_count = redis.call('ZCARD', failures_key)
local success_count = redis.call('ZCARD', successes_key)
local total_count = failure_count + success_count

-- 4. Get current state
local state = redis.call('GET', state_key) or 'CLOSED'

local failure_rate = 0
if total_count > 0 then
  failure_rate = math.floor((failure_count / total_count) * 100)
end

-- 5. Any failure while HALF_OPEN immediately re-opens the circuit
if state == 'HALF_OPEN' then
  redis.call('SET', state_key, 'OPEN')
  redis.call('SET', opened_at_key, tostring(now))
  redis.call('SET', half_open_key, '0')

  local ttl_ms = reset_timeout * 2
  redis.call('PEXPIRE', state_key, ttl_ms)
  redis.call('PEXPIRE', opened_at_key, ttl_ms)
  redis.call('PEXPIRE', failures_key, ttl_ms)
  redis.call('PEXPIRE', successes_key, ttl_ms)
  redis.call('PEXPIRE', half_open_key, ttl_ms)

  return {'OPEN', failure_count, total_count, failure_rate}
end

-- 6. Determine if circuit should open
local should_open = false

-- Check absolute failure count
if failure_count >= fail_threshold then
  should_open = true
end

-- Check failure rate (only with enough data)
if total_count >= min_requests and total_count > 0 then
  local rate = math.floor((failure_count / total_count) * 100)
  if rate >= rate_threshold then
    should_open = true
  end
end

-- 7. Transition to OPEN if needed
if should_open and state ~= 'OPEN' then
  redis.call('SET', state_key, 'OPEN')
  redis.call('SET', opened_at_key, tostring(now))
  -- Safety TTL: auto-expire keys at 2x reset timeout (prevents stale state)
  local ttl_ms = reset_timeout * 2
  redis.call('PEXPIRE', state_key, ttl_ms)
  redis.call('PEXPIRE', opened_at_key, ttl_ms)
  redis.call('PEXPIRE', failures_key, ttl_ms)
  redis.call('PEXPIRE', successes_key, ttl_ms)
  redis.call('PEXPIRE', half_open_key, ttl_ms)
  return {'OPEN', failure_count, total_count, failure_rate}
end

-- Keep window keys alive while active
redis.call('PEXPIRE', failures_key, reset_timeout * 2)
redis.call('PEXPIRE', successes_key, reset_timeout * 2)

return {state, failure_count, total_count, failure_rate}
