
let fileHandle = null;
let bodyFontSize = 17;
let editorWidth = 1080;
// UI-14: at ≤1180px the panel is a drawer and the Formatting section moves under the top bar.
const MOBILE_LAYOUT = window.matchMedia('(max-width: 1180px)');
let savedRange = null;
let lastSelectionRange = null; // last caret/selection inside the editor (used by side-panel controls)
let filePrefix = null; // Store the 6-digit prefix from first save
// Write-Assist feature disabled: no model IDs or API credentials in this build.
let isLoading = false; // True while importing a file (prevents auto-rewriting it to disk)

// --- DOCUMENT LIBRARY (Recents) ---
// The live document keeps using the original *_v13 keys, unchanged. In addition, every
// document gets its own snapshot so it can be reopened from the Recents list later.
const FILES_INDEX_KEY = 'quorly_files_v1';
const CURRENT_ID_KEY = 'quorly_current_id_v1';
// Reading typeface, same value set as the Theme menu (see changeTypography).
const READING_FONT_KEY = 'quorly_typeface_v1';
const MAX_RECENTS = 10;
// Version history is capped per document.
const MAX_VERSIONS = 20;
const RESTORE_WINDOW_MS = 48 * 60 * 60 * 1000; // reopen the last document only if touched within 48 h
let currentId = null;
// File handles cannot be stored in localStorage, so disk links live for this session only.
const sessionHandles = new Map();

// Default document shown on first load and when starting a new file.
const DEFAULT_TITLE = "Welcome to Quorly";
const DEFAULT_BODY = "<h2>Overview</h2><p>Quorly is a quiet, local-first writing space. Select any text to format it, or use the panel on the right.</p><blockquote>Everything stays on your device.</blockquote><p>Start writing..</p>";

// --- SAFETY & UTILITIES ---

// File System Access API feature detection (Chromium only; Firefox/Safari lack these)
const FSA_SUPPORTED = typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';

// Escape text for safe interpolation into HTML
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Sanitize untrusted HTML before it ever reaches innerHTML
const PURIFY_CONFIG = {
    ADD_ATTR: ['contenteditable', 'data-highlighted', 'target'],
    ADD_DATA_URI_TAGS: ['img'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta'],
    FORBID_ATTR: ['srcdoc']
};
function sanitizeHTML(html) {
    if (window.DOMPurify) {
        return DOMPurify.sanitize(html, PURIFY_CONFIG);
    }
    // Fallback if the sanitizer failed to load: strip scripts and event handlers.
    const t = document.createElement('div');
    t.innerHTML = String(html);
    t.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach(n => n.remove());
    t.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(a => {
            const n = a.name.toLowerCase();
            if (n.startsWith('on') || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(a.value))) {
                el.removeAttribute(a.name);
            }
        });
    });
    return t.innerHTML;
}

// Transient on-screen notice (replaces silent failures)
let toastTimer = null;
function toast(message, ms) {
    let el = document.getElementById('appToast');
    if (!el) { el = document.createElement('div'); el.id = 'appToast'; document.body.appendChild(el); }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 4000);
}

// localStorage write that can't crash the app when the quota is exceeded
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        if (err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)) {
            track('storage_quota_exceeded');
            toast('Storage full — this document (or its images) is too large to save locally. Try removing images or exporting to disk.');
        } else {
            console.warn('localStorage write failed', err);
        }
        return false;
    }
}

// Debounce helper for autosave
function debounce(fn, wait) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

// --- FUNNEL COUNTERS (M-1) ---
// Anonymous, cookieless, fail-open. A counter sends only an event name and, at most, one short
// coarse property — never document content, never an identifier, never a cookie. It is a
// same-origin beacon (`connect-src 'self'`), the endpoint answers 204 and never blocks, and a
// dropped beacon (offline, blocked, unbound) is simply lost. Nothing here may affect the editor.
const FUNNEL_EVENTS = new Set(['landing_cta', 'first_keystroke', 'export', 'storage_quota_exceeded', 'returning_writer', 'webmcp_tool']);
let firstKeystrokeTracked = false; // one `first_keystroke` per document that gets worked on

function track(event, props) {
    try {
        if (!navigator.sendBeacon || !FUNNEL_EVENTS.has(event)) return;
        const payload = { e: event };
        if (props && typeof props.format === 'string') payload.format = props.format.slice(0, 32);
        if (props && typeof props.tool === 'string') payload.tool = props.tool.slice(0, 32);
        navigator.sendBeacon('/e', JSON.stringify(payload));
    } catch (err) {
        // Analytics must never be able to break the editor or delay a navigation.
    }
}

// --- IMAGE INTAKE (S-2b) ---
// Every image is decoded, downscaled and re-encoded on the way in, before it reaches any store:
// one unprocessed phone photo can dominate everything the app holds, and the live document it
// lands in has a hard 5 MB budget. Longest edge is capped per use; opaque images become WebP (JPEG
// where WebP is unsupported), images with transparency stay PNG. Anything past MAX_IMAGE_BYTES is
// refused before it is decoded. Re-encoding here is also what lets identical images dedupe to a
// single content-addressed blob once the same bytes reach the library.
//
// Measured against a real 1920x863 photograph (S-2b check): downscaled to 1600x719 and encoded to
// WebP at IMAGE_QUALITY, the result is 244 KB against the 460 KB source, and against a lossless PNG
// of the same pixels it holds a 44 dB PSNR — mean per-channel error 2.5/255, nothing anywhere over
// 32, and at most 9/255 in flat sky, which is where lossy banding shows up first. There is no
// visible cost to the size it buys, so the quality is left where it is.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // refuse before decoding anything larger
const MAX_IMAGE_EDGE = 1600;              // body / inline images
const MAX_TITLE_EDGE = 1000;              // header (title) image
const IMAGE_QUALITY = 0.85;

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode failed'));
        img.src = src;
    });
}

// True if any pixel is not fully opaque. Sampled across the whole image: guessing from the MIME
// type would keep a large PNG that should have become WebP.
function hasTransparency(ctx, w, h) {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
    }
    return false;
}

// Decode, downscale so the longest edge is `maxEdge`, then re-encode. Returns a data URL, or
// null when the file was refused or is not an image (the user is told why in that case).
async function downscaleImage(file, maxEdge) {
    if (!file || file.type.indexOf('image/') !== 0) return null;
    if (file.size > MAX_IMAGE_BYTES) {
        toast('That image is larger than 10 MB. Please resize it before inserting.');
        return null;
    }

    let img;
    try {
        img = await loadImageElement(await readFileAsDataURL(file));
    } catch (err) {
        console.warn('Image could not be decoded', err);
        toast('That image could not be read. Try a different file.');
        return null;
    }

    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    if (!sw || !sh) {
        toast('That image has no readable dimensions. Try a different file.');
        return null;
    }

    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    if (hasTransparency(ctx, w, h)) return canvas.toDataURL('image/png');
    const webp = canvas.toDataURL('image/webp', IMAGE_QUALITY);
    // toDataURL silently falls back to PNG when the requested type is unsupported.
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
}

const editTitle = document.getElementById('editTitle');
const editBody = document.getElementById('editBody');
const cmdPalette = document.getElementById('commandPalette');
const toolbar = document.getElementById('toolbar');

// DD-03: say so if the library could not be opened. Falling back to localStorage keeps the editor
// working, but it is a limited mode — reads cannot see anything already in IndexedDB — and quietly
// pretending otherwise is how someone loses trust in the app.
async function announceBackend() {
    const backend = await QuorlyStore.open();
    if (backend === 'idb') return;
    toast('This browser could not open the document library. Documents still autosave, but Recents may be incomplete.', 8000);
}

async function init() {
    // Load mode preference
    if (localStorage.getItem("mode") === 'light') {
        document.body.classList.add('light-mode');
    }
    syncModeButton();

    // UI-09: reopen the last-worked document, but only if it was touched within 48 h.
    const savedId = localStorage.getItem(CURRENT_ID_KEY);
    const entry = savedId ? readIndex().find((e) => e.id === savedId) : null;
    const expired = !!entry && (Date.now() - entry.updatedAt) > RESTORE_WINDOW_MS;
    const hasLiveDoc = localStorage.getItem("doc_title_v13") !== null
        || localStorage.getItem("doc_body_v13") !== null;

    // Which document does the legacy global version history belong to? (See migration below.)
    let legacyOwnerId = null;

    if (savedId && !expired) {
        currentId = savedId;
        legacyOwnerId = savedId;
        restoreLiveDocument();
    } else if (savedId && expired) {
        // Too old: open a clean page. The previous document stays in Recents, untouched.
        // The legacy history belongs to that previous document, not to this fresh page.
        legacyOwnerId = savedId;
        // Its latest content is in the live keys (the open document's only storage), so park it
        // under its own id before startCleanDocument overwrites those keys.
        if (await writeSnapshot(savedId, snapshotFromLiveKeys())) {
            currentId = newDocId();
            safeSetItem(CURRENT_ID_KEY, currentId);
            startCleanDocument(false);
        } else {
            // Could not park it. Keep the live keys and carry on with that document, rather than
            // clear the only copy of it. It will be parked when the user switches documents.
            currentId = savedId;
            restoreLiveDocument();
        }
    } else if (hasLiveDoc) {
        // Upgrade path: adopt a document written before the library existed.
        currentId = newDocId();
        safeSetItem(CURRENT_ID_KEY, currentId);
        legacyOwnerId = currentId;
        restoreLiveDocument();
    } else {
        currentId = newDocId();
        safeSetItem(CURRENT_ID_KEY, currentId);
        startCleanDocument(false);
    }

    updateStats();
    // One-time upgrade: adopt version history written before it became per-document, then drop the
    // legacy global key — once the per-document copy exists it is dead weight (and can be
    // image-sized). The copy is written through the storage layer, so it lands in the library, and
    // the legacy key is only removed once the new copy is durable: if a write fails, the legacy key
    // is left alone, never discarded.
    if (legacyOwnerId) {
        const legacy = localStorage.getItem('doc_versions_v13');
        if (legacy) {
            try {
                const list = JSON.parse(legacy);
                const existing = await QuorlyStore.listVersions(legacyOwnerId);
                if (existing.length) {
                    localStorage.removeItem('doc_versions_v13'); // already migrated in an earlier session
                } else if (Array.isArray(list) && list.length) {
                    const tail = list.slice(-MAX_VERSIONS);
                    let ok = tail.length > 0;
                    for (const version of tail) {
                        if (!await QuorlyStore.appendVersion(legacyOwnerId, version, MAX_VERSIONS)) { ok = false; break; }
                    }
                    if (ok) localStorage.removeItem('doc_versions_v13');
                }
            } catch (err) {
                console.warn('Could not migrate legacy version history', err);
            }
        }
    }
    touchCurrentDocument(); // make sure this document has an index entry
    renderRecents();

    // DD-03: open the library and move anything still parked in localStorage into it. Not required
    // for correctness — a read adopts on its own — but it is what empties localStorage of the
    // library, and it does that in the background rather than holding up the editor.
    announceBackend();
    const indexIds = readIndex().map((entry) => entry.id);
    QuorlyStore.migrate(indexIds).then((result) => {
        if (result.adopted) {
            console.info('Quorly: moved ' + result.adopted + ' localStorage records into the library.');
        }
    }).catch((err) => console.warn('Quorly: could not move the library.', err));

    // M-1: a returning writer is simply someone whose live keys already existed on load. Coarse
    // by design — there is no identifier to be more precise with, and none is wanted.
    if (hasLiveDoc) track('returning_writer');
    setTimeout(attachTitleButton, 100);
    setTimeout(attachBodyImageDeleteButtons, 100);
    setTimeout(applyCodeHighlighting, 100);
}

async function newFile() {
    // No confirmation dialog: the current document is parked into Recents automatically, so
    // starting a new one cannot lose it. Flush the editor into the live keys, then park that
    // copy — the live keys are the open document's only storage and startCleanDocument is
    // about to overwrite them.
    saveToLocalStorage();
    if (!await parkCurrentDocument()) return; // never switch away from a document we could not keep

    currentId = newDocId();
    safeSetItem(CURRENT_ID_KEY, currentId);
    fileHandle = null;
    filePrefix = null;

    startCleanDocument(true); // blank "Untitled" page
    fileDisplayEl().textContent = "Local Storage";
    updateStats();
    touchCurrentDocument();
}

// Parse Markdown into a sanitized DOM fragment. Shared by the import path and the WebMCP
// append/replace tools so agent-written text goes through exactly the same pipeline.
function markdownToClean(markdownText) {
    if (typeof marked === 'undefined') return null;
    const html = marked.parse(markdownText);
    const temp = document.createElement('div');
    temp.innerHTML = sanitizeHTML(html); // sanitize BEFORE building interactive nodes

    // Convert MD images to interactive containers
    temp.querySelectorAll('img').forEach(img => {
        const container = document.createElement('div');
        container.className = 'img-container';
        container.contentEditable = "false";
        const newImg = img.cloneNode();
        container.appendChild(newImg);
        img.replaceWith(container);
    });

    // Clean up list items - remove wrapping paragraphs that marked.js adds
    temp.querySelectorAll('li > p').forEach(p => {
        if (p.parentElement.childNodes.length === 1) {
            const li = p.parentElement;
            while (p.firstChild) {
                li.insertBefore(p.firstChild, p);
            }
            p.remove();
        }
    });
    return temp;
}

