# Orchestra Auth Hardening Autoplan

Branch: `orchestra/orchestra-v8pgj7x6te`
Base branch: `main`
Platform: GitHub
Scope: fix the remote auth bug without losing localhost, LAN, tunnel, or Tailscale functionality.

## Problem

Right now Orchestra has one bad simplification:

```text
loopback request == trusted request
```

That is fine for a browser on the same machine hitting `localhost`.
It is wrong for proxy-backed remote access, because `tailscale serve` terminates on localhost too.

The result is two separate problems in the same auth surface:

1. Host validation turns off when bearer auth exists.
2. Loopback traffic is treated as authenticated even when it is really remote traffic arriving through Tailscale.

Users feel this as "remote access works," but the mechanism is sloppy. It creates a real security bug and then warns about it in the UI.

## Goal

Ship a clean auth matrix:

```text
Direct localhost browser      -> no token
LAN / Cloudflare / SSH        -> bearer token
Tailscale Serve browser       -> Tailscale identity -> signed session cookie
Tailscale tagged device       -> bearer token fallback
WebSocket                     -> same cookie or bearer token
```

No UX loss.
No "tailnet devices can access without a token" warning.
No host-header bypass.

## Non-Goals

- Full multi-user RBAC
- Tailscale OIDC / `tsidp`
- Reworking all remote auth UI flows in one shot
- Removing every query-token path in the same PR if it creates rollout risk

## Current State

Files involved now:

- `server/src/index.ts`
- `server/src/auth.ts`
- `server/src/utils/origins.ts`
- `server/src/routes/tailscale.ts`
- `client/src/lib/auth.ts`
- `client/src/hooks/useWebSocket.ts`
- `client/src/components/RemoteAccessSettings.tsx`

Current behavior:

- Host validation only blocks bad hosts when there is no `authToken`.
- REST auth is skipped for loopback traffic.
- WS auth is skipped for loopback traffic.
- Tailscale traffic looks like loopback traffic.
- UI explicitly warns that any tailnet device gets in without a token.

## Chosen Approach

Use Tailscale as a first-class auth provider instead of a localhost exception.

Core idea:

1. Always enforce host validation.
2. Stop equating loopback with authenticated.
3. Treat trusted Tailscale identity headers as a bootstrap auth signal.
4. Mint a short-lived signed session cookie for the browser.
5. Let REST and WebSocket use that cookie after first page load.
6. Keep bearer auth for non-Tailscale remote paths and tagged-device Tailscale fallbacks.

This is the clean line:

```text
transport source says how the request arrived
identity says who is allowed
```

That is the whole game.

## CEO Review

### User outcome

The user should be able to:

- keep opening Orchestra on `localhost` with no token
- keep using LAN/tunnel/SSH with a bearer token
- keep using Tailscale from another device without a separate token prompt
- keep tagged-device access working via bearer fallback
- stop seeing a warning that the Tailscale path is insecure

### Scope decisions

Auto-decisions:

- Include Tailscale bootstrap cookie auth in this work. Yes.
- Include WebSocket auth alignment in this work. Yes.
- Include UI copy updates in this work. Yes.
- Include URL-token removal in this work. No. Keep existing bearer-token remote flows intact until the cookie bootstrap path is proven.
- Include full tunnel auth redesign in this work. No.

Verdict:

This is a boilable lake. Same blast radius, same user job, under 10 files plus tests.

## Design Review

UI changes are small but important. The current copy tells the truth about the bug. After the fix, that copy becomes wrong.

### Desired user-facing copy

Tailscale ready state should say something like:

```text
This URL works from devices on your tailnet.
Orchestra will sign you in with your Tailscale identity.
```

LAN/tunnel/manual remote access should still describe token-based auth plainly.

### UX constraints

- No extra modal on healthy Tailscale access
- No new settings unless strictly needed
- No ambiguous "maybe secure" wording
- Fresh phone/tablet cold-start must work on the very first request
- If Tailscale identity bootstrap fails, fail closed and show a direct auth error

## Engineering Review

### Architecture

Add one explicit auth decision layer instead of scattering rules through `index.ts`.

