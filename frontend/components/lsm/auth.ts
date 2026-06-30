/**
 * Client-side auth helpers for the LSM (Predict) web app.
 *
 * Cross-subdomain SSO (Requirement 23): the backend issues a `.agentrix.top`
 * domain-scoped HttpOnly cookie `agentrix_token` (and the JWT guard accepts it),
 * so a user logged in on agentrix.top is already authenticated on
 * polymarket.agentrix.top. We therefore treat EITHER a localStorage token
 * (same-origin login) OR the shared cookie as a session. These helpers only
 * drive UI gating + login redirect; they are NOT a security boundary.
 */

/** True when a shared `.agentrix.top` SSO cookie is present (HttpOnly cookies
 * are not readable, but the non-HttpOnly mirror / presence marker is). */
function hasSsoCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return /(?:^|;\s*)agentrix_token=/.test(document.cookie);
}

/** True when a plausible session (localStorage token OR shared SSO cookie) exists. */
export function isLoggedIn(): boolean {
  if (typeof window === 'undefined') return false;
  const token =
    localStorage.getItem('access_token') ||
    localStorage.getItem('authToken') ||
    sessionStorage.getItem('authToken');
  if (token && token.length > 8) return true;
  return hasSsoCookie();
}

/** Send the user to the existing login flow, remembering where to return. */
export function gotoLogin(redirectTo?: string): void {
  if (typeof window === 'undefined') return;
  const target = redirectTo || window.location.pathname + window.location.search;
  window.location.href = `/auth/login?redirect=${encodeURIComponent(target)}`;
}
