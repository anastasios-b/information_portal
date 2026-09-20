# Information Portal

React information portal deployed as one Cloudflare Worker with Static Assets and R2 storage.

## Admin routes

- `/admin` redirects to `/admin/articles`
- `/admin/articles`
- `/admin/categories`
- `/admin/users`
- `/admin/settings`

## Portal search

The portal loads articles and categories once, then performs filtering entirely in the client:

- live text search across title, summary, article body, and category name
- category dropdown
- combined search + category filtering
- live result count
- no API request on each keystroke

When the portal is public, its first article/category load is cached in `sessionStorage` for five minutes. Private portal data is never put in that cache.

Normal `api()` requests always use browser `cache: "no-store"`. All admin screens use this uncached API path. Admin data is therefore fetched fresh when an admin page loads or reloads after a mutation.

## R2 database layout

The former monolithic JSON database has been split into four independent objects:

```text
db/users.json
db/articles.json
db/article-categories.json
db/settings.json
```

Each file has its own UUID root record and conditional-write ETag.

The API reads only the stores needed by the operation. Examples:

```text
login                         users
bootstrap                     users + settings
public article list           settings + articles
public category list          settings + article-categories
admin user CRUD               users
article save                  users + article-categories + articles
category save                 users + article-categories
category delete               users + articles + article-categories
visibility change             users + settings
```

### Legacy migration

The previous object remains supported as a read-only migration source:

```text
db/information-portal.json
```

If one of the new split files does not exist, the Worker reads the legacy object once, extracts only that store's data, and writes the new split file. After all four stores have been touched, normal API traffic no longer needs the monolithic object.

Existing users, password hashes, articles, categories, visibility mode, UUIDs, and timestamps are retained. Legacy articles without a category remain `Uncategorized` until edited.

## Permissions

- Initial setup exists only while there is no administrator.
- No public registration is available afterward.
- Administrators manage users, categories, articles, and visibility.
- Editors manage categories and articles.
- Readers consume published content.
- The last administrator cannot be deleted or demoted.
- Visibility changes require the logged-in administrator's current password.
- The currently selected visibility mode cannot be selected again.

## Authentication

Passwords use PBKDF2-SHA-256 with:

- random per-user salt
- stored iteration count
- 60,000 iterations for newly generated hashes
- compatibility with URL-safe and standard Base64 stored hashes

Changing a password rotates the user's session nonce and invalidates previous sessions.

## Concurrency

Each R2 store uses conditional writes against its own ETag. Failed conditions are retried before returning a write conflict. Cloudflare R2 supports conditional `put()` through the `onlyIf` option.

## Tests

`npm run build` executes tests before Vite compilation:

```bash
npm test
vite build
```

Regression coverage includes:

- password login
- split-store creation
- legacy monolithic migration
- store-level API read tracing
- public/private visibility
- category/article integrity
- administrator invariants
- structured R2 failures
- live search UI contract
- public cache contract
- admin no-cache contract

## Cloudflare deployment

Create the R2 bucket once:

```bash
npx wrangler r2 bucket create information-portal-data
```

Set the session secret:

```bash
npx wrangler secret put SESSION_SECRET
```

Workers Builds:

```text
Build command:  npm run build
Deploy command: npx wrangler deploy
```


## Inline article images

Administrators and editors can upload JPEG, PNG, WebP, GIF, or AVIF images up to 5 MB while editing an article.

New images are stored by their original filename:

```text
article-images/hotel-map.png
article-images/front-desk.webp
```

The article body references that filename directly:

```text
[[image:hotel-map.png|50]]
```

The final value is the display width percentage. Supported widths are 25%, 50%, 75%, and 100%. Resizing only changes the article token; it does not rewrite the image binary.

Duplicate filenames are rejected instead of overwriting an existing media object.

### Media library

The article editor includes a **Media library** button. It opens a fresh, uncached list of existing filename-backed article images from R2. Selecting an image inserts it at the current content cursor position.

The media library endpoint is restricted to administrators and editors:

```text
GET /api/article-images
```

Image API:

```text
GET  /api/article-images
POST /api/article-images
GET  /api/article-images/:filename
```

Uploads send the original filename separately from the binary body. Image reads follow portal visibility: private mode requires authentication; public mode allows published article images to load publicly.

Legacy UUID-backed image references remain readable for existing articles, but they are not shown in the filename-based media library because their original filenames were never stored.
