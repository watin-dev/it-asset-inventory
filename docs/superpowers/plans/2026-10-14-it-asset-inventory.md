# IT Asset Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static HTML/JS web app where signed-in staff record, search, and edit office and IT assets stored in Supabase Postgres.

**Architecture:** The browser loads `index.html`, which pulls `@supabase/supabase-js` from a CDN as an ES module and talks to Supabase directly. Supabase Auth issues the session; Row Level Security in Postgres decides what that session may read and write. There is no application server. GitHub Actions publishes the repository root to GitHub Pages on every push to `main`.

**Tech Stack:** Plain HTML, CSS, and ES-module JavaScript; `@supabase/supabase-js` v2 from esm.sh; Supabase (Auth + Postgres); GitHub Pages via GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-it-asset-inventory-design.md`

## Global Constraints

- No build step, no bundler, no `npm install`. Every file is served exactly as committed.
- `@supabase/supabase-js` is loaded from `https://esm.sh/@supabase/supabase-js@2.45.4` — an exact pinned version, never a range.
- Only the Supabase **anon** key may appear in the repository. The `service_role` key must never be committed, logged, or placed in any client file.
- Row Level Security must be enabled on `public.assets` before any real record is entered.
- All JavaScript is ES modules (`<script type="module">`). No global script tags, no `var`.
- The browser must never be sent a `console.log` of a Supabase key or session token.
- Category values are exactly: Laptop, Desktop, Monitor, Phone, Network, Other.
- Status values are exactly: In use, Spare, Repair, Retired.

## Review Focus

Input classes the spec implies but no happy-path check exercises. Each has a check pinned to the task that owns the code.

1. **Duplicate `asset_tag` on insert** — the unique constraint raises Postgres error 23505; the user must see "Asset tag already exists", not a raw constraint string. Owned by Task 4.
2. **Expired or revoked session mid-use** — a write after the session dies returns an auth error; the app must return the user to the login form rather than showing an empty table. Owned by Task 2.
3. **Network failure during load** — `fetch` rejects rather than returning an `error` field; an unhandled rejection would leave the page blank with no message. Owned by Task 3.
4. **Text fields containing HTML** — an asset named `<img src=x onerror=alert(1)>` must render as literal text, not execute. Owned by Task 3.
5. **Search with no matches** — the table must show an explicit empty-state row, not silently render zero rows that look like a loading failure. Owned by Task 5.

## Verification note

This project has no test framework, by design in the spec. "Write the failing test" is replaced by a written browser check performed before and after each implementation step: you state what you expect to see, observe the real page, and only then move on. Every task ends with a check you actually run, and a commit.

---

### Task 1: Repository scaffold and database schema

**Files:**
- Create: `schema.sql`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the `public.assets` table with columns `id, asset_tag, name, category, status, assigned_to, location, note, created_at, updated_at, owner_id`, RLS enabled, and four policies named `assets_select`, `assets_insert`, `assets_update`, `assets_delete`.

- [ ] **Step 1: Write `.gitignore`**

```gitignore
.DS_Store
Thumbs.db
*.log
.env
.vscode/
```

- [ ] **Step 2: Write `schema.sql`**

```sql
-- IT Asset Inventory schema. Run in the Supabase SQL editor.

create table if not exists public.assets (
  id          uuid primary key default gen_random_uuid(),
  asset_tag   text not null unique,
  name        text not null,
  category    text,
  status      text,
  assigned_to text,
  location    text,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  owner_id    uuid default auth.uid() references auth.users (id)
);

create index if not exists assets_updated_at_idx on public.assets (updated_at desc);

-- Keep updated_at honest on every edit.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists assets_set_updated_at on public.assets;
create trigger assets_set_updated_at
  before update on public.assets
  for each row
  execute function public.set_updated_at();

-- Row Level Security: the only thing protecting this data.
alter table public.assets enable row level security;

drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets
  for select using (auth.uid() is not null);

drop policy if exists assets_insert on public.assets;
create policy assets_insert on public.assets
  for insert with check (auth.uid() is not null);

drop policy if exists assets_update on public.assets;
create policy assets_update on public.assets
  for update using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists assets_delete on public.assets;
create policy assets_delete on public.assets
  for delete using (auth.uid() is not null);
```

- [ ] **Step 3: Write `README.md`**

````markdown
# IT Asset Inventory

A small static web app for recording office and IT assets. Data lives in
Supabase Postgres; the site is served from GitHub Pages. No build step.

## Setup

