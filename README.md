# Information Portal

Lean React information portal for small to medium-sized teams, deployed as one Cloudflare Worker with Static Assets and R2 storage.

## Admin routes

- `/admin` redirects to `/admin/articles`.
- `/admin/articles`
- `/admin/categories`
- `/admin/users`
- `/admin/settings`

Navigation is URL-driven rather than tab-only state.

## Behavior

- Initial setup exists only while no administrator exists.
- There is no public registration afterward.
- Private mode requires login.
- Public mode exposes published articles.
- Switching public/private mode requires the logged-in administrator's current password.
- The currently selected mode cannot be selected again.
- Administrators manage users, categories, articles, and visibility.
- Editors manage categories and articles.
- Readers consume published content.
- The last administrator cannot be deleted or demoted.
- All persisted entity IDs are UUIDs.
- "View portal" opens the public portal in a new tab.

## Categories

Categories are UUID-backed database records. Articles store a `categoryId`.

API:

```text
GET    /api/categories
GET    /api/categories?manage=1
POST   /api/categories
PUT    /api/categories/:uuid
DELETE /api/categories/:uuid
```

Administrators and editors may manage categories. A category cannot be deleted while an article references it.

## Database migration

The JSON database is stored at:

```text
db/information-portal.json
```

Schema version 2 adds:

```json
{
  "categories": [],
  "articles": [
    {
      "categoryId": "UUID"
    }
  ]
}
```

Existing schema-v1 users and articles are preserved. Existing articles migrate with `categoryId: null` and remain readable as "Uncategorized" until edited. The migrated schema is persisted on the next database mutation.

## Authentication

Passwords are stored as PBKDF2-SHA-256 records with:

- per-user random salt
- stored iteration count
- derived hash
- URL-safe Base64 encoding

Verification uses the same derivation function as hashing and accepts both URL-safe Base64 and standard Base64 for compatibility with previously stored hashes.

Changing a user's password rotates the session nonce and invalidates their old sessions.

## Architecture

- React + Vite frontend
- Cloudflare Worker API
- Workers Static Assets
- Cloudflare R2 JSON storage
- signed HttpOnly session cookie
- R2 conditional writes for concurrent mutation safety

## Tests

`npm run build` runs regression tests before Vite compilation.

The suite covers:

- initial setup
- schema migration
- UUID storage
- password hashing/login compatibility
- password-confirmed visibility switching
- category CRUD
- article/category integrity
- article access and management
- administrator/editor/reader permissions
- final-admin protection
- password change/session invalidation
- infrastructure errors
- required UI routes and controls

Run:

```bash
npm test
```

## Cloudflare deployment

Create the bucket once:

```bash
npx wrangler r2 bucket create information-portal-data
```

Set the required secret:

```bash
npx wrangler secret put SESSION_SECRET
```

Optional first-setup protection:

```bash
npx wrangler secret put BOOTSTRAP_TOKEN
```

Workers Builds:

```text
Build command:  npm run build
Deploy command: npx wrangler deploy
```
