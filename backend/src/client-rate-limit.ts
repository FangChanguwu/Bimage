import { isIP, SocketAddress } from "node:net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

export type ClientRateLimitKey = (request: Request) => string;

function canonicalIp(value: string | undefined): string | undefined {
  if (!value || value.includes("%")) return;
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) {
    const { address } = new SocketAddress({ address: value, family: "ipv6" });
    return address.startsWith("::ffff:") ? address.slice(7) : address;
  }
}

export function clientRateLimitKey(trustedIp?: string): ClientRateLimitKey {
  const proxy = canonicalIp(trustedIp);
  if (trustedIp && !proxy)
    throw new Error("TRUSTED_WEB_PROXY_IP must be a single IP address");

  return (request) => {
    const peer = canonicalIp(request.socket.remoteAddress);
    // Only the explicitly configured web proxy can supply this single header.
    // Keep Express proxy trust disabled so forwarded scheme/host stay untrusted.
    const header = request.headers["x-real-ip"];
    const client =
      proxy && peer === proxy && typeof header === "string"
        ? canonicalIp(header)
        : undefined;
    // Retain express-rate-limit's IPv6 /56 grouping and common fallback bucket.
    return ipKeyGenerator(client ?? peer ?? "unknown-peer");
  };
}