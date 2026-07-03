import { loadConfig } from "../config/index";

export interface ScopeRequest {
  namespaces?: string[];
  sensitivityAllowed?: string[];
}

export interface ResolvedScope {
  namespaces: string[];
  sensitivities: string[];
}

/** Pure: intersect a requested scope with explicit allowlists. */
export function intersectScope(
  requested: ScopeRequest,
  allowedNamespaces: string[],
  allowedSensitivities: string[],
): ResolvedScope {
  const reqNs = requested.namespaces?.length ? requested.namespaces : allowedNamespaces;
  const reqSe = requested.sensitivityAllowed?.length ? requested.sensitivityAllowed : allowedSensitivities;
  const namespaces = [...new Set(reqNs.filter((n) => allowedNamespaces.includes(n)))];
  const sensitivities = [...new Set(reqSe.filter((s) => allowedSensitivities.includes(s)))];
  return { namespaces, sensitivities };
}

/** Config-bound by default; pass `allow` to scope against a connector profile instead. */
export function resolveScope(
  requested: ScopeRequest,
  allow?: { namespaces: string[]; sensitivities: string[] },
): ResolvedScope {
  if (allow) return intersectScope(requested, allow.namespaces, allow.sensitivities);
  const { policy } = loadConfig();
  return intersectScope(requested, policy.allowed_namespaces, policy.allowed_sensitivity);
}
