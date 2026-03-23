const TOKEN_KEY = "orchestra_auth_token";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Check URL for ?token= param, store it, and strip from the URL.
 * This enables QR code links that auto-authenticate.
 */
export function extractTokenFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  if (token) {
    setStoredToken(token);
    // Remove token from URL to avoid leaking it in history/bookmarks
    params.delete("token");
    const cleanUrl = params.toString()
      ? `${window.location.pathname}?${params}`
      : window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);
    return true;
  }
  return false;
}
