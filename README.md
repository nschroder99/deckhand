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

## Sync setup (done 2026-10-25)

Project `deckhand` (`nywhpenpwxykpdcuokua`, us-east-1) on the free plan, separate from other apps.

1. `supabase/schema.sql` was run in the SQL editor.
2. Sign-in is email + password ("Confirm email" off). Supabase's free plan can't customise its emails, and an emailed
   link would open Safari rather than the installed iPhone app, so links/codes aren't used.
3. After the owner's account exists, **Authentication → Sign In / Providers → Allow new users to sign up** is switched
   off so nobody else can create an account and use the storage quota.
4. URL Configuration: Site URL `https://nschroder99.github.io/deckhand/`; redirect URLs for that and `http://127.0.0.1:8091`.
5. `config.js` holds the project URL and publishable key (public by design; row-level security does the protecting).

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
