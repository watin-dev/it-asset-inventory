# IT Asset Inventory

A small static web app for recording office and IT assets. Data lives in
Supabase Postgres; the site is served from GitHub Pages. No build step.

## Setup

1. Create a project at https://supabase.com.
2. Open the SQL editor and run the contents of `schema.sql`.
3. **Turn off public sign-up.** Go to **Authentication > Sign In / Providers
   > Email** and set **Allow new users to sign up** to off. Every signed-in
   user has full read and write access to the whole inventory, so an open
   sign-up endpoint means any stranger can create an account and get it.
   This is the single most important setup step.
4. Go to **Authentication > Users** and add an account for each person who
   should have access. The app has no sign-up form by design.
5. Go to **Project Settings > API** and copy the Project URL and the
   `anon` `public` key.
6. Put both into `config.js`:

   ```js
   export const SUPABASE_URL = "https://YOURPROJECT.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJ...";
   ```

7. Serve the folder and open it in a browser:

   ```bash
   python -m http.server 8080
   ```

   Then go to `http://localhost:8080`. Opening the file directly with
   `file://` does not work — ES module imports need a real origin.

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
Supabase client, then exercises the rendering, escaping, error, write and
filter paths. It needs no Supabase project, no npm install, and runs in
the deploy workflow before publishing. It does not cover anything that
requires a live backend — that is what the checklist below is for.

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
