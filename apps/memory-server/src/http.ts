import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcp } from './mcp.js';
import type { VaultStore } from './vault.js';
import type { Maintenance } from './state.js';
import { validateVaults, type VaultBinding } from './config.js';

export type HttpOptions = { port: number; host?: string; capabilityUrl?: boolean } &
  ({ vaults: VaultBinding[] } | { store: VaultStore; maintenance: Maintenance; token: string });
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function respond(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}
async function body(req: IncomingMessage) {
  const max = 3 * 1024 * 1024;
  if (Number(req.headers['content-length']) >= max) throw Object.assign(new Error('Payload too large'), { status: 413 });
  const chunks: Buffer[] = []; let length = 0;
  // Keep the socket alive long enough to send a 413 for chunked requests too.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length >= max) { req.resume(); throw Object.assign(new Error('Payload too large'), { status: 413 }); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export async function startHttp(options: HttpOptions) {
  const vaults = 'vaults' in options ? options.vaults : [{ id: 'personal', store: options.store, maintenance: options.maintenance, token: options.token }];
  if (vaults.some(v => v.token.length < 32 || /[\s/?#%\\]|[^\x21-\x7e]/.test(v.token) || new URL(`http://localhost/${v.token}/mcp`).pathname !== `/${v.token}/mcp`)) throw new Error('Each HTTP token must have at least 32 bytes and be URL-safe');
  await validateVaults(vaults);
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Use a local reverse proxy; the listener must bind loopback');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const target = new URL(req.url ?? '/', 'http://localhost');
      const bearer = vaults.find(v => equal(req.headers.authorization ?? '', `Bearer ${v.token}`));
      const capability = options.capabilityUrl ? vaults.find(v => equal(target.pathname, `/${v.token}/mcp`)) : undefined;
      // A credential selects exactly one vault. Never resolve scope from tool arguments.
      if ((req.headers.authorization && !bearer) || (bearer && capability && bearer !== capability)) { respond(res, 401, 'Unauthorized'); return; }
      const vault = bearer ?? capability;
      if (!vault) { respond(res, 401, 'Unauthorized'); return; }
      const capabilityPath = capability !== undefined;
      if (target.pathname !== '/mcp' && !capabilityPath) { respond(res, 404, 'Not found'); return; }
      if (req.headers.origin) { respond(res, 403, 'Browser origins are not allowed'); return; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); respond(res, 405, 'Method not allowed'); return; }
      if ((req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') { respond(res, 415, 'Expected JSON'); return; }
      const parsed = await body(req);
      const mcp = createMcp(vault.store, vault.maintenance, vault.id);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error: any) {
      if (error.status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
      if (!res.headersSent) respond(res, error.status === 413 ? 413 : error.status === 400 ? 400 : 500, error.status === 413 ? 'Payload too large' : error.status === 400 ? 'Invalid JSON' : 'Request failed');
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, host, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP listener');
  let closed = false;
  return { url: `http://${host === '::1' ? '[::1]' : host}:${address.port}/mcp`, close: async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