1. Create a project at https://supabase.com.
2. Open the SQL editor and run the contents of `schema.sql`.
3. Go to **Authentication > Users** and add an account for each person who
   should have access. There is no public sign-up form by design.
4. Go to **Project Settings > API** and copy the Project URL and the
   `anon` `public` key.
5. Put both into `config.js`:

   ```js
   export const SUPABASE_URL = "https://YOURPROJECT.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```

6. Serve the folder (`python -m http.server 8080`) and open
   `http://localhost:8080`. Opening the file directly with `file://` does
   not work — ES module imports need a real origin.

The `anon` key is designed to be public — Row Level Security is what
protects the data. Never put the `service_role` key in this repository.

## Deploy

Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the
site. In the repository: **Settings > Pages > Source: GitHub Actions**.

## Manual test checklist

Run all of these before trusting the app with real records.

1. Signing in with a valid account shows the asset table.
2. Signing in with a wrong password shows an error banner.
3. Adding an asset makes it appear at the top of the list.
4. Adding a second asset with a duplicate asset tag is rejected with a
   readable message.
5. Editing an asset persists after a page reload.
6. Deleting an asset asks for confirmation and then removes the row.
7. Search matches on asset tag, name, and assigned person.
8. Category and status filters combine correctly with the search text.
9. Signing out returns to the login form.
10. Signed out, running this in the browser console returns zero rows,
    proving RLS is active:

    ```js
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
    const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log(await c.from("assets").select("*"));
    ```
````

- [ ] **Step 4: Verify the schema runs**

Paste `schema.sql` into the Supabase SQL editor and run it.
Expected: "Success. No rows returned."
Then run it a second time. Expected: success again — every statement is
idempotent, so a re-run must not error.

- [ ] **Step 5: Verify RLS is on**

Run in the SQL editor:

```sql
select relrowsecurity from pg_class where relname = 'assets';
```

Expected: a single row, `true`. If it is `false`, stop — nothing else in
this plan is safe to build on.

- [ ] **Step 6: Commit**

```bash
git add .gitignore schema.sql README.md
git commit -m "feat: add assets schema, RLS policies, and setup docs"
```

---

### Task 2: Supabase client, configuration, and authentication

**Files:**
- Create: `config.js`
- Create: `index.html`
- Create: `styles.css`
- Create: `app.js`

**Interfaces:**
- Consumes: the `public.assets` table from Task 1 (not queried yet).
- Produces:
  - `config.js` exports `SUPABASE_URL: string` and `SUPABASE_ANON_KEY: string`.
  - `app.js` defines `supabase` (the client), `showBanner(message, kind)` where `kind` is `"error" | "info"`, `clearBanner()`, `showView(name)` where `name` is `"login" | "app"`, `escapeHtml(value)` returning a safe string, and `requireSession(error)` returning `false` when the session is dead.
  - `index.html` provides elements with ids: `banner`, `login-view`, `app-view`, `login-form`, `login-email`, `login-password`, `logout-button`, `user-email`, `asset-tbody`, `search-input`, `filter-category`, `filter-status`, `add-button`, `asset-dialog`, `asset-form`, `dialog-title`, `field-id`, `field-asset-tag`, `field-name`, `field-category`, `field-status`, `field-assigned-to`, `field-location`, `field-note`, `dialog-cancel`.

- [ ] **Step 1: Write `config.js`**

Use placeholder values; the real ones are filled in at Step 5.

```js
// Supabase project credentials.
// The anon key is public by design — Row Level Security protects the data.
// NEVER put the service_role key in this file.
export const SUPABASE_URL = "https://YOURPROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
```

