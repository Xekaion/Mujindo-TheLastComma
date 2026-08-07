# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Secure player economy

The `/market` route contains the server-backed equipment auction house, the
gold-bar/Memory Ash order book, the Steam top-up surface, and the account
security center. On localhost, open `/market?demo=A` and switch between demo
users A/B to exercise real D1 escrow and settlement without using a payment
provider. Local save-slot items and balances are deliberately never accepted
by the market API.

Production runtime values belong in encrypted Worker/Sites configuration:

- `ECONOMY_ACCOUNT_PEPPER`: high-entropy secret used to pseudonymize platform subjects and network rate-limit keys.
- `ECONOMY_ADMIN_KEY`: localhost-only emergency-admin test key. The worker hard-locks this API on remote hosts until operator MFA, RBAC, named audit identities, and two-person approval are implemented.
- `STEAM_APP_ID` and `STEAM_PUBLISHER_KEY`: server-only Steam ownership and MicroTxn credentials.
- `STEAM_MICROTXN_SANDBOX=true`: use Steam's sandbox while testing payments.
- `ECONOMY_LIVE_ENABLED=true`: separately unlocks production market writes after Steam ownership and server-issued asset flows are ready.
- `ECONOMY_PAYMENTS_ENABLED=true`: unlocks only Steam MicroTxn sandbox testing while `STEAM_MICROTXN_SANDBOX=true`. Production payment remains hard-blocked in code until GetReport reconciliation, refunds, chargebacks, debt recovery, and incident drills are implemented.
- `PVP_ACCOUNT_AUTH_ENABLED=true`: requires the same verified Steam/internal account on every PVP session and sync request, making login/PVP sanctions immediately enforceable.

Remote economy identity is Steam-session-only; hosting name/email headers are
never accepted as account authority or exposed as seller names. Apply the D1
migrations in order (`0001_secure_market.sql`, then `0002_loud_major_mapleleaf.sql`).
The first economy request installs the 26 versioned D1 triggers from
`worker/economy-triggers.sql` as individual prepared statements and records a
schema marker; the request fails closed if that atomic installation fails.
Before any real-money launch, complete every gate in `docs/economy-security.md`,
including server-authoritative PvE issuance and Korean legal/rating review.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
