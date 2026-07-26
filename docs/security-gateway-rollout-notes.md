# Security gateway rollout notes

## OpenClaw pages compatibility

The security-gateway implementation currently serves `$OPENCLAW_STATE_DIR/pages`
through AlphaClaw with a restrictive browser sandbox. We are keeping this
protection for initial testing, but it is a deliberate compatibility risk rather
than a proven backwards-compatible change.

The sandbox may affect existing customer pages that use:

- relative or same-origin `fetch()`;
- JavaScript modules;
- HTML forms or `<base>` elements;
- embedding in another page;
- same-origin browser storage; or
- authenticated AlphaClaw API requests.

Before a production rollout, test representative existing pages, including pages
that load JSON or other assets dynamically and pages that communicate with
AlphaClaw APIs.

### Compatibility rollback

If existing pages are negatively affected, roll back the browser sandbox as one
coherent compatibility change rather than selectively adding sandbox exceptions:

1. Stop attaching `kPageContentSecurityPolicy` in
   `lib/server/routes/pages.js`.
2. Remove the corresponding runtime guidance about unsupported `fetch()` and ES
   modules from `lib/setup/core-prompts/AGENTS.md`.
3. Replace the CSP/CORS expectations in
   `tests/server/routes-pages.test.js` with compatibility coverage for the page
   behaviors that need to remain supported.

Keep the independent protections in the page handler: private/public ingress
enforcement, trusted gateway-source verification, path containment, symlink
escape prevention, dotfile rejection, method restrictions, and
`X-Content-Type-Options: nosniff`.

If stronger page isolation is still required after a compatibility rollback,
design it as a separate-origin feature with an explicit migration plan instead
of incrementally weakening the same-origin sandbox.

## Tailscale API token lifetime

The provisioning workflow assumes the submitted Tailscale API token remains
valid for at least one day. That is sufficient for the current synchronous
onboarding flow.

The token is used only near the end of the active onboarding request for tailnet
policy, HTTPS, auth-key, device-verification, and device-invite operations. It is
not persisted and is not used by startup, dashboard access, or a background
reconciliation process. A failed onboarding retry requires a newly submitted
token.

Revisit when the token is collected if its minimum lifetime is shortened
materially or if Tailscale finalization becomes asynchronous or deferred beyond
the onboarding request.
