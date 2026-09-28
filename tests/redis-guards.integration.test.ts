import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  acquireSlots,
  cancelReservation,
  consumeTurnstileToken,
  GuardUnavailableError,
  releaseSlots,
  reserveRequest,
  settleRequest,
  type ReserveRequestOptions,
} from "../src/lib/redis-guards";

const run = promisify(execFile);
const container = process.env.KANABCO_REDIS_TEST_CONTAINER;
const redisUrl = "https://kanabco-redis-integration.invalid";
const today = new Date().toISOString().slice(0, 10);
const minuteBucket = Math.floor(Date.now() / 60_000);
const hash = (letter: string) => letter.repeat(64);
const jobId = () => crypto.randomUUID();

async function redis(...args: string[]): Promise<unknown> {
  assert.ok(container);
  const { stdout } = await run("docker", ["exec", container, "redis-cli", "--json", ...args], {
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
}

async function reset() {
  assert.equal(await redis("FLUSHDB"), "OK");
}

// The app uses Upstash REST; this adapter forwards its commands to an isolated real Redis.
// It preserves Redis's atomic EVAL execution while keeping the production client unchanged.
function redisFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const destination = String(input);
  assert.ok(destination.startsWith(redisUrl), destination);
  const body = JSON.parse(String(init?.body)) as unknown;
  const execute = async (command: unknown) => {
    assert.ok(Array.isArray(command));
    const result = await redis(...command.map(String));
    if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
      throw new Error(String(result.error));
    }
    return { result };
  };
  return (async () => {
    const response = Array.isArray(body) && Array.isArray(body[0])
      ? await Promise.all(body.map(execute))
      : await execute(body);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  })();
}

function reserve(overrides: Partial<ReserveRequestOptions> = {}): ReserveRequestOptions {
  return {
    jobId: jobId(),
    ipHash: hash("a"),
    sessionHash: hash("b"),
    dayUtc: today,
    minuteBucket,
    ipPerMinute: 10,
    sessionPerMinute: 10,
    ipPerDay: 20,
    sessionPerDay: 20,
    globalPerDay: 100,
    sessionUsdCents: 500,
    globalUsdCents: 1_000,
    reserveCents: 100,
    ...overrides,
  };
}

