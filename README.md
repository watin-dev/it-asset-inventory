# IT Asset Inventory

A small static web app for recording office and IT assets. Plain HTML, CSS
and JavaScript — no build step, no framework, no npm install. Data lives in
Supabase Postgres; the site is served from GitHub Pages.

One shared inventory: everyone signed in reads all of it, and only admins
add, edit or delete. There is no sign-up form — you create each account
yourself in the Supabase dashboard.

## What you need before you start

- A GitHub account.
- A Supabase account (the free tier is enough).
- Git installed locally.
- Node.js, only if you want to run the automated checks. The app itself
  does not need it.

Installation runs in two halves: **Supabase first**, because the app needs
its credentials, then **GitHub**. Expect about fifteen minutes.

---

## Part 1 — Supabase

### 1. Create the project

Go to https://supabase.com, sign in, and create a new project. Choose a
region near your users and save the database password somewhere safe — you
will not need it for this app, but you cannot see it again.

Wait for the project to finish provisioning before continuing.

### 2. Create the tables and the security policies

In the left sidebar, open **SQL Editor** and click **New query**. Paste the
entire contents of `schema.sql` from this repository, then click **Run**.

You should see `Success. No rows returned`.

This creates:

- `assets` — the inventory itself.
- `profiles` — one row per account, holding `admin` or `viewer`.
- Triggers that stamp `created_at` / `updated_at` and record who created
  each row, so a client cannot forge either.
- Row Level Security policies, which are what actually protect the data.

`schema.sql` is safe to run more than once.

### 3. Turn off public sign-up

**Do this before the site goes live.** Go to **Authentication > Sign In /
Providers > Email** and set **Allow new users to sign up** to **off**.

Supabase allows public email sign-up by default. Anyone signed in can read
the whole inventory, so leaving this on means any stranger who finds your
page can register an account and read everything. Roles restrict who can
*write*; they do not restrict who can look.

### 4. Create the accounts

Go to **Authentication > Users** and click **Add user > Create new user**
for each person who should have access.

Tick **Auto Confirm User**. Without it the account stays unconfirmed and
sign-in fails with `Email not confirmed`.

### 5. Make yourself an admin

Every new account starts as a `viewer`. Until at least one admin exists,
nobody can add or change an asset.

Back in the **SQL Editor**, with your own email:

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@example.com');
```

Check it took effect:

```sql
select u.email, p.role
from public.profiles p
join auth.users u on u.id = p.id;
```

Every account you created should be listed, and yours should say `admin`.
If someone is missing, they were created before you ran `schema.sql` — run
`schema.sql` again and they will be added as a viewer.

### 6. Copy the credentials

Go to **Project Settings > API** and copy two values:

- **Project URL** — `https://<your-project-ref>.supabase.co`
- **Project API keys > `anon` `public`**

Take the `anon` key, never the `service_role` key. `service_role` bypasses
Row Level Security entirely and must never appear in this repository or in
anything a browser downloads.

---

## Part 2 — GitHub

### 7. Get the code and set the credentials

Clone or download this repository, then open `config.js` and paste in the
two values from step 6:

```js
export const SUPABASE_URL = "https://YOURPROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```

The `anon` key belongs in the repository. It is designed to be public — it
identifies the project and grants nothing on its own. Row Level Security is
what protects the data.

### 8. Try it locally first

A browser will not load ES modules over `file://`, so serve the folder:

```bash
python -m http.server 8080
```

Open `http://localhost:8080` and sign in with the account from step 4. You
should see the inventory, and — because you are an admin — an **Add asset**
button.