// Load markdown file (import only)
function loadMarkdown(markdownText) {
    const temp = markdownToClean(markdownText);
    if (!temp) {
        toast('Markdown renderer failed to load. Check your connection and try again.');
        return;
    }

    const h1 = temp.querySelector('h1');
    editTitle.textContent = h1 ? h1.textContent : "Untitled Document";
    if(h1) h1.remove();
    isLoading = true;
    editBody.innerHTML = temp.innerHTML;
    applyTableWidths();
    migrateAlignment();
    firstKeystrokeTracked = false; // an imported document starts its own count
    updateStats();
    saveToLocalStorage(); // Save the imported content
    isLoading = false;
    setTimeout(attachTitleButton, 100);
    setTimeout(attachBodyImageDeleteButtons, 100);
    setTimeout(applyCodeHighlighting, 100);
}

// --- DOCUMENT LIBRARY (Recents) ---

function newDocId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// The keys for parked snapshots and version history belong to the storage layer (stories.js),
// which owns them for both backends. Nothing else in this file should name them.
function readIndex() {
    try {
        const list = JSON.parse(localStorage.getItem(FILES_INDEX_KEY) || '[]');
        return Array.isArray(list) ? list.filter((e) => e && e.id) : [];
    } catch (err) {
        console.warn('Recents index was unreadable; starting a new one.', err);
        return [];
    }
}

// Version history is per document, so opening a different document doesn't show someone else's
// snapshots. The storage layer owns both the key and the IndexedDB store behind it; the legacy
// global key `doc_versions_v13` is read once, for migration.
// Keep only the newest MAX_RECENTS entries. The document that is currently open is never evicted.
// Anything that falls off goes with its version history: the storage layer deletes both, and a
// document whose snapshot is gone would be unreachable from Recents anyway.
function trimIndex(list) {
    if (list.length <= MAX_RECENTS) return list;
    const evicted = list.slice(MAX_RECENTS).filter((entry) => entry.id !== currentId);
    if (evicted.length) {
        QuorlyStore.evict(evicted.map((entry) => entry.id)).catch((err) => {
            console.warn('Recents: could not clean up evicted documents.', err);
        });
    }
    return list.slice(0, MAX_RECENTS);
}

function countWords() {
    const text = editBody.innerText || '';
    return text.trim() ? text.trim().split(/\s+/).length : 0;
}

// Remember the disk handle for the open document (session only) so switching documents
// through Recents can never make one document overwrite another's file.
function rememberHandle() {
    if (currentId && fileHandle) {
        sessionHandles.set(currentId, { handle: fileHandle, prefix: filePrefix });
    }
}

// --- HOW A DOCUMENT IS STORED ---
// The live *_v13 keys are the open document's ONLY storage. A body snapshot under
// quorly_file_<id> is written only when we are about to switch away from a document
// (parkCurrentDocument). Writing a second copy on every autosave is what used to halve the
// usable storage, and it is why an ordinary illustrated post could fail to save at all.

// Snapshot the open document from the live keys. Reading the keys rather than the DOM also works
// before the editor has been populated (e.g. when the 48 h restore window has lapsed).
function snapshotFromLiveKeys() {
    const title = (localStorage.getItem("doc_title_v13") || '').trim() || 'Untitled';
    let titleImage = null;
    const rawImage = localStorage.getItem("doc_title_image_v13");
    if (rawImage) {
        try { titleImage = JSON.parse(rawImage); } catch (err) { titleImage = null; }
    }
    return {
        title: title,
        body: localStorage.getItem("doc_body_v13") || '',
        titleImage: titleImage
    };
}

// Write a snapshot for `id` through the storage layer. If storage is full, evict the oldest parked
// documents and retry. Resolves true only when the snapshot is actually durable.
async function writeSnapshot(id, snapshot) {
    if (await QuorlyStore.putSnapshot(id, snapshot)) return true;

    const victims = readIndex().filter((e) => e.id !== id && e.id !== currentId).slice(-3);
    for (const v of victims) {
        await QuorlyStore.evict([v.id]);
        if (await QuorlyStore.putSnapshot(id, snapshot)) return true;
    }
    return false;
}

// Park the open document before anything overwrites the live keys. Callers must NOT switch
// documents when this resolves false: at that moment the live keys hold the only copy.
async function parkCurrentDocument() {
    if (!currentId) return true;
    if (!await writeSnapshot(currentId, snapshotFromLiveKeys())) {
        toast('Storage is full — this document could not be kept in Recents. Export it to disk, then try again.');
        return false;
    }
    touchCurrentDocument();
    return true;
}

// Upsert the open document into the Recents index. Runs on every autosave and is deliberately
// cheap (a few hundred bytes) — it writes no body snapshot.
function touchCurrentDocument() {
    if (!currentId) {
        currentId = newDocId();
        safeSetItem(CURRENT_ID_KEY, currentId);
    }

    const title = (editTitle.textContent || '').trim() || 'Untitled';
    const list = readIndex().filter((e) => e.id !== currentId);
    list.unshift({
        id: currentId,
        title: title,
        updatedAt: Date.now(),
        wordCount: countWords()
    });
    safeSetItem(FILES_INDEX_KEY, JSON.stringify(trimIndex(list)));
    renderRecents();
}

function relativeTime(ts) {
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h ago';
    return Math.round(hours / 24) + ' d ago';
}

// UI-13: inline SVG for the Recents rows. Inline (rather than an icon font or an image
// request) so the strict CSP has nothing to block and light/dark is just currentColor.
const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';

// --- Recents row actions (UI-13) ---------------------------------------------------------
// The menu element lives at the end of <body> and is positioned against the viewport, so
// neither the Recents list nor the sidebar's own scroll box can clip it.
let rowMenuDocId = null;
let rowMenuAnchor = null;

function openRowMenu(anchor, id) {
    const menu = document.getElementById('rowMenu');
    if (!menu) { deleteRecent(id); return; }   // no menu in the DOM → keep the action reachable
    if (rowMenuAnchor === anchor && !menu.hidden) { closeRowMenu(); return; }
    closeRowMenu();

    rowMenuDocId = id;
    rowMenuAnchor = anchor;
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');

    // Right-aligned under the kebab; flipped above it when the viewport bottom is close.
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8));
    let top = a.bottom + 6;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, a.top - m.height - 6);
    menu.style.setProperty('left', left + 'px');
    menu.style.setProperty('top', top + 'px');

    const first = menu.querySelector('.row-menu-item');
    if (first) first.focus();
}

function closeRowMenu(refocus) {
    const menu = document.getElementById('rowMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    const anchor = rowMenuAnchor;
    if (anchor) {
        anchor.setAttribute('aria-expanded', 'false');
        // The row may have been re-rendered (e.g. by the delete that just ran).
        if (refocus && document.contains(anchor)) anchor.focus();
    }
    rowMenuAnchor = null;
    rowMenuDocId = null;
}

function renderRecents() {
    const list = document.getElementById('recentsList');
    if (!list) return;

    const searchEl = document.getElementById('recentsSearch');
    const query = (searchEl ? searchEl.value : '').trim().toLowerCase();
    const files = readIndex();
    const shown = query ? files.filter((f) => (f.title || '').toLowerCase().includes(query)) : files;

    list.textContent = '';

    if (files.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'recents-empty';
        empty.textContent = 'Documents you write are saved here automatically.';
        list.appendChild(empty);
        return;
    }
    if (shown.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'recents-empty';
        empty.textContent = 'No documents match this search.';
        list.appendChild(empty);
        return;
    }

    shown.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'recent-item' + (entry.id === currentId ? ' is-current' : '');

        // Leading document glyph — decorative, so it is hidden from assistive tech.
        const icon = document.createElement('span');
        icon.className = 'recent-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = ICON_DOC;

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'recent-open';
        open.title = entry.title;

        const name = document.createElement('span');
        name.className = 'recent-title';
        name.textContent = entry.title;

        const meta = document.createElement('span');
        meta.className = 'recent-meta';
        meta.textContent = relativeTime(entry.updatedAt) + ' · ' + (entry.wordCount || 0) + ' words';

        open.append(name, meta);
        open.addEventListener('click', () => openRecent(entry.id));

        // Row actions: the ⋮ from the UI-13 design replaces the old × delete affordance.
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'recent-menu-btn';
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        more.setAttribute('aria-label', 'Actions for ' + entry.title);
        more.title = 'More actions';
        more.innerHTML = ICON_MORE;
        more.addEventListener('click', (e) => {
            e.stopPropagation();
            openRowMenu(more, entry.id);
        });

        row.append(icon, open, more);
        list.appendChild(row);
    });
}

async function deleteRecent(id) {
    const entry = readIndex().find((e) => e.id === id);
    if (!entry) return;
    if (!confirm('Delete "' + entry.title + '" from this browser? This cannot be undone.')) return;

    // The open document's content is in the live keys, so deleting its index entry alone would
    // leave it alive; the branch below gives it a fresh id instead. Either way the parked copy
    // and the version history go.
    await QuorlyStore.deleteSnapshot(id);
    await QuorlyStore.deleteVersions(id);
    sessionHandles.delete(id);
    safeSetItem(FILES_INDEX_KEY, JSON.stringify(readIndex().filter((e) => e.id !== id)));

    if (id === currentId) {
        // The open document was deleted — move to a clean page.
        currentId = newDocId();
        safeSetItem(CURRENT_ID_KEY, currentId);
        fileHandle = null;
        filePrefix = null;
        startCleanDocument(false);
        updateStats();
        touchCurrentDocument();
    }
    renderRecents();
    toast('Deleted "' + entry.title + '"');
}

// Put the live document (the original *_v13 keys) into the editor.
function restoreLiveDocument() {
    editTitle.textContent = localStorage.getItem("doc_title_v13") || DEFAULT_TITLE;
    editBody.innerHTML = sanitizeHTML(localStorage.getItem("doc_body_v13") || DEFAULT_BODY);
    applyTableWidths();
    migrateAlignment();
    loadStoredTitleImage();
    firstKeystrokeTracked = false;
}

function loadStoredTitleImage() {
    const img = document.getElementById('titleImage');
    const container = document.getElementById('titleImageContainer');
    img.src = '';
    img.style.width = '';
    container.classList.remove('has-image');

    const saved = localStorage.getItem("doc_title_image_v13");
    if (!saved) return;
    try {
        const imageData = JSON.parse(saved);
        img.src = imageData.src;
        img.style.width = imageData.width;
        container.classList.add('has-image');
    } catch (e) {
        console.error('Failed to load title image', e);
    }
}

// A clean page (first run, "New", or after the 48 h restore window lapses).
function startCleanDocument(blank) {
    editTitle.textContent = blank ? "Untitled" : DEFAULT_TITLE;
    editBody.innerHTML = blank ? "" : sanitizeHTML(DEFAULT_BODY);

    const img = document.getElementById('titleImage');
    const container = document.getElementById('titleImageContainer');
    img.src = '';
    img.style.width = '';
    container.classList.remove('has-image');

    // Overwrite the live keys so a reload cannot resurrect the previous document.
    safeSetItem("doc_title_v13", editTitle.textContent);
    safeSetItem("doc_body_v13", bodyHTML());
    localStorage.removeItem("doc_title_image_v13");
    firstKeystrokeTracked = false;
}

async function openRecent(id) {
    if (id === currentId) {
        toast('That document is already open.');
        return;
    }
    // Flush the editor into the live keys, then park that copy before switching: the live keys
    // are the open document's only storage.
    saveToLocalStorage();
    if (!await parkCurrentDocument()) return;

    // Read-through: a document parked before the library moved is in localStorage, and the
    // storage layer adopts it on the way past.
    const snapshot = await QuorlyStore.getSnapshot(id);
    if (!snapshot) {
        toast('That document is no longer stored in this browser.');
        renderRecents();
        return;
    }

    currentId = id;

    // Restore this document's disk link if it was saved earlier in this session.
    const linked = sessionHandles.get(id);
    fileHandle = linked ? linked.handle : null;
    filePrefix = linked ? linked.prefix : null;

    isLoading = true;
    editTitle.textContent = snapshot.title || 'Untitled';
    editBody.innerHTML = sanitizeHTML(snapshot.body || '');
    applyTableWidths();
    migrateAlignment();
    if (snapshot.titleImage) {
        // Set the width before setTitleImage so the write it triggers records the real width.
        document.getElementById('titleImage').style.width = snapshot.titleImage.width || '700px';
        setTitleImage(snapshot.titleImage.src);
    } else {
        deleteTitleImage();
    }
    isLoading = false;
    firstKeystrokeTracked = false; // a freshly opened document starts its own count

    // Point the stored id at the document only now that its content is in the live keys, so an
    // interrupted switch cannot leave the id pointing at a different document's content.
    safeSetItem(CURRENT_ID_KEY, id);

    fileDisplayEl().textContent = linked ? linked.handle.name : 'Local Storage';
    updateStats();
    touchCurrentDocument(); // opening a document counts as working on it
    setTimeout(attachTitleButton, 100);
    setTimeout(attachBodyImageDeleteButtons, 100);
    setTimeout(applyCodeHighlighting, 100);
    toast('Opened "' + (snapshot.title || 'Untitled') + '"');
}

// --- FILE SYSTEM ---

function generateFileName() {
    // Reuse existing prefix if we have one, otherwise generate new
    if (!filePrefix) {
        filePrefix = Math.floor(100000 + Math.random() * 900000).toString();
    }
    
    const slug = editTitle.textContent.toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 50);
    return `${filePrefix}-${slug || 'document'}.html`;
}

