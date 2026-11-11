# Taskmaster

Standalone installable web app for Taskmaster, part of The World Government, Inc.

- Live: https://taskmaster.theworldgovernmentincorporated.com/
- Hosting: GitHub Pages from `main` / root, custom domain in `CNAME`.
- Sign-in: TWGI master accounts (same public Supabase project as the main site), email link or Google, PKCE, returns to `/login/`.
- Storage: `localStorage` keys `twgi-taskmaster-v1:<user id>` (signed in) and `twgi-taskmaster-v1:device` (signed out). Sync seam: `TWGITaskmaster.sync.pull/.push` in `assets/taskmaster.js` (local-only for now; no database table yet).
- One-time import: the main site's old `/taskmaster/` page redirects here with `#tm-import=<json>`; `assets/import.js` removes the fragment immediately and asks before merging by task id.
- Offline: `sw.js` precaches the app shell. Bump `CACHE` (currently `taskmaster-v4`) on every release.
- Task times (`assets/task-time.js`): scheduled start, due, projected duration; Start / Stop (not finished) / Resume / Finish record worked sessions (`segments`). Actual duration = sum of sessions, shown as a tag (e.g. `Actual 1h 25m`), also on stopped tasks, which carry a red `Incomplete` tag until resumed or finished. Actual start/end can also be typed in.
- Manual order (`assets/task-order.js`, v4): drag a task by its handle (touch, pen or mouse), use the arrow keys on the handle, or tap Up / Down. Each task stores `order` (0 = top) in the same localStorage list, and the array is saved in that order. Lists from before v4 keep their existing sequence. The order is not sent to the push service.
- Notifications (`assets/push-core.js`, `assets/push-ui.js`): push service at `https://push.theworldgovernmentincorporated.com` (separate Worker, see push-build/backend/DEPLOY.md). Permission is asked only after a tap on Enable notifications. For signed-in devices with notifications on, only each task's id, name (can be hidden), done flag, planned start, due, duration and actual start/end are sent so the server can schedule reminders. `sw.js` handles `push` and `notificationclick` (opens `/?task=<id>`).
- Comments (`assets/comments.js`, `supabase/taskmaster_comments.sql`, NOT applied yet): per-task comment threads in Supabase with row level security; the owner grants comment access per task or for the whole list by TWGI account email, can revoke, and can delete any comment; others edit/delete only their own.

Never commit secrets, `wrangler.jsonc`, or Hyperdrive ids. Only the publishable (public) Supabase key is used.
