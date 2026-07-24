#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const sharp = require("sharp");

// ---------- Paths & constants ----------
const ROOT = __dirname;
const CLUBS_DIR = path.join(ROOT, "clubs");
const TEMPLATE_DIR = path.join(ROOT, "template");
const SECTIONS_DIR = path.join(TEMPLATE_DIR, "sections");
const DIST_DIR = path.join(ROOT, "dist");
const SCHEMA_PATH = path.join(ROOT, "club.schema.json");

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 80;
const RASTER_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".gif"];

// Configurable split thresholds — a section becomes its own page when
// item count > threshold. Officers is intentionally NOT here: it always
// renders inline on index.html no matter how many officers there are.
const SPLIT_THRESHOLDS = { events: 5, awards: 5, gallery: 8 };

// ---------- CLI args: --club=<slug> (default example-club) ----------
function parseArgs(argv) {
    let club = "example-club";
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--club=(.+)$/);
        if (m) {
            club = m[1];
        } else if (arg.startsWith("--")) {
            console.warn(`⚠ Unrecognized flag "${arg}" — did you mean --club=<slug>? Ignoring it; building "${club}".`);
        }
    }
    return { club };
}

// ---------- Small helpers ----------
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const MONTHS = ["January","February","March","April","May","June",
    "July","August","September","October","November","December"];

function formatDate(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    if (!y || !m || !d || m < 1 || m > 12) return escapeHtml(iso);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function initials(name) {
    return String(name).trim().split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
}

// Shared {{token}} replacer — unknown tokens collapse to "" so a typo
// never leaks raw {{...}} into the page. Used for page.html AND for
// each section partial.
function fillTokens(str, data) {
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) =>
        Object.prototype.hasOwnProperty.call(data, key) ? data[key] : ""
    );
}

function loadPartial(name) {
    return fs.readFileSync(path.join(SECTIONS_DIR, `${name}.html`), "utf8");
}

// ---------- Section renderers ----------
// Each returns a whole, self-contained <section>…</section> string,
// or "" if there's no data. This exact string is reused verbatim
// whether it ends up inline on index.html or as an entire sub-page's
// <main> content — see "Architecture" in the plan doc.
function renderAbout(club) {
    if (!club.description) return "";
    const meeting = club.meetingTime
        ? `<p class="section-lead"><strong>When we meet:</strong> ${escapeHtml(club.meetingTime)}</p>`
        : "";
    return `
    <section id="about" class="section">
      <div class="container">
        <h2 class="section-title">About Us</h2>
        <p class="section-lead">${escapeHtml(club.description)}</p>
        ${meeting}
      </div>
    </section>`;
}

function renderOfficers(officers) {
    if (!officers || officers.length === 0) return "";
    const itemsHtml = officers.map(o => `
        <li class="officer-card">
          <div class="officer-avatar" aria-hidden="true">${escapeHtml(initials(o.name))}</div>
          <span class="officer-name">${escapeHtml(o.name)}</span>
          <span class="officer-role">${escapeHtml(o.role)}</span>
        </li>`).join("");
    return fillTokens(loadPartial("officers"), { itemsHtml });
}

function renderEvents(events) {
    if (!events || events.length === 0) return "";
    const itemsHtml = events.map(e => `
        <li class="event-card">
          <span class="event-date">${formatDate(e.date)}</span>
          <h3 class="event-title">${escapeHtml(e.title)}</h3>
          ${e.description ? `<p class="event-desc">${escapeHtml(e.description)}</p>` : ""}
        </li>`).join("");
    return fillTokens(loadPartial("events"), { itemsHtml });
}

function renderAwards(awards) {
    if (!awards || awards.length === 0) return "";
    const itemsHtml = awards.map(a => `
        <li class="award-card">
          <span class="award-year">${escapeHtml(a.year)}</span>
          <p class="award-title">${escapeHtml(a.title)}</p>
        </li>`).join("");
    return fillTokens(loadPartial("awards"), { itemsHtml });
}

function renderGallery(images, clubName) {
    if (!images || images.length === 0) return "";
    const itemsHtml = images.map(file => `
        <figure class="gallery-item">
          <img src="images/${encodeURIComponent(file)}" alt="${escapeHtml(clubName)} photo" loading="lazy">
        </figure>`).join("");
    return fillTokens(loadPartial("gallery"), { itemsHtml });
}