async function syncNow() {
    if (!FSA_SUPPORTED) {
        toast('Saving to disk requires a Chromium-based browser (Chrome, Edge, Brave, Opera). Your work is still saved in this browser.');
        return;
    }
    if (!fileHandle || !fileHandle.name.endsWith('.html')) {
        // First time save - create new file
        const suggestedName = generateFileName();
        try {
            fileHandle = await window.showSaveFilePicker({
                suggestedName: suggestedName,
                types: [{ description: 'HTML Document', accept: {'text/html': ['.html']} }]
            });
            
            // Extract and store the prefix from the chosen filename
            const match = fileHandle.name.match(/^(\d{6})-/);
            if (match) {
                filePrefix = match[1];
            }
            rememberHandle();

            fileDisplayEl().textContent = fileHandle.name;
            await saveToDisk();
            const display = fileDisplayEl();
            display.textContent = "Saved ✓";
            setTimeout(() => display.textContent = fileHandle.name, 1500);
        } catch (err) {
            if (err && err.name !== 'AbortError') {
                toast('Could not save file: ' + (err.message || err.name));
            }
            return;
        }
    } else {
        // Existing file - check if title changed and update filename
        const currentName = fileHandle.name;
        const newName = generateFileName();
        
        if (currentName !== newName) {
            // Title changed - save to new filename
            try {
                const newHandle = await window.showSaveFilePicker({
                    suggestedName: newName,
                    types: [{ description: 'HTML Document', accept: {'text/html': ['.html']} }]
                });
                fileHandle = newHandle;
                rememberHandle();
                fileDisplayEl().textContent = fileHandle.name;
            } catch (err) {
                // User cancelled, keep using old file
                return;
            }
        }
        
        await saveToDisk();

        const display = fileDisplayEl();
        const originalName = fileHandle.name;
        display.textContent = "Saved ✓";
        setTimeout(() => display.textContent = originalName, 1500);
    }
}

async function exportMarkdown() {
    if (!FSA_SUPPORTED) {
        toast('Exporting files requires a Chromium-based browser (Chrome, Edge, Brave, Opera).');
        return;
    }
    const slug = editTitle.textContent.toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 50);
    
    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: `${slug || 'document'}.md`,
            types: [{ description: 'Markdown', accept: {'text/markdown': ['.md']} }]
        });
        
        const writable = await handle.createWritable();
        const markdown = convertToMarkdown();
        await writable.write(markdown);
        await writable.close();
        
        // Brief feedback
        const display = fileDisplayEl();
        const originalName = fileHandle ? fileHandle.name : 'Local Storage';
        display.textContent = "Exported ✓";
        setTimeout(() => display.textContent = originalName, 1500);
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            toast('Export failed: ' + (err.message || err.name));
        }
    }
}

async function exportQuorly() {
    if (!FSA_SUPPORTED) {
        toast('Exporting files requires a Chromium-based browser (Chrome, Edge, Brave, Opera).');
        return;
    }
    const slug = editTitle.textContent.toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 50);
    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: `${slug || 'document'}.quorly`,
            types: [{ description: 'Quorly document', accept: { 'application/json': ['.quorly'] } }]
        });
        const writable = await handle.createWritable();
        const titleImageData = getTitleImageData();
        const payload = JSON.stringify({
            version: 1,
            title: editTitle.textContent,
            body: bodyHTML(),
            titleImage: titleImageData
        }, null, 2);
        await writable.write(payload);
        await writable.close();
        const display = fileDisplayEl();
        const originalName = fileHandle ? fileHandle.name : 'Local Storage';
        display.textContent = "Exported ✓";
        setTimeout(() => display.textContent = originalName, 1500);
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            toast('Export failed: ' + (err.message || err.name));
        }
    }
}

// Plain-text download (same File System Access path as the .MD export).
async function exportText() {
    if (!FSA_SUPPORTED) {
        toast('Exporting files requires a Chromium-based browser (Chrome, Edge, Brave, Opera).');
        return;
    }
    const slug = editTitle.textContent.toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .substring(0, 50);

    try {
        const handle = await window.showSaveFilePicker({
            suggestedName: `${slug || 'document'}.txt`,
            types: [{ description: 'Plain text', accept: { 'text/plain': ['.txt'] } }]
        });
        const writable = await handle.createWritable();
        const text = (editTitle.textContent ? editTitle.textContent + '\n\n' : '') + (editBody.innerText || '');
        await writable.write(text);
        await writable.close();

        const display = fileDisplayEl();
        const originalName = fileHandle ? fileHandle.name : 'Local Storage';
        display.textContent = "Exported ✓";
        setTimeout(() => display.textContent = originalName, 1500);
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            toast('Export failed: ' + (err.message || err.name));
        }
    }
}

async function openFile() {
    if (!FSA_SUPPORTED) {
        toast('Opening files requires a Chromium-based browser (Chrome, Edge, Brave, Opera).');
        return;
    }
    try {
        const [handle] = await window.showOpenFilePicker({
            types: [
                { description: 'Documents', accept: {'text/html': ['.html'], 'text/markdown': ['.md'], 'application/json': ['.quorly']} }
            ]
        });
        
        const file = await handle.getFile();
        const content = await file.text();
        
        // Detect file type and load accordingly
        if (handle.name.endsWith('.md')) {
            loadMarkdown(content);
            fileHandle = null;
            filePrefix = null;
            fileDisplayEl().textContent = 'Imported from .md';
        } else if (handle.name.endsWith('.quorly')) {
            loadQuorly(content);
            fileHandle = handle;
            const match = handle.name.match(/^(\d{6})-/);
            if (match) filePrefix = match[1];
            rememberHandle();
            fileDisplayEl().textContent = fileHandle.name;
        } else {
            // Ask for write access up-front (needed later to save back to this file).
            // Must happen while we still have the user's click as activation.
            try {
                if (handle.requestPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                    await handle.requestPermission({ mode: 'readwrite' });
                }
            } catch (permErr) {
                console.warn('Write permission not granted; saving back to this file may fail.', permErr);
            }

            // Load HTML and extract prefix from filename
            fileHandle = handle;
            const match = handle.name.match(/^(\d{6})-/);
            if (match) {
                filePrefix = match[1];
            }
            rememberHandle();
            loadHTML(content);
            fileDisplayEl().textContent = fileHandle.name;
        }
    } catch (err) {
        if (err && err.name !== 'AbortError') {
            toast('Could not open file: ' + (err.message || err.name));
        }
    }
}

function loadQuorly(rawContent) {
    try {
        isLoading = true;
        const snapshot = JSON.parse(rawContent);
        editTitle.textContent = snapshot.title || 'Untitled';
        editBody.innerHTML = sanitizeHTML(snapshot.body || '');
        applyTableWidths();
        migrateAlignment();
        if (snapshot.titleImage && snapshot.titleImage.src) {
            const img = document.getElementById('titleImage');
            const container = document.getElementById('titleImageContainer');
            img.src = snapshot.titleImage.src;
            img.style.width = snapshot.titleImage.width || '700px';
            container.classList.add('has-image');
        } else {
            deleteTitleImage();
        }
        updateStats();
        saveToLocalStorage();
        isLoading = false;
        setTimeout(attachTitleButton, 100);
        setTimeout(attachBodyImageDeleteButtons, 100);
        setTimeout(applyCodeHighlighting, 100);
        toast('Imported .quorly document');
    } catch (err) {
        console.error('Failed to load .quorly file', err);
        toast('Failed to import .quorly file: invalid format');
    }
}

function loadHTML(htmlContent) {
    const temp = document.createElement('div');
    temp.innerHTML = sanitizeHTML(htmlContent); // strip scripts/handlers from untrusted files
    
    // Extract title from h1 or title tag
    let title = "Untitled Document";
    const h1 = temp.querySelector('h1');
    if (h1) {
        title = h1.textContent;
        h1.remove();
    } else {
        const titleTag = htmlContent.match(/<title>(.*?)<\/title>/i);
        if (titleTag) title = titleTag[1];
    }
    
    editTitle.textContent = title;
    isLoading = true;
    editBody.innerHTML = temp.innerHTML;
    applyTableWidths();
    migrateAlignment();
    updateStats();
    saveToLocalStorage();
    isLoading = false;
    setTimeout(attachTitleButton, 100);
    setTimeout(attachBodyImageDeleteButtons, 100);
    setTimeout(applyCodeHighlighting, 100);
}

async function saveToDisk() {
    if (!fileHandle) return false;
    try {
        const writable = await fileHandle.createWritable();
        const htmlContent = generateHTMLFile();
        await writable.write(htmlContent);
        await writable.close();
        return true;
    } catch (err) {
        console.error("Save failed", err);
        return false;
    }
}


// --- SELECTION TOOLBAR ---

document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    // Remember the caret/selection inside the editor so panel controls (heading dropdown,
    // sidebar buttons) can still act on it after focus moves to the sidebar.
    if (selection.rangeCount && selection.anchorNode && editBody.contains(selection.anchorNode)) {
        lastSelectionRange = selection.getRangeAt(0).cloneRange();
    }
    if (selection.toString().length > 0 && !selection.isCollapsed && editBody.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        toolbar.style.display = 'flex';
        // Keep the floating toolbar inside the viewport (it used to run off-screen near the edges)
        const tbWidth = toolbar.offsetWidth;
        const viewportLeft = window.scrollX;
        const viewportRight = window.scrollX + document.documentElement.clientWidth;
        let left = rect.left + window.scrollX + (rect.width / 2) - (tbWidth / 2);
        left = Math.max(viewportLeft + 8, Math.min(left, viewportRight - tbWidth - 8));
        let top = rect.top + window.scrollY - toolbar.offsetHeight - 10;
        top = Math.max(window.scrollY + 8, top);
        toolbar.style.top = `${top}px`;
        toolbar.style.left = `${left}px`;
    } else {
        setTimeout(() => { 
            if (window.getSelection().toString().length === 0) toolbar.style.display = 'none'; 
        }, 150);
    }
});

// --- COMMAND PALETTE (@) ---

editBody.addEventListener('keyup', (e) => {
    const sel = window.getSelection();
    if (e.key === '@') {
        if (sel.rangeCount > 0) {
            savedRange = sel.getRangeAt(0).cloneRange();
            const rect = savedRange.getBoundingClientRect();
            cmdPalette.style.display = 'flex';
            cmdPalette.style.top = `${rect.bottom + window.scrollY}px`;
            cmdPalette.style.left = `${rect.left + window.scrollX}px`;
        }
    } else if (e.key === 'Escape' || e.key === ' ') {
        cmdPalette.style.display = 'none';
    } else if (e.key === 'Backspace') {
        // Check if @ was just deleted - hide palette
        if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const text = range.startContainer.textContent || '';
            const cursorPos = range.startOffset;
            // Check if there's no @ before cursor
            const textBeforeCursor = text.substring(0, cursorPos);
            if (!textBeforeCursor.includes('@') || textBeforeCursor.lastIndexOf('@') < cursorPos - 10) {
                cmdPalette.style.display = 'none';
            }
        }
    }
});

function triggerCmd(type) {
    cmdPalette.style.display = 'none';
    if (!savedRange) return;

    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);

    // Remove '@'
    document.execCommand('delete', false, null);

    if (type === 'image') {
        insertImageSlot();
    } else if (type === 'rule') {
        insertDivider();
    }
}

// Insert an inline image dropzone at the caret
// Focusing the editor or inserting at the caret makes browsers scroll the caret into view,
// which yanks the page to the top. Capture and restore every scroll owner around the insert.
function preserveScroll(fn) {
    const x = window.scrollX;
    const y = window.scrollY;
    const se = document.scrollingElement;
    const seTop = se ? se.scrollTop : 0;
    const scrollers = [];
    [editBody, document.querySelector('.reader'), document.querySelector('.app')].forEach(el => {
        if (el && el.scrollHeight > el.clientHeight + 1) scrollers.push([el, el.scrollTop]);
    });
    const restore = () => {
        scrollers.forEach(([el, top]) => { el.scrollTop = top; });
        if (se) se.scrollTop = seTop;
        window.scrollTo(x, y);
    };
    try {
        fn();
    } finally {
        restore();
        requestAnimationFrame(restore);
    }
}

// --- PASTE CLEAN (N-7) ---
// Nothing pasted into the editor is inserted the way it came off the clipboard. The browser's own
// paste drops the source app's markup straight into the document, which is why Google Docs arrives as
// <b id="docs-internal-guid-…"> + <span style> + a <style> block (and renders bold end to end), and
// why an X/Twitter thread — one <div> per line — collapses into a single run once those divs are
// folded away. normalizePastedHTML() rebuilds the payload from a small block/inline allow-list and
// returns semantic HTML. It has no side effects beyond a detached element, so the .docx/.md importers
// (N-5, N-6) can call the same function instead of growing a second converter.
//
// Every route a paste can take — Ctrl+V, Ctrl+Shift+V, the context menu, long-press → Paste —
// dispatches the one cancelable `paste` event, so this is the only hook the editor needs.

// Inline tags kept as themselves. Anything else inline (span, font, u, label…) is unwrapped: its text
// survives, its formatting does not.
const PASTE_INLINE = {
    B: 'strong', STRONG: 'strong',
    I: 'em', EM: 'em',
    A: 'a',
    CODE: 'code',
    S: 's', DEL: 's', STRIKE: 's',
    SUB: 'sub', SUP: 'sup'
};
const PASTE_HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
// Elements that start their own block. Anything holding one of these is a container, not a paragraph:
// X wraps its run of line-divs in an outer <div>, and Google Docs wraps whole paragraphs in one <b>.
// Folding either into a single <p> is exactly the collapse this handler exists to prevent.
const PASTE_BLOCKS = new Set([
    ...PASTE_HEADINGS,
    'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE',
    'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
    'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'HR'
]);

// Collapse runs of HTML whitespace (and NBSPs) the way the browser would on render, so a source's
// indentation never reaches the document as visible space.
function pasteText(value) {
    return String(value).replace(/\s+/g, ' ');
}

// A serialized run is blank when it carries no text and no image: <br> and empty tags alone don't
// count. Empty paragraphs and headings are dropped rather than left behind as gaps.
function isPasteBlank(html) {
    return !/[^\s]/.test(html.replace(/<[^>]*>/g, '')) && !/<img\b/i.test(html);
}

function pasteHasBlockChild(el) {
    return Array.from(el.children || []).some(child => PASTE_BLOCKS.has(child.tagName));
}

