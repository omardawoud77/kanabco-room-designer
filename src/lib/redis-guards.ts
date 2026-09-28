import { Redis } from "@upstash/redis";

const PREFIX = "{kanabco-ai}:v1";
const DAY_TTL_SECONDS = 172_800;
const MINUTE_TTL_SECONDS = 180;
const TOKEN_TTL_SECONDS = 600;
const REPEAT_TTL_SECONDS = 600;

let redisClient: Redis | undefined;

export class GuardUnavailableError extends Error {
  constructor() {
    super("AI protection is temporarily unavailable");
    this.name = "GuardUnavailableError";
  }
}

export class GuardLimitError extends Error {
  constructor(
    readonly scope: string,
    readonly retryAfterSeconds?: number,
  ) {
    super("AI request limit reached");
    this.name = "GuardLimitError";
  }
}

export function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new GuardUnavailableError();
  if (!redisClient) redisClient = new Redis({ url, token });
  return redisClient;
}

function hash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new GuardUnavailableError();
  return value;
}

function job(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new GuardUnavailableError();
  return value;
}

function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new GuardUnavailableError();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new GuardUnavailableError();
  }
  return value;
}

function bucket(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new GuardUnavailableError();
  return value;
}

function nonnegative(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new GuardUnavailableError();
  return value;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new GuardUnavailableError();
  return value;
}

async function evalScript<T>(script: string, keys: string[], args: Array<string | number>): Promise<T> {
  try {
    return (await getRedis().eval(script, keys, args)) as T;
  } catch {
    throw new GuardUnavailableError();
  }
}

const CONSUME_TOKEN_SCRIPT = `
local result = redis.call('SET', KEYS[1], '1', 'NX', 'EX', tonumber(ARGV[1]))
if result then return 1 end
return 0
`;

export async function consumeTurnstileToken(tokenHash: string): Promise<boolean> {
  const result = await evalScript<number>(
    CONSUME_TOKEN_SCRIPT,
    [`${PREFIX}:turnstile:${hash(tokenHash)}`],
    [TOKEN_TTL_SECONDS],
  );
  if (result !== 0 && result !== 1) throw new GuardUnavailableError();
  return result === 1;
}

const ACQUIRE_REPEAT_SCRIPT = `
local accepted = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[2]))
if accepted then return 1 end
return 0
`;

const RELEASE_REPEAT_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function repeatKey(sessionHash: string, repeatDigest: string): string {
  return `${PREFIX}:repeat:${hash(sessionHash)}:${hash(repeatDigest)}`;
}

export async function acquireRepeatLock(options: {
  sessionHash: string;
  repeatDigest: string;
  jobId: string;
}): Promise<boolean> {
  const result = await evalScript<number>(
    ACQUIRE_REPEAT_SCRIPT,
    [repeatKey(options.sessionHash, options.repeatDigest)],
    [job(options.jobId), REPEAT_TTL_SECONDS],
  );
  if (result !== 0 && result !== 1) throw new GuardUnavailableError();
  return result === 1;
}

export async function releaseRepeatLock(options: {
  sessionHash: string;
  repeatDigest: string;
  jobId: string;
}): Promise<void> {
  const result = await evalScript<number>(
    RELEASE_REPEAT_SCRIPT,
    [repeatKey(options.sessionHash, options.repeatDigest)],
    [job(options.jobId)],
  );
  if (result !== 0 && result !== 1) throw new GuardUnavailableError();
}

const ACQUIRE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lease_end = now + tonumber(ARGV[2])
for i = 1, 3 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZSCORE', KEYS[i], ARGV[1]) then return 4 end
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[i + 2]) then return i end
end
for i = 1, 3 do
  redis.call('ZADD', KEYS[i], lease_end, ARGV[1])
  local ttl = redis.call('PTTL', KEYS[i])
  local needed_ttl = tonumber(ARGV[2]) + 60000
  if ttl < needed_ttl then redis.call('PEXPIRE', KEYS[i], needed_ttl) end