function renderContact(club) {
    const rows = [];
    if (club.advisorName) rows.push(`<p class="contact-row"><span class="contact-label">Advisor:</span> ${escapeHtml(club.advisorName)}</p>`);
    if (club.meetingTime) rows.push(`<p class="contact-row"><span class="contact-label">Meetings:</span> ${escapeHtml(club.meetingTime)}</p>`);
    return `
    <section id="contact" class="section">
      <div class="container">
        <h2 class="section-title">Get In Touch</h2>
        <div class="contact-card">
          <p class="section-lead">Interested in joining ${escapeHtml(club.clubName)}? Come to a meeting or reach out to our advisor.</p>
          ${rows.join("\n          ")}
        </div>
      </div>
    </section>`;
}

function renderTeaser(section, count) {
    const label = section.label.toLowerCase();
    return `
    <section id="${section.key}" class="section">
      <div class="container">
        <h2 class="section-title">${escapeHtml(section.label)}</h2>
        <p class="section-lead">
          ${count} ${escapeHtml(label)} and counting —
          <a class="btn btn-primary" href="${section.file}">See all ${escapeHtml(label)} →</a>
        </p>
      </div>
    </section>`;
}

// ---------- Splittable section registry (drives split decisions AND nav) ----------
const SPLITTABLE_SECTIONS = [
    { key: "events",  label: "Events",          threshold: SPLIT_THRESHOLDS.events,  file: "events.html",  getItems: c => c.events  || [] },
    { key: "awards",  label: "Awards & Honors", threshold: SPLIT_THRESHOLDS.awards,  file: "awards.html",  getItems: c => c.awards  || [] },
    { key: "gallery", label: "Gallery",         threshold: SPLIT_THRESHOLDS.gallery, file: "gallery.html", getItems: c => c.images  || [] },
];

function decideSplits(club) {
    const mode = club.siteMode || "dynamic";
    const splits = {};
    for (const s of SPLITTABLE_SECTIONS) {
        const count = s.getItems(club).length;
        if (count === 0) { splits[s.key] = false; continue; } // no data — never a page, never a nav link
        splits[s.key] =
            mode === "single"    ? false :
            mode === "multipage" ? true  :
            count > s.threshold;                                // dynamic
    }
    return splits;
}

function buildSectionHtml(club) {
    return {
        events: renderEvents(club.events),
        awards: renderAwards(club.awards),
        gallery: renderGallery(club.images, club.clubName),
    };
}

// ---------- Nav model: one source of truth for every page's nav ----------
function buildNavModel(club, splits) {
    const model = [];
    if (club.description) model.push({ label: "About", target: { kind: "anchor", id: "about" } });
    if ((club.officers || []).length > 0) model.push({ label: "Officers", target: { kind: "anchor", id: "officers" } });
    for (const s of SPLITTABLE_SECTIONS) {
        if (s.getItems(club).length === 0) continue;
        model.push({
            label: s.label,
            target: splits[s.key] ? { kind: "page", file: s.file } : { kind: "anchor", id: s.key },
        });
    }
    model.push({ label: "Contact", target: { kind: "anchor", id: "contact" } });
    return model;
}

function resolveHref(target, currentPage) {
    if (target.kind === "page") return target.file;
    return currentPage === "index" ? `#${target.id}` : `index.html#${target.id}`;
}

function renderNavLinks(navModel, currentPage) {
    return navModel
        .map(item => `<li><a href="${resolveHref(item.target, currentPage)}">${escapeHtml(item.label)}</a></li>`)
        .join("\n          ");
}

// ---------- Compose index.html's <main> ----------
function composeIndexMain(club, splits, sectionHtml) {
    const parts = [renderAbout(club), renderOfficers(club.officers)];
    for (const s of SPLITTABLE_SECTIONS) {
        const items = s.getItems(club);
        if (items.length === 0) continue; // no data at all — no section, no teaser, no nav link
        parts.push(splits[s.key] ? renderTeaser(s, items.length) : sectionHtml[s.key]);
    }
    parts.push(renderContact(club));
    return parts.filter(Boolean).join("\n");
}

// ---------- Shell rendering (shared by index.html and every sub-page) ----------
function renderShell(data) {
    const template = fs.readFileSync(path.join(TEMPLATE_DIR, "page.html"), "utf8");
    return fillTokens(template, data);
}

