# IT Asset Inventory

A small static web app for recording office and IT assets. Data lives in
Supabase Postgres; the site is served from GitHub Pages. No build step.

## Setup

1. Create a project at https://supabase.com.
2. Open the SQL editor and run the contents of `schema.sql`.
3. **Turn off public sign-up.** Go to **Authentication > Sign In / Providers
   > Email** and set **Allow new users to sign up** to off. Every signed-in
   user can read the whole inventory, so an open sign-up endpoint means any
   stranger can create an account and read it. Roles limit who can *write*;
   they do not limit who can look. This is the single most important setup
   step.
4. Go to **Authentication > Users** and add an account for each person who
   should have access. The app has no sign-up form by design.
5. Make yourself an admin. Every account starts read-only, so until you do
   this, nobody can add or change an asset:

   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'you@example.com');
   ```
6. Go to **Project Settings > API** and copy the Project URL and the
   `anon` `public` key.
7. Put both into `config.js`:

   ```js
   export const SUPABASE_URL = "https://YOURPROJECT.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```

8. Serve the folder and open it in a browser:

   ```bash
   python -m http.server 8080
   ```

   Then go to `http://localhost:8080`. Opening the file directly with
   `file://` does not work — ES module imports need a real origin.

## Roles

One shared inventory. Everyone signed in reads all of it; only admins add,
edit or delete. New accounts start as `viewer`.

Roles live in `public.profiles` and are changed only from the Supabase SQL
editor — the table has no write policy, so the app cannot change them even
if someone edits the page in their browser:

```sql
update public.profiles set role = 'admin' where id = '<user uuid>';
update public.profiles set role = 'viewer' where id = '<user uuid>';
select u.email, p.role from public.profiles p join auth.users u on u.id = p.id;
```

A viewer sees the inventory and the filters, with no Add button and no row
actions, and a `read-only` badge beside their email. Hiding the buttons is a
courtesy; the RLS policies are the enforcement.

**Upgrading an existing project:** run `migrations/001-roles.sql` in the SQL
editor. Read its header first — you must put your own email in it, or it
refuses to finish and rolls back.

The `anon` key is designed to be public — Row Level Security is what
protects the data. Never put the `service_role` key in this repository.

## Deploy

Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the
site. In the repository: **Settings > Pages > Source: GitHub Actions**.

After the first deploy, add the published URL to the Supabase dashboard
under **Authentication > URL Configuration**, as both the Site URL and a
Redirect URL. Without this, sign-in behaves inconsistently on the
deployed origin.

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
17. A viewer cannot change their own role:
    `update public.profiles set role = 'admin'` from the app's client returns
    zero rows.
18. Signed out, running this in the browser console returns zero rows,
    proving RLS is active:

    ```js
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import("./config.js");
    const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log(await c.from("assets").select("*"));
    ```