- [ ] **Step 2: Write `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IT Asset Inventory</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>

<div id="banner" class="banner" hidden></div>

<section id="login-view" class="login-view" hidden>
  <form id="login-form" class="card">
    <h1>IT Asset Inventory</h1>
    <label for="login-email">Email</label>
    <input id="login-email" type="email" autocomplete="username" required>
    <label for="login-password">Password</label>
    <input id="login-password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</section>

<section id="app-view" hidden>
  <header class="topbar">
    <h1>IT Asset Inventory</h1>
    <div class="topbar-right">
      <span id="user-email"></span>
      <button id="logout-button" type="button">Sign out</button>
    </div>
  </header>

  <div class="toolbar">
    <input id="search-input" type="search" placeholder="Search tag, name, or person">
    <select id="filter-category"><option value="">All categories</option></select>
    <select id="filter-status"><option value="">All statuses</option></select>
    <button id="add-button" type="button">Add asset</button>
  </div>

  <table class="assets">
    <thead>
      <tr>
        <th>Asset tag</th><th>Name</th><th>Category</th><th>Status</th>
        <th>Assigned to</th><th>Location</th><th>Note</th><th>Updated</th><th></th>
      </tr>
    </thead>
    <tbody id="asset-tbody"></tbody>
  </table>
</section>

<dialog id="asset-dialog">
  <form id="asset-form" method="dialog">
    <h2 id="dialog-title">Add asset</h2>
    <input id="field-id" type="hidden">
    <label for="field-asset-tag">Asset tag *</label>
    <input id="field-asset-tag" required>
    <label for="field-name">Name *</label>
    <input id="field-name" required>
    <label for="field-category">Category</label>
    <select id="field-category"></select>
    <label for="field-status">Status</label>
    <select id="field-status"></select>
    <label for="field-assigned-to">Assigned to</label>
    <input id="field-assigned-to">
    <label for="field-location">Location</label>
    <input id="field-location">
    <label for="field-note">Note</label>
    <textarea id="field-note" rows="3"></textarea>
    <menu>
      <button id="dialog-cancel" type="button">Cancel</button>
      <button type="submit" value="save">Save</button>
    </menu>
  </form>
</dialog>

<script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `styles.css`**

```css
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --line: #d8dce3;
  --text: #1d2228;
  --muted: #5d6673;
  --accent: #2563eb;
  --danger: #b42318;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}

.banner {
  padding: 10px 16px;
  font-weight: 500;
  cursor: pointer;
}
.banner.error { background: #fde7e5; color: var(--danger); }
.banner.info  { background: #e6f0fe; color: var(--accent); }

.login-view {
  display: flex;
  justify-content: center;
  padding: 80px 16px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 28px;
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.card h1 { margin: 0 0 12px; font-size: 20px; }

label { font-size: 13px; color: var(--muted); margin-top: 8px; }

input, select, textarea {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  font: inherit;
  background: #fff;
}

button {
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
button[type="submit"], #add-button {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
button:hover { filter: brightness(0.97); }

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}
.topbar h1 { margin: 0; font-size: 18px; }
.topbar-right { display: flex; align-items: center; gap: 12px; }
#user-email { color: var(--muted); font-size: 13px; }

.toolbar {
  display: flex;
  gap: 10px;
  padding: 14px 20px;
  flex-wrap: wrap;
}
#search-input { flex: 1 1 260px; }

table.assets {
  width: calc(100% - 40px);
  margin: 0 20px 40px;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.assets th, .assets td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.assets th { background: #eef1f5; font-size: 13px; color: var(--muted); }
.assets tr:last-child td { border-bottom: none; }
.assets .empty { text-align: center; color: var(--muted); padding: 28px; }
.row-actions { display: flex; gap: 6px; white-space: nowrap; }

dialog {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 24px;
  width: 420px;
  max-width: 92vw;
}
dialog form { display: flex; flex-direction: column; }
dialog h2 { margin: 0 0 8px; font-size: 18px; }
dialog menu {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin: 20px 0 0;
  padding: 0;
}
```

- [ ] **Step 4: Write `app.js` — client, banner, views, auth**

```js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CATEGORIES = ["Laptop", "Desktop", "Monitor", "Phone", "Network", "Other"];
const STATUSES = ["In use", "Spare", "Repair", "Retired"];

const el = (id) => document.getElementById(id);

// --- Banner -------------------------------------------------------------

function showBanner(message, kind = "error") {
  const banner = el("banner");
  banner.textContent = message;
  banner.className = `banner ${kind}`;
  banner.hidden = false;
}

function clearBanner() {
  el("banner").hidden = true;
}

el("banner").addEventListener("click", clearBanner);

// --- Views --------------------------------------------------------------

function showView(name) {
  el("login-view").hidden = name !== "login";
  el("app-view").hidden = name !== "app";
}

// --- Escaping -----------------------------------------------------------

// Asset text is user-supplied and goes into innerHTML, so it must be escaped.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// --- Auth ---------------------------------------------------------------

el("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearBanner();
  const { error } = await supabase.auth.signInWithPassword({
    email: el("login-email").value.trim(),
    password: el("login-password").value,
  });
  if (error) {
    showBanner(error.message);
    return;
  }
  el("login-password").value = "";
});

el("logout-button").addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) showBanner(error.message);
});

// A dead session must land the user on the login form, not an empty table.
function requireSession(error) {
  const message = error?.message ?? "";
  if (/jwt|session|token|not authenticated/i.test(message)) {
    showView("login");
    showBanner("Session expired. Please sign in again.");
    return false;
  }
  return true;
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    el("user-email").textContent = session.user.email;
    showView("app");
  } else {
    showView("login");
  }
});

