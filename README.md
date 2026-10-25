# Deckhand

An Anki-compatible flashcard PWA. Imports any `.apkg`/`.colpkg` (including Anki 23.10+'s zstd format),
studies with Anki's review flow and FSRS, and syncs the collection across devices through Supabase.

Plain ES modules, no build step. Everything lives in IndexedDB on each device; Supabase is a mirror.

## Run locally

```bash
npm run serve
```

Then open http://127.0.0.1:8091 (the service worker is skipped on 127.0.0.1 so code changes show up immediately).

Before deploying, run `npm run check`. It syntax-checks every script, rewrites `precache.json`, and stamps `sw.js` with a
new version so installed copies update.

## Layout

| Path | What it does |
|---|---|
| `app.js` | Router, deck list, deck overview, import, settings |
| `views/` | Reviewer, note editor, browser, stats, deck options + note type editor |
| `card.html` | Card renderer, loaded in `<iframe sandbox="allow-scripts">` so deck HTML/JS can't touch the app's storage or login |
| `lib/import/` | `.apkg` reader (protobuf, zstd, SQLite via sql.js) and the import worker |
| `lib/render.js` | Anki template engine: fields, conditionals, cloze, hint, type-in, furigana |
| `lib/srs.js` | Learning steps + FSRS (ts-fsrs) scheduling, 4 am day rollover |
| `lib/col.js` | In-memory collection, queues and daily limits, answering, undo |
| `lib/sync.js` | Supabase sign-in, outbox push, cursor pull, media bucket |
| `lib/export.js` | Legacy (schema 11) `.apkg` export, readable by every Anki version |
| `supabase/schema.sql` | Table, last-write-wins trigger, row-level security, media bucket policies |

## Set up sync (one time)

1. In the Supabase dashboard, create a **new project** (free plan) named `deckhand`. Keep it separate from other apps.
2. **SQL Editor** → paste and run `supabase/schema.sql`.
3. **Authentication → Sign In / Providers**: Email on. Turn off "Confirm email" if you like; the code sign-in confirms anyway.
4. **Authentication → Email Templates → Magic Link**: add the code so it can be typed into the installed app
   (on iPhone a home-screen app can't receive a link), for example:
   `<p>Your Deckhand code: <b>{{ .Token }}</b></p><p>Or <a href="{{ .ConfirmationURL }}">sign in on this device</a>.</p>`
5. **Authentication → URL Configuration**: Site URL = where the app is hosted (e.g. `https://nschroder99.github.io/deckhand/`),
   and add the same URL plus `http://127.0.0.1:8091` under Redirect URLs.
6. **Project Settings → API**: copy the Project URL and the publishable (anon) key into `config.js`, or paste them in the
   app under Settings → Sync server on each device.

Supabase's built-in mailer sends only a few emails per hour, which is fine for signing in a handful of devices.

### How sync behaves

- Every change is written locally first and queued; the app works fully offline.
- Sync runs on open, a few seconds after changes, when the tab becomes visible, every 5 minutes, and on reconnect.
- Conflicts: per row, the newer edit wins (enforced by a trigger on the server). Reviews are separate rows, so reviews done offline on two devices both count.
- Media goes to a private bucket under `<user id>/<sha1>`. Other devices download each file the first time a card needs it (or all at once with Settings → Download all media).
- If the free project pauses after a week without use, the app keeps working and shows "Sync paused"; restore the project in the dashboard and it catches up.

### Free-plan budget

Database: cards and reviews take a few MB of the 500 MB. Storage: media counts against 1 GB per project
(the MCAT test deck is ~134 MB). Settings → Check storage use shows the current total, with a warning past 800 MB.

## Not yet supported

Image Occlusion note types (the template needs Anki's own JS), LaTeX images (`[latex]` tags; MathJax `\( \)` works,
loaded from jsDelivr the first time it's needed), filtered decks (their cards import into their home decks), add-ons, and syncing with AnkiWeb itself.

## Licenses

Vendored libraries keep their licenses in `lib/vendor/*.LICENSE`: ts-fsrs (MIT), sql.js (MIT), fflate (MIT), fzstd (MIT), supabase-js (MIT).
