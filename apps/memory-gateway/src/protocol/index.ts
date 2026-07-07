import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/index";

/**
 * The KB protocol is a NOTE IN THE VAULT (not a config file, not a per-client skill):
 * edit it in Obsidian/SilverBullet and every MCP client picks it up on its next
 * connection — served as server `instructions` at initialize and via memory_protocol.
 */
export const PROTOCOL_PATH = "0x09 Meta/Protocol.md";

/** Cap what gets injected into every client session; the full note stays readable in the vault. */
const MAX_CHARS = 16000;

/** Read the protocol note's body (frontmatter stripped). Undefined when absent/empty — never throws. */
export function loadProtocol(): string | undefined {
  try {
    const { vault } = loadConfig();
    const raw = readFileSync(join(vault.root, PROTOCOL_PATH), "utf8");
    let body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    if (body.length > MAX_CHARS) {
      body = `${body.slice(0, MAX_CHARS)}\n\n[truncated — read the full note at ${PROTOCOL_PATH}]`;
    }
    return body.length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
}