Proposed server structure:

```text
server/src/auth.ts
  - token helpers
  - cookie signing + verification
  - auth context parsing
  - request classification helpers

server/src/index.ts
  - host validation middleware
  - auth middleware using auth context
  - WS upgrade auth using same rules
```

### Request classification

Define four cases:

1. `local_direct`
   Browser is hitting `localhost` / `127.0.0.1` directly. No remote proxy identity. No bearer required.

2. `tailscale_bootstrap`
   Request arrived on loopback, host matches the Tailscale hostname, and trusted Tailscale identity headers are present. Server should mint a signed session cookie.

3. `session_authenticated`
   Request presents a valid Orchestra session cookie. Allow.

4. `tailscale_tagged_fallback`
   Request arrived through the local Tailscale proxy but user identity headers are absent. Require bearer auth and do not auto-sign-in.

5. `bearer_authenticated`
   Request presents a valid bearer token. Allow.

Anything else: reject.

### Trust rule for Tailscale headers

Only trust Tailscale identity headers when all of these are true:

- request source is loopback
- request host matches detected Tailscale hostname or configured remote URL host for that Tailscale path
- Tailscale identity headers are present

Reason:

- remote tailnet traffic reaches Orchestra through the local `tailscale serve` proxy
- spoofed headers from arbitrary LAN clients should not be trusted
- local processes can already access `localhost`, so trusting loopback+hostname is an acceptable boundary here

Tagged-device rule:

- if request looks like Tailscale Serve traffic on loopback but `Tailscale-User-*` headers are absent, do not auto-sign-in
- fall back to bearer auth
- test this explicitly so the plan stays honest about what “no UX loss” really covers

### Session cookie

Add a signed cookie with:

- auth provider: `tailscale`
- login / display name
- issued-at
- expiry

Cookie properties:

- `HttpOnly`
- `Secure` when request is HTTPS
- `SameSite=Lax`
- path `/`
- short TTL, for example 12 hours

Signing secret:

- stored in the Orchestra data dir beside the auth token
- generated once if absent

### Bootstrap path

The first Tailscale browser request must mint the cookie.

Concrete rule:

- on `GET` or `HEAD` requests for non-`/api/*` paths
- if request class is `tailscale_bootstrap`
- and no valid Orchestra session cookie exists
- set the signed session cookie before serving the SPA shell or static asset

Expected cold-start flow:

```text
device opens https://host.ts.net/
-> initial HTML request carries trusted Tailscale identity headers
-> Orchestra sets session cookie on that HTML response
-> SPA boots
-> API + WS use the cookie
```

### REST flow

For `/api/*`:

1. enforce host validation first
2. read auth context
3. allow `local_direct`
4. allow valid session cookie
5. allow valid bearer token
6. allow `tailscale_bootstrap` only on eligible non-API bootstrap requests and mint the cookie there
7. keep `Origin` validation mandatory for every state-changing request, including cookie-authenticated ones
8. otherwise reject

### WebSocket flow

WS needs to stop making its own auth guesses.

Plan:

1. Share the same auth-context logic with HTTP.
2. Accept valid bearer token for non-cookie remote clients.
3. Accept valid session cookie for Tailscale browser flows.
4. Accept valid bearer token for tagged-device or non-browser fallback clients.
5. Stop depending on loopback as a proxy for "already authenticated."

Keep bearer query-param auth temporarily for non-browser fallback if needed.
Do not remove existing query-token support in this PR. De-prioritize it for the normal Tailscale browser path once the cookie flow exists.

### Host validation

Change from:

```text
block invalid host only when authToken is absent
```

to:

```text
always block invalid host
```

Also extend allowed hosts carefully so real remote entrypoints still work:

- `localhost`
- `127.0.0.1`
- detected Tailscale hostname
- tunnel hostname
- hostname extracted from `remoteUrl`, if set

First-request race handling:

- if request arrives on loopback with candidate Tailscale Serve headers and `tailscaleHostname` is still null
- do a one-shot detector refresh in middleware
- re-evaluate the host allowlist with the resolved hostname
- if hostname still cannot be proven, fail closed