end
return 0
`;

export type AcquireSlotsOptions = {
  jobId: string;
  ipHash: string;
  sessionHash: string;
  ipMax: number;
  sessionMax: number;
  globalMax: number;
  leaseMs: number;
};

export type GuardDecision = { ok: true } | { ok: false; scope: string; retryAfterSeconds?: number };

export async function acquireSlots(options: AcquireSlotsOptions): Promise<GuardDecision> {
  const { jobId, ipHash, sessionHash, ipMax, sessionMax, globalMax, leaseMs } = options;
  const result = await evalScript<number>(
    ACQUIRE_SCRIPT,
    [
      `${PREFIX}:inflight:ip:${hash(ipHash)}`,
      `${PREFIX}:inflight:session:${hash(sessionHash)}`,
      `${PREFIX}:inflight:global`,
    ],
    [job(jobId), positive(leaseMs), nonnegative(ipMax), nonnegative(sessionMax), nonnegative(globalMax)],
  );
  const scopes: Record<number, string> = { 1: "ip", 2: "session", 3: "global", 4: "duplicate" };
  if (result === 0) return { ok: true };
  if (scopes[result]) return { ok: false, scope: scopes[result] };
  throw new GuardUnavailableError();
}

const RELEASE_SCRIPT = `
for i = 1, 3 do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1
`;

export async function releaseSlots(options: {
  jobId: string;
  ipHash: string;
  sessionHash: string;
}): Promise<void> {
  const result = await evalScript<number>(
    RELEASE_SCRIPT,
    [
      `${PREFIX}:inflight:ip:${hash(options.ipHash)}`,
      `${PREFIX}:inflight:session:${hash(options.sessionHash)}`,
      `${PREFIX}:inflight:global`,
    ],
    [job(options.jobId)],
  );
  if (result !== 1) throw new GuardUnavailableError();
}

const RESERVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {8, 60} end
if redis.call('EXISTS', KEYS[8]) == 1 then
  local breaker_time = redis.call('TIME')
  return {9, math.max(1, tonumber(ARGV[12]) - tonumber(breaker_time[1]))}
end

local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
for i = 2, 3 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now_ms - 60000)
  local limit = tonumber(ARGV[i])
  if limit <= 0 then return {i - 1, 60} end
  if redis.call('ZCARD', KEYS[i]) >= limit then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local retry = math.max(1, math.ceil((tonumber(oldest[2]) + 60000 - now_ms) / 1000))
    return {i - 1, retry}
  end
end
for i = 4, 6 do
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i]) then
    return {i - 1, math.max(1, tonumber(ARGV[12]) - tonumber(t[1]))}
  end
end

local reserve = tonumber(ARGV[9])
local session_reserved_field = 's:' .. ARGV[11] .. ':r'
local session_spent_field = 's:' .. ARGV[11] .. ':s'
local session_total = tonumber(redis.call('HGET', KEYS[7], session_reserved_field) or '0')
  + tonumber(redis.call('HGET', KEYS[7], session_spent_field) or '0')
local global_total = tonumber(redis.call('HGET', KEYS[7], 'g_r') or '0')
  + tonumber(redis.call('HGET', KEYS[7], 'g_s') or '0')
if session_total + reserve > tonumber(ARGV[7]) then
  local t = redis.call('TIME')
  return {6, math.max(1, tonumber(ARGV[12]) - tonumber(t[1]))}
end
if global_total + reserve > tonumber(ARGV[8]) then
  local t = redis.call('TIME')
  return {7, math.max(1, tonumber(ARGV[12]) - tonumber(t[1]))}
end

for i = 2, 3 do redis.call('ZADD', KEYS[i], now_ms, ARGV[1]) end
for i = 4, 6 do redis.call('INCR', KEYS[i]) end
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[13]))
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[13]))
for i = 4, 6 do redis.call('EXPIRE', KEYS[i], tonumber(ARGV[14])) end
redis.call('HINCRBY', KEYS[7], 'g_r', reserve)
redis.call('HINCRBY', KEYS[7], session_reserved_field, reserve)
redis.call('EXPIRE', KEYS[7], tonumber(ARGV[14]))
redis.call('HSET', KEYS[1], 'state', 'reserved', 'day', ARGV[10], 'session', ARGV[11], 'reserve', reserve)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[14]))
return {0, 0}
`;

export type ReserveRequestOptions = {
  jobId: string;
  ipHash: string;
  sessionHash: string;
  dayUtc: string;
  minuteBucket: number;
  ipPerMinute: number;
  sessionPerMinute?: number;
  ipPerDay: number;
  sessionPerDay: number;
  globalPerDay: number;
  sessionUsdCents: number;
  globalUsdCents: number;
  reserveCents: number;
};

export async function reserveRequest(options: ReserveRequestOptions): Promise<GuardDecision> {
  const dayUtc = day(options.dayUtc);
  bucket(options.minuteBucket);
  const ipHash = hash(options.ipHash);
  const sessionHash = hash(options.sessionHash);
  const dayEnd = Math.floor(Date.parse(`${dayUtc}T00:00:00.000Z`) / 1000) + 86_400;
  const result = await evalScript<[number, number]>(
    RESERVE_SCRIPT,
    [
      `${PREFIX}:job:${job(options.jobId)}`,
      `${PREFIX}:req:ip:min:${ipHash}`,
      `${PREFIX}:req:session:min:${sessionHash}`,
      `${PREFIX}:req:ip:day:${ipHash}:${dayUtc}`,
      `${PREFIX}:req:session:day:${sessionHash}:${dayUtc}`,
      `${PREFIX}:req:global:day:${dayUtc}`,
      `${PREFIX}:cost:day:${dayUtc}`,
      `${PREFIX}:usage-unknown:day:${dayUtc}`,
    ],
    [
      options.jobId,
      nonnegative(options.ipPerMinute),
      nonnegative(options.sessionPerMinute ?? options.ipPerMinute),
      nonnegative(options.ipPerDay),
      nonnegative(options.sessionPerDay),
      nonnegative(options.globalPerDay),
      nonnegative(options.sessionUsdCents),
      nonnegative(options.globalUsdCents),
      positive(options.reserveCents),
      dayUtc,
      sessionHash,
      dayEnd,
      MINUTE_TTL_SECONDS,
      DAY_TTL_SECONDS,
    ],
  );
  if (!Array.isArray(result) || result.length !== 2) throw new GuardUnavailableError();
  const [code, retryAfterSeconds] = result.map(Number);
  const scopes: Record<number, string> = {
    1: "ip_minute",
    2: "session_minute",
    3: "ip_day",
    4: "session_day",
    5: "global_day",
    6: "session_cost",
    7: "global_cost",
    8: "duplicate",
    9: "usage_unknown",
  };
  if (code === 0) return { ok: true };
  if (scopes[code] && Number.isSafeInteger(retryAfterSeconds)) {
    return { ok: false, scope: scopes[code], retryAfterSeconds };
  }
  throw new GuardUnavailableError();
}

