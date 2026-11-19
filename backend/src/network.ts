import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch, FormData, type RequestInit } from "undici";
import { fail, object } from "./http.js";
import type { ProviderConfig } from "./types.js";

function privateIP(address: string): boolean {
  if (address.includes(":"))
    return (
      !/^2[0-9a-f]{3}:/i.test(address) ||
      address.toLowerCase().startsWith("2001:db8:")
    );
  const [a, b, c] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export async function validateUrl(
  raw: string,
  allow = false,
  resultUrl = false,
) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail(400, "URL 无效");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (!resultUrl && url.search)
  )
    throw fail(400, "URL 无效");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await lookup(host, { all: true });
  if (
    !addresses.length ||
    (!allow && addresses.some((item) => privateIP(item.address)))
  )
    throw fail(400, "不允许私网地址；需管理员明确授权");
  return { url, addresses };
}
/** Enforce the cap while streaming, regardless of a missing/incorrect Content-Length. */
export async function limited(
  response: {
    headers: { get(name: string): string | null };
    body: AsyncIterable<Uint8Array> | null;
  },
  max: number,
): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > max)
    throw new Error("响应过大");
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body)
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > max) throw new Error("响应过大");
      chunks.push(chunk);
    }
  return Buffer.concat(chunks);
}
export async function safeFetch(
  url: string,
  options: RequestInit = {},
  allow = false,
): Promise<Response> {
  const { addresses } = await validateUrl(url, allow, true);
  // Pin exactly the addresses checked above. Never resolve again at connection time.
  const dispatcher = new Agent({
    connect: {
      lookup(_host, options, callback) {
        const address = addresses[0];
        if (options.all) callback(null, addresses);
        else callback(null, address.address, address.family);
      },
    },
  });
  try {
    const timeout = AbortSignal.timeout(120000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const response = await fetch(url, {
      ...options,
      signal,
      dispatcher,
      redirect: "error",
    });
    const bytes = await limited(response, 32 * 1024 * 1024);
    return new Response(new Uint8Array(bytes), {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
  } finally {
    await dispatcher.close();
  }
}
export async function upstream(
  provider: ProviderConfig,
  endpoint: string,
  payload?: Record<string, unknown> | FormData,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const multipart = payload instanceof FormData;
  const response = await safeFetch(
    provider.baseUrl + endpoint,
    {
      method: payload ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + provider.apiKey,
        ...(payload && !multipart
          ? { "content-type": "application/json" }
          : {}),
      },
      body: payload
        ? multipart
          ? payload
          : JSON.stringify(payload)
        : undefined,
      signal,
    },
    !!provider.allowPrivate,
  );
  if (!response.ok) throw fail(response.status, "上游 HTTP " + response.status);
  return object(await response.json());
}