// Excluded contexts where anchor-only behaviour must not apply: anchors inside table cells,
// list items, headings, pre, blockquote, hr, or nested inside any of those.
function isExcludedPasteContext(node) {
    const excludedTags = new Set(['BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'TD', 'TH', 'TABLE']);
    let parent = node.parentElement;
    while (parent && parent.tagName !== 'BODY' && parent.tagName !== 'HTML') {
        if (excludedTags.has(parent.tagName)) return true;
        parent = parent.parentElement;
    }
    return false;
}

// A block is anchor-only when, after removing every <a>, nothing remains but whitespace,
// and the node contains at least one <a>, no <br>, no images, and no nested block elements.
function isAnchorOnlyBlock(node) {
    if (!node || node.nodeType !== 1) return false;
    if (isExcludedPasteContext(node)) return false;
    const anchors = node.getElementsByTagName ? Array.from(node.getElementsByTagName('A')) : [];
    if (!anchors.length) return false;
    // No nested block elements (excluding the node itself)
    for (const el of Array.from(node.getElementsByTagName ? node.getElementsByTagName('*') : [])) {
        if (el !== node && PASTE_BLOCKS.has(el.tagName)) return false;
    }
    // No <br> or images anywhere inside
    if (node.getElementsByTagName('BR').length > 0) return false;
    if (node.getElementsByTagName('IMG').length > 0) return false;
    // After stripping all <a> tags, only whitespace should remain
    const clone = node.cloneNode(true);
    for (const a of Array.from(clone.getElementsByTagName ? clone.getElementsByTagName('A') : [])) a.remove();
    const stripped = clone.innerHTML.replace(/<[^>]*>/g, '').replace(/\s+/g, '').trim();
    return stripped.length === 0;
}

// href allow-list: http(s), mailto and relative. The probe drops control characters and spaces first,
// because "java\tscript:" is a scheme the browser still honours.
function pasteHref(value) {
    const href = String(value == null ? '' : value).trim();
    if (!href) return '';
    const probe = href.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
    const scheme = probe.match(/^([a-z][a-z0-9+.-]*):/);
    if (!scheme) return href; // relative path or #anchor
    return (scheme[1] === 'http' || scheme[1] === 'https' || scheme[1] === 'mailto') ? href : '';
}

// Images: data: URIs are self-contained (the app's own intake produces them) and https: renders,
// because img-src in _headers allows it and imported files already show remote images. A relative src
// would point at this origin, and http: is blocked by that same CSP, so neither is kept.
function pasteImage(node) {
    const src = String(node.getAttribute('src') || '').trim();
    const probe = src.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
    if (!/^(data:image\/|https:)/.test(probe)) return '';
    const alt = String(node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
}

// <b style="font-weight:normal"> is a wrapper, not emphasis — that is Google Docs' outer <b>, and
// keeping it would make every pasted line bold.
function isPasteNeutralBold(el) {
    const style = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
    return style.includes('font-weight:normal') || style.includes('font-weight:400');
}

// <pre> keeps its text verbatim: syntax-highlight spans go, their text and the newlines stay.
function pastePreText(node) {
    let text = '';
    Array.from(node.childNodes).forEach(n => {
        if (n.nodeType === 3) text += n.nodeValue;
        else if (n.nodeType === 1) text += n.tagName === 'BR' ? '\n' : pastePreText(n);
    });
    // The HTML parser drops one newline right after <pre>; authored content does not include it.
    return text.replace(/^\n/, '');
}

// Serialize inline content. `open` holds the inline tags already being emitted, so <b><b>x</b></b>
// produces one <strong> instead of two.
function pasteInline(parent, open) {
    return Array.from(parent.childNodes).map(node => pasteInlineNode(node, open)).join('');
}

function pasteInlineNode(node, open) {
    if (node.nodeType === 3) return escapeHtml(pasteText(node.nodeValue));
    if (node.nodeType !== 1) return ''; // comments and the like never survive a sanitize
    const tag = node.tagName;
    if (tag === 'BR') return '<br>';
    if (tag === 'IMG') return pasteImage(node);

    const name = PASTE_INLINE[tag];
    if (!name) return pasteInline(node, open); // span, font, …: keep the text, drop the wrapper
    if (name === 'strong' && isPasteNeutralBold(node)) return pasteInline(node, open);

    if (name === 'a') {
        const href = pasteHref(node.getAttribute('href'));
        const inner = pasteInline(node, open);
        return href ? `<a href="${escapeHtml(href)}" rel="noopener">${inner}</a>` : inner;
    }
    if (open.has(name)) return pasteInline(node, open);

    const next = new Set(open);
    next.add(name);
    return `<${name}>${pasteInline(node, next)}</${name}>`;
}

// <ul>/<ol> survive with their items, nested lists stay inside their parent item, and neither a stray
// node nor an empty <li> becomes an empty bullet.
function pasteList(list) {
    const items = [];
    Array.from(list.childNodes).forEach(node => {
        if (node.nodeType !== 1) return; // bare text directly inside a list has no item to live in
        if (node.tagName === 'LI') {
            const item = pasteListItem(node);
            if (item) items.push(item);
        } else if (node.tagName === 'UL' || node.tagName === 'OL') {
            if (items.length) items[items.length - 1] += pasteList(node);
        }
    });
    return items.length ? `<${list.tagName.toLowerCase()}>${items.join('')}</${list.tagName.toLowerCase()}>` : '';
}

// Serialize a container that has to come out as one run of inline HTML (a list item, a table cell).
// Inline nodes are emitted next to each other with nothing inserted between them: pasteText() has
// already normalised each text node's whitespace, so `<li>Hello <a>world</a>!</li>` keeps its space
// before "world" and gains none before the "!", and Word's `<span>Wor</span><span>d</span>` is "Word".
// A block child is a line of its own — Word and Docs wrap every list item in <p> or <div> — so lines
// are joined by the caller, never nodes.
function pasteInlineLines(container, skip) {
    const lines = [];
    let run = '';
    const flush = () => {
        const html = run.trim();
        run = '';
        if (html && !isPasteBlank(html)) lines.push(html);
    };
    Array.from(container.childNodes).forEach(node => {
        if (node.nodeType === 3) { run += escapeHtml(pasteText(node.nodeValue)); return; }
        if (node.nodeType !== 1) return; // comments and the like never survive a sanitize
        if (skip && skip(node)) return;
        if (PASTE_BLOCKS.has(node.tagName)) {
            flush();
            run = pasteInline(node, new Set());
            flush();
            return;
        }
        run += pasteInlineNode(node, new Set());
    });
    flush();
    return lines;
}

function pasteListItem(li) {
    // A nested list belongs to its item, not to its text.
    let nested = '';
    const lines = pasteInlineLines(li, node => {
        if (node.tagName !== 'UL' && node.tagName !== 'OL') return false;
        nested += pasteList(node);
        return true;
    });
    const text = lines.join(' ');
    if (!text && !nested) return '';
    return `<li>${text}${nested}</li>`;
}

// A pasted table becomes the table insertTable() builds — `<table class="editor-table">` with a real
// <thead>/<tbody> and no inline styles — so the table menu, the column widths and the Markdown export
// all work on it. The wrapper and the menu buttons are added after insertion by applyTableWidths(),
// which is how every other table in the editor gets them.
// The editor's table model has no merged cells: a colspan is expanded into its columns (so the grid
// still lines up with the rows below it, the text in the first one) and a rowspan is dropped. Short
// rows are padded, which keeps the table rectangular for the column operations.
function pasteTable(table) {
    const rows = [];
    // The table's own rows and cells (not querySelectorAll): a nested table stays inside its cell.
    Array.from(table.rows || []).forEach(row => {
        const cells = [];
        Array.from(row.cells || []).forEach(cell => {
            if (cell.tagName !== 'TD' && cell.tagName !== 'TH') return;
            const th = cell.tagName === 'TH';
            const span = Math.max(1, Math.min(20, Math.trunc(Number(cell.getAttribute('colspan'))) || 1));
            cells.push({ th, html: pasteInlineLines(cell).join('<br>') });
            for (let extra = 1; extra < span; extra++) cells.push({ th, html: '' });
        });
        if (!cells.length) return;
        rows.push(cells);
    });
    if (!rows.length) return '';

    // A first row made only of <th> is the source's header row; anything else stays in the body,
    // because a header the source did not have should not be invented. Header cells stay <th>.
    const headed = rows[0].every(cell => cell.th);
    const width = Math.max(...rows.map(row => row.length));
    const pad = (count, tag) => Array.from({ length: count }, () => `<${tag}><br></${tag}>`).join('');
    const rowHtml = (row, forceTag) => {
        const cells = row.map(cell => {
            const tag = forceTag || (cell.th ? 'th' : 'td');
            return `<${tag}>${cell.html || '<br>'}</${tag}>`;
        }).join('');
        return `<tr>${cells}${pad(width - row.length, forceTag || 'td')}</tr>`;
    };

    const head = headed ? `<thead>${rowHtml(rows[0], 'th')}</thead>` : '';
    const body = rows.slice(headed ? 1 : 0).map(row => rowHtml(row)).join('');
    return `<table class="editor-table">${head}${body ? `<tbody>${body}</tbody>` : ''}</table>`;
}

// Rebuild one block element into `out` (a list of HTML strings, in document order).
function pasteBlock(node, out) {
    const tag = node.tagName;

    if (tag === 'HR') { out.push('<hr>'); return; }

    if (tag === 'PRE') {
        const text = pastePreText(node);
        if (text.trim()) out.push('<pre>' + escapeHtml(text) + '</pre>');
        return;
    }

    if (tag === 'BLOCKQUOTE') {
        const inner = [];
        pasteBlocks(node, inner);
        if (inner.length) out.push('<blockquote>' + inner.join('') + '</blockquote>');
        return;
    }

    if (tag === 'UL' || tag === 'OL') {
        const list = pasteList(node);
        if (list) out.push(list);
        return;
    }

    // A table is rebuilt as a table (never as a run of paragraphs) and pushed as a block of its own,
    // so a table pasted mid-paragraph is split out of the paragraph like any other block here.
    if (tag === 'TABLE') {
        const table = pasteTable(node);
        if (table) out.push(table);
        return;
    }

    // Whatever else holds blocks is only a wrapper (X's outer div, Docs' outer b) — recurse.
    if (pasteHasBlockChild(node)) { pasteBlocks(node, out); return; }

    // Anchor-only block: flows into the open paragraph (or opens one if none is open).
    // Exclusions (table cells, list items, headings, pre, blockquote, hr) are handled above
    // by isExcludedPasteContext, so this only affects standard block containers.
    if (isAnchorOnlyBlock(node)) {
        const html = pasteInline(node, new Set()).trim();
        if (!isPasteBlank(html)) {
            if (out.length > 0) {
                const last = out[out.length - 1];
                if (last && last.startsWith('<p>') && last.endsWith('</p>')) {
                    const inner = last.slice(3, -4);
                    const sep = inner.length > 0 && !/\s$/.test(inner) ? ' ' : '';
                    out[out.length - 1] = '<p>' + inner + sep + html + '</p>';
                    return;
                }
            }
            out.push('<p>' + html + '</p>');
        }
        return;
    }

    const html = pasteInline(node, new Set()).trim();
    if (isPasteBlank(html)) return; // an empty <p> run is a gap, not content

    // A heading stays a heading, but never empty and never inside a paragraph — the parser would
    // otherwise split the paragraph around it.
    if (PASTE_HEADINGS.has(tag)) out.push(`<${tag.toLowerCase()}>${html}</${tag.toLowerCase()}>`);
    else out.push('<p>' + html + '</p>');
}

// Walk a container: an inline run becomes one paragraph, blocks are rebuilt in place.
function pasteBlocks(container, out) {
    let run = '';
    const flush = () => {
        const html = run.trim();
        run = '';
        if (html && !isPasteBlank(html)) out.push('<p>' + html + '</p>');
    };
    Array.from(container.childNodes).forEach(node => {
        if (node.nodeType === 3) { run += escapeHtml(pasteText(node.nodeValue)); return; }
        if (node.nodeType !== 1) return;
        if (PASTE_BLOCKS.has(node.tagName)) {
            flush();
            pasteBlock(node, out);
            return;
        }
        if (pasteHasBlockChild(node)) { // e.g. <b> wrapped around whole paragraphs
            flush();
            pasteBlocks(node, out);
            return;
        }
        run += pasteInlineNode(node, new Set());
    });
    flush();
}

// Foreign HTML in, clean semantic HTML out. Pure: it parses into an inert document and returns a
// string, so nothing is fetched and nothing touches the editor until the caller inserts the result.
// (A detached element would not do — Chrome starts loading images set inside one, which would let a
// pasted tracking pixel phone home while we are still deciding what to keep.)
function normalizePastedHTML(html) {
    // sanitizeHTML first: the walk below must never see scripts, on* handlers, <style> or <meta>.
    const doc = new DOMParser().parseFromString(sanitizeHTML(String(html == null ? '' : html)), 'text/html');
    const out = [];
    pasteBlocks(doc.body || doc.documentElement, out);
    return out.join('');
}

// text/plain (or the Shift+paste escape hatch): a blank line is a paragraph break, a single newline a
// line break inside the paragraph. Escaped throughout, and NBSPs become ordinary spaces.
function plainTextToHTML(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => {
        const html = para.join('<br>');
        para = [];
        if (!isPasteBlank(html)) out.push('<p>' + html + '</p>');
    };
    lines.forEach(line => {
        const clean = escapeHtml(line.replace(/\s+/g, ' ').trim());
        if (clean) para.push(clean);
        else flush();
    });
    flush();
    return out.join('');
}

// The text a pasted fragment carries, read back out of the same rebuild: one line per block and a line
// break inside a block. textContent alone would run X's one-<div>-per-line payload together, so it is
// only used as the shape the rebuild already gives it. Needed when a source offers no text/plain.
function htmlToPlainText(html) {
    const normalized = normalizePastedHTML(html);
    if (!normalized) return '';
    const doc = new DOMParser().parseFromString(normalized, 'text/html');
    const textOf = node => Array.from(node.childNodes).map(child => {
        if (child.nodeType === 3) return child.nodeValue;
        if (child.nodeType !== 1) return '';
        return child.tagName === 'BR' ? '\n' : textOf(child);
    }).join('');
    const lines = [];
    Array.from(doc.body ? doc.body.children : []).forEach(el => {
        if (el.tagName === 'TABLE') {
            Array.from(el.rows || []).forEach(row => {
                lines.push(Array.from(row.cells || []).map(cell => textOf(cell)).join('\t'));
            });
            return;
        }
        lines.push(textOf(el));
    });
    return lines.join('\n');
}

// The editor's only paste hook. It is bound to #editBody alone, so the title field, the rename and
// search boxes and dialogs keep the browser's own paste.
// Escape hatch: Shift+paste inserts the clipboard text as plain text, bypassing normalisation, for
// anyone who wants the source's own words (or is filling a code block) without the rebuild.
editBody.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const html = data.getData('text/html') || '';
    const text = data.getData('text/plain') || '';
    // Nothing we can rebuild (an image file on the clipboard, say): leave it to the browser.
    if (!html.trim() && !text) return;
    e.preventDefault();

    // Inside a code block the text is the content: a <p> built for the page body would look wrong in
    // <pre> and break the block. Escaped text is inserted as-is — its newlines stay literal characters
    // in one text node, so they render as lines here and survive into the Markdown export, whereas
    // <br> would render but leave textContent empty.
    // The caret is not always in the selection — a context-menu paste can arrive after focus moved —
    // so the event target is the fallback for "where is this going" before we give up on <pre>.
    const selection = window.getSelection();
    const anchor = selection ? selection.anchorNode : null;
    const caretEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const inPre = (caretEl && caretEl.closest && caretEl.closest('pre'))
        || (e.target && e.target.closest ? e.target.closest('pre') : null);
    // A source that supplies only text/html (some do) still has to arrive as text inside a code block,
    // or its block markup would be inserted into the <pre>.
    const codeText = inPre && editBody.contains(inPre) ? (text || htmlToPlainText(html)) : '';
    if (codeText) {
        // insertHTML is not guaranteed to be honoured; the text itself is the last resort.
        if (!document.execCommand('insertHTML', false, escapeHtml(codeText))) {
            document.execCommand('insertText', false, codeText);
        }
        return;
    }

    const insert = e.shiftKey ? plainTextToHTML(text)
        : html.trim() ? normalizePastedHTML(html)
        : plainTextToHTML(text);

    // One execCommand keeps the whole paste a single undo step and leaves the caret after it. The
    // existing `input` listener on #editBody already runs the debounced save and the first_keystroke
    // counter, so nothing extra is saved here.
    // preventDefault() has already taken the clipboard away from the browser, so a paste that rebuilds
    // to nothing (whitespace only, an image whose src we keep none of) or that the browser refuses to
    // insert must still land as plain text rather than disappear.
    if (insert && document.execCommand('insertHTML', false, sanitizeHTML(insert))) {
        // A pasted table gets the same wrapper and menu button as one made from the toolbar.
        if (insert.includes('<table')) applyTableWidths();
        return;
    }
    const fallback = text || htmlToPlainText(html);
    if (fallback) document.execCommand('insertText', false, fallback);
});

function insertImageSlot() {
    preserveScroll(() => {
        if (lastSelectionRange) {
            editBody.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(lastSelectionRange);
        }
        const id = 'dz-' + Date.now();
        const dzHtml = `<div id="${id}" class="inline-dropzone" contenteditable="false">Click or Drop Image Here</div><p><br></p>`;
        document.execCommand('insertHTML', false, dzHtml);

        const dz = document.getElementById(id);
        if (dz) wireDropzone(dz);
        saveToLocalStorage();
    });
}

// Make a dropzone accept a click or a dragged file
function wireDropzone(dz) {
    dz.addEventListener('click', () => pickImageInto(dz));
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file && file.type.indexOf('image/') === 0) handleImage(file, dz);
    });
}

