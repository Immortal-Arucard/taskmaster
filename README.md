# Taskmaster

Standalone installable web app for Taskmaster, part of The World Government, Inc.

- Live: https://taskmaster.theworldgovernmentincorporated.com/
- Hosting: GitHub Pages from `main` / root, custom domain in `CNAME`.
- Sign-in: TWGI master accounts (same public Supabase project as the main site), email link or Google, PKCE, returns to `/login/`.
- Storage: `localStorage` keys `twgi-taskmaster-v1:<user id>` (signed in) and `twgi-taskmaster-v1:device` (signed out). Sync seam: `TWGITaskmaster.sync.pull/.push` in `assets/taskmaster.js` (local-only for now; no database table yet).
- One-time import: the main site's old `/taskmaster/` page redirects here with `#tm-import=<json>`; `assets/import.js` removes the fragment immediately and asks before merging by task id.
- Offline: `sw.js` precaches the app shell. Bump `CACHE` (currently `taskmaster-v1`) on every release.

Never commit secrets, `wrangler.jsonc`, or Hyperdrive ids. Only the publishable (public) Supabase key is used.
