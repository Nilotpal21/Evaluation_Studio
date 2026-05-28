-- check-state.lua
--
-- Atomically checks the circuit breaker state and determines if
-- a request can proceed. Handles the OPEN → HALF_OPEN transition
-- when the reset timeout expires.
--
-- KEYS[1] = breaker:{level}:{key}:state            (string)
-- KEYS[2] = breaker:{level}:{key}:opened_at        (string)
-- KEYS[3] = breaker:{level}:{key}:half_open_count  (string/counter)
--
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = reset timeout (ms)
-- ARGV[3] = max concurrent in HALF_OPEN
--
-- Returns: {state, can_execute (0|1), retry_after_ms}

local state_key     = KEYS[1]
local opened_at_key = KEYS[2]
local half_open_key = KEYS[3]

local now           = tonumber(ARGV[1])
local reset_timeout = tonumber(ARGV[2])
local max_half_open = tonumber(ARGV[3])

-- 1. Get current state
local state = redis.call('GET', state_key) or 'CLOSED'

-- 2. CLOSED — always allow
if state == 'CLOSED' then
  return {'CLOSED', 1, 0}
end

-- 3. OPEN — check if reset timeout has elapsed
if state == 'OPEN' then
  local opened_at = tonumber(redis.call('GET', opened_at_key) or '0')
  local elapsed = now - opened_at

  if elapsed >= reset_timeout then
    -- Timeout expired — transition to HALF_OPEN
    redis.call('SET', state_key, 'HALF_OPEN')
    redis.call('SET', half_open_key, 1)  -- This request counts as first probe
    return {'HALF_OPEN', 1, 0}
  else
    -- Still within timeout — reject with retry-after
    local retry_after = reset_timeout - elapsed
    return {'OPEN', 0, retry_after}
  end
end

-- 4. HALF_OPEN — allow up to max concurrent probes
if state == 'HALF_OPEN' then
  local count = tonumber(redis.call('GET', half_open_key) or '0')
  if count < max_half_open then
    redis.call('INCR', half_open_key)
    return {'HALF_OPEN', 1, 0}
  else
    -- Too many concurrent probes — wait
    return {'HALF_OPEN', 0, 5000}
  end
end

-- Unknown state — default deny
return {state, 0, 0}
