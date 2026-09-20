# Information Portal

Lean information portal for small to medium-sized teams, implemented with React and Cloudflare Pages. It supports authenticated `administrator`, `editor`, and `reader` users plus an optional public mode.

## Required behavior

- `/admin` is the administration route.
- Initial setup is available only while no administrator exists. It creates the first administrator; there is no public registration afterward.
- **Private mode:** anonymous visitors see the login screen.
- **Public mode:** anonymous visitors can read published articles. Existing users and all stored data remain untouched when visibility changes.
- **Administrators:** manage visibility, users, and articles.
- **Editors:** create/import, edit, publish/draft, and delete articles.
- **Readers:** read published content only.
- The final administrator cannot be deleted or demoted. This is enforced server-side as well as represented in the UI.
- All persisted database records use UUIDs, never integer IDs.

## Architecture

- **UI:** React 19 + Vite.
- **Hosting:** Cloudflare Pages.
- **API:** Cloudflare Pages Functions under `/api/*`.
- **Data:** a JSON database object in Cloudflare R2, bound as `PORTAL_DATA`.
- **Concurrency:** database mutations use an R2 conditional write against the current ETag. Conflicting writes retry, which prevents concurrent changes from bypassing invariants such as the required administrator account.
- **Authentication:** signed HttpOnly session cookie. Passwords are stored as PBKDF2-SHA-256 hashes with per-user random salts.

The R2 object is stored at `db/information-portal.json`. Its root, settings record, user records, and article records all carry UUID identifiers.

## Data shape

```json
{
  "id": "UUID",
  "schemaVersion": 1,
  "settings": {
    "id": "UUID",
    "mode": "private"
  },
  "users": [
    {
      "id": "UUID",
      "email": "admin@example.com",
      "role": "administrator"
    }
  ],
  "articles": [
    {
      "id": "UUID",
      "title": "Example",
      "status": "published",
      "authorId": "UUID"
    }
  ]
}
```

Password hashes and timestamps are omitted from the example.

## Local development

Requirements: current Node.js LTS and npm.

```bash
npm install
cp .env.example .dev.vars
```

Set a random `SESSION_SECRET` of at least 32 characters in `.dev.vars`. `BOOTSTRAP_TOKEN` is optional; when set, initial setup requires it.

Then run:

```bash
npm run dev:pages
```

Wrangler persists the R2 binding locally by default.

## Cloudflare deployment

1. Authenticate Wrangler:

```bash
npx wrangler login
```

2. Create the production R2 bucket once:

```bash
npx wrangler r2 bucket create information-portal-data
```

3. Create or connect the Cloudflare Pages project named `information-portal`.

4. Configure the session secret before the deployment that uses it:

```bash
npx wrangler pages secret put SESSION_SECRET --project-name information-portal
```

Optionally protect first-run setup with:

```bash
npx wrangler pages secret put BOOTSTRAP_TOKEN --project-name information-portal
```

5. Build and deploy:

```bash
npm run deploy
```

For Git-connected Pages deployments, use `npm run build` as the build command and `dist` as the output directory. `wrangler.jsonc` is the source of truth for the R2 binding.

## Security notes

- R2 is accessed only by Pages Functions; credentials are never sent to the React client.
- Session cookies are HttpOnly, SameSite=Lax, and Secure on HTTPS.
- Mutating API requests reject cross-origin browser requests.
- React renders article text as text rather than raw HTML, avoiding an unnecessary HTML/Markdown injection surface.
- Changing a user's password rotates their session nonce, invalidating existing sessions for that user.
- For Internet-facing deployments, add Cloudflare rate limiting/WAF rules to the login and setup endpoints as appropriate for your threat model.