const { data: { session: initialSession } } = await supabase.auth.getSession();
if (initialSession) {
  el("user-email").textContent = initialSession.user.email;
  showView("app");
} else {
  showView("login");
}
```

- [ ] **Step 5: Fill in real credentials and check sign-in**

Put the real Supabase URL and anon key into `config.js`, then serve the
folder (`python -m http.server 8080`) and open `http://localhost:8080`.
`file://` will not work — ES module imports need a real origin.

Expected, in order:
- The login form appears, not the table.
- A wrong password shows a red banner with Supabase's message.
- A correct password swaps to the app view and shows your email in the top bar.
- Reloading the page keeps you signed in.
- "Sign out" returns to the login form.

- [ ] **Step 6: Check that only the anon key is being committed**

Run:

```bash
git add config.js
git diff --cached -- config.js
```

Expected: the staged value starts with `eyJ`, and the string
`service_role` appears nowhere in the file.

- [ ] **Step 7: Commit**

```bash
git add config.js index.html styles.css app.js
git commit -m "feat: add Supabase client, page shell, and email authentication"
```

---

### Task 3: Load and render the asset table

**Files:**
- Modify: `app.js` (append the data-access and rendering groups)

**Interfaces:**
- Consumes: `supabase`, `showBanner`, `clearBanner`, `escapeHtml`, `requireSession`, `el` from Task 2.
- Produces: `allAssets` (module-level array of loaded rows), `loadAssets()` returning a promise, `renderAssets(rows)`, and `formatDate(iso)`.

- [ ] **Step 1: Append the data-access and rendering code to `app.js`**

```js
// --- Data ---------------------------------------------------------------

let allAssets = [];

async function loadAssets() {
  clearBanner();
  let result;
  try {
    result = await supabase
      .from("assets")
      .select("*")
      .order("updated_at", { ascending: false });
  } catch (networkError) {
    // fetch rejects outright when the network is down; there is no error field.
    showBanner(`Could not reach the database: ${networkError.message}`);
    return;
  }
  const { data, error } = result;
  if (error) {
    if (!requireSession(error)) return;
    showBanner(`Could not load assets: ${error.message}`);
    return;
  }
  allAssets = data ?? [];
  applyFilters();
}

// --- Rendering ----------------------------------------------------------

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function renderAssets(rows) {
  const tbody = el("asset-tbody");
  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td class="empty" colspan="9">No assets match.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.asset_tag)}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.category)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.assigned_to)}</td>
        <td>${escapeHtml(row.location)}</td>
        <td>${escapeHtml(row.note)}</td>
        <td>${escapeHtml(formatDate(row.updated_at))}</td>
        <td class="row-actions">
          <button type="button" data-edit="${escapeHtml(row.id)}">Edit</button>
          <button type="button" data-delete="${escapeHtml(row.id)}">Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

// Replaced in Task 5 with real search and filter logic.
function applyFilters() {
  renderAssets(allAssets);
}
```

- [ ] **Step 2: Load the data once the app view is shown**

In the `onAuthStateChange` handler written in Task 2, add a call right
after `showView("app");` inside the `if (session)` branch:

```js
    loadAssets();
```

And in the initial-session block at the end of the file, add a call right
after its `showView("app");`:

```js
  await loadAssets();
```

- [ ] **Step 3: Insert a test row and check rendering**

In the Supabase SQL editor:

```sql
insert into public.assets (asset_tag, name, category, status, assigned_to, location)
values ('CKP-LT-0001', 'ThinkPad T14', 'Laptop', 'In use', 'Somchai', 'HQ 4F');
```

Reload the signed-in page. Expected: one row showing every column, with a
readable local timestamp in Updated, and Edit and Delete buttons.

- [ ] **Step 4: Check that HTML in a field cannot execute**

In the SQL editor:

```sql
insert into public.assets (asset_tag, name)
values ('CKP-XSS-0001', '<img src=x onerror="alert(1)">');
```

Reload. Expected: the row shows the literal text
`<img src=x onerror="alert(1)">`. No alert box appears, and no broken
image icon renders. If an alert fires, `escapeHtml` is not being applied —
fix before continuing.

Then clean up:

```sql
delete from public.assets where asset_tag = 'CKP-XSS-0001';
```

