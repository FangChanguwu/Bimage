// Capture and remove the setup secret before any application resources load.
(() => {
  const url = new URL(window.location.href);
  let token = url.searchParams.get("setup_token") || "";
  if (url.searchParams.has("setup_token")) {
    url.searchParams.delete("setup_token");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) token = "";
  window.__bimageTakeSetupToken = () => {
    const value = token;
    token = "";
    return value;
  };
})();
