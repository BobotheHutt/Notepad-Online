# Noteshack

A word processor and PDF editor that runs in the browser: vanilla JS PWA, no
build step. Live at https://noteshack.org. The README has the features, the
privacy promises, the file list and the credits; read the part you need.

## Where things are

| What | Where |
|---|---|
| The site | GitHub Pages from `main` (repo BobotheHutt/Noteshack), behind Cloudflare. **A push to `main` is live.** |
| Translation models, Noto fonts | Cloudflare R2 bucket `noteshack-files`, served at `files.noteshack.org`. Uploaded by `tools/translation-models.py`, `tools/noto-fonts.py`. |
| Online translator, problem reports | Cloudflare Worker `noteshack-api` at `api.noteshack.org` (`worker/index.js`). Deployed by `.github/workflows/worker.yml` on a push to `main` that touches `worker/`, then checked live. Translating stops for the day (until midnight UTC) at **$1** of Workers AI, counted in the Durable Object `Budget`: the account is on Workers Paid, so past the free allowance it is billed, not stopped. |
| Cloudflare account | `c047d9e1fea222a9db788c3e9a79cc37`, on **Workers Paid** (shared with another project). |
| Analytics | Cloudflare Web Analytics, added to the page by Cloudflare; allowed in the CSP. |

## Secrets (none in the repo, none in chat)

- **GitHub repository secrets:** `CLOUDFLARE_API_TOKEN` (deploys the Worker:
  Workers Scripts Edit, Workers Routes Edit and Zone Read on noteshack.org) and
  `NOTESHACK_ISSUES_TOKEN` (fine-grained, Noteshack only, Issues read and write;
  the Worker files reports with it).
- **This cloud environment:** a Bearer secret for `api.cloudflare.com`, path
  `/client/v4/accounts/c047d9e1fea222a9db788c3e9a79cc37/r2/` only. It reaches
  R2 and nothing else in Cloudflare.
- The session's network cannot reach `files.noteshack.org` or
  `api.noteshack.org`. Check the live Worker through its GitHub workflow (it
  translates a sentence and checks other sites are refused; run it by hand
  with `test_report: true` to also file a test report, then close that issue).

## Releasing

1. Make the change. Run **only the tests it affects**, here, in Chromium.
2. Bump the release: `CACHE` in `sw.js`, the `?v=` number on every file in
   `index.html` (same number; `tests/release.spec.mjs` checks), and
   `APP_VERSION` in `js/app.js`. `VENDOR` in `sw.js` too if `vendor/` changed.
3. Commit and push straight to `main`. No work-branch push first: it only
   doubles GitHub's test run.
4. Check it is live: `https://noteshack.org/sw.js` shows the new `CACHE`.
5. GitHub then runs every test in Chromium, Firefox and WebKit (about 12
   minutes): the safety net. If it fails, fix it at once. Re-run a failure
   once only when it is plainly unrelated to the change; two known flaky ones
   are below.

### Tests on this machine

```
npm install
python3 tools/test-setup.py           # fonts and models into tests/.fixtures/ (not committed)
NOTESHACK_FONTS=tests/.fixtures/fontsource npx playwright test tests/<affected>.spec.mjs --project=chromium
```

Only Chromium is installed here. Tests that use the online service (the
translator, reports) stand it in with `page.route`, and need
`serviceWorkers: 'block'` for WebKit.

## Rules of this codebase

- **Every phrase the app shows is in `locales/{es,fr,de,pt,it}.js`**, keyed by
  the English; the i18n tests fail on any missing, unused, or with different
  `{placeholders}`. Translate so it reads naturally, not word for word.
- **Only components that allow commercial use.**
- **User-facing text sounds human.** The welcome popup sells the app: what you
  get, no disclaimers (a warning belongs where the thing is chosen).
- **Nothing in the text says "no analytics"** (there are analytics), and
  nothing announces them either. That was decided; leave it.
- Reports are public GitHub issues and the form says so. Spam protection is
  the hidden field, 3 a minute per visitor and length checks; add Turnstile
  only if spam actually appears.

## Open work

1. Proposed, **not approved**: an About-and-storage line to remove downloaded
   models and fonts; a monthly GitHub check that warns before
   `NOTESHACK_ISSUES_TOKEN` expires.
2. Later, only if asked: translation with your own key (DeepL, Google…); a
   Buy Me a Coffee link.
3. Flaky tests: `editor.spec` once found 4 documents instead of 3 (not
   reproduced in 30 runs; it now prints the names if it happens again);
   reading a scan in WebKit once found no text.
4. The app's translations have not been checked by native speakers, and
   none are available.

## Working with the owner

- **Never ask for a secret in chat.** Secrets go in GitHub's secrets or the
  environment's settings, which the owner fills in.
- **Setup steps: exact, click by click, all at once.** Work out every token
  and setting needed before the first step, never one more after "that's
  all". Fine-grained GitHub tokens.
- **A question is not a go.** Raise it, recommend, wait for "go". Once it is
  given, build and ship without another checkpoint.
- **Ask once.** Do not re-list things already asked or done.
- **When pushed back on, check before defending.**
- Keep replies short and plain. End a long one with the actions, split into
  what needs an answer and what needs doing.
