#!/usr/bin/env node
"use strict";

// Deploys the already-built websites/dist to the correct Cloudflare Worker
// for the club being deployed. The Worker name is derived from the club
// slug (see scripts/club-target.js) and passed to wrangler with --name,
// which overrides whatever "name" happens to be committed in
// wrangler.jsonc. This is what lets every club's Cloudflare project share
// the same wrangler.jsonc without fighting over the same Worker identity.
//
// Some Cloudflare project types (static-assets-only Workers, and possibly
// classic Pages) don't expose a build-variable UI, so CLUB_SLUG can't
// always be set once per project. In that case the slug has to be typed
// again in the deploy command's --club= flag, which reopens the door to
// drift between the build command's slug and the deploy command's slug.
// To catch that, build.js stamps the slug it actually built into
// .club-build-slug, and this script refuses to publish if that doesn't
// match what it was told to deploy.
//
// Usage:
//   node scripts/deploy.js                  (slug from CLUB_SLUG)
//   node scripts/deploy.js --club=<slug>
//   node scripts/deploy.js -- --dry-run      (extra flags forwarded to wrangler)

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
    ROOT,
    resolveSlug,
    workerNameFor,
    assertValidWorkerName,
    assertClubExists,
} = require("./club-target");

function parseArgs(argv) {
    let club = null;
    const passthrough = [];
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--club=(.+)$/);
        if (m) {
            club = m[1];
        } else {
            passthrough.push(arg);
        }
    }
    return { club, passthrough };
}

function main() {
    const { club, passthrough } = parseArgs(process.argv);

    // Unlike build.js, there is no silent default here: a deploy that
    // can't tell which club it's shipping must refuse to run rather than
    // guess and potentially overwrite the wrong Worker.
    if (!club && !process.env.CLUB_SLUG) {
        console.error(
            "✖ No club specified — pass --club=<slug> or set the CLUB_SLUG build variable."
        );
        process.exit(1);
    }

    const slug = resolveSlug(club);
    assertClubExists(slug);

    // Cross-check against what build.js actually produced. If the marker
    // is missing (predates this check, or dist/ was built by some other
    // means) we can't verify anything, so we proceed but say so — this is
    // a safety net for the two-command-same-slug case, not a hard
    // requirement for every possible workflow.
    const markerPath = path.join(ROOT, ".club-build-slug");
    if (fs.existsSync(markerPath)) {
        const builtSlug = fs.readFileSync(markerPath, "utf8").trim();
        if (builtSlug !== slug) {
            console.error(
                `✖ Refusing to deploy: the last build was for club "${builtSlug}" but this deploy ` +
                `command was told to deploy "${slug}". Check that the build command's --club= ` +
                `matches the deploy command's --club= for this Cloudflare project.`
            );
            process.exit(1);
        }
    } else {
        console.warn(`⚠ No .club-build-slug marker found — skipping the build/deploy slug cross-check.`);
    }

    const name = workerNameFor(slug);
    assertValidWorkerName(name);

    console.log(`→ Deploying club "${slug}" as Worker "${name}"`);

    const result = spawnSync(
        "npx",
        ["wrangler", "deploy", "--name", name, ...passthrough],
        { cwd: ROOT, stdio: "inherit", shell: true }
    );

    if (result.error) {
        console.error(`✖ Failed to run wrangler: ${result.error.message}`);
        process.exit(1);
    }
    process.exit(result.status == null ? 1 : result.status);
}

main();