const SETTLE_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return {-1, 0} end
if redis.call('HGET', KEYS[1], 'day') ~= ARGV[1] then return {-2, 0} end
if state == 'settled' then
  return {1, tonumber(redis.call('HGET', KEYS[1], 'ten_spend') or '0')}
end
if state ~= 'reserved' then return {-3, 0} end

local session = redis.call('HGET', KEYS[1], 'session')
local reserve = tonumber(redis.call('HGET', KEYS[1], 'reserve'))
local charged = tonumber(ARGV[2])
local estimated = tonumber(ARGV[5])
redis.call('HINCRBY', KEYS[2], 'g_r', -reserve)
redis.call('HINCRBY', KEYS[2], 'g_s', charged)
redis.call('HINCRBY', KEYS[2], 's:' .. session .. ':r', -reserve)
redis.call('HINCRBY', KEYS[2], 's:' .. session .. ':s', charged)
redis.call('INCRBY', KEYS[3], estimated)
redis.call('EXPIRE', KEYS[3], 720)
local ten_spend = 0
for i = 3, 12 do
  ten_spend = ten_spend + tonumber(redis.call('GET', KEYS[i]) or '0')
end
redis.call('HSET', KEYS[1], 'state', 'settled', 'charged', charged, 'estimated', estimated, 'ten_spend', ten_spend)
if ARGV[3] == '0' then redis.call('SET', KEYS[13], '1', 'EX', tonumber(ARGV[4])) end
return {0, ten_spend}
`;

export async function settleRequest(options: {
  jobId: string;
  dayUtc: string;
  chargedCents: number;
  estimatedCents: number;
  minuteBucket: number;
  usageKnown: boolean;
}): Promise<{ spend10MinCents: number }> {
  const dayUtc = day(options.dayUtc);
  const dayEnd = Math.floor(Date.parse(`${dayUtc}T00:00:00.000Z`) / 1000) + 86_400;
  const breakerTtl = Math.max(1, dayEnd - Math.floor(Date.now() / 1000));
  const result = await evalScript<[number, number]>(
    SETTLE_SCRIPT,
    [
      `${PREFIX}:job:${job(options.jobId)}`,
      `${PREFIX}:cost:day:${dayUtc}`,
      ...Array.from({ length: 10 }, (_, offset) => `${PREFIX}:spend:min:${bucket(options.minuteBucket - offset)}`),
      `${PREFIX}:usage-unknown:day:${dayUtc}`,
    ],
    [dayUtc, nonnegative(options.chargedCents), options.usageKnown ? "1" : "0", breakerTtl, nonnegative(options.estimatedCents)],
  );
  if (!Array.isArray(result) || result.length !== 2) throw new GuardUnavailableError();
  const [code, spend10MinCents] = result.map(Number);
  if ((code !== 0 && code !== 1) || !Number.isSafeInteger(spend10MinCents)) {
    throw new GuardUnavailableError();
  }
  return { spend10MinCents };
}

const CANCEL_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state then return -1 end
if redis.call('HGET', KEYS[1], 'day') ~= ARGV[1] then return -2 end
if state == 'cancelled' then return 1 end
if state ~= 'reserved' then return -3 end
local reserve = tonumber(redis.call('HGET', KEYS[1], 'reserve'))
local session = redis.call('HGET', KEYS[1], 'session')
redis.call('HINCRBY', KEYS[2], 'g_r', -reserve)
redis.call('HINCRBY', KEYS[2], 's:' .. session .. ':r', -reserve)
redis.call('HSET', KEYS[1], 'state', 'cancelled')
return 1
`;

export async function cancelReservation(options: { jobId: string; dayUtc: string }): Promise<void> {
  const dayUtc = day(options.dayUtc);
  const result = await evalScript<number>(
    CANCEL_SCRIPT,
    [`${PREFIX}:job:${job(options.jobId)}`, `${PREFIX}:cost:day:${dayUtc}`],
    [dayUtc],
  );
  if (result !== 1) throw new GuardUnavailableError();
}
