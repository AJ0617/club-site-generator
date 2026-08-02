#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const sharp = require("sharp");
const { resolveSlug } = require("./scripts/club-target");

// ---------- Paths & constants ----------
const ROOT = __dirname;
const CLUBS_DIR = path.join(ROOT, "clubs");
const TEMPLATE_DIR = path.join(ROOT, "template");
const SECTIONS_DIR = path.join(TEMPLATE_DIR, "sections");
const DIST_DIR = path.join(ROOT, "dist");
const SCHEMA_PATH = path.join(ROOT, "club.schema.json");
const BUILD_MARKER_PATH = path.join(ROOT, ".club-build-slug");

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 80;
const RASTER_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".tiff", ".gif"];

// Configurable split thresholds — a section becomes its own page when
// item count > threshold. Officers is intentionally NOT here: it always
// renders inline on index.html no matter how many officers there are.
const SPLIT_THRESHOLDS = { events: 5, awards: 5, gallery: 8 };

// ---------- CLI args: --club=<slug> (falls back to CLUB_SLUG env var, then example-club) ----------
function parseArgs(argv) {
    const args = argv.slice(2);
    let explicitClub = null;
    const unrecognized = [];
    for (const arg of args) {
        const m = arg.match(/^--club=(.+)$/);
        if (m) {
            explicitClub = m[1];
        } else if (arg.startsWith("--")) {
            unrecognized.push(arg);
        }
    }

    // Resolved up front, after the whole argv has been scanned, so the
    // warning below always reflects the club that will actually be built —
    // not a stale value from before a later --club= flag was seen.
    const club = resolveSlug(explicitClub);
    for (const arg of unrecognized) {
        console.warn(`⚠ Unrecognized flag "${arg}" — did you mean --club=<slug>? Ignoring it; building "${club}".`);
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
const WEEKDAYS_ABBR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function formatDate(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    if (!y || !m || !d || m < 1 || m > 12) return escapeHtml(iso);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Local (not UTC-parsed) date parts — same day-shift caution formatDate takes.
function dateParts(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return { y, m, d };
}

function weekdayAbbrev(iso) {
    const { y, m, d } = dateParts(iso);
    if (!y || !m || !d) return "";
    return WEEKDAYS_ABBR[new Date(y, m - 1, d).getDay()];
}

// Groups events into consecutive month buckets (assumes events are/will be
// sorted ascending by date first). Label includes the year — a bare month
// name would be ambiguous for a club whose events span a school year.
function groupEventsByMonth(events) {
    const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
    const groups = [];
    let current = null;
    for (const e of sorted) {
        const { y, m } = dateParts(e.date);
        const key = `${y}-${m}`;
        if (!current || current.key !== key) {
            current = { key, label: `${MONTHS[m - 1].toUpperCase()} ${y}`, events: [] };
            groups.push(current);
        }
        current.events.push(e);
    }
    return groups;
}

function initials(name) {
    return String(name).trim().split(/\s+/).map(w => w[0] || "").join("").slice(0, 2).toUpperCase();
}

function renderAvatarHtml(name, photo, cssClass) {
    return photo
        ? `<img class="${cssClass}" src="${resolveImageSrc(photo)}" alt="" loading="lazy">`
        : `<div class="${cssClass}" aria-hidden="true">${escapeHtml(initials(name))}</div>`;
}

// Reconciles legacy bare-filename values already in club.json ("ava.jpg")
// with path-prefixed values Pages CMS writes ("images/ava.jpg") — every
// club's Pages CMS media source is configured with output: images, so new
// uploads always land on the "already contains /" branch.
function resolveImageSrc(value) {
    const withPrefix = String(value).includes("/") ? value : `images/${value}`;
    return withPrefix.split("/").map(encodeURIComponent).join("/");
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
    const itemsHtml = officers.map(o => {
        const avatar = renderAvatarHtml(o.name, o.photo, "officer-avatar");
        return `
        <li class="officer-card">
          ${avatar}
          <span class="officer-name">${escapeHtml(o.name)}</span>
          <span class="officer-role">${escapeHtml(o.role)}</span>
        </li>`;
    }).join("");
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
          <div class="award-text">
            <p class="award-title">${escapeHtml(a.title)}</p>
            ${a.description ? `<p class="award-desc">${escapeHtml(a.description)}</p>` : ""}
          </div>
        </li>`).join("");
    return fillTokens(loadPartial("awards"), { itemsHtml });
}

function renderGallery(images, clubName) {
    if (!images || images.length === 0) return "";
    const itemsHtml = images.map(file => `
        <figure class="gallery-item">
          <img src="${resolveImageSrc(file)}" alt="${escapeHtml(clubName)} photo" loading="lazy">
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

// ---------- App-shell renderers (siteMode "multipage" / "dynamic") ----------
// Single-page design: all 5 tabs render into one index.html and are switched
// client-side (see app-shell.html's inline <script>) — there are no sub-pages.

function renderQuickLinks(links) {
    if (!links || links.length === 0) return "";
    const itemsHtml = links.map(l => {
        const icon = l.icon
            ? `<img class="quick-link-icon" src="${resolveImageSrc(l.icon)}" alt="" loading="lazy">`
            : `<svg class="quick-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>`;
        return `
        <a class="quick-link-card" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">
          ${icon}
          <span class="quick-link-label">${escapeHtml(l.label)}</span>
        </a>`;
    }).join("");
    return `
    <div class="quick-links-section">
      <h2 class="tab-heading">Quick Links</h2>
      <div class="quick-links-grid">${itemsHtml}</div>
    </div>`;
}

function renderHeroSection(club) {
    const clubNameEsc = escapeHtml(club.clubName);
    const tagline = escapeHtml(club.tagline || club.clubName);
    const meeting = club.meetingTime
        ? `<p class="home-hero-meta">${escapeHtml(club.meetingTime)}</p>`
        : "";
    // heroImage is a CSS background, not an <img> — a missing/not-yet-uploaded
    // file just degrades to the gradient fallback instead of a broken-image icon.
    const bgStyle = club.heroImage
        ? ` style="background-image:url('${resolveImageSrc(club.heroImage)}')"`
        : "";
    return `
    <section class="home-hero"${bgStyle}>
      <div class="home-hero-wash"></div>
      <div class="home-hero-brand">${clubNameEsc}</div>
      <div class="home-hero-content">
        <div class="home-hero-eyebrow">${clubNameEsc}</div>
        <h1 class="home-hero-title">${tagline}</h1>
        ${meeting}
        <a class="btn btn-primary" href="#more" data-tab-target="more">Join Us</a>
      </div>
    </section>`;
}

function renderAboutRow(club) {
    if (!club.description && !club.advisorName) return "";
    const about = club.description
        ? `<h2 class="tab-heading">About</h2><p class="about-text">${escapeHtml(club.description)}</p>`
        : "";
    const advisor = club.advisorName
        ? `
        <div class="advisor-card">
          <div class="advisor-icon" aria-hidden="true"></div>
          <p class="advisor-text"><strong>Advisor:</strong> ${escapeHtml(club.advisorName)}</p>
        </div>`
        : "";
    return `
    <div class="about-row">
      <div class="about-col">${about}</div>
      ${advisor}
    </div>`;
}

function pickNextUpEvent(events, now) {
    if (!events || events.length === 0) return null;
    const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
    const today = now.toISOString().slice(0, 10);
    // Prefer the next upcoming event; fall back to the most recent past one
    // so the teaser is never simply missing.
    return sorted.find(e => e.date >= today) || sorted[sorted.length - 1];
}

function renderNextUpTeaser(events, now = new Date()) {
    const e = pickNextUpEvent(events, now);
    if (!e) return "";
    const { d } = dateParts(e.date);
    return `
    <div class="teaser-card teaser-primary">
      <div class="teaser-eyebrow">Next Up</div>
      <div class="event-day-col">
        <span class="event-day-num">${d}</span>
        <span class="event-day-wd">${weekdayAbbrev(e.date)}</span>
      </div>
      <div class="teaser-title">${escapeHtml(e.title)}</div>
      ${e.description ? `<p class="teaser-desc">${escapeHtml(e.description)}</p>` : ""}
    </div>`;
}

function renderMembersPreview(officers) {
    if (!officers || officers.length === 0) return "";
    const preview = officers.slice(0, 3).map(o => `
        <div class="mini-avatar-item">
          ${renderAvatarHtml(o.name, o.photo, "mini-avatar")}
          <div class="mini-avatar-name">${escapeHtml(o.name)}</div>
        </div>`).join("");
    return `
    <div class="teaser-card">
      <div class="teaser-head"><span class="teaser-card-title">Members</span><button type="button" class="see-all" data-tab-target="members">See all &rarr;</button></div>
      <div class="mini-avatar-row">${preview}</div>
    </div>`;
}

function renderAwardsPreview(awards) {
    if (!awards || awards.length === 0) return "";
    const pinned = awards.filter(a => a.featured === true);
    const top = pinned.length > 0
        ? [...pinned].sort((a, b) => b.year - a.year)
        : [...awards].sort((a, b) => b.year - a.year).slice(0, 2);
    const rows = top.map(a => `
      <div class="award-preview-row">
        <span class="award-year">${escapeHtml(a.year)}</span>
        <span class="award-preview-title">${escapeHtml(a.title)}</span>
      </div>`).join("");
    return `
    <div class="teaser-card">
      <div class="teaser-head"><span class="teaser-card-title">Awards</span><button type="button" class="see-all" data-tab-target="members">See all &rarr;</button></div>
      ${rows}
    </div>`;
}

function renderGalleryPreview(images, clubName) {
    if (!images || images.length === 0) return "";
    const itemsHtml = images.slice(0, 4).map(file => `
        <div class="gallery-preview-item">
          <img src="${resolveImageSrc(file)}" alt="${escapeHtml(clubName)} photo" loading="lazy">
        </div>`).join("");
    return `
    <div class="preview-section">
      <div class="teaser-head"><h2 class="tab-heading" style="margin:0">Gallery</h2><button type="button" class="see-all" data-tab-target="gallery">See all &rarr;</button></div>
      <div class="gallery-preview-grid">${itemsHtml}</div>
    </div>`;
}

function renderHomeTabContent(club, variant) {
    const parts = [renderHeroSection(club), renderAboutRow(club)];
    if (variant === "teasers") {
        const teasers = [renderNextUpTeaser(club.events), renderMembersPreview(club.officers), renderAwardsPreview(club.awards)]
            .filter(Boolean);
        if (teasers.length > 0) parts.push(`<div class="teaser-row">${teasers.join("")}</div>`);
        parts.push(renderGalleryPreview(club.images, club.clubName));
    }
    parts.push(renderQuickLinks(club.links));
    return parts.filter(Boolean).join("\n");
}

function renderEventsTabContent(events) {
    if (!events || events.length === 0) {
        return `<h2 class="tab-heading">Events</h2><p class="empty-note">No events scheduled yet — check back soon.</p>`;
    }
    const groups = groupEventsByMonth(events).map(grp => {
        const cards = grp.events.map(e => {
            const { d } = dateParts(e.date);
            return `
        <div class="event-card2">
          <div class="event-day-col">
            <span class="event-day-num">${d}</span>
            <span class="event-day-wd">${weekdayAbbrev(e.date)}</span>
          </div>
          <div class="event-info">
            <h3 class="event-card2-title">${escapeHtml(e.title)}</h3>
            ${e.description ? `<p class="event-card2-desc">${escapeHtml(e.description)}</p>` : ""}
          </div>
        </div>`;
        }).join("");
        return `
      <div class="event-month-group">
        <div class="event-month-label">${escapeHtml(grp.label)}</div>
        <div class="event-grid">${cards}</div>
      </div>`;
    }).join("");
    return `<h2 class="tab-heading">Events</h2>${groups}`;
}

function renderMembersTabContent(club) {
    const officers = club.officers || [];
    const grid = officers.length === 0 ? "" : `
    <div class="members-grid">
      ${officers.map(o => `
        <div class="member-card">
          ${renderAvatarHtml(o.name, o.photo, "member-avatar")}
          <div class="member-name">${escapeHtml(o.name)}</div>
          <div class="member-role">${escapeHtml(o.role)}</div>
        </div>`).join("")}
    </div>`;
    return `<h2 class="tab-heading">Members</h2>${grid}${renderAwards(club.awards)}`;
}

function renderMoreTabContent(club) {
    const rows = [];
    if (club.advisorName) rows.push(`<p class="more-row"><strong>Advisor:</strong> <span>${escapeHtml(club.advisorName)}</span></p>`);
    if (club.meetingTime) rows.push(`<p class="more-row"><strong>Meets:</strong> <span>${escapeHtml(club.meetingTime)}</span></p>`);
    const lead = club.moreText || `Interested in joining ${club.clubName}? Come to a meeting or reach out below.`;
    return `
    <h2 class="tab-heading">More</h2>
    <div class="more-card">
      <p class="more-lead">${escapeHtml(lead)}</p>
      ${rows.join("\n      ")}
      <span class="btn btn-primary more-join-btn">Join Us</span>
    </div>
    ${renderQuickLinks(club.links)}`;
}

// ---------- Theme → CSS pipeline (app-shell path only) ----------
const THEME_CSS_VAR_MAP = {
    primaryColor:    "--primary",
    accentColor:     "--accent",
    accentTextColor: "--accent-text",
    backgroundColor: "--bg",
    surfaceColor:    "--surface",
    textColor:       "--text",
    mutedTextColor:  "--muted",
    borderColor:     "--border",
};

// Hex colors are already guaranteed valid by the schema's pattern check
// (enforced in buildClub()'s validate(club) call before rendering runs),
// but font names are free text — strip anything that could break out of
// a <style> block or a Google Fonts URL.
function sanitizeFontName(value) {
    return String(value).replace(/[^A-Za-z0-9 \-]/g, "");
}

function renderThemeOverrideStyle(theme) {
    if (!theme) return "";
    const declarations = [];
    for (const [field, cssVar] of Object.entries(THEME_CSS_VAR_MAP)) {
        if (theme[field]) declarations.push(`${cssVar}: ${theme[field]};`);
    }
    if (theme.headingFont) {
        declarations.push(`--head-font: "${sanitizeFontName(theme.headingFont)}", Georgia, "Times New Roman", serif;`);
    }
    if (theme.bodyFont) {
        declarations.push(`--body-font: "${sanitizeFontName(theme.bodyFont)}", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;`);
    }
    if (declarations.length === 0) return "";
    return `<style>:root{${declarations.join(" ")}}</style>`;
}

function buildFontLinkHref(theme) {
    const heading = sanitizeFontName(theme && theme.headingFont ? theme.headingFont : "Newsreader").trim().replace(/ /g, "+");
    const body = theme && theme.bodyFont ? sanitizeFontName(theme.bodyFont).trim().replace(/ /g, "+") : "";
    const families = [`family=${heading}:wght@400;500;600;700`];
    if (body && body !== heading) families.push(`family=${body}:wght@400;500;600;700`);
    return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`;
}

function renderAppShellPage(club, variant) {
    const template = fs.readFileSync(path.join(TEMPLATE_DIR, "app-shell.html"), "utf8");
    const clubNameEsc = escapeHtml(club.clubName);
    return fillTokens(template, {
        pageTitle: clubNameEsc,
        clubName: clubNameEsc,
        metaDescription: escapeHtml((club.description || club.clubName).slice(0, 155)),
        homeTabContent: renderHomeTabContent(club, variant),
        eventsTabContent: renderEventsTabContent(club.events),
        membersTabContent: renderMembersTabContent(club),
        galleryTabContent: renderGallery(club.images, club.clubName) ||
            `<h2 class="tab-heading">Gallery</h2><p class="empty-note">No photos yet — check back soon.</p>`,
        moreTabContent: renderMoreTabContent(club),
        year: String(new Date().getFullYear()),
        fontLinkHref: buildFontLinkHref(club.theme),
        themeOverrideStyle: renderThemeOverrideStyle(club.theme),
    });
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

    const mode = club.siteMode || "dynamic";

    // Wipe dist/ before writing — otherwise stale sub-pages from a
    // previous build (e.g. a prior siteMode/threshold that split a
    // section this one doesn't) would keep sitting there, still fully
    // reachable, even after index.html stops linking to them.
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.mkdirSync(DIST_DIR, { recursive: true });

    let generatedFiles;

    if (mode === "single") {
        // ---- Classic top-nav, one-long-scrolling-page design. Untouched. ----
        const splits = decideSplits(club);
        const navModel = buildNavModel(club, splits);
        const sectionHtml = buildSectionHtml(club);
        const clubNameEsc = escapeHtml(club.clubName);
        const year = String(new Date().getFullYear());

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
        generatedFiles = ["index.html"];
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
    } else {
        // ---- App-shell design: sidebar + client-side tabs, one page only.
        // "multipage" = no Home teasers, "dynamic" = Home teasers. ----
        const variant = mode === "multipage" ? "no-teasers" : "teasers";
        fs.writeFileSync(path.join(DIST_DIR, "index.html"), renderAppShellPage(club, variant), "utf8");
        fs.copyFileSync(path.join(TEMPLATE_DIR, "app-shell.css"), path.join(DIST_DIR, "app-shell.css"));
        generatedFiles = ["index.html"];
    }

    await copyAndOptimizeImages(clubDir);

    // Records which club this build actually produced, so scripts/deploy.js
    // (run as a separate command, possibly with its own --club= typed by
    // hand in the Cloudflare dashboard) can refuse to publish if it's ever
    // given a different slug than what was just built. Deliberately NOT
    // inside dist/ — that directory is uploaded wholesale as public static
    // assets, and this marker has no business being a fetchable file on
    // the live site.
    fs.writeFileSync(BUILD_MARKER_PATH, slug, "utf8");

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