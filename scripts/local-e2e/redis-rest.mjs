import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);
const host = "127.0.0.1";
const port = Number(process.env.KANABCO_REDIS_REST_PORT ?? "6391");
const container = process.env.KANABCO_REDIS_E2E_CONTAINER ?? "kanabco-redis-e2e";
const token = process.env.LOCAL_REDIS_REST_TOKEN ?? "";
const maxBodyBytes = 200_000;

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local Redis REST port");
if (!/^kanabco-redis-e2e(?:-[a-z0-9_-]+)?$/.test(container)) throw new Error("Use a disposable kanabco-redis-e2e* container");
if (token.length < 32) throw new Error("LOCAL_REDIS_REST_TOKEN must contain at least 32 characters");

function authorized(value) {
  const supplied = Buffer.from(value ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function bodyOf(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBodyBytes) throw new Error("oversize");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validatedCommand(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) throw new Error("bad-command");
  if (!value.every((part) => typeof part === "string" || (typeof part === "number" && Number.isSafeInteger(part)))) {
    throw new Error("bad-argument");
  }
  const name = String(value[0]).toLowerCase();
  if (name !== "eval" && name !== "set") throw new Error("unsupported-command");
  if (name === "set" && value.length > 8) throw new Error("bad-command");
  return value.map(String);
}

async function execute(command) {
  const { stdout } = await run("docker", ["exec", container, "redis-cli", "--json", ...validatedCommand(command)], {
    maxBuffer: 1_000_000,
    timeout: 10_000,
  });
  const result = JSON.parse(stdout.trim());
  if (result && typeof result === "object" && !Array.isArray(result) && "error" in result) {
    throw new Error("redis-command-error");
  }
  return { result };
}

const server = createServer(async (request, response) => {
  if (request.socket.remoteAddress !== host && request.socket.remoteAddress !== `::ffff:${host}`) {
    return json(response, 403, { error: "Forbidden" });
  }
  if (!authorized(request.headers.authorization)) return json(response, 403, { error: "Forbidden" });
  if (request.method !== "POST" || (request.url !== "/" && request.url !== "/pipeline")) {
    return json(response, 404, { error: "Not found" });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    return json(response, 415, { error: "Unsupported content type" });
  }
  try {
    const body = await bodyOf(request);
    if (request.url === "/pipeline") {
      if (!Array.isArray(body) || body.length < 1 || body.length > 16) throw new Error("bad-pipeline");
      const results = [];
      for (const command of body) results.push(await execute(command));
      return json(response, 200, results);
    }
    return json(response, 200, await execute(body));
  } catch {
    return json(response, 503, { error: "Local Redis unavailable" });
  }
});

server.requestTimeout = 15_000;
server.listen(port, host, () => {
  console.log(`Local Redis REST adapter listening on http://${host}:${port}`);
});
