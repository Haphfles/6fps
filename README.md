# 6FPS

A shared black-and-white animation, drawn one portrait frame at a time. Playback is fixed at 6 FPS. One browser identity can reserve the next frame at a time.

## Next: set up your Supabase project

Your project URL and browser-safe publishable key are already in `public/config.js`. No database password, service-role key, or secret key is used in this project.

1. In Supabase, open **SQL Editor → New query**.
2. Paste the entire contents of `supabase/setup.sql` and click **Run**. This creates the tables, booking functions, access rules, and the `sixfps-frames` image bucket. It is safe to rerun; it does not delete published frames. The script drops and recreates only its named policies, so Supabase may show a warning about those statements.
3. In **Authentication → Sign In / Providers**, enable **Anonymous Sign-Ins** and save. Visitors get a browser identity when they first book a frame, without entering an email address or password.

This creates a separate, initially empty online movie. Your existing local SQLite movie stays intact. Importing the local movie is a separate step.

## Preview on your computer

Requires Node.js 24 or newer. From this folder:

```sh
npm ci
npm start
```

Open http://localhost:3000. By default, this keeps using your existing local SQLite movie.

To test the Supabase movie after the setup steps above, stop the local server and run:

```sh
SIXFPS_BACKEND=supabase npm start
```

A setup error means the SQL script or anonymous sign-in setting still needs attention. The app does not silently fall back to local storage in cloud mode.

## Publish on GitHub Pages for free

1. Create a **public** GitHub repository named `6fps` on the Free GitHub plan.
2. Commit this project's source files, including the hidden `.github/workflows/pages.yml` file and `package-lock.json`. GitHub Desktop is an easy way to upload the complete project. Do not upload `data/`, `node_modules/`, `.env` files, or database files; `.gitignore` excludes these when using Git.
3. Push to the `main` branch.
4. In the repository, open **Settings → Pages → Build and deployment → Source**, and select **GitHub Actions**.
5. Open **Actions → Deploy 6FPS → Run workflow** if the first push happened before Pages was enabled.
6. Wait for the workflow to succeed. Share the URL shown in **Settings → Pages**, normally `https://YOUR-USERNAME.github.io/6fps/`.

The workflow installs pinned dependencies, runs tests, builds the Supabase browser bundle, and publishes only `public/`. It does not expose the local database, server, or tests. The published version uses Supabase automatically. GitHub does not need a Supabase secret, and Supabase does not need access to your GitHub repository.

## How cloud storage and bookings work

- Supabase Storage holds published PNG images (maximum 2 MiB per image).
- Postgres holds frame order and the active booking. All booking mutations acquire the same row lock, so concurrent requests cannot reserve the same turn.
- Bookings last ten minutes and renew once per minute while the drawing tab is visible. Expiry is checked on the server.
- Anonymous Supabase Auth gives each browser an identity. The publishable key alone cannot book, upload, or publish.
- Browser clients cannot directly modify the movie or booking tables. Only the carefully scoped database functions can do that.
- The bucket is public because the community movie is public. Uploads require ownership of an active booking and its exact upload path; clients cannot overwrite or delete artwork.
- Publishing is retry-safe: the same booking cannot create two frames.
- Draft drawings are held in memory in the current tab. Reloading loses unpublished drawings. Clearing browser storage also loses that browser's anonymous identity.
- Uploaded images are constrained by MIME type and file size. This pilot does not perform server-side image decoding or dimension checks on Supabase uploads; the app creates 540 × 960 PNGs.

## Pilot limits and maintenance

The free Supabase plan has storage/bandwidth limits and can pause projects after low activity. Check the Supabase Usage dashboard and export backups periodically. Browser previews currently load the film's images; bandwidth grows with both movie length and audience size.

For a small trusted pilot, the supplied setup is ready after the SQL and Auth steps. Before advertising widely, add CAPTCHA/Turnstile integration for anonymous sign-ups and moderation/reporting. Supabase recommends CAPTCHA for anonymous authentication; if you enable CAPTCHA in the dashboard, the browser sign-up flow must be updated to supply the token. Abandoned uploads and anonymous accounts need periodic cleanup; no automatic destructive cleanup is included. Remove orphaned images through the Storage API/dashboard, never by deleting rows directly from `storage.objects`.

## Project files

- `public/`: interface, drawing tools, timeline, and browser backend adapter.
- `public/config.js`: public Supabase configuration.
- `supabase/setup.sql`: database functions, tables, grants, and Storage policy.
- `scripts/build.js`: bundles the official Supabase client locally.
- `.github/workflows/pages.yml`: GitHub Pages build/deploy workflow.
- `server.js`: local development server and original SQLite backend.
- `data/`: local SQLite movie, not deployed.
- `test/`: local-server tests and embedded Postgres tests of the actual Supabase SQL.

`npm test` checks local booking behavior and SQL permissions/ownership/expiry/retry behavior. SQL tests use local fixtures for Supabase Auth/Storage and are not an end-to-end test of your hosted project. After setup, test two separate browsers: only one should book, then publish, scrub, and play the cloud movie.

## Private movie editor

See [ADMIN-SETUP.md](ADMIN-SETUP.md) to enable your private editor. Run `supabase/admin.sql` after `supabase/setup.sql`, create your own confirmed email/password user, then grant only that user admin access. The public site keeps its submission-only permissions. Play/pause icons now use SVG for consistent iPhone rendering.
