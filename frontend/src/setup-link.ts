declare global {
  interface Window {
    __bimageTakeSetupToken?: () => string;
  }
}

// The synchronous HTML bootstrap owns URL cleanup, before resource loading.
export function takeSetupToken(): string {
  const take = window.__bimageTakeSetupToken;
  delete window.__bimageTakeSetupToken;
  return take?.() ?? '';
}
