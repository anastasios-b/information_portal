# Information Portal

React information portal deployed as one Cloudflare Worker with Static Assets and R2 storage.

## Admin routes

- `/admin` redirects to `/admin/articles`
- `/admin/articles`
- `/admin/categories`
- `/admin/announcements`
- `/admin/logbook` (administrators only)
- `/admin/users`
- `/admin/settings`

## Portal content loading

Portal content is loaded through one aggregate endpoint:

```text
GET /api/content
GET /api/content?manage=1
```

The React application memoizes that request in memory for the current visibility/user scope. Home and article navigation reuse the same loaded articles, categories, active announcements, and private-mode comments instead of querying those resources again. Administrative article/category/announcement mutations patch the already-loaded client state directly.

A visibility or authentication scope change creates a new content scope and performs one fresh aggregate load because the permitted dataset can change.

Normal `api()` requests use browser `cache: "no-store"`.

Search and category filtering are entirely client-side after the initial content load:

- live text search across title, summary, article body, and every attached category
- category dropdown
- combined search + category filtering
- live result count
- no API request on each keystroke

## R2 database layout

The portal uses independent R2 JSON objects:

```text
db/users.json
db/articles.json
db/article-categories.json
db/settings.json
db/logbook.json
db/announcements.json
db/comments.json
```

Each file has its own UUID root record and conditional-write ETag.

The API reads only the stores needed by the operation. Examples:

```text
login                         users
bootstrap                     users + settings
portal content load           settings + users when private + articles + article-categories + announcements + comments when private
manage content load           settings + users + articles + article-categories + announcements
admin user CRUD               users
article save                  users + article-categories + articles + asynchronous logbook
category save                 users + article-categories + asynchronous logbook
category delete               users + articles + article-categories + asynchronous logbook
visibility change             users + settings + asynchronous logbook
announcement CRUD             users + announcements
comment create                settings + users + articles + comments
```

### Legacy migration

The previous object remains supported as a read-only migration source:

```text
db/information-portal.json
```

If one of the new split files does not exist, the Worker reads the legacy object once, extracts only that store's data, and writes the new split file. After the legacy-backed stores have been touched, normal API traffic no longer needs the monolithic object.

Existing users, password hashes, articles, categories, visibility mode, UUIDs, and timestamps are retained. Legacy single-category articles remain readable and are exposed to the client as `categoryIds[]`. Legacy users without a full name remain readable and use their email as the display-name fallback until edited.

## Permissions

- Initial setup exists only while there is no administrator.
- No public registration is available afterward.
- Administrators manage users, categories, articles, announcements, visibility, and the administrator-only logbook.
- Editors manage categories, articles, and announcements.
- Readers consume published content.
- Comments are available only while the portal is private.
- Administrators and editors always have comment write access.
- Reader comment writing is an administrator-controlled per-user boolean and defaults to disabled.
- Users with comment write access can edit or delete only their own comments.
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


## Logbook

Audit entries are stored in `db/logbook.json`. Logbook access is restricted to administrators only.


## Articles, comments, and announcements

Articles can be attached to one or more categories. The persisted canonical field is:

```json
{ "categoryIds": ["<uuid>", "<uuid>"] }
```

Private-mode article pages include comments. Each comment stores a snapshot of the author's full name and email and is displayed as:

```text
Full Name (email@example.com)
```

Announcements are managed by administrators and editors. Each announcement has a required start date and an optional end date; an omitted end date means the announcement remains eligible indefinitely. Public/private portal content includes only announcements active at the current time, while the manage endpoint includes all announcements.

The Home and Article pages show a right sidebar with **Announcements** above **Recent Articles**. Up to three announcements appear inline; when more are active, **Show all** opens a right-side drawer with the full list.

## Visual accent

The portal's distinct accent color is:

```text
#e74e24
```


## Portal identity

Portal name is configurable by administrators under **Settings → Portal name**. Existing installations default to **Information Portal**. The configured value is used for the visible portal/admin brand, sign-in screen, and browser document title.

## Announcement status

The Announcements admin list displays a status indicator immediately after the title:

- **Stopped** in orange when an end date exists and has already passed.
- **Active** in green otherwise.

The status badge is an administrative indicator; portal visibility still follows the announcement start/end scheduling rules.
