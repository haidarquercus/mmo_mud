(() => {
  const KEY = "kmmoToken";
  let token = localStorage.getItem(KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(KEY, token);
  }
  // keep cookie in sync for server fallback
  document.cookie = `${KEY}=${encodeURIComponent(token)}; path=/; max-age=31536000; SameSite=Lax`;
  window.__KM_TOKEN__ = token;
})();