- [ ] **Step 5: Check the network-failure path**

With the page signed in, open DevTools, set the Network tab to Offline,
and reload. Expected: a red banner reading "Could not reach the database:"
followed by a message, and no uncaught error in the console. The page must
not sit blank. Set the network back to Online afterwards.

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: load and render the asset table"
```

---

### Task 4: Add, edit, and delete assets

**Files:**
- Modify: `app.js` (append the dropdown, dialog, and write groups)

**Interfaces:**
- Consumes: `supabase`, `loadAssets`, `showBanner`, `clearBanner`, `requireSession`, `CATEGORIES`, `STATUSES`, `allAssets`, `el` from Tasks 2 and 3.
- Produces: `populateSelect(select, values, blankLabel)`, `openDialog(asset)` where `asset` is a row object or `null` for a new one, `saveAsset(fields)` returning `true` on success, and `deleteAsset(id, label)`.

- [ ] **Step 1: Populate the dropdowns**

Append to `app.js`:

```js
// --- Dropdowns ----------------------------------------------------------

function populateSelect(select, values, blankLabel) {
  select.innerHTML =
    `<option value="">${blankLabel}</option>` +
    values.map((v) => `<option value="${v}">${v}</option>`).join("");
}

populateSelect(el("filter-category"), CATEGORIES, "All categories");
populateSelect(el("filter-status"), STATUSES, "All statuses");
populateSelect(el("field-category"), CATEGORIES, "—");
populateSelect(el("field-status"), STATUSES, "—");
```

- [ ] **Step 2: Add the dialog open and close logic**

```js
// --- Add / edit dialog --------------------------------------------------

function openDialog(asset) {
  el("dialog-title").textContent = asset ? "Edit asset" : "Add asset";
  el("field-id").value = asset?.id ?? "";
  el("field-asset-tag").value = asset?.asset_tag ?? "";
  el("field-name").value = asset?.name ?? "";
  el("field-category").value = asset?.category ?? "";
  el("field-status").value = asset?.status ?? "";
  el("field-assigned-to").value = asset?.assigned_to ?? "";
  el("field-location").value = asset?.location ?? "";
  el("field-note").value = asset?.note ?? "";
  el("asset-dialog").showModal();
}

el("add-button").addEventListener("click", () => openDialog(null));
el("dialog-cancel").addEventListener("click", () => el("asset-dialog").close());
```

- [ ] **Step 3: Add the save path**

Empty optional fields are stored as `null`, not `""`, so the database holds
one representation of "not set".

```js
// --- Writes -------------------------------------------------------------

const orNull = (value) => (value.trim() === "" ? null : value.trim());

async function saveAsset(fields) {
  const { id, ...values } = fields;
  const query = id
    ? supabase.from("assets").update(values).eq("id", id)
    : supabase.from("assets").insert(values);

  let result;
  try {
    result = await query;
  } catch (networkError) {
    showBanner(`Could not reach the database: ${networkError.message}`);
    return false;
  }
  const { error } = result;
  if (error) {
    if (!requireSession(error)) return false;
    // 23505 is the Postgres unique-violation code; assets has one unique column.
    if (error.code === "23505") {
      showBanner(`Asset tag "${values.asset_tag}" already exists.`);
    } else {
      showBanner(`Could not save: ${error.message}`);
    }
    return false;
  }
  return true;
}

el("asset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearBanner();
  const fields = {
    id: el("field-id").value || null,
    asset_tag: el("field-asset-tag").value.trim(),
    name: el("field-name").value.trim(),
    category: orNull(el("field-category").value),
    status: orNull(el("field-status").value),
    assigned_to: orNull(el("field-assigned-to").value),
    location: orNull(el("field-location").value),
    note: orNull(el("field-note").value),
  };
  const saved = await saveAsset(fields);
  if (!saved) return;
  el("asset-dialog").close();
  await loadAssets();
});
```

- [ ] **Step 4: Add the delete path and wire the row buttons**

```js
async function deleteAsset(id, label) {
  if (!window.confirm(`Delete asset "${label}"? This cannot be undone.`)) return;
  clearBanner();
  let result;
  try {
    result = await supabase.from("assets").delete().eq("id", id);
  } catch (networkError) {
    showBanner(`Could not reach the database: ${networkError.message}`);
    return;
  }
  const { error } = result;
  if (error) {
    if (!requireSession(error)) return;
    showBanner(`Could not delete: ${error.message}`);
    return;
  }
  await loadAssets();
}

