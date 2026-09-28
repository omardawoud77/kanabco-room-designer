import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../next.config";

test("development CSP permits React debugging eval without allowing it in production", async () => {
  const prior = process.env.NODE_ENV;
  try {
    Reflect.set(process.env, "NODE_ENV", "development");
    const dev = await nextConfig.headers?.();
    const devCsp = dev?.[0]?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
    assert.ok(devCsp?.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com"));

    Reflect.set(process.env, "NODE_ENV", "production");
    const production = await nextConfig.headers?.();
    const productionCsp = production?.[0]?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
    assert.ok(productionCsp?.includes("script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"));
    assert.ok(!productionCsp?.includes("unsafe-eval"));
    assert.ok(productionCsp?.includes("upgrade-insecure-requests"));
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", prior);
  }
});
