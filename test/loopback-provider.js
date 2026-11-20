import { createProviderNetwork, validateUrl } from '../backend/dist/network.js';

// In-process dependency for functional tests. Only the specific fixture server
// is allowed; the production entrypoint never supplies a custom network.
export function loopbackProvider(server) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  return createProviderNetwork(async (raw, resultUrl = false) => {
    const url = new URL(raw);
    if (url.origin !== origin || url.username || url.password || url.hash || (!resultUrl && url.search)) {
      return validateUrl(raw, resultUrl);
    }
    return { url, addresses: [{ address: '127.0.0.1', family: 4 }] };
  });
}
