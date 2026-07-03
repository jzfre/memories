import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./build";
import { resolveProfile } from "../connectors/profile";

const DEFAULT_PORT = Number(process.env.MCP_HTTP_PORT ?? 8788);

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when the request carries the capability token (last path segment must be 'mcp'). */
export function isAuthorized(
  method: string,
  urlPath: string,
  headers: Record<string, string | string[] | undefined>,
  token: string,
): boolean {
  if (!token) return false;
  const u = new URL(urlPath, "http://localhost");
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs[segs.length - 1] !== "mcp") return false;
  // Bearer header is accepted on any *-/mcp path (e.g. /mcp).
  const auth = headers["authorization"];
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer && safeEq(bearer, token)) return true;
  // Capability URL must be EXACTLY /<token>/mcp — no extra path segments.
  return segs.length === 2 && safeEq(segs[0]!, token);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Start the HTTP MCP server. Returns the http.Server (listening). */
export function start(port: number = DEFAULT_PORT): Promise<Server> {
  const token = process.env.MCP_HTTP_TOKEN ?? "";
  const httpServer = createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const urlPath = req.url ?? "/";
      if (!isAuthorized(method, urlPath, req.headers, token)) {
        return send(res, 401, { error: "unauthorized" });
      }
      if (method !== "POST") {
        return send(res, 405, { error: "method not allowed (stateless JSON mode accepts POST only)" });
      }
      const body = await readJson(req);
      // Stateless: a fresh server+transport per request, plain JSON responses.
      const mcp = buildMcpServer(resolveProfile("chatgpt"));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: "internal error", detail: (err as Error).message });
    }
  });
  // Default to loopback; set MCP_HTTP_HOST=0.0.0.0 inside a container (Docker publishes the
  // port to the host's 127.0.0.1) or to a Tailscale IP for private cross-device access.
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  return new Promise((resolveListen) => httpServer.listen(port, host, () => resolveListen(httpServer)));
}

// Entry point when run directly (tsx src/mcp/http.ts)
if (process.argv[1] && process.argv[1].endsWith("http.ts")) {
  start().then((s) => {
    const addr = s.address();
    const p = typeof addr === "object" && addr ? addr.port : DEFAULT_PORT;
    console.error(`memories MCP HTTP listening on 127.0.0.1:${p} (path: /<MCP_HTTP_TOKEN>/mcp)`);
  });
}