// One listener on the tbody — rows are re-rendered constantly.
el("asset-tbody").addEventListener("click", (event) => {
  const editId = event.target.dataset.edit;
  const deleteId = event.target.dataset.delete;
  if (editId) {
    const asset = allAssets.find((a) => a.id === editId);
    if (asset) openDialog(asset);
  } else if (deleteId) {
    const asset = allAssets.find((a) => a.id === deleteId);
    if (asset) deleteAsset(asset.id, asset.asset_tag);
  }
});
```

- [ ] **Step 5: Check add, edit, and delete**

Reload the signed-in page.

Expected:
- "Add asset" opens the dialog with every field empty and both dropdowns
  listing exactly the six categories and four statuses.
- Saving a new asset closes the dialog and puts the new row at the top.
- "Edit" opens the dialog pre-filled; changing the location and saving
  updates the row, and the change survives a page reload.
- "Delete" asks for confirmation naming the asset tag; cancelling leaves
  the row; confirming removes it.

- [ ] **Step 6: Check the duplicate asset tag message**

Add an asset with an `asset_tag` that already exists.
Expected: a red banner reading `Asset tag "CKP-LT-0001" already exists.`
The dialog stays open with the entered values intact, so the tag can be
corrected without retyping everything.

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "feat: add, edit, and delete assets"
```

---

### Task 5: Search and filter

**Files:**
- Modify: `app.js` (replace the `applyFilters` stub from Task 3)

**Interfaces:**
- Consumes: `allAssets`, `renderAssets`, `el` from Tasks 2 and 3.
- Produces: the real `applyFilters()`, replacing the stub. Same name and
  signature, so `loadAssets` needs no change.

- [ ] **Step 1: Replace the `applyFilters` stub**

Delete the stub written in Task 3 Step 1 and put the real version in its
place, in the same spot in the file:

```js
// --- Search and filter --------------------------------------------------

// Filters the rows already in memory. Fine up to a few thousand assets;
// past that, move this to a server-side ilike query in loadAssets.
function applyFilters() {
  const term = el("search-input").value.trim().toLowerCase();
  const category = el("filter-category").value;
  const status = el("filter-status").value;

  const rows = allAssets.filter((asset) => {
    if (category && asset.category !== category) return false;
    if (status && asset.status !== status) return false;
    if (!term) return true;
    const haystack = [asset.asset_tag, asset.name, asset.assigned_to]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });

  renderAssets(rows);
}

el("search-input").addEventListener("input", applyFilters);
el("filter-category").addEventListener("change", applyFilters);
el("filter-status").addEventListener("change", applyFilters);
```

- [ ] **Step 2: Check search and filters**

Add at least four assets spanning two categories and two statuses, with
different people in "Assigned to". Then check each of these:

- Typing part of an asset tag narrows the table to that asset.
- Typing part of a name matches it.
- Typing part of an assigned person's name matches it.
- Search is case-insensitive: `thinkpad` and `ThinkPad` give the same rows.
- Choosing a category narrows the table; choosing a status narrows further.
- A category and a search term together show only rows matching both.
- Clearing the search box and both dropdowns restores the full list.

- [ ] **Step 3: Check the empty state**

Type `zzzzzz` into the search box.
Expected: one centred grey row reading "No assets match." — not a blank
table body, which would look like a failed load.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: add client-side search and category/status filters"
```

---

### Task 6: GitHub Pages deployment

**Files:**
- Create: `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: the finished static site from Tasks 1 to 5.
- Produces: a published site at `https://<user>.github.io/<repo>/`.

- [ ] **Step 1: Write `.github/workflows/pages.yml`**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: deploy to GitHub Pages on push to main"
git push -u origin main
```

- [ ] **Step 3: Enable Pages**

In the GitHub repository: **Settings > Pages > Build and deployment >
Source: GitHub Actions**.

- [ ] **Step 4: Check the deployment**

Open the Actions tab. Expected: the "Deploy to GitHub Pages" run finishes
green, and the job summary links the published URL.

- [ ] **Step 5: Add the live URL to Supabase**

In the Supabase dashboard: **Authentication > URL Configuration**. Add the
GitHub Pages URL to Site URL and to Redirect URLs. Without this, auth
behaves inconsistently on the deployed origin.

- [ ] **Step 6: Run the full checklist against the live site**

Open the published URL and work through all ten items in the README's
manual test checklist, including item 10 — the signed-out console query
that proves RLS blocks reads. Expected: all ten pass.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in live deployment checklist"
git push
```