function pickImageInto(target) {
    const input = document.getElementById('fileInput');
    input.value = '';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) handleImage(file, target);
    };
    input.click();
}

// Insert a horizontal divider
function insertDivider() {
    preserveScroll(() => {
        if (lastSelectionRange) {
            editBody.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(lastSelectionRange);
        }
        const ruleHtml = `<div class="content-divider" contenteditable="false"></div>`;
        document.execCommand('insertHTML', false, ruleHtml);
        saveToLocalStorage();
    });
}

// Insert an editable table
function insertTable(rowsWanted = 3, colsWanted = 3) {
    const rows = Math.max(1, Math.min(20, Math.trunc(Number(rowsWanted)) || 3));
    const cols = Math.max(1, Math.min(20, Math.trunc(Number(colsWanted)) || 3));
    preserveScroll(() => {
        if (lastSelectionRange) {
            editBody.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(lastSelectionRange);
        }
        let tableHtml = '<table class="editor-table"><thead><tr>';
        for (let c = 0; c < cols; c++) tableHtml += '<th><br></th>';
        tableHtml += '</tr></thead><tbody>';
        for (let r = 1; r < rows; r++) {
            tableHtml += '<tr>';
            for (let c = 0; c < cols; c++) tableHtml += '<td><br></td>';
            tableHtml += '</tr>';
        }
        tableHtml += '</tbody></table>';
        const html = `<div class="table-wrapper">${tableHtml}<button class="table-menu-btn" contenteditable="false" aria-label="Table options" title="Table options">\u22ee</button><div class="table-menu-dropdown" contenteditable="false"><button data-action="insert-row-above">Insert row above</button><button data-action="insert-row-below">Insert row below</button><button data-action="insert-col-left">Insert column left</button><button data-action="insert-col-right">Insert column right</button><button data-action="delete-row">Delete row</button><button data-action="delete-col">Delete column</button><button data-action="delete-table">Delete table</button></div></div><p><br></p>`;
        document.execCommand('insertHTML', false, html);
        // Column widths are applied through CSSOM — inline style attributes are blocked by the
        // strict CSP, but property writes are not.
        const wrappers = editBody.querySelectorAll('.table-wrapper');
        const inserted = wrappers[wrappers.length - 1];
        const insertedTable = inserted && inserted.querySelector('table.editor-table');
        if (insertedTable) {
            insertedTable.querySelectorAll('th, td').forEach(cell => {
                cell.setAttribute('data-w', '150');
                cell.style.width = '150px';
            });
        }
        saveToLocalStorage();
    });
}

async function handleImage(file, target) {
    if (!file) return;
    // S-2b: downscale and re-encode before it ever reaches the document or localStorage.
    const src = await downscaleImage(file, MAX_IMAGE_EDGE);
    if (!src) return;
    if (!target.isConnected) return; // the dropzone was removed while the image was decoding

    const container = document.createElement('div');
    container.className = 'img-container';
    container.contentEditable = "false";
    const img = document.createElement('img');
    img.src = src;
    img.style.width = "450px";
    container.appendChild(img);

    // Add delete button
    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'img-delete';
    deleteBtn.textContent = '×';
    deleteBtn.contentEditable = "false";
    deleteBtn.onclick = (ev) => {
        ev.stopPropagation();
        container.remove();
        saveToLocalStorage();
    };
    container.appendChild(deleteBtn);

    target.replaceWith(container);
    saveToLocalStorage();
}

// Attach delete buttons to existing body images
function attachBodyImageDeleteButtons() {
    editBody.querySelectorAll('.img-container').forEach(container => {
        if (!container.querySelector('.img-delete')) {
            const deleteBtn = document.createElement('div');
            deleteBtn.className = 'img-delete';
            deleteBtn.textContent = '×';
            deleteBtn.contentEditable = "false";
            deleteBtn.onclick = (ev) => {
                ev.stopPropagation();
                container.remove();
                saveToLocalStorage();
            };
            container.appendChild(deleteBtn);
        }
    });
}

// --- CORE SYNC & CONVERSION ---

// The menu button/dropdown are stripped from saved HTML, so rebuild them (and wrap any bare
// table) whenever a document is loaded or a table is inserted.
const TABLE_MENU_ITEMS = [
    ['insert-row-above', 'Insert row above'],
    ['insert-row-below', 'Insert row below'],
    ['insert-col-left', 'Insert column left'],
    ['insert-col-right', 'Insert column right'],
    ['delete-row', 'Delete row'],
    ['delete-col', 'Delete column'],
    ['delete-table', 'Delete table']
];

function ensureTableChrome(root) {
    (root || editBody).querySelectorAll('table.editor-table').forEach(table => {
        let wrapper = table.closest('.table-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'table-wrapper';
            table.parentNode.insertBefore(wrapper, table);
            wrapper.appendChild(table);
        }
        if (!wrapper.querySelector(':scope > .table-menu-btn')) {
            const btn = document.createElement('button');
            btn.className = 'table-menu-btn';
            btn.contentEditable = 'false';
            btn.setAttribute('aria-label', 'Table options');
            btn.title = 'Table options';
            btn.textContent = '\u22ee';
            wrapper.appendChild(btn);
        }
        if (!wrapper.querySelector(':scope > .table-menu-dropdown')) {
            const dd = document.createElement('div');
            dd.className = 'table-menu-dropdown';
            dd.contentEditable = 'false';
            TABLE_MENU_ITEMS.forEach(([action, label]) => {
                const b = document.createElement('button');
                b.setAttribute('data-action', action);
                b.textContent = label;
                dd.appendChild(b);
            });
            wrapper.appendChild(dd);
        }
    });
}

// Column widths live in data-w so they survive a save/reload: the strict CSP drops inline
// style attributes when HTML is parsed, but property writes from JS are allowed.
function applyTableWidths(root) {
    ensureTableChrome(root);
    (root || editBody).querySelectorAll('.editor-table [data-w]').forEach(cell => {
        const w = parseFloat(cell.getAttribute('data-w'));
        if (!isNaN(w)) cell.style.width = w + 'px';
    });
    (root || editBody).querySelectorAll('.editor-table tr[data-h]').forEach(row => {
        const h = parseFloat(row.getAttribute('data-h'));
        if (!isNaN(h)) row.style.height = h + 'px';
    });
}

// Serialize the editor without the table UI chrome (menu button/dropdown, resize handles).
// The chrome lives inside #editBody so it can be positioned, but it must never be saved.
function bodyHTML() {
    const clone = editBody.cloneNode(true);
    clone.querySelectorAll('.table-menu-btn, .table-menu-dropdown, .resize-overlay').forEach(el => el.remove());
    return clone.innerHTML;
}

function saveToLocalStorage() {
    safeSetItem("doc_title_v13", editTitle.textContent);
    safeSetItem("doc_body_v13", bodyHTML());
    
    // Save title image data
    const titleImageData = getTitleImageData();
    if (titleImageData) {
        safeSetItem("doc_title_image_v13", JSON.stringify(titleImageData));
    } else {
        localStorage.removeItem("doc_title_image_v13");
    }
    
    updateStats();
    // Keep the Recents index in step with the live document (the live keys are its storage, so
    // nothing else has to be written on an autosave).
    if (!isLoading) touchCurrentDocument();
    // Don't rewrite a file we just imported, and don't hit the disk on every keystroke.
    if (fileHandle && !isLoading) scheduleDiskSave();
}

const scheduleDiskSave = debounce(() => { saveToDisk(); }, 800);

