#!/usr/bin/env node
"use strict";

// Shared by build.js and scripts/deploy.js so the two never disagree about
// which club is being built vs. which Worker it deploys to. See the
// "Multi-Club Cloudflare Deploys" plan for why this exists: every club's
// Cloudflare project builds from the same checked-in wrangler.jsonc, so the
// Worker name can't come from that file — it has to be derived here, from
// the slug, at build/deploy time.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLUBS_DIR = path.join(ROOT, "clubs");

const DEFAULT_SLUG = "example-club";

// example-club's Cloudflare project was set up before this naming scheme
// existed, and its Worker (dynamic-example-club) is already live with that
// name baked into its *.workers.dev URL (and possibly a custom domain).
// Renaming it is a separate, deliberate action — not a side effect of this
// refactor — so it's pinned here rather than left to fall through to the
// `club-${slug}` convention below.
const LEGACY_NAMES = {
    "example-club": "dynamic-example-club",
};

const WORKER_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Resolves which club slug is in play, in order of precedence:
//   1. an explicit --club=<slug> flag (already parsed by the caller)
//   2. the CLUB_SLUG build variable (set per Cloudflare project)
//   3. DEFAULT_SLUG, so plain `node build.js` still works locally
function resolveSlug(explicit) {
    if (explicit) return explicit;
    if (process.env.CLUB_SLUG) return process.env.CLUB_SLUG;
    return DEFAULT_SLUG;
}

// Computes the Worker name a given slug should deploy to.
function workerNameFor(slug) {
    if (Object.prototype.hasOwnProperty.call(LEGACY_NAMES, slug)) {
        return LEGACY_NAMES[slug];
    }
    return `club-${slug}`;
}

function assertValidWorkerName(name) {
    if (!WORKER_NAME_RE.test(name)) {
        console.error(
            `✖ "${name}" is not a valid Cloudflare Worker name (lowercase letters, digits, ` +
            `and hyphens only, 1-63 chars, no leading/trailing hyphen). Check the club slug.`
        );
        process.exit(1);
    }
}

function assertClubExists(slug) {
    const clubJsonPath = path.join(CLUBS_DIR, slug, "club.json");
    if (!fs.existsSync(clubJsonPath)) {
        console.error(`✖ No club found for slug "${slug}" — expected ${clubJsonPath}`);
        process.exit(1);
    }
}

module.exports = {
    ROOT,
    CLUBS_DIR,
    DEFAULT_SLUG,
    LEGACY_NAMES,
    resolveSlug,
    workerNameFor,
    assertValidWorkerName,
    assertClubExists,
};
