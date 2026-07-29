# club-site-generator
An easy way to create sites for your clubs!

## Building a site locally

```bash
cd websites
npm install
node build.js --club=<slug>   # slug = a folder name under websites/clubs/
```

Output is written to `websites/dist/` (wiped and rebuilt each run).

## Adding officer photos

By default, each officer on the site shows a circular avatar with their
initials. You can replace that with a real photo:

1. Put the image file in `websites/clubs/<slug>/images/` (create that
   folder if it doesn't exist yet). This is the same folder used for the
   photo gallery.
2. In that club's `websites/clubs/<slug>/club.json`, add a `"photo"` field
   to the officer's entry with the image's filename:
   ```json
   "officers": [
     { "name": "Ava Chen", "role": "President", "photo": "ava-chen.jpg" },
     { "name": "Marcus Bell", "role": "Vice President" }
   ]
   ```
   `photo` is optional per officer — leave it out and that officer keeps
   the initials avatar (as Marcus does above).
3. Rebuild the site (`node build.js --club=<slug>`). Photos larger than
   1600px wide are automatically resized and compressed, same as gallery
   images.

## Deploying to Cloudflare

Each club gets its **own** Cloudflare Pages/Workers project, all pointed at
this same repo. This section walks through setting up one project for one
club. Repeat it for every additional club, substituting that club's slug.

### Steps

1. Add the club's data first, if it doesn't exist yet: create
   `websites/clubs/<slug>/club.json` and commit/push it.
2. In the Cloudflare dashboard, create a new Workers/Pages project and
   connect it to this repo (or open the existing project if you're just
   updating settings).
3. Set **root directory** to `websites/`.
4. Check whether the project has a **build variables** section:
   - **If yes**, set:
     | Setting | Value |
     | --- | --- |
     | Build command | `node build.js` |
     | Deploy command | `npm run deploy` |
     | Build variable | `CLUB_SLUG=<slug>` |

     The variable's **name** is `CLUB_SLUG`; its **value** is the club's
     slug (the folder name under `websites/clubs/`), not the Worker name.
     For the existing club, that's `CLUB_SLUG=example-club`.
   - **If no** (some static-assets-only Worker project types, and classic
     Pages, don't expose it), pass the slug in both commands instead:
     | Setting | Value |
     | --- | --- |
     | Build command | `node build.js --club=<slug>` |
     | Deploy command | `npm run deploy -- --club=<slug>` |
5. Save the project settings and trigger a deploy (push a commit, or use
   the dashboard's "Retry deployment"/"Deploy" action).
6. In the deploy log, confirm the line
   `→ Deploying club "<slug>" as Worker "<worker-name>"` shows the Worker
   name you expect **before** it hands off to wrangler. For `example-club`
   that name is `dynamic-example-club`, not `club-example-club` — see
   "Why this is needed" below.
7. Open the deployed URL and confirm it's the right club's site.

### Why this is needed

Because every club's project shares the one committed
`websites/wrangler.jsonc`, its `"name"` field can't be used to pick which
Worker a given club deploys to — every project would deploy to the same
Worker and overwrite each other's live sites. Instead, the Worker name is
computed from the club slug at deploy time and passed to wrangler with
`--name`, overriding whatever `"name"` happens to be committed in
`wrangler.jsonc`. That committed value is just a fallback for ad hoc local
deploys; it is not authoritative and isn't required to match any real
project.

If you're using the explicit `--club=<slug>` commands (step 4, second
option), typing the slug twice reopens the door to it drifting between the
build and deploy commands — so `build.js` stamps the slug it just built
into `.club-build-slug` (gitignored, next to `dist/`), and
`scripts/deploy.js` refuses to run if that doesn't match the slug it was
given. A mismatch prints an error naming both slugs instead of silently
deploying the wrong club's content under the wrong Worker name.

The slug → Worker name mapping lives in `websites/scripts/club-target.js`.
By default a slug `foo` deploys to Worker `club-foo`. One exception is
pinned in `LEGACY_NAMES`: `example-club` deploys to `dynamic-example-club`,
the name its Worker already had before this convention existed — changing
that would rename a live Worker and could break its URL/custom domain, so
it's intentionally not renamed.
