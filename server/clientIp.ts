import { isIP } from "node:net";

export const TRUSTED_CLIENT_IP_HEADER = "x-breexe-client-ip";

type ClientIpRequest = {
  get: (name: string) => string | undefined;
  socket: { remoteAddress?: string };
};

function validAddress(value: unknown) {
  const candidate = String(value || "").trim();
  return isIP(candidate) ? candidate : "";
}

/**
 * Resolve the rate-limit identity without trusting public forwarding headers.
 * The bundled Caddy proxy overwrites x-breexe-client-ip with its parsed
 * `{client_ip}` value; deployments without that contract must leave trust off.
 */
export function requestClientIp(req: ClientIpRequest, trustBundledProxyHeader: boolean) {
  if (trustBundledProxyHeader) {
    const trusted = validAddress(req.get(TRUSTED_CLIENT_IP_HEADER));
    if (trusted) return trusted;
  }
  return validAddress(req.socket.remoteAddress) || "unknown";
}
