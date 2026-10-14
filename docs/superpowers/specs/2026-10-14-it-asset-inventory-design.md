# IT Asset Inventory — Design Spec

Date: 2026-10-14
Status: Approved for planning

## Purpose

A small web app for recording and tracking office and IT assets (laptops,
monitors, phones, and similar equipment). Staff sign in with an email
account, then add, edit, delete, search, and filter asset records. The app
is a static site; all data lives in a hosted Supabase Postgres database.

Success means a signed-in staff member can find any asset and its current
holder in a few seconds, and that nobody who is not signed in can read or
change the data.

## Constraints

- Plain HTML, CSS, and JavaScript. No build step, no bundler, no npm
  install. The `@supabase/supabase-js` client loads from a CDN as an ES
  module.
- Hosted on GitHub Pages, deployed automatically on push to `main`.
- Because the site is static and public, the repository may contain only
  the Supabase **anon** key. The `service_role` key must never appear in
  this repository or in any client code.
- Row Level Security is the only barrier protecting the data. It must be
  enabled before the app is used with real records.

## Out of scope

CSV import and export, a change-history audit log, file or photo
attachments, barcode scanning, and per-user data isolation. These may be
added later; none of them shape the current design.

## Architecture

```
Browser (static HTML + JS)
  |
  +-- supabase-js (CDN, ES module)
        |
        +-- Supabase Auth      (email + password sessions)
        +-- Supabase Postgres  (assets table, protected by RLS)

GitHub repository --(GitHub Actions)--> GitHub Pages
```

There is no application server. The browser talks to Supabase directly,
and Supabase enforces access rules in the database.

## Data model

Table `public.assets`:

| Column      | Type        | Constraints / default                  |
|-------------|-------------|----------------------------------------|
| id          | uuid        | primary key, default `gen_random_uuid()` |
| asset_tag   | text        | not null, unique                       |
| name        | text        | not null                               |
| category    | text        | nullable                               |
| status      | text        | nullable                               |
| assigned_to | text        | nullable                               |
| location    | text        | nullable                               |
| note        | text        | nullable                               |
| created_at  | timestamptz | not null, default `now()`              |
| updated_at  | timestamptz | not null, default `now()`              |
| owner_id    | uuid        | default `auth.uid()`, references `auth.users(id)` |

`category` and `status` are free text in the database, but the form offers
fixed choices: category from Laptop, Desktop, Monitor, Phone, Network,
Other; status from In use, Spare, Repair, Retired. Keeping them as text
avoids a migration when the list changes.

A `before update` trigger sets `updated_at` to `now()` on every update.

`owner_id` records who created the row. It is informational only; it does
not restrict access.

## Access control

Row Level Security is enabled on `assets`. Four policies — one each for
select, insert, update, and delete — all grant access when
`auth.uid() is not null`. This makes the inventory shared: any signed-in
user sees and may edit every record. Signed-out visitors, including anyone
holding the public anon key, get nothing.

Account creation is handled in the Supabase dashboard rather than by a
public sign-up form, so only invited staff can obtain a session.

## Files

| Path                           | Contents                                              |
|--------------------------------|-------------------------------------------------------|
| `index.html`                   | Login view, asset table view, add/edit modal — markup only |
| `app.js`                       | Session handling, CRUD calls, rendering, search and filter |
| `config.js`                    | `SUPABASE_URL` and the anon key                       |
| `styles.css`                   | Layout and visual styling                             |
| `schema.sql`                   | Table, trigger, RLS enablement, and policies          |
| `README.md`                    | Setup, deploy, and the manual test checklist          |
| `.github/workflows/pages.yml`  | Deploy to GitHub Pages on push to `main`              |

`app.js` is organised into four clear groups: authentication, data access
(one function per Supabase operation), rendering, and event wiring. If it
grows past roughly 400 lines it should be split by those boundaries.

## Behaviour

**Startup.** The page calls `supabase.auth.getSession()`. Without a
session it shows the login form; with one it shows the asset table and
loads the data. An `onAuthStateChange` listener switches between the two
views so that signing in or out needs no page reload.

**Loading.** Assets are fetched with a single select ordered by
`updated_at` descending, and held in memory for filtering.

**Search and filter.** Filtering runs in the browser over the loaded rows:
a case-insensitive substring match across `asset_tag`, `name`, and
`assigned_to`, combined with dropdown filters for category and status.
This is fast and simple up to a few thousand assets. Beyond that, the
filter should move to a server-side `ilike` query — a change confined to
the data-access group.

**Adding and editing.** One modal form serves both. Submitting inserts
when no record id is present and updates when there is one. `asset_tag`
and `name` are required; the unique constraint on `asset_tag` surfaces as
a readable duplicate-tag message.

**Deleting.** A confirmation step naming the asset precedes the delete.

**After any write.** The list reloads so the view always reflects the
database rather than optimistic local state.

## Error handling

Every Supabase call inspects the returned `{ data, error }` pair. On an
error the app shows a dismissible banner carrying the actual message from
Supabase, and leaves the existing data on screen. Nothing fails silently,
and no error is swallowed into the console alone.

## Testing

There is no test framework. The README carries a manual checklist that
must pass before the app is treated as working:

1. Signing in with a valid account shows the asset table.
2. Signing in with a wrong password shows an error banner.
3. Adding an asset makes it appear at the top of the list.
4. Adding a second asset with a duplicate `asset_tag` is rejected with a
   readable message.
5. Editing an asset persists after a page reload.
6. Deleting an asset asks for confirmation and then removes the row.
7. Search matches on asset tag, name, and assigned person.
8. Category and status filters combine correctly with the search text.
9. Signing out returns to the login form.
10. With no session, a direct query from the browser console returns no
    rows — proving RLS is active.

## Setup prerequisites

Before deployment the following are needed: a Supabase project URL and its
anon key for `config.js`, at least one user account created in the
Supabase dashboard, `schema.sql` run in the Supabase SQL editor, and a
GitHub repository with Pages enabled and its source set to GitHub Actions.
