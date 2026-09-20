# Information Portal

Lean React information portal for small to medium-sized teams, deployed as one Cloudflare Worker with Static Assets and R2 storage.

## Required behavior

- The administration UI lives under `/admin`.
- Initial setup is available only while no administrator exists. It creates the first administrator; there is no public registration afterward.
- **Private mode:** anonymous visitors must sign in.
- **Public mode:** anonymous visitors can read published articles. Changing visibility never deletes users or articles.
- **Administrators:** manage visibility, users, and articles.
- **Editors:** create/import, edit, publish/draft, and delete articles.
- **Readers:** read published content only.
- The final administrator cannot be deleted or demoted.
- All persisted database records use UUIDs, never integer IDs.

## Architecture

- **UI:** React 19 + Vite.
- **Hosting:** Cloudflare Workers Static Assets.
- **API:** native Worker routes under `/api/*`.
- **Data:** one JSON database object in R2, bound as `PORTAL_DATA`.
- **Database key:** `db/information-portal.json`.
- **Concurrency:** R2 conditional writes against the current ETag retry on conflicts.
- **Authentication:** signed HttpOnly session cookie.
- **Passwords:** PBKDF2-SHA-256 with a per-user random salt.
- **Observability:** Workers Logs enabled through `wrangler.jsonc`.

The database root, settings record, user records, and article records all carry UUID identifiers.

## Automated verification

`npm run build` runs the Worker API regression suite before Vite builds the UI. The tests cover:

- initial administrator setup and registration lockout
- UUID-backed persistence
- login
- private/public visibility
- administrator user management
- final-administrator delete/demotion protection
- editor article permissions
- reader permissions
- password-change session invalidation
- clean JSON infrastructure errors
- presence of the required UI features

Run them directly with:

```bash
npm test
```

## Local development

```bash
npm install
cp .env.example .dev.vars
```

Set `SESSION_SECRET` to a random value of at least 32 characters. `BOOTSTRAP_TOKEN` is optional.

Build and run the complete Worker locally:

```bash
npm run dev:worker
```

Wrangler provides local R2 persistence for development.

## Cloudflare configuration

Create the R2 bucket once:

```bash
npx wrangler r2 bucket create information-portal-data
```

Configure the Worker secret:

```bash
npx wrangler secret put SESSION_SECRET
```

Optionally protect initial setup:

```bash
npx wrangler secret put BOOTSTRAP_TOKEN
```

For Git-connected Workers Builds use:

```text
Build command:  npm run build
Deploy command: npx wrangler deploy
```

The R2 binding is declared in `wrangler.jsonc`:

```json
{
  "binding": "PORTAL_DATA",
  "bucket_name": "information-portal-data"
}
```

## Security notes

- R2 is only accessible server-side through the Worker binding.
- Session cookies are HttpOnly, SameSite=Lax, and Secure on HTTPS.
- Mutating requests reject cross-origin browser requests.
- Article bodies are rendered as text rather than raw HTML.
- Password changes rotate the user's session nonce and invalidate existing sessions.
- R2 write conflicts cannot silently bypass administrator-count invariants.
- Add Cloudflare rate limiting/WAF controls for login/setup if the portal becomes Internet-facing at meaningful scale.