function generateHTMLFile() {
    const safeTitle = escapeHtml(editTitle.textContent);
    const titleImageData = getTitleImageData();
    const titleImageHTML = titleImageData 
        ? `<div style="text-align: center; margin-bottom: 30px;"><img src="${titleImageData.src}" style="max-width: 100%; width: ${titleImageData.width}; border-radius: 12px;" /></div>`
        : '';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    <style>
        body { max-width: 800px; margin: 40px auto; padding: 20px; font-family: 'Inter', sans-serif; line-height: 1.8; }
        h1 { font-size: 2.5em; margin-bottom: 0.5em; }
        img { max-width: 100%; height: auto; border-radius: 8px; }
        .img-container { text-align: center; margin: 30px 0; }
        blockquote { border-left: 3px solid #ccc; padding-left: 20px; color: #666; font-style: italic; }
    </style>
</head>
<body>
    ${titleImageHTML}
    <h1>${safeTitle}</h1>
    ${exportBodyHTML()}
</body>
</html>`;
}

function convertToMarkdown() {
    let md = `# ${editTitle.textContent}\n\n`;
    
    // Add title image if exists
    const titleImageData = getTitleImageData();
    if (titleImageData) {
        md += `![Header Image](${titleImageData.src})\n\n`;
    }
    
    // Helper to serialize inline content (preserves bold, italic, etc.)
    const serializeInline = (node) => {
        let text = "";
        node.childNodes.forEach(child => {
            if (child.nodeType === 3) {
                text += child.textContent;
            } else if (child.nodeType === 1) {
                const tag = child.tagName;
                if (tag === 'STRONG' || tag === 'B') {
                    text += `**${serializeInline(child)}**`;
                } else if (tag === 'EM' || tag === 'I') {
                    text += `*${serializeInline(child)}*`;
                } else if (tag === 'CODE') {
                    text += `\`${child.textContent}\``;
                } else if (tag === 'BR') {
                    text += '\n';
                } else {
                    text += serializeInline(child);
                }
            }
        });
        return text;
    };
    
    const serializeTable = (table) => {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (!rows.length) return '';
        const cellText = (cell) => serializeInline(cell).trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|');
        const line = (cells) => '| ' + cells.join(' | ') + ' |';
        const header = Array.from(rows[0].children).map(cellText);
        let out = line(header) + '\n' + line(header.map(() => '---')) + '\n';
        rows.slice(1).forEach(tr => { out += line(Array.from(tr.children).map(cellText)) + '\n'; });
        return out.replace(/\n$/, '');
    };

    const serialize = (el) => {
        let text = "";
        el.childNodes.forEach(node => {
            if (node.nodeType === 3) { // Plain text
                const val = node.textContent.trim();
                if (val) text += val + "\n\n";
            } else if (node.nodeType === 1) { // Elements
                const tag = node.tagName;
                
                if (node.classList.contains('img-container')) {
                    const img = node.querySelector('img');
                    text += `\n![image](${img.src})\n\n`;
                } 
                else if (tag === 'H1') text += `# ${serializeInline(node)}\n\n`;
                else if (tag === 'H2') text += `## ${serializeInline(node)}\n\n`;
                else if (tag === 'H3') text += `### ${serializeInline(node)}\n\n`;
                else if (tag === 'H4') text += `#### ${serializeInline(node)}\n\n`;
                else if (tag === 'BLOCKQUOTE') text += `> ${serializeInline(node)}\n\n`;
                else if (tag === 'PRE') text += '\n```\n' + node.textContent.replace(/\n$/, '') + '\n```\n\n';
                else if (tag === 'TABLE') text += serializeTable(node) + '\n\n';
                else if (tag === 'UL') {
                    const listItems = Array.from(node.children).filter(child => child.tagName === 'LI');
                    listItems.forEach(li => {
                        text += `* ${serializeInline(li).trim()}\n`;
                    });
                    text += "\n";
                }
                else if (tag === 'OL') {
                    const listItems = Array.from(node.children).filter(child => child.tagName === 'LI');
                    listItems.forEach((li, idx) => {
                        text += `${idx + 1}. ${serializeInline(li).trim()}\n`;
                    });
                    text += "\n";
                }
                else if (tag === 'P' || tag === 'DIV') {
                    const content = serializeInline(node).trim();
                    if (content !== "") text += `${content}\n\n`;
                }
            }
        });
        
        return text.replace(/\n{3,}/g, '\n\n').trim();
    };

    return md + serialize(editBody);
}

function format(cmd) {
    if (['h1', 'h2', 'h3', 'h4', 'blockquote', 'p'].includes(cmd)) {
        document.execCommand('formatBlock', false, cmd);
    } else if (cmd === 'link') {
        const url = prompt('Enter URL:');
        if (url) {
            if (window.getSelection().isCollapsed) {
                document.execCommand('insertHTML', false, '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>');
            } else {
                document.execCommand('createLink', false, url);
            }
        }
    } else if (cmd === 'code') {
        formatInlineCode();
        return; // formatInlineCode saves the document itself
    } else if (cmd === 'codeblock') {
        document.execCommand('formatBlock', false, 'pre');
    } else if (ALIGN_BY_CMD[cmd]) {
        applyAlignment(cmd); // UI-17: a class, not execCommand's blocked inline style
    } else {
        document.execCommand(cmd, false, null);
    }
    saveToLocalStorage();
}

// --- UI-17: alignment ---------------------------------------------------------------
//
// `document.execCommand('justify*')` writes an inline `style="text-align:…"`, and the strict
// `style-src 'self'` blocks style attributes: the attribute landed in the DOM but was never
// applied (getComputedStyle stayed `start`), print lost it, and every click logged a CSP
// violation. CSSOM writes (`el.style.x = …`) are exempt from that check, but a stored attribute
// would be blocked again on the next load — so alignment is carried by a class the stylesheet
// defines, and is converted back to an inline style only in the exported file, which is opened
// outside our origin.
const ALIGN_CLASSES = ['q-align-left', 'q-align-center', 'q-align-right', 'q-align-justify'];
const ALIGN_BY_CMD = { justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right', justifyFull: 'justify' };
const ALIGN_TAGS = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,td,th,table,div';

// The deepest block-level elements the selection touches: a caret inside a paragraph aligns that
// paragraph; a selection across two list items aligns both. Heading/quote/code blocks and table
// cells are blocks in their own right, so a wrapping <div> never wins over them.
function alignmentTargets() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    if (!editBody.contains(range.commonAncestorContainer)) return [];
    const hits = Array.from(editBody.querySelectorAll(ALIGN_TAGS)).filter(el => range.intersectsNode(el));
    return hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
}

function applyAlignment(cmd) {
    const value = ALIGN_BY_CMD[cmd];
    if (!value) return;
    const targets = alignmentTargets();
    if (!targets.length) {
        toast('Click into the document first, then choose an alignment.');
        return;
    }
    targets.forEach(el => {
        el.classList.remove(...ALIGN_CLASSES);
        if (value !== 'left') el.classList.add('q-align-' + value);
    });
}

// Documents saved before UI-17 hold `style="text-align:…"` that the CSP refuses to apply. Move it
// onto the class so existing documents show the alignment they always had on disk. The dead
// attribute is dropped whole: rewriting a style attribute is itself blocked, and any other
// declaration in it was inert under the same rule.
function migrateAlignment() {
    editBody.querySelectorAll('[style*="text-align"]').forEach(el => {
        const decl = (el.getAttribute('style') || '').split(';')
            .map(s => s.trim()).filter(Boolean)
            .find(p => /^text-align\s*:/i.test(p));
        if (!decl) return;
        const value = decl.split(':')[1].trim().toLowerCase();
        if (!['left', 'right', 'center', 'justify'].includes(value)) return;
        el.classList.remove(...ALIGN_CLASSES);
        if (value !== 'left') el.classList.add('q-align-' + value);
        el.removeAttribute('style');
    });
}

// The export is opened outside our origin, so an inline style is allowed there and is the most
// portable form (it survives being pasted into another tool). Turn the classes back into inline
// styles in the export only — the editor keeps the class.
function exportBodyHTML() {
    const clone = editBody.cloneNode(true);
    clone.querySelectorAll(ALIGN_CLASSES.map(c => '.' + c).join(',')).forEach(el => {
        const cls = ALIGN_CLASSES.find(c => el.classList.contains(c));
        if (!cls) return;
        el.classList.remove(...ALIGN_CLASSES);
        if (!el.classList.length) el.removeAttribute('class'); // don't leave class=""
        el.style.textAlign = cls.slice('q-align-'.length);
    });
    return clone.innerHTML;
}

// Toggle inline <code> around the current selection
function formatInlineCode() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anchorEl = sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
    const existing = anchorEl && anchorEl.closest ? anchorEl.closest('code') : null;

    // Already inside a <code> element → unwrap it
    if (existing && editBody.contains(existing)) {
        const parent = existing.parentNode;
        while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
        existing.remove();
        saveToLocalStorage();
        return;
    }

    if (range.collapsed) {
        toast('Select some text to format as inline code.');
        return;
    }

    const code = document.createElement('code');
    code.appendChild(range.extractContents());
    range.insertNode(code);

    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(code);
    sel.addRange(r);
    saveToLocalStorage();
}

// Apply a block style from the side-panel heading dropdown
function applyHeading(value) {
    if (!value) return;
    if (!lastSelectionRange) {
        toast('Click into the document first, then choose a style.');
        return;
    }
    editBody.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(lastSelectionRange);
    document.execCommand('formatBlock', false, value);
    saveToLocalStorage();
}

function handleExport(value) {
    if (value === 'quorly') { track('export', { format: 'quorly' }); exportQuorly(); }
    else if (value === 'pdf') { track('export', { format: 'pdf' }); window.print(); }
    else if (value === 'md') { track('export', { format: 'md' }); exportMarkdown(); }
    else if (value === 'txt') { track('export', { format: 'txt' }); exportText(); }
}

function handleInsert(value) {
    // Restore the caret/selection that lived in the editor before focus moved to the dropdown.
    // Fall back to the end of the document when there is no remembered selection (e.g. the
    // welcome sample is on screen and the user never clicked into the editor).
    preserveScroll(() => {
        editBody.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        if (lastSelectionRange) {
            sel.addRange(lastSelectionRange);
        } else {
            const r = document.createRange();
            r.selectNodeContents(editBody);
            r.collapse(false);
            sel.addRange(r);
        }
        if (value === 'image') insertImageSlot();
        else if (value === 'table') insertTable();
        else if (value === 'codeblock') { document.execCommand('formatBlock', false, 'pre'); saveToLocalStorage(); }
        else if (value === 'divider') insertDivider();
    });
}

function syncHeadingDropdown() {
    const root = document.getElementById('headingDropdown');
    if (!root) return;
    if (root.classList.contains('open')) return;
    const valueEl = root.querySelector('.dropdown-value');
    const menu = root.querySelector('.dropdown-menu');
    if (!valueEl || !menu) return;
    const sel = window.getSelection();
    let node = (sel && sel.rangeCount) ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (node && node.nodeType === 3) node = node.parentNode;
    let tag = 'P';
    while (node && node !== editBody && node !== document.body) {
        if (node.nodeName && /^H[1-6]$/.test(node.nodeName)) { tag = node.nodeName; break; }
        if (node === editBody) break;
        node = node.parentNode;
    }
    const label = ({ H1:'Heading 1', H2:'Heading 2', H3:'Heading 3', H4:'Heading 4', P:'Paragraph' })[tag] || 'Paragraph';
    valueEl.textContent = label;
    const targetVal = (tag === 'P') ? 'p' : tag.toLowerCase();
    menu.querySelectorAll('[role="option"]').forEach((o) => {
        o.setAttribute('aria-selected', String(o.getAttribute('data-value') === targetVal));
    });
}

// Toggle the "More" panel in the Document section
// UI-16: the bottom bar's "Local Storage" / filename chip is gone from the markup. Every write to
// it goes through this accessor, which hands back a detached stand-in when the chip isn't in the
// page — so the Save/Export feedback below becomes a no-op instead of throwing. Putting the chip
// back is then a markup-only change.
function fileDisplayEl() {
    const el = document.getElementById('fileNameDisplay');
    return el || { textContent: '' };
}

function updateStats() {
    const text = editBody.innerText || "";
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    document.getElementById('wordCount').textContent = `${words} words`;
    document.getElementById('charCount').textContent = `${text.length} chars`;
    document.getElementById('readTime').textContent = `Estimated read - ${Math.max(1, Math.ceil(words/200))} min`;
}

// --- UTILS ---
function toggleFocus() {
    const on = document.body.classList.toggle('focus-mode');
    const btn = document.getElementById('focusModeBtn');
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // UI-14: otherwise an open drawer would sit behind a scrim with its panel hidden.
    if (on) setPanelOpen(false);
}

// UI-13 / UI-14: one action, two behaviours. Above 1180px the header chevron collapses the panel
// into the grid (a floating button brings it back); at ≤1180px the same action opens and closes
// the panel drawer, and the hamburger in the top bar uses it too.
function setPanelOpen(open) {
    document.body.classList.toggle('panel-open', open);
    const menuBtn = document.getElementById('menuBtn');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
    const collapseBtn = document.getElementById('sidebarCollapse');
    if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!open));
    if (open) closeRowMenu();   // the row menu is viewport-positioned
}

function toggleSidebar() {
    if (MOBILE_LAYOUT.matches) {
        // The panel can't show while focus mode is on, so leaving it comes first — which also
        // makes the hamburger a guaranteed way out of focus mode on a phone.
        if (document.body.classList.contains('focus-mode')) toggleFocus();
        setPanelOpen(!document.body.classList.contains('panel-open'));
        return;
    }
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    const collapseBtn = document.getElementById('sidebarCollapse');
    const expandBtn = document.getElementById('sidebarExpand');
    if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    if (expandBtn) expandBtn.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) closeRowMenu();   // the row menu is viewport-positioned
}

