# club-site-generator
An easy way to create sites for your clubs!

## Building a site locally

```bash
cd websites
npm install
node build.js --club=<slug>   # slug = a folder name under websites/clubs/
```

Output is written to `websites/dist/` (wiped and rebuilt each run).

## Deploying to Cloudflare

Each club gets its own Cloudflare Pages/Workers project, all pointed at this
repo with **root directory `websites/`**. Because every project shares that
one directory, they also share the single committed `websites/wrangler.jsonc`
— so its `"name"` field cannot be used to pick which Worker a given club
deploys to (every project would deploy to the same Worker and overwrite
each other's live sites).

Instead, the Worker name is computed from the club slug at deploy time and
passed to wrangler with `--name`, overriding whatever `"name"` happens to be
committed in `wrangler.jsonc`. That committed value is just a fallback for
ad hoc local deploys; it is not authoritative and isn't required to match
any real project.

**If your Cloudflare project type exposes a build variable** (some
static-assets-only Worker projects, and classic Pages, don't), that's the
simplest setup — the slug lives in exactly one place per project:

| Cloudflare project setting | Value |
| --- | --- |
| Root directory | `websites/` |
| Build command | `node build.js` |
| Deploy command | `npm run deploy` |
| Build variable | `CLUB_SLUG=<slug>` |

**If it doesn't**, pass the slug explicitly in both commands instead:

| Cloudflare project setting | Value |
| --- | --- |
| Root directory | `websites/` |
| Build command | `node build.js --club=<slug>` |
| Deploy command | `npm run deploy -- --club=<slug>` |

Typing the slug twice reopens the door to it drifting between the two
commands — so `build.js` stamps the slug it just built into
`.club-build-slug` (gitignored, next to `dist/`), and `scripts/deploy.js`
refuses to run if that doesn't match the slug it was given. A mismatch
prints an error naming both slugs instead of silently deploying the wrong
club's content under the wrong Worker name.

The slug → Worker name mapping lives in `websites/scripts/club-target.js`.
By default a slug `foo` deploys to Worker `club-foo`. One exception is
pinned in `LEGACY_NAMES`: `example-club` deploys to `dynamic-example-club`,
the name its Worker already had before this convention existed — changing
that would rename a live Worker and could break its URL/custom domain, so
it's intentionally not renamed.

Adding a new club: create `websites/clubs/<slug>/club.json`, then create a
new Cloudflare project pointed at this repo with the settings above,
substituting that club's slug.
