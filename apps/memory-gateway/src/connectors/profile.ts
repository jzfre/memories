import { loadConfig } from "../config/index";

export interface ResolvedProfile {
  name: string;
  clientLabel: string;
  transport: "stdio" | "http";
  auth: "none" | "token" | "oauth";
  capabilities: { read: boolean; propose: boolean; review: boolean };
  scope: { namespaces: string[]; sensitivities: string[] };
  publicBaseUrl?: string;
}

function labelFor(name: string): string {
  return name === "claude-code" ? "mcp" : `mcp:${name}`;
}

export function resolveProfile(name: string): ResolvedProfile {
  const config = loadConfig();
  const allowNs = config.policy.allowed_namespaces;
  const allowSe = config.policy.allowed_sensitivity;
  const raw = config.connectors[name];

  // Backward-compat: no profile configured → full-trust stdio (today's behavior).
  if (!raw) {
    return {
      name,
      clientLabel: labelFor(name),
      transport: "stdio",
      auth: "none",
      capabilities: { read: true, propose: true, review: true },
      scope: { namespaces: allowNs, sensitivities: allowSe },
    };
  }

  const ns = raw.scope.namespaces === "*" ? allowNs : raw.scope.namespaces.filter((n) => allowNs.includes(n));
  const se = raw.scope.sensitivities === "*" ? allowSe : raw.scope.sensitivities.filter((s) => allowSe.includes(s));

  return {
    name,
    clientLabel: labelFor(name),
    transport: raw.transport,
    auth: raw.auth,
    capabilities: {
      read: raw.capabilities.includes("read"),
      propose: raw.capabilities.includes("propose"),
      review: raw.capabilities.includes("review"),
    },
    scope: { namespaces: ns, sensitivities: se },
    // Env var overrides the per-connector config value (used for ChatGPT citation URLs).
    publicBaseUrl: process.env.MCP_HTTP_PUBLIC_BASE_URL || raw.public_base_url,
  };
}