// UI-14: below 1180px the Formatting section lives in the fixed bar under the top bar; above it,
// it goes back into the panel in its original position (before Insert). One instance is moved
// around rather than duplicated, so its ids and dropdown wiring stay single.
function syncLayoutMode(isMobile) {
    const section = document.getElementById('formatSection');
    const bar = document.getElementById('mobileFmtBar');
    const panel = document.getElementById('sidebarPanel');
    if (!section || !bar || !panel) return;
    if (isMobile) {
        document.body.classList.remove('sidebar-collapsed');
        if (section.parentNode !== bar) bar.appendChild(section);
    } else {
        setPanelOpen(false);
        if (section.parentNode !== panel) {
            const insert = document.getElementById('insertSection');
            panel.insertBefore(section, insert && insert.parentNode === panel ? insert : null);
        }
    }
}
function syncModeButton() {
    const btn = document.getElementById('modeBtn');
    if (!btn) return;
    const light = document.body.classList.contains('light-mode');
    // The button shows the current mode as an icon (moon = dark, sun = light); its label, for
    // screen readers and the tooltip, describes the action.
    const label = light ? 'Switch to dark mode' : 'Switch to light mode';
    btn.setAttribute('aria-pressed', String(light));
    btn.setAttribute('aria-label', label);
    btn.title = label;
}
function toggleMode() { 
    document.body.classList.toggle('light-mode'); 
    const light = document.body.classList.contains('light-mode');
    localStorage.setItem('mode', light ? 'light' : 'dark');
    syncModeButton();
}
// UI-15: the A−/A+ and ←/→ button pairs became numeric dropdowns, so these take an absolute
// value. `resetFontSize` stays because Ctrl/Cmd+0 still uses it.
function setFontSize(px) {
    bodyFontSize = px;
    document.documentElement.style.setProperty('--body-font-size', `${bodyFontSize}px`);
}
function resetFontSize() {
    setFontSize(17);
}
function setWidth(px) {
    editorWidth = Math.max(600, Math.min(1400, px));
    document.documentElement.style.setProperty('--editor-width', `${editorWidth}px`);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    
    if (!isMod) return;
    
    // Bold (Cmd/Ctrl + B)
    if (e.key === 'b') {
        e.preventDefault();
        format('bold');
    }
    
    // Italic (Cmd/Ctrl + I)
    if (e.key === 'i') {
        e.preventDefault();
        format('italic');
    }

    // Underline (Cmd/Ctrl + U)
    if (e.key === 'u') {
        e.preventDefault();
        format('underline');
    }
    
    // Link (Cmd/Ctrl + K)
    if (e.key === 'k') {
        e.preventDefault();
        format('link');
    }
    
    // Save / Export .quorly (Cmd/Ctrl + S)
    if (e.key === 's') {
        e.preventDefault();
        exportQuorly();
    }
    
    // Print/PDF (Cmd/Ctrl + P)
    if (e.key === 'p') {
        e.preventDefault();
        window.print();
    }
    
    // Focus Mode (Cmd/Ctrl + Shift + F)
    if (e.key === 'f' && e.shiftKey) {
        e.preventDefault();
        toggleFocus();
    }
    
    // Format shortcuts using number keys
    // Ctrl/Cmd + 1 = Paragraph
    if (e.key === '1') {
        e.preventDefault();
        format('p');
    }
    // Ctrl/Cmd + 2 = H2
    if (e.key === '2') {
        e.preventDefault();
        format('h2');
    }
    // Ctrl/Cmd + 3 = H3
    if (e.key === '3') {
        e.preventDefault();
        format('h3');
    }
    // Ctrl/Cmd + 4 = H4
    if (e.key === '4') {
        e.preventDefault();
        format('h4');
    }
    
    // Ctrl/Cmd + 0 = Reset font size to default
    if (e.key === '0') {
        e.preventDefault();
        resetFontSize();
    }
});

// Code syntax highlighting (CSS-based)
function highlightCode(codeElement) {
    let code = codeElement.textContent;
    
    // Escape markup first, so code containing HTML can't inject nodes when written back
    code = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // JavaScript/General syntax highlighting
    code = code
        // Comments
        .replace(/(\/\/.*$)/gm, '<span class="comment">$1</span>')
        .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="comment">$1</span>')
        // Strings
        .replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, '<span class="string">$1</span>')
        // Numbers
        .replace(/\b(\d+\.?\d*)\b/g, '<span class="number">$1</span>')
        // Keywords
        .replace(/\b(function|const|let|var|if|else|return|for|while|class|import|export|from|async|await|try|catch|throw|new|this|super|extends|static|get|set|break|continue|switch|case|default|do|typeof|instanceof|void|delete|in|of|yield|null|undefined|true|false|def|lambda|print|range|class|self|pass|raise|with|as)\b/g, '<span class="keyword">$1</span>')
        // Functions
        .replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g, '<span class="function">$1</span>(');
    
    codeElement.innerHTML = code;
}

// Apply syntax highlighting to all code blocks
function applyCodeHighlighting() {
    editBody.querySelectorAll('pre').forEach(pre => {
        if (!pre.dataset.highlighted) {
            highlightCode(pre);
            pre.dataset.highlighted = 'true';
        }
    });
}

// Re-highlight on blur
editBody.addEventListener('blur', (e) => {
    if (e.target.tagName === 'PRE') {
        highlightCode(e.target);
    }
}, true);

// --- WRITE-ASSIST removed: feature hidden. Restore from the original app if needed. ---

function changeTypography(font) {
    // Final set (2026-10-20). Default won the heading/body comparison; the serif and mono
    // candidates sit alongside it. Every key here must also exist as an option in the
    // Theme menu (app/index.html) and in the set_reading_preferences enum (webmcp.js).
    const fontMap = {
        'Default': {
            title: "'Montserrat', sans-serif",
            body: "'Inter', system-ui, sans-serif"
        },
        'Literature': {
            title: "'Literata', serif",
            body: "'Literata', serif"
        },
        'Paperback': {
            title: "'Crimson Pro', serif",
            body: "'Crimson Pro', serif"
        },
        'Screenwriter': {
            title: "'Courier Prime', monospace",
            body: "'Courier Prime', monospace"
        },
        'OpenDyslexic': {
            title: "'OpenDyslexic', system-ui, sans-serif",
            body: "'OpenDyslexic', system-ui, sans-serif"
        }
    };
    const entry = fontMap[font];
    if (!entry) return; // unknown value (stale WebMCP client, old storage): leave the page as-is
    document.documentElement.style.setProperty('--title-font', entry.title);
    document.documentElement.style.setProperty('--body-font', entry.body);
    safeSetItem(READING_FONT_KEY, font);
}

// A typeface is a reading preference, not a per-session action: without this a writer who
// picks Paperback comes back to Default on reload and has no idea why.
function restoreReadingFont() {
    const saved = localStorage.getItem(READING_FONT_KEY);
    const root = document.getElementById('typographyDropdown');
    if (!saved || !root) return;
    const options = Array.from(root.querySelectorAll('.dropdown-menu [role="option"]'));
    const chosen = options.find((o) => o.getAttribute('data-value') === saved);
    // A value from an older build (or a font we dropped) is ignored rather than half-applied.
    if (!chosen) return;
    changeTypography(saved);
    options.forEach((o) => o.setAttribute('aria-selected', String(o === chosen)));
    // The toggle is labelled with the current face, the same way a click labels it.
    const valueEl = root.querySelector('.dropdown-value');
    if (valueEl) valueEl.textContent = chosen.textContent.trim();
}

// Title image management
function attachTitleButton() {
    const doc = document.querySelector('.doc');
    if (!doc.querySelector('.title-add-btn')) {
        const btn = document.createElement('div');
        btn.className = 'title-add-btn';
        btn.textContent = '+';
        btn.contentEditable = 'false';
        btn.onclick = (e) => {
            e.stopPropagation();
            const input = document.getElementById('fileInput');
            input.onchange = async (ev) => {
                const file = ev.target.files[0];
                if (!file) return;
                // S-2b: the header image is capped tighter than body images.
                const src = await downscaleImage(file, MAX_TITLE_EDGE);
                if (src) setTitleImage(src);
            };
            input.click();
        };
        doc.appendChild(btn);
    }
}

function setTitleImage(src) {
    const container = document.getElementById('titleImageContainer');
    const img = document.getElementById('titleImage');
    img.src = src;
    container.classList.add('has-image');
    saveToLocalStorage();
}

function deleteTitleImage() {
    const container = document.getElementById('titleImageContainer');
    const img = document.getElementById('titleImage');
    img.src = '';
    container.classList.remove('has-image');
    saveToLocalStorage();
}

function getTitleImageData() {
    const container = document.getElementById('titleImageContainer');
    const img = document.getElementById('titleImage');
    if (container.classList.contains('has-image')) {
        return {
            src: img.src,
            width: img.style.width || '700px'
        };
    }
    return null;
}

// Title image resizing
const titleImage = document.getElementById('titleImage');
titleImage.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = titleImage.clientWidth;
    
    const onMouseMove = (ev) => {
        const newWidth = startWidth + (ev.clientX - startX);
        titleImage.style.width = Math.max(200, Math.min(1000, newWidth)) + 'px';
    };
    
    const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        saveToLocalStorage();
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
});

editBody.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'IMG') {
        e.preventDefault(); // Prevent drag ghost image
        const img = e.target;
        const startX = e.clientX;
        const startWidth = img.clientWidth;
        const onMouseMove = (ev) => img.style.width = (startWidth + (ev.clientX - startX)) + 'px';
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            saveToLocalStorage();
        };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    }
});

// Esc toggles Focus Mode, but lets transient UI (command palette / version history) close first.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cmdPalette && cmdPalette.style.display === 'flex') {
        cmdPalette.style.display = 'none';
        return;
    }
    // UI-14: an open panel drawer is transient UI too — close it before focus mode.
    if (document.body.classList.contains('panel-open')) {
        setPanelOpen(false);
        const menuBtn = document.getElementById('menuBtn');
        if (menuBtn) menuBtn.focus();
        return;
    }
    toggleFocus();
});

const debouncedLocalSave = debounce(saveToLocalStorage, 400);
[editTitle, editBody].forEach(el => el.addEventListener('input', debouncedLocalSave));

// M-1: the first keystroke of each document that actually gets worked on.
[editTitle, editBody].forEach(el => el.addEventListener('input', () => {
    if (firstKeystrokeTracked) return;
    firstKeystrokeTracked = true;
    track('first_keystroke');
}));


init();
attachTitleButton(); // Add + button to title area

// A menu normally lives inside its root — except while it is open in the mobile formatting bar,
// when open() moves it to <body>. Find it in either place.
function dropdownMenuOf(d) {
    return d.querySelector('.dropdown-menu') ||
        (d.id ? document.querySelector(`.dropdown-menu[data-owner="${d.id}"]`) : null);
}

// Shared close/reset for a dropdown root. Undoes the open() positioning and returns a menu that was
// moved to <body> to its root, so the DOM is only perturbed while a menu is actually open.
function closeDropdownRoot(d) {
    d.classList.remove('open');
    const menu = dropdownMenuOf(d);
    const toggle = d.querySelector('.dropdown-toggle');
    if (menu) {
        menu.hidden = true;
        menu.classList.remove('dropdown-menu-fixed');
        menu.style.removeProperty('left');
        menu.style.removeProperty('top');
        menu.style.removeProperty('width');
        if (menu.parentElement !== d) d.appendChild(menu);
    }
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// The mobile formatting bar scrolls horizontally, and a menu anchored to a control inside it would
// be left behind by the scroll, so close whatever is open instead.
function closeOpenDropdowns() {
    document.querySelectorAll('.dropdown.open').forEach(closeDropdownRoot);
}

// Custom dropdown (replaces <select> so the open list can use our palette).
// reset=true: the control is an action menu, so the label reverts to its placeholder.
function initDropdown(root, onSelect, reset, keepSelected) {
    keepSelected = !!keepSelected;
    const toggle = root.querySelector('.dropdown-toggle');
    const menu = root.querySelector('.dropdown-menu');
    const valueEl = root.querySelector('.dropdown-value');
    if (!toggle || !menu || !valueEl) return;
    if (root.id) menu.setAttribute('data-owner', root.id);
    const options = () => Array.from(menu.querySelectorAll('[role="option"]'));
    const placeholder = root.getAttribute('data-placeholder') || '';

    function close() {
        closeDropdownRoot(root);
    }
    function closeOthers() {
        document.querySelectorAll('.dropdown.open').forEach((d) => {
            if (d !== root) closeDropdownRoot(d);
        });
    }
    function open() {
        closeOthers();
        // Inside the mobile formatting bar the menu cannot simply sit next to its toggle: the bar
        // sets `backdrop-filter`, which makes it the containing block for fixed-position
        // descendants, and its `overflow-x: auto` then clips the menu to the 48px bar — it opened
        // but was invisible and untappable. Moving it to <body>, outside every filtered/scrolled
        // ancestor, lets `position: fixed` resolve against the viewport, so the bar serves neither
        // as a clipping box nor as an offset origin, and its horizontal scroll cannot drag the menu
        // out from under the toggle.
        const host = root.closest('.mobile-fmtbar');
        if (host && root.id) {
            const r = toggle.getBoundingClientRect();
            const w = Math.min(Math.max(toggle.offsetWidth || 120, 120), window.innerWidth - 24);
            menu.classList.add('dropdown-menu-fixed');
            menu.style.setProperty('width', `${w}px`);
            menu.style.setProperty('left', `${Math.max(12, Math.min(r.left, window.innerWidth - w - 12))}px`);
            menu.style.setProperty('top', `${r.bottom + 6}px`);
            document.body.appendChild(menu);
        }
        root.classList.add('open');
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
    }
    function choose(li) {
        options().forEach((o) => o.setAttribute('aria-selected', String(o === li)));
        onSelect(li.getAttribute('data-value'), li.textContent.trim());
        if (reset) {
            if (!keepSelected) options().forEach((o) => o.setAttribute('aria-selected', 'false'));
            if (placeholder) valueEl.textContent = placeholder;
        } else {
            if (li.querySelector('svg')) valueEl.innerHTML = li.innerHTML.trim();
            else valueEl.textContent = li.textContent.trim();
        }
        close();
        toggle.focus();
    }

    toggle.addEventListener('click', () => {
        if (root.classList.contains('open')) close(); else open();
    });

    toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!root.classList.contains('open')) open();
            const target = menu.querySelector('[aria-selected="true"]') || options()[0];
            if (target) target.focus();
        }
    });

    menu.addEventListener('click', (e) => {
        const li = e.target.closest('[role="option"]');
        if (li) choose(li);
    });

    menu.addEventListener('keydown', (e) => {
        const list = options();
        const i = list.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.stopPropagation(); close(); toggle.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? list[list.length - 1] : list[i - 1]).focus(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i >= 0) choose(list[i]); }
    });

    // Initialise the toggle label from the currently selected option (for tracking dropdowns).
    if (!reset) {
        const sel = options().find((o) => o.getAttribute('aria-selected') === 'true') || options()[0];
        if (sel) {
            if (sel.querySelector('svg')) valueEl.innerHTML = sel.innerHTML.trim();
            else valueEl.textContent = sel.textContent.trim();
        }
    }

    document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) close();
    });
}