### Client changes

`client/src/components/RemoteAccessSettings.tsx`

- remove the insecure Tailscale warning
- explain Tailscale identity sign-in
- explain that tagged-device paths still use bearer auth
- keep token messaging for manual remote URLs where applicable

`client/src/hooks/useWebSocket.ts`

- prefer cookie-backed WS auth when the browser already has a session
- keep bearer query-param fallback only where still needed

`client/src/lib/auth.ts`

- keep current storage helpers for bearer mode
- keep URL-token ingestion untouched in this PR for existing bearer-based remote flows
- do not require URL tokens for the normal Tailscale browser path once cookie bootstrap is live

## Test Plan

Add and update server tests for:

- invalid `Host` is rejected even when external auth is enabled
- loopback request with bad `Host` is rejected
- direct localhost request still works without bearer
- LAN-style remote request without bearer is rejected
- bearer-authenticated remote request still works
- first Tailscale HTML request mints a session cookie before SPA boot
- loopback request with trusted Tailscale identity headers mints a session cookie
- subsequent API request with session cookie succeeds without bearer
- forged Tailscale headers on non-loopback request are rejected
- loopback Tailscale request with missing user headers falls back to bearer auth
- WS upgrade accepts valid session cookie
- WS upgrade rejects remote unauthenticated request even if loopback heuristics would previously have passed
- cookie-authenticated POST with bad `Origin` is rejected
- cookie-authenticated DELETE with bad `Origin` is rejected
- first-request host validation succeeds after hostname refresh when detector cache is cold

Client/UI tests:

- Tailscale ready state no longer claims tokenless insecure access
- Tailscale copy reflects identity-based sign-in
- tagged-device fallback copy is accurate

Regression tests:

- existing auth token flows still pass
- origin validation still blocks cross-origin mutation

## Rollout Plan

Land server auth, WS auth, bootstrap path, and UI copy in one branch.

### Verification

After merge, manually verify:

1. `localhost` on the host machine still works without a token
2. LAN access still requires token
3. Tailscale HTTPS signs in automatically
4. first cold-start Tailscale page load gets a cookie on the HTML response
5. WebSocket connects over Tailscale with the cookie
6. tagged-device access still works with bearer auth
7. DNS-rebinding style bad `Host` gets `403`

## Implementation Order

1. Refactor `server/src/auth.ts` into explicit request classification, cookie helpers, and tagged-device fallback handling.
2. Update `server/src/utils/origins.ts` host allowlist support for `remoteUrl` hostname and active remote hosts.
3. Replace host validation in `server/src/index.ts`, including the one-shot Tailscale hostname refresh path.
4. Add non-API bootstrap handling in `server/src/index.ts` so first HTML load can set the cookie.
5. Replace REST auth middleware in `server/src/index.ts`.
6. Replace WS auth path in `server/src/index.ts`.
7. Add tests for host validation, cookie bootstrap, tagged-device fallback, CSRF, and WS auth.
8. Update Tailscale status/UI copy.
9. Run `bun test`.

## Risks

- Cookie auth on WS can be subtle if Bun upgrade handling differs from normal request parsing.
- Tailscale tagged-device behavior does not include user-login headers, so the bearer fallback path is mandatory.
- Mixing bearer and cookie auth in the same client needs a clean precedence rule.
- First-request detector refresh must not turn into a slow path on every request.

## Decision Log

- Chose cookie bootstrap over "token everywhere" because it preserves the Tailscale UX.
- Chose first-HTML-response bootstrap over a separate login endpoint because it removes an unnecessary extra hop for fresh devices.
- Chose explicit request classification over more boolean checks in `index.ts` because security code needs one place to read the truth.
- Kept bearer auth for LAN/tunnel and tagged-device fallback because that preserves access while staying honest about Tailscale header limits.
- Did not pull in full OIDC because this is a fix, not a platform rewrite.

## Final Verdict

Implement this as one auth hardening feature with tests.

Do not ship a half fix like "always require token remotely" unless you want to deliberately change the Tailscale UX.
Do not keep the current localhost trust shortcut. That shortcut is the bug.
