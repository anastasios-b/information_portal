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

Portal article loading is staged:

```text
GET /api/content?initial=1
GET /api/content
GET /api/content?manage=1
```

The first portal response reads `db/articles-initial.json` and renders immediately. The full portal content request then runs in the background and replaces the initial article set when complete. Search uses the currently loaded set, so it works against the initial articles immediately and automatically expands to all portal-visible articles when the background load finishes.

`db/articles.json` remains the canonical article database. `db/articles-initial.json` is a derived homepage index containing the newest published, visible articles by `createdAt`. Its size is controlled by the administrator setting **Initial Articles**, which defaults to 12. The derived index is refreshed when articles change, category visibility changes, or the Initial Articles setting changes.

Management content always loads the complete article database.

Normal `api()` requests use browser `cache: "no-store"`.

Search is centered in the persistent portal header and is available on the homepage and article pages. It searches title, summary, article body, and attached categories, shows up to five dropdown results, and shows **View all results** when more matches exist. The homepage category filter remains client-side.

## R2 database layout

The portal uses independent R2 JSON objects:

```text
db/users.json
db/articles.json
db/articles-initial.json
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


## Category visibility

Article categories can be marked **Hidden** by administrators or editors.

- Hidden categories are omitted from portal-facing category lists.
- A published article assigned only to hidden categories is omitted from portal-facing article lists and content.
- If an article belongs to both hidden and visible categories, it remains visible and only its visible category associations are exposed in portal-facing responses.
- Management views continue to show hidden categories and their articles.
- Existing categories without a stored `hidden` value are treated as visible.


## Homepage settings

Administrators can edit the homepage hero label, title, and description in **Settings**. The same settings area controls **Initial Articles**.


## Homepage and search

Administrators can edit the homepage hero label, title, and description from **Settings → Homepage content**.

Portal pages use a persistent centered header search. Search matches article title, summary, rendered body text, and category names. It displays up to five dropdown matches immediately; when more than five matches exist, **View all results** opens the homepage with the same search query so the complete matching set is shown.

The search uses the initially loaded article index until the full article set finishes loading in the background, then automatically searches the complete set.
