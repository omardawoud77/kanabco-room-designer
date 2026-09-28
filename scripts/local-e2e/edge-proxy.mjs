import { createServer, request as upstreamRequest } from "node:http";
import { connect } from "node:net";

const host = "127.0.0.1";
const port = Number(process.env.KANABCO_EDGE_PORT ?? "3460");
const upstreamPort = Number(process.env.KANABCO_NEXT_PORT ?? "3461");
const edgeSecret = process.env.AI_EDGE_SHARED_SECRET ?? "";
const clientIpHeader = (process.env.AI_TRUSTED_CLIENT_IP_HEADER ?? "cf-connecting-ip").toLowerCase();

if (![port, upstreamPort].every((value) => Number.isInteger(value) && value >= 1024 && value <= 65535) || port === upstreamPort) {
  throw new Error("Invalid local proxy ports");
}
if (edgeSecret.length < 32) throw new Error("AI_EDGE_SHARED_SECRET must contain at least 32 characters");
if (clientIpHeader !== "cf-connecting-ip") throw new Error("Local proxy supports cf-connecting-ip only");

const untrustedHeaders = [
  "x-kanabco-edge-secret", "cf-connecting-ip", "x-forwarded-for", "forwarded", "x-real-ip", "true-client-ip",
];

function forwardedHeaders(incoming, isAiRoute) {
  const headers = { ...incoming, host: `${host}:${upstreamPort}` };
  for (const name of untrustedHeaders) delete headers[name];
  if (isAiRoute) {
    headers["x-kanabco-edge-secret"] = edgeSecret;
    headers[clientIpHeader] = host;
  }
  return headers;
}

const server = createServer((request, response) => {
  if (request.socket.remoteAddress !== host && request.socket.remoteAddress !== `::ffff:${host}`) {
    response.writeHead(403).end();
    return;
  }
  const isAiRoute = request.url?.split("?", 1)[0] === "/api/room-design";
  const upstream = upstreamRequest({
    host,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request.headers, isAiRoute),
  }, (result) => {
    response.writeHead(result.statusCode ?? 502, result.headers);
    result.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Local app unavailable");
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
});

server.requestTimeout = 260_000;
server.on("upgrade", (request, socket, head) => {
  if (request.socket.remoteAddress !== host && request.socket.remoteAddress !== `::ffff:${host}`) {
    socket.destroy();
    return;
  }
  const upstream = connect({ host, port: upstreamPort });
  upstream.on("connect", () => {
    const headers = forwardedHeaders(request.headers, false);
    const lines = Object.entries(headers).flatMap(([name, value]) =>
      Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : value === undefined ? [] : [`${name}: ${value}`],
    );
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(port, host, () => {
  console.log(`Local edge proxy listening on http://${host}:${port}`);
});
