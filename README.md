# 6FPS

Collaborative black-and-white movies: 90 portrait frames at 6 FPS, for a 15-second finished movie. Each contributor reserves one available slot per movie. Multiple people can draw consecutive frames at once, with a live previous-frame overlay.

## Existing installation

Follow [PROJECTS-SETUP.md](PROJECTS-SETUP.md). Run supabase/projects.sql before deploying the updated public/ files. The first run archives the original movie's current drawings; subsequent runs preserve new contributions.

## New installation

1. Set your Supabase URL and publishable key in public/config.js. Never put a secret/service-role key in browser files.
2. Run supabase/setup.sql, then supabase/admin.sql, then supabase/projects.sql, in that order.
3. Enable anonymous sign-ins in Supabase Authentication.
4. Follow ADMIN-SETUP.md to create your confirmed admin account and grant only that account editor access.
5. Deploy public/ through the existing .github/workflows/pages.yml workflow. GitHub Pages hosts the UI; Supabase stores shared data.

Do not rerun the legacy setup/admin scripts after the projects upgrade. They describe the original single-movie schema.

## Local preview

Requires Node.js 24+. Run `npm ci` and `npm start`, then open http://localhost:3000. The updated UI connects to the configured Supabase project, including when opened locally. The old SQLite API remains in server.js for compatibility tests; it does not power the new projects interface.

## Behaviour and permissions

- Admins create movies and can move/swap, archive, restore or permanently delete frames. Clear movie archives its frames and releases its bookings.
- Visitors choose a movie and press + above the timeline to book its first available numbered slot. A slot belongs to one user at a time. A browser identity has one booking per movie.
- Bookings last ten minutes, renewing each minute while the page is visible. A movie row lock serializes reservations and publication, preventing duplicate bookings or a 91st frame.
- Final PNGs are uploaded to the public sixfps-frames bucket, limited to 2 MiB. Ownership and the exact booked upload path are checked in the database. Final images are immutable to contributors.
- Small PNG previews are sent while drawing changes and delivered using Supabase Realtime. They are visible to all visitors to the public movie, including before publication.
- Expired previews are hidden immediately. Preview rows are deleted with the booking on release/publication or when another booking cleans expired slots.
- Full-resolution unpublished drawings are held in tab memory. On reload only the last small preview can be recovered while the booking is active.
- Completed movies cannot receive more frames until an admin removes an active frame. Empty reserved slots are retained during playback so frame timing stays consistent.
- Frames render at 540 × 960. Playback is 6 FPS. Upload MIME/size and owner are checked; Supabase does not decode the PNG to validate its dimensions.

Free hosting still has storage, bandwidth and Realtime quotas. Inspect usage in your Supabase dashboard. Archives occupy storage until deleted; abandoned uploads require separate cleanup through the Storage API/dashboard. Never delete storage.objects rows directly.

## Files and checks

- public/: shipped UI, Supabase adapters, public config and bundled SDK.
- supabase/: initial schema, admin setup and projects migration.
- test/: local API and embedded Postgres tests of the actual SQL functions and permissions.
- scripts/build.js: bundles the official Supabase client.
- server.js: development server and legacy local API.
- data/: local legacy database, not uploaded or deployed.

Run `npm test` and `npm run build`. SQL tests use simulated Supabase Auth/Storage schemas in PGlite. They do not replace the hosted two-browser check in PROJECTS-SETUP.md.
