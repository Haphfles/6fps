# 6FPS — movies update

Every movie has 90 slots at 6 FPS: 15 seconds. Only the admin creates movies; everyone can choose one and contribute.

## 1. Update Supabase first

Open your Supabase project → SQL Editor → create a new SQL snippet (not a Logs query).
Copy the ENTIRE contents of `supabase/projects.sql`, paste it and click Run.

This upgrade requires the setup.sql and admin.sql scripts you already ran. Do not rerun those older scripts after this upgrade.

On its first run, this script clears the original movie by moving its existing drawings into your admin Archive. It also releases old bookings. Images and your admin login remain intact. Rerunning projects.sql does not clear new drawings.

The script changes database constraints, access rules and functions, so Supabase may show its destructive-operation warning. The intended artwork change is archival, not permanent image deletion. It also enables live updates for movie state and temporary drawing previews.

## 2. Update GitHub

Unzip `6fps-projects-update.zip`. Open your Haphfles/6fps repository → Add file → Upload files.
Drag the contents of the extracted folder into the repository root, preserving the public/, supabase/ and test/ folders. Do not upload the ZIP itself or put everything inside another folder.
Commit the changes. Your existing GitHub Actions workflow deploys the update; wait for its green check.
No hidden files or new credentials are needed for this update.

## 3. Use your admin editor

Open https://haphfles.github.io/6fps/admin.html and refresh. Sign in with your existing admin account.

- Enter a name and press **+ Movie** to create a movie.
- Use the movie selector to choose which movie you manage.
- **Clear movie** moves that movie's submitted frames into Archive and releases its bookings.
- Archive → select a drawing → Restore frame brings it back into an available slot.
- Permanent deletion is still a separate admin action.

## 4. Try it with two browsers

Open the public site in two separate browsers, or one normal and one private window. Refresh after deployment.

1. Select the same movie in both browsers.
2. Press **+** above the timeline in the first browser. It reserves frame 1.
3. Press **+** in the second browser. It reserves frame 2.
4. Draw in frame 1. The second browser should see its live outline behind frame 2. Adjust the overlay opacity below the canvas.
5. Publish both frames. Each must stay in its reserved slot, even if frame 2 finishes first.
6. Create another movie as admin, refresh the public page, and select it from the menu.

LIVE means the realtime connection is subscribed. Draft previews are sent roughly every 750 ms while drawing changes; actual delivery depends on the network. A 10-second fallback refresh is used if realtime disconnects.

The database rejects bookings and submissions beyond 90 submitted frames. If all remaining slots are reserved, the + button waits for publication or an expired/released booking. Expired slots can be booked again. A finished movie reopens only if an admin archives or clears frames.

## Storage

Final full-resolution PNGs stay in Supabase Storage. Temporary, lower-resolution previews live in the sixfps_drafts database table and disappear when their booking is released, replaced or published. Expired previews are hidden by RLS immediately; stored expired rows are removed on the next booking in that movie. Archived final images continue using storage until permanently deleted.

Browser tabs retain full-resolution unpublished drawings only in memory. A reload can recover the latest low-resolution live preview if its booking is still active; it is not a full-resolution autosave.

## Verification already performed

The automated tests cover ownership, separate slots, draft permissions, expired bookings, out-of-order submissions, the 90-frame limit, admin-only creation/clearing, project isolation and safe migration reruns. A local UI fixture was used to check the movie selector, booking button, drawing and previous-frame overlay. Hosted realtime needs the two-browser check above after you run the SQL and deploy.