If something is wrong, jump to [Troubleshooting](#troubleshooting) before
deploying.

### 9. Create the GitHub repository

On github.com, click **New repository**. Give it a name, and create it
**empty** — no README, no `.gitignore`, no license. An initialised
repository will reject the first push.

Public or private is your call. GitHub Pages on a private repository
requires a paid plan; a public repository exposes your code and your `anon`
key, which is expected and safe as long as steps 2 and 3 are done.

### 10. Push

```bash
git remote add origin https://github.com/<your-user>/<your-repo>.git
git branch -M main
git push -u origin main
```

### 11. Turn on GitHub Pages

In the repository: **Settings > Pages > Build and deployment > Source:
GitHub Actions**.

Then open the **Actions** tab. The workflow in
`.github/workflows/pages.yml` runs the automated checks and publishes the
site on every push to `main`. If the first run failed with
`Get Pages site failed`, it ran before you set the source — re-run it now.

When it finishes, the run shows the published URL.

### 12. Tell Supabase about the live URL

Back in Supabase: **Authentication > URL Configuration**. Set **Site URL**
to your Pages URL and add the same URL under **Redirect URLs**:

```
https://<your-user>.github.io/<your-repo>/
```

Sign-in behaves inconsistently on the deployed origin without this.

### 13. Check it

Open the Pages URL and sign in. Then work through the
[manual test checklist](#manual-test-checklist) below.

---

## Upgrading an existing installation

If you set this up before roles existed, do not re-run `schema.sql`. Run
`migrations/001-roles.sql` instead — read its header first, because you
must put your own email in it. If you forget, it raises an error and the
SQL editor rolls the whole script back, so it is safe to re-run.

## Managing roles

Roles are changed only from the Supabase SQL editor. `profiles` has no
write policy and no write grants, so the app cannot change a role even if
someone edits the page in their browser.

```sql
-- See everyone
select u.email, p.role from public.profiles p
join auth.users u on u.id = p.id;

-- Promote or demote
update public.profiles set role = 'admin'  where id = '<user uuid>';
update public.profiles set role = 'viewer' where id = '<user uuid>';
```

A viewer sees the inventory, the search and the filters, with no Add button
and no row actions, and a `read-only` badge beside their email. Hiding the
buttons is a courtesy; the RLS policies are the enforcement.

To remove someone's access entirely, delete their account under
**Authentication > Users**. Assets they created stay, with their
`owner_id` cleared.

## Troubleshooting

| What you see | What it means |
|---|---|
| `Invalid login credentials` | Wrong password, or the account was never created. |
| `Email not confirmed` | Created without **Auto Confirm User**. Open the user in Authentication > Users and confirm them. |
| Signed in, but the table is empty and no error | `schema.sql` has not been run on this project. |
| Signed in, but the badge says `read-only` and you expected admin | Step 5 was skipped, or run against a different project. Check the `select` in step 5. |
| `read-only` for everyone, including after step 5 | `config.js` points at a different project than the one you ran the SQL on. Compare the ref in `SUPABASE_URL` against the project in the dashboard. |
| Blank page, console says `Failed to resolve module specifier` | Opened over `file://`. Serve it over HTTP (step 8). |
| `Get Pages site failed` in Actions | Pages source not set to GitHub Actions yet (step 11). |
| Sign-in works locally but not on the Pages URL | Step 12 was skipped. |

## Automated checks

```bash
node test/smoke.mjs
```

`test/smoke.mjs` loads the real `app.js` with a stubbed DOM and a stubbed
Supabase client, then exercises the rendering, escaping, error, auth-event,
role, write and filter paths, including the form submit handler and the row
Edit/Delete wiring. It needs no Supabase project, no npm install, and runs
in the deploy workflow before publishing.

What it cannot see, and why the checklist below still matters:

- **Anything CSS.** The stubbed elements have no stylesheet behind them, so
  layout and visibility bugs are invisible to it. One such bug — the sign-in
  card staying on screen after sign-in, because an author `display` rule
  beats the user agent's `[hidden]` — passed every stub check and was only
  caught in a real browser.
- **Real Supabase behaviour.** Error codes, RLS enforcement, the triggers,
  token refresh and session persistence are all stubbed. The stubs encode
  what Supabase is believed to return, which is not the same as what it does.
- **Real browser semantics** beyond the few deliberately modelled (a
  `<select>` rejecting an off-list value is modelled; focus, validation,
  `<dialog>` behaviour and event bubbling are not).

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
9. Signing out returns to the login form, and the previous user's rows are
   gone from the table behind it.
10. Signed in, the sign-in card is **not** visible anywhere on the page.
11. Editing an asset whose category came from an import and is not in the
    dropdown list leaves that category intact after saving.
12. Deleting a user in Authentication > Users succeeds even when that user
    created assets.
13. Signed in as a viewer, the Add button and the row Edit/Delete buttons
    are absent, and the topbar shows `read-only`.
14. Signed in as a viewer, the inventory, search and filters all still work.
15. Promoting a viewer to admin in SQL and signing out and back in makes the
    Add button appear.
16. A viewer who gets a write through anyway sees "You have read-only
    access.", stays signed in, and is **not** returned to the login form.
    Reproduce from the console while signed in as a viewer:

    ```js
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
    const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log(await c.from("assets").insert({ asset_tag: "X", name: "X" }));
    ```

    Expect error code `42501`.
17. A viewer cannot change their own role. From the same console:
    `await c.from("profiles").update({ role: "admin" }).eq("id", "<their uuid>")`
    returns zero rows.
18. Signed out, running this in the browser console returns zero rows,
    proving RLS is active:

    ```js
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
    const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log(await c.from("assets").select("*"));
    ```

## Files

| Path | Purpose |
|---|---|
| `index.html` | The whole page: login card, table, add/edit dialog. |
| `app.js` | All behaviour: auth, roles, loading, rendering, writes, filters. |
| `config.js` | Your Supabase URL and `anon` key. The only file you edit. |
| `styles.css` | Styling. |
| `schema.sql` | Tables, triggers and RLS policies. Run on a fresh project. |
| `migrations/001-roles.sql` | Adds roles to a project created before they existed. |
| `test/smoke.mjs` | Automated checks. Zero dependencies. |
| `.github/workflows/pages.yml` | Runs the checks, then publishes to Pages. |
| `docs/superpowers/` | The design spec and implementation plan. |