// --- EVENT WIRING (replaces the inline handlers removed for the strict CSP) ---
function wireUI() {
    document.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            switch (btn.getAttribute('data-action')) {
                case 'new-file': newFile(); break;
                case 'open-file': openFile(); break;
                case 'export-md': track('export', { format: 'md' }); exportMarkdown(); break;
                case 'export-pdf': track('export', { format: 'pdf' }); window.print(); break;
                case 'export-txt': track('export', { format: 'txt' }); exportText(); break;

                case 'toggle-focus': toggleFocus(); break;
                case 'toggle-sidebar': toggleSidebar(); break;
                case 'toggle-mode': toggleMode(); break;
            }
        });
    });

    const typoDrop = document.getElementById('typographyDropdown');
    if (typoDrop) {
        // No reset/placeholder: the toggle shows the chosen face (Default, Paperback, ...)
        // rather than a fixed label, so the current typeface is visible without opening the menu.
        initDropdown(typoDrop, (value) => changeTypography(value));
        restoreReadingFont();
    }

    const headingDrop = document.getElementById('headingDropdown');
    if (headingDrop) initDropdown(headingDrop, (value) => applyHeading(value));

    // UI-15: page width dropdown (icon-based selection).
    const widthDrop = document.getElementById('docWidthDropdown');
    if (widthDrop) initDropdown(widthDrop, (value) => setWidth(Number(value)));

    const exportDrop = document.getElementById('exportDropdown');
    if (exportDrop) initDropdown(exportDrop, (value) => handleExport(value), true);

    const fmtInsertDrop = document.getElementById('fmtInsertDropdown');
    if (fmtInsertDrop) initDropdown(fmtInsertDrop, (value) => handleInsert(value), true);

    document.addEventListener('selectionchange', () => { syncHeadingDropdown(); });

    const recentsSearch = document.getElementById('recentsSearch');
    if (recentsSearch) recentsSearch.addEventListener('input', renderRecents);

    document.querySelectorAll('#commandPalette .cmd-item[data-cmd]').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            triggerCmd(item.getAttribute('data-cmd'));
        });
    });

    document.querySelectorAll('[data-format]').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            format(btn.getAttribute('data-format'));
        });
    });

    document.querySelectorAll('[data-insert]').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const kind = btn.getAttribute('data-insert');
            if (kind === 'image') insertImageSlot();
            else if (kind === 'table') insertTable();
            else if (kind === 'codeblock') { document.execCommand('formatBlock', false, 'pre'); saveToLocalStorage(); }
            else if (kind === 'divider') insertDivider();
        });
    });


    // --- Custom tables -------------------------------------------------------------
    // Every handler is delegated from #editBody so tables inserted after load work too.
    let activeTableCell = null;

    function clearTableSelection(exceptWrapper) {
        document.querySelectorAll('.table-wrapper.table-selected').forEach(w => {
            if (w === exceptWrapper) return;
            w.classList.remove('table-selected');
            w.querySelectorAll('th, td').forEach(c => c.classList.remove('resize-active'));
            const overlay = w.querySelector('.resize-overlay');
            if (overlay) overlay.remove();
            const dd = w.querySelector('.table-menu-dropdown');
            if (dd) dd.classList.remove('open');
        });
    }

    function positionHandles(wrapper, cell) {
        let overlay = wrapper.querySelector('.resize-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'resize-overlay';
            overlay.contentEditable = 'false';
            wrapper.appendChild(overlay);
        }
        overlay.innerHTML = '';
        const wr = wrapper.getBoundingClientRect();
        const cr = cell.getBoundingClientRect();
        const v = document.createElement('span');
        v.className = 'resize-v';
        v.contentEditable = 'false';
        v.style.left = (cr.right - wr.left - 6) + 'px';
        v.style.top = (cr.top - wr.top + cr.height / 2 - 8) + 'px';
        const h = document.createElement('span');
        h.className = 'resize-h';
        h.contentEditable = 'false';
        h.style.left = (cr.left - wr.left + cr.width / 2 - 8) + 'px';
        h.style.top = (cr.bottom - wr.top - 6) + 'px';
        overlay.appendChild(v);
        overlay.appendChild(h);

        // The menu button sits on the bottom-right corner of the selected cell.
        const btn = wrapper.querySelector('.table-menu-btn');
        if (btn) {
            btn.style.left = (cr.right - wr.left - 26) + 'px';
            btn.style.top = (cr.bottom - wr.top - 26) + 'px';
            const dd = wrapper.querySelector('.table-menu-dropdown');
            if (dd) {
                dd.style.left = btn.style.left;
                dd.style.top = btn.style.top;
            }
        }
    }

    function selectTableCell(cell) {
        const wrapper = cell.closest('.table-wrapper');
        if (!wrapper) return;
        clearTableSelection(wrapper);
        wrapper.classList.add('table-selected');
        wrapper.querySelectorAll('th, td').forEach(c => c.classList.remove('resize-active'));
        cell.classList.add('resize-active');
        activeTableCell = cell;
        positionHandles(wrapper, cell);
    }

    function cellIndex(cell) {
        return Array.from(cell.parentNode.children).indexOf(cell);
    }

    editBody.addEventListener('click', (e) => {
        if (e.target.closest('.table-menu-btn') || e.target.closest('.table-menu-dropdown')) return;
        const cell = e.target.closest('th, td');
        if (cell && editBody.contains(cell)) {
            selectTableCell(cell);
            return;
        }
        if (!e.target.closest('.table-wrapper')) clearTableSelection(null);
    });

    editBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.table-menu-btn');
        if (btn) {
            e.preventDefault();
            e.stopPropagation();
            const wrapper = btn.closest('.table-wrapper');
            const dd = wrapper && wrapper.querySelector('.table-menu-dropdown');
            if (dd) {
                clearTableSelection(wrapper);
                wrapper.classList.add('table-selected');
                dd.classList.toggle('open');
            }
            return;
        }
        const actionBtn = e.target.closest('.table-menu-dropdown button');
        if (!actionBtn) return;
        e.preventDefault();
        e.stopPropagation();
        const wrapper = actionBtn.closest('.table-wrapper');
        const table = wrapper && wrapper.querySelector('table.editor-table');
        if (!table) return;
        applyTableAction(table, actionBtn.getAttribute('data-action'));
        const dd = wrapper.querySelector('.table-menu-dropdown');
        if (dd) dd.classList.remove('open');
        saveToLocalStorage();
    });

    function colWidth(table, index) {
        const th = table.querySelectorAll('thead th')[index];
        const w = th ? parseFloat(th.style.width) : NaN;
        return isNaN(w) ? 150 : w;
    }

    function applyTableAction(table, action) {
        const headCells = Array.from(table.querySelectorAll('thead th'));
        const colCount = headCells.length || 3;
        const cell = activeTableCell && table.contains(activeTableCell) ? activeTableCell : null;
        const idx = cell ? cellIndex(cell) : null;
        const activeRow = cell ? cell.closest('tr') : table.querySelector('tbody tr');

        if (action === 'insert-row-above' || action === 'insert-row-below') {
            if (!activeRow) return;
            const tr = document.createElement('tr');
            for (let i = 0; i < colCount; i++) {
                const td = document.createElement('td');
                td.innerHTML = '<br>';
                const w = colWidth(table, i);
                td.style.width = w + 'px';
                td.setAttribute('data-w', String(w));
                tr.appendChild(td);
            }
            if (activeRow.parentNode.tagName === 'THEAD') {
                const tbody = table.querySelector('tbody');
                if (tbody) {
                    if (tbody.firstChild) tbody.insertBefore(tr, tbody.firstChild);
                    else tbody.appendChild(tr);
                }
            } else if (action === 'insert-row-above') {
                activeRow.parentNode.insertBefore(tr, activeRow);
            } else {
                activeRow.parentNode.insertBefore(tr, activeRow.nextSibling);
            }
        } else if (action === 'insert-col-left' || action === 'insert-col-right') {
            const at = idx === null ? colCount : (action === 'insert-col-left' ? idx : idx + 1);
            const width = colWidth(table, Math.min(Math.max(at, 0), colCount - 1));
            table.querySelectorAll('tr').forEach(tr => {
                const isHead = tr.parentElement.tagName === 'THEAD';
                const c = document.createElement(isHead ? 'th' : 'td');
                c.innerHTML = '<br>';
                c.style.width = width + 'px';
                c.setAttribute('data-w', String(width));
                const ref = tr.children[at];
                if (ref) tr.insertBefore(c, ref); else tr.appendChild(c);
            });
        } else if (action === 'delete-row') {
            const rowCount = table.querySelectorAll('tbody tr').length;
            if (activeRow && activeRow.parentNode.tagName === 'TBODY' && rowCount > 1) activeRow.remove();
        } else if (action === 'delete-col') {
            if (colCount <= 1) return;
            const at = idx === null ? colCount - 1 : idx;
            table.querySelectorAll('tr').forEach(tr => {
                const c = tr.children[at];
                if (c) c.remove();
            });
        } else if (action === 'delete-table') {
            const wrapper = table.closest('.table-wrapper');
            activeTableCell = null;
            if (wrapper) wrapper.remove();
            else table.remove();
            return;
        }
        activeTableCell = null;
        const wrapper = table.closest('.table-wrapper');
        if (wrapper) {
            const overlay = wrapper.querySelector('.resize-overlay');
            if (overlay) overlay.remove();
        }
        table.querySelectorAll('th, td').forEach(c => c.classList.remove('resize-active'));
    }

    // Pointer drag on the injected resize handles.
    (function setupTableResize() {
        let drag = null;
        editBody.addEventListener('pointerdown', (e) => {
            const handle = e.target.closest('.resize-v, .resize-h');
            if (!handle) return;
            const cell = activeTableCell;
            if (!cell || !cell.isConnected) return;
            e.preventDefault();
            e.stopPropagation();
            const isCol = handle.classList.contains('resize-v');
            const row = cell.closest('tr');
            drag = {
                mode: isCol ? 'col' : 'row',
                cell,
                startX: e.clientX,
                startY: e.clientY,
                startSize: isCol
                    ? (parseFloat(cell.style.width) || cell.offsetWidth)
                    : ((row && row.offsetHeight) || cell.offsetHeight)
            };
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            document.body.style.userSelect = 'none';
            document.body.style.cursor = isCol ? 'col-resize' : 'row-resize';
        }, true);

        document.addEventListener('pointermove', (e) => {
            if (!drag) return;
            if (drag.mode === 'col') {
                const width = Math.max(24, drag.startSize + (e.clientX - drag.startX));
                const table = drag.cell.closest('table');
                const index = cellIndex(drag.cell);
                table.querySelectorAll('tr').forEach(tr => {
                    const c = tr.children[index];
                    if (c) {
                        c.style.width = width + 'px';
                        c.setAttribute('data-w', String(Math.round(width)));
                    }
                });
            } else {
                const height = Math.max(24, drag.startSize + (e.clientY - drag.startY));
                const row = drag.cell.closest('tr');
                if (row) {
                    row.style.height = height + 'px';
                    row.setAttribute('data-h', String(Math.round(height)));
                }
            }
            const wrapper = drag.cell.closest('.table-wrapper');
            if (wrapper) positionHandles(wrapper, drag.cell);
        });

        document.addEventListener('pointerup', () => {
            if (!drag) return;
            drag = null;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            saveToLocalStorage();
        });
    })();

    window.addEventListener('resize', () => {
        if (activeTableCell && activeTableCell.isConnected) {
            const wrapper = activeTableCell.closest('.table-wrapper');
            if (wrapper) positionHandles(wrapper, activeTableCell);
        }
    });

    const tid = document.getElementById('titleImageDelete');
    if (tid) tid.addEventListener('click', deleteTitleImage);


    // UI-13: the Recents row-actions menu. One shared, body-level popover for every row.
    const rowMenu = document.getElementById('rowMenu');
    if (rowMenu) {
        const del = document.getElementById('rowMenuDelete');
        if (del) del.addEventListener('click', () => {
            const id = rowMenuDocId;
            closeRowMenu();
            if (id) deleteRecent(id);
        });
        rowMenu.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); closeRowMenu(true); }
        });
        document.addEventListener('click', (e) => {
            if (!rowMenu.hidden && !rowMenu.contains(e.target)) closeRowMenu();
        });
        // It is positioned in viewport coordinates, so it must not survive a scroll.
        window.addEventListener('scroll', () => { closeRowMenu(); closeOpenDropdowns(); }, true);
    }

    window.addEventListener('resize', () => {
        closeRowMenu();
        closeOpenDropdowns();
    });

    // UI-14: the Formatting section lives in the panel above 1180px and in the fixed bar below it.
    syncLayoutMode(MOBILE_LAYOUT.matches);
    if (MOBILE_LAYOUT.addEventListener) {
        MOBILE_LAYOUT.addEventListener('change', (e) => syncLayoutMode(e.matches));
    }

    const scrim = document.getElementById('panelScrim');
    if (scrim) scrim.addEventListener('click', () => setPanelOpen(false));

    const fmtBar = document.getElementById('mobileFmtBar');
    if (fmtBar) fmtBar.addEventListener('scroll', closeOpenDropdowns, { passive: true });
}

wireUI();
initConnectivityCue();
registerServiceWorker();

/**
 * W-2: say so when the browser is offline. This is a local-first app, so being offline is
 * not an error state — the reassurance is the point: the document keeps saving to this
 * browser either way.
 */
function initConnectivityCue() {
    const el = document.getElementById('netStatus');
    if (!el) return;
    const sync = () => {
        const offline = navigator.onLine === false;
        el.hidden = !offline;
        el.textContent = offline ? 'Offline — saved in this browser' : '';
    };
    window.addEventListener('offline', sync);
    window.addEventListener('online', () => {
        const wasOffline = !el.hidden;
        sync();
        if (wasOffline) toast('Back online');
    });
    sync();
}

/**
 * W-1: register the service worker. Deferred to `load` so it never competes with the first
 * paint, and failures are swallowed on purpose — offline support is a bonus, and the editor
 * is fully functional without a worker.
 */
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => { /* never surface: the editor works without a worker */ });
}