// ---------- Images: copy, resize+compress anything > 1600px ----------
async function copyAndOptimizeImages(clubDir) {
    const srcDir = path.join(clubDir, "images");
    const outDir = path.join(DIST_DIR, "images");
    if (!fs.existsSync(srcDir)) {
        console.log("  (no images/ folder — skipping image copy)");
        return;
    }
    fs.mkdirSync(outDir, { recursive: true });

    for (const file of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, file);
        const outPath = path.join(outDir, file);
        if (!fs.statSync(srcPath).isFile()) continue;

        const ext = path.extname(file).toLowerCase();
        if (!RASTER_EXTS.includes(ext)) {
            fs.copyFileSync(srcPath, outPath);
            continue;
        }
        try {
            const image = sharp(srcPath);
            const meta = await image.metadata();
            if (meta.width && meta.width > MAX_WIDTH) {
                await image.resize({ width: MAX_WIDTH }).jpeg({ quality: JPEG_QUALITY }).toFile(outPath);
                console.log(`  ↳ optimized ${file}: ${meta.width}px → ${MAX_WIDTH}px, JPEG q${JPEG_QUALITY}`);
            } else {
                fs.copyFileSync(srcPath, outPath);
                console.log(`  ↳ copied ${file} (${meta.width || "?"}px, under ${MAX_WIDTH}px)`);
            }
        } catch (err) {
            console.warn(`  ⚠ could not process ${file}: ${err.message} — copied as-is`);
            fs.copyFileSync(srcPath, outPath);
        }
    }
}

// ---------- Build one club (validate → decide splits → render pages → images) ----------
async function buildClub(slug, validate) {
    const clubDir = path.join(CLUBS_DIR, slug);
    const jsonPath = path.join(clubDir, "club.json");

    if (!fs.existsSync(jsonPath)) {
        console.warn(`⚠ [${slug}] no club.json found at ${jsonPath} — skipping.`);
        return false;
    }

    let club;
    try {
        club = JSON.parse(fs.readFileSync(jsonPath, "utf8")); // trailing comma etc. throws here
    } catch (err) {
        console.warn(`⚠ [${slug}] club.json is not valid JSON — skipping.`);
        console.warn(`    ${err.message}`);
        return false;
    }

    if (!validate(club)) {
        console.warn(`⚠ [${slug}] club.json failed schema validation — skipping. Problems:`);
        for (const e of validate.errors) {
            const where = e.instancePath || "(root)";
            console.warn(`    • ${where} ${e.message}` +
                (e.params && Object.keys(e.params).length ? `  ${JSON.stringify(e.params)}` : ""));
        }
        return false;
    }

    const splits = decideSplits(club);
    const navModel = buildNavModel(club, splits);
    const sectionHtml = buildSectionHtml(club);
    const clubNameEsc = escapeHtml(club.clubName);
    const year = String(new Date().getFullYear());

    // Wipe dist/ before writing — otherwise stale sub-pages from a
    // previous build (e.g. a prior siteMode/threshold that split a
    // section this one doesn't) would keep sitting there, still fully
    // reachable, even after index.html stops linking to them.
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });

    // index.html — always generated
    const indexHtml = renderShell({
        pageTitle: clubNameEsc,
        clubName: clubNameEsc,
        metaDescription: escapeHtml((club.description || club.clubName).slice(0, 155)),
        navLinks: renderNavLinks(navModel, "index"),
        heroTagline: club.meetingTime ? escapeHtml(club.meetingTime) : "A school club for students who love the game.",
        heroCtaHref: "#contact",
        mainContent: composeIndexMain(club, splits, sectionHtml),
        year,
    });
    fs.writeFileSync(path.join(DIST_DIR, "index.html"), indexHtml, "utf8");

    // Sub-pages — only for sections that actually split
    const generatedFiles = ["index.html"];
    for (const s of SPLITTABLE_SECTIONS) {
        if (!splits[s.key]) continue;
        const subHtml = renderShell({
            pageTitle: `${s.label} — ${clubNameEsc}`,
            clubName: clubNameEsc,
            metaDescription: escapeHtml(`${s.label} for ${club.clubName}`),
            navLinks: renderNavLinks(navModel, s.key),
            heroTagline: s.label,
            heroCtaHref: "index.html#contact", // Contact only lives on index.html
            mainContent: sectionHtml[s.key],
            year,
        });
        fs.writeFileSync(path.join(DIST_DIR, s.file), subHtml, "utf8");
        generatedFiles.push(s.file);
    }

    fs.copyFileSync(path.join(TEMPLATE_DIR, "style.css"), path.join(DIST_DIR, "style.css"));
    await copyAndOptimizeImages(clubDir);

    console.log(`✓ [${slug}] built → dist/{${generatedFiles.join(", ")}}`);
    return true;
}

// ---------- Main ----------
(async function main() {
    const { club } = parseArgs(process.argv);

    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
    const validate = ajv.compile(schema);

    console.log(`Building club: ${club}`);
    const ok = await buildClub(club, validate);

    process.exitCode = ok ? 0 : 1; // never crash — non-zero just signals "skipped"
})();