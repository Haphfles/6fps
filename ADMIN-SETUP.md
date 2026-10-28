# Enable your private 6FPS editor

This update adds `admin.html`: a separate email/password sign-in, full-film preview at 6 FPS, a frame grid and scrubber, reordering, reversible archiving, restoring, permanent deletion, and booking release. Regular visitors still submit their own frame and watch the movie. They cannot edit the movie or gain admin access by signing up.

## 1. Upgrade Supabase

Open Supabase → SQL Editor → New query. Paste and run **supabase/admin.sql** in full. This preserves existing drawings and assigns them their current timeline positions. It adds an admin allowlist and protects every editor action in the database.

Run this migration after the original setup.sql. If you rerun setup.sql in the future, immediately rerun admin.sql afterward. Do not run only setup.sql on an upgraded project.

This script creates no admin user and grants nobody admin access by itself.

## 2. Create your own editor login

In Supabase → Authentication → Users, use **Add user → Create new user**. Enter your own email and a strong password that you keep in your password manager. For your own user, enable Auto Confirm User if that option is shown. If you use the invitation flow instead, complete the email verification and password setup first.

This is a login for your 6FPS app. Your Supabase dashboard/organization login is separate.

Open **supabase/grant-admin.sql**. Replace `YOUR_EMAIL_HERE` with the email of the user you just created. Paste that script into Supabase SQL Editor and run it. It refuses anonymous or unconfirmed accounts. Do not send your password to anyone or put it in code.

To revoke access later, remove that user's row from `sixfps_admins` through your Supabase dashboard. Every database action rechecks membership.

## 3. Upload this update yourself

The supplied `6fps-admin-update.zip` contains the changed/new files, with their folder structure. Unzip it and upload its contents through GitHub → your 6fps repository → Add file → Upload files. Keep the `public`, `supabase`, and `test` folder paths. Commit to main. No hidden files or changes to your existing workflow are needed for this update.

Wait for Actions → Deploy 6FPS to finish successfully, then open:

https://haphfles.github.io/6fps/admin.html

Sign in with the editor email/password from step 2. Anyone can load the login screen, but only an explicitly allowlisted, verified non-anonymous user can load or change movie data. There is no secret URL-based authorization and no service-role key in the browser.

The admin session is separate from the public drawing session and stored only in the current tab's session storage. Use Sign out when finished.

## Editor controls

- **Movie / Archive** switches between published and removed frames.
- Select a frame to preview it. **Position → Move** changes its timeline position.
- **Archive frame** removes it from playback and keeps the drawing for recovery. **Restore to end** returns it to the movie. You can then move it.
- Archived files remain in the public Storage bucket and can still be accessed through an existing direct URL. Archiving is reversible, not a privacy deletion.
- **Delete permanently** is available only for archived frames and requires confirmation. It deletes the image through the Supabase Storage API, then deletes its frame record. Cached/downloaded copies cannot be recalled.
- If a network error interrupts deletion, the frame says **DELETION PENDING**. Retry Delete permanently to complete it; it cannot be restored midway through deletion.
- **Release booking** frees a stuck turn. It invalidates that contributor's current reservation; their tab retains their draft.
- The editor blocks movie edits while a live drawing turn is reserved. Let it finish or explicitly release it first.
- **Refresh** loads other changes. Conflicting edits are rejected instead of overwriting a newer movie version.

The public app refreshes frame order and count after an admin edit, normally within 10 seconds for active tabs. Playback stops when the movie changes.

## Also fixed: iPhone playback button

Play/pause now use SVG icons rather than Unicode characters, and native iOS button styling is disabled. The same black-and-white control is used in the public app and admin editor.

## Validation and limits

Local embedded-Postgres tests check migration of an existing film, admin/visitor separation, anonymous allowlist rejection, reordering, archive/restore, stale edits, booking conflicts, safe deletion, and stable frame IDs after deletion. These tests use fixtures for Supabase Auth and Storage. Live editor testing requires you to run the migration and create your admin account; no live drawings were modified during development.

The editor currently manages sequence and moderation; it does not redraw someone else's artwork. No automatic data deletion, bulk reset, or backup scheduler is installed.