test("Redis guard Lua scripts are atomic and fail closed against real Redis", {
  skip: !container && "Set KANABCO_REDIS_TEST_CONTAINER to a disposable Redis container name",
}, async (t) => {
  assert.match(
    container ?? "",
    /^kanabco-redis-test(?:-[a-z0-9_-]+)?$/,
    "Integration tests use FLUSHDB and require a disposable kanabco-redis-test* container",
  );
  process.env.UPSTASH_REDIS_REST_URL = redisUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = "integration-test-token-not-real";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = redisFetch;
  try {
    await t.test("Turnstile token is consumed only once under concurrency", async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 12 }, () => consumeTurnstileToken(hash("c"))));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await consumeTurnstileToken(hash("c")), false);
    });

    await t.test("IP and global slots block concurrent jobs and release cleanly", async () => {
      await reset();
      const first = { jobId: jobId(), ipHash: hash("a"), sessionHash: hash("b"), ipMax: 1, sessionMax: 2, globalMax: 2, leaseMs: 30_000 };
      assert.deepEqual(await acquireSlots(first), { ok: true });
      assert.deepEqual(await acquireSlots(first), { ok: false, scope: "duplicate" });
      assert.deepEqual(await acquireSlots({ ...first, jobId: jobId(), sessionHash: hash("c") }), { ok: false, scope: "ip" });
      const second = { ...first, jobId: jobId(), ipHash: hash("d") };
      assert.deepEqual(await acquireSlots(second), { ok: true });
      const third = { ...first, jobId: jobId(), ipHash: hash("e"), sessionHash: hash("f") };
      assert.deepEqual(await acquireSlots(third), { ok: false, scope: "global" });
      await releaseSlots(first);
      assert.deepEqual(await acquireSlots(third), { ok: true });
      await releaseSlots(second);
      await releaseSlots(third);

      await reset();
      const contenders = Array.from({ length: 8 }, (_, index) => ({
        jobId: jobId(), ipHash: (index + 1).toString(16).padStart(64, "0"),
        sessionHash: (index + 9).toString(16).padStart(64, "0"),
        ipMax: 1, sessionMax: 1, globalMax: 2, leaseMs: 30_000,
      }));
      const decisions = await Promise.all(contenders.map(acquireSlots));
      assert.equal(decisions.filter((decision) => decision.ok).length, 2);
      assert.equal(decisions.filter((decision) => !decision.ok && decision.scope === "global").length, 6);
    });

    await t.test("rolling minute and UTC-day request limits are enforced", async () => {
      await reset();
      const minute = reserve({ ipPerMinute: 2, sessionPerMinute: 3 });
      assert.deepEqual(await reserveRequest(minute), { ok: true });
      assert.deepEqual(await reserveRequest({ ...minute, jobId: jobId() }), { ok: true });
      const blocked = await reserveRequest({ ...minute, jobId: jobId() });
      assert.equal(blocked.ok, false);
      if (!blocked.ok) {
        assert.equal(blocked.scope, "ip_minute");
        assert.ok((blocked.retryAfterSeconds ?? 0) > 0);
      }

      await reset();
      const bySession = reserve({ sessionPerMinute: 1 });
      assert.deepEqual(await reserveRequest(bySession), { ok: true });
      const sessionBlocked = await reserveRequest({ ...bySession, jobId: jobId(), ipHash: hash("d") });
      assert.equal(sessionBlocked.ok, false);
      if (!sessionBlocked.ok) {
        assert.equal(sessionBlocked.scope, "session_minute");
        assert.ok((sessionBlocked.retryAfterSeconds ?? 0) > 0);
      }

      await reset();
      const byDay = reserve({ ipPerDay: 1 });
      assert.deepEqual(await reserveRequest(byDay), { ok: true });
      const dayBlocked = await reserveRequest({ ...byDay, jobId: jobId() });
      assert.equal(dayBlocked.ok, false);
      if (!dayBlocked.ok) assert.equal(dayBlocked.scope, "ip_day");

      await reset();
      const global = reserve({ globalPerDay: 1 });
      assert.deepEqual(await reserveRequest(global), { ok: true });
      const globalBlocked = await reserveRequest({ ...global, jobId: jobId(), ipHash: hash("d"), sessionHash: hash("e") });
      assert.equal(globalBlocked.ok, false);
      if (!globalBlocked.ok) assert.equal(globalBlocked.scope, "global_day");
    });

    await t.test("cost reservations are atomic and settlement is idempotent", async () => {
      await reset();
      const oneSession = reserve({ sessionUsdCents: 100 });
      assert.deepEqual(await reserveRequest(oneSession), { ok: true });
      const sessionBlocked = await reserveRequest({ ...oneSession, jobId: jobId(), ipHash: hash("e") });
      assert.equal(sessionBlocked.ok, false);
      if (!sessionBlocked.ok) assert.equal(sessionBlocked.scope, "session_cost");

      await reset();
      const requests = ["a", "b", "c", "d"].map((letter) => reserve({
        ipHash: hash(letter), sessionHash: hash(letter), sessionUsdCents: 100,
        globalUsdCents: 200, reserveCents: 100,
      }));
      const decisions = await Promise.all(requests.map(reserveRequest));
      assert.equal(decisions.filter((decision) => decision.ok).length, 2);
      assert.equal(decisions.filter((decision) => !decision.ok && decision.scope === "global_cost").length, 2);

      const accepted = requests.filter((_, index) => decisions[index].ok);
      const first = await settleRequest({ jobId: accepted[0].jobId, dayUtc: today, chargedCents: 100, estimatedCents: 20, minuteBucket, usageKnown: true });
      assert.deepEqual(first, { spend10MinCents: 20 });
      const duplicate = await settleRequest({ jobId: accepted[0].jobId, dayUtc: today, chargedCents: 100, estimatedCents: 999, minuteBucket, usageKnown: true });
      assert.deepEqual(duplicate, first);
      assert.equal(await redis("HGET", `{kanabco-ai}:v1:cost:day:${today}`, "g_r"), "100");
      assert.equal(await redis("HGET", `{kanabco-ai}:v1:cost:day:${today}`, "g_s"), "100");

      const second = await settleRequest({ jobId: accepted[1].jobId, dayUtc: today, chargedCents: 100, estimatedCents: 30, minuteBucket, usageKnown: false });
      assert.deepEqual(second, { spend10MinCents: 50 });
      assert.equal(await redis("HGET", `{kanabco-ai}:v1:cost:day:${today}`, "g_r"), "0");
      assert.equal(await redis("HGET", `{kanabco-ai}:v1:cost:day:${today}`, "g_s"), "200");

      const breaker = await reserveRequest(reserve({ ipHash: hash("e"), sessionHash: hash("e"), globalUsdCents: 1_000 }));
      assert.equal(breaker.ok, false);
      if (!breaker.ok) assert.equal(breaker.scope, "usage_unknown");
    });

    await t.test("cancellation releases reserved dollars but keeps the request counted", async () => {
      await reset();
      const first = reserve({ globalUsdCents: 100 });
      assert.deepEqual(await reserveRequest(first), { ok: true });
      assert.equal((await reserveRequest(reserve({ ipHash: hash("c"), sessionHash: hash("d"), globalUsdCents: 100 }))).ok, false);
      await cancelReservation({ jobId: first.jobId, dayUtc: today });
      await cancelReservation({ jobId: first.jobId, dayUtc: today });
      assert.equal(await redis("HGET", `{kanabco-ai}:v1:cost:day:${today}`, "g_r"), "0");
      assert.deepEqual(await reserveRequest(reserve({ ipHash: hash("c"), sessionHash: hash("d"), globalUsdCents: 100 })), { ok: true });
      await assert.rejects(() => settleRequest({ jobId: first.jobId, dayUtc: today, chargedCents: 100, estimatedCents: 100, minuteBucket, usageKnown: true }), GuardUnavailableError);
    });

    await t.test("Redis failure closes the guard", async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "Redis unavailable" }), { status: 503 });
      try {
        await assert.rejects(() => consumeTurnstileToken(hash("f")), GuardUnavailableError);
      } finally {
        globalThis.fetch = redisFetch;
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
