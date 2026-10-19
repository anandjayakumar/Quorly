/* Quorly storage layer — DD-03.
 *
 * The library (parked snapshots, version history and their images) lives in IndexedDB; the
 * document that is open right now keeps its original localStorage keys, unchanged. That split is
 * deliberate: localStorage is synchronous, so the editor can always read and write the live
 * document without waiting for anything, including on the very first paint.
 *
 * Everything here is asynchronous. With one exception — `isIDB()`, because callers need to know
 * whether to bother extracting images — nothing outside this file knows which backend is in use.
 *
 * Two rules hold this together:
 *
 *   1. The DOM and every export path only ever see inline `data:` URLs. A `quorly-blob:<hash>`
 *      reference exists only inside an IndexedDB record and is turned back into a `data:` URL
 *      before the record is handed to a caller. (`img-src` in /_headers does not allow `blob:`,
 *      and layout must not depend on a URL that can be revoked.)
 *   2. Nothing is deleted before its replacement is durable. A document parked before the library
 *      moved is read through from localStorage, written to IndexedDB, and only then is the
 *      localStorage copy removed — so an interrupted migration loses nothing.
 *
 * Where a record already exists in IndexedDB the localStorage copy is ignored; where it does not,
 * the localStorage copy is adopted on first read. That makes `migrate()` an optimisation rather
 * than a requirement: a document the user never opens is moved by it, and one that is opened
 * before it has run is moved by the read-through instead.
 */
(function () {
    'use strict';

    const DB_NAME = 'quorly';
    const DB_VERSION = 1;
    const STORE_SNAPSHOTS = 'snapshots';
    const STORE_VERSIONS = 'versions';
    const STORE_BLOBS = 'blobs';
    const SCHEMA = 2;

    // The original localStorage keys. This module owns them so that no caller has to know which
    // backend is in use, and so the fallback path exists in exactly one place.
    const LS_SNAPSHOT_PREFIX = 'quorly_file_';
    const LS_VERSIONS_PREFIX = 'quorly_versions_';

    const BLOB_SCHEME = 'quorly-blob:';
    // Only base64 image payloads are extracted. Everything the editor produces comes from
    // canvas.toDataURL(), which is always base64; anything else is left inline rather than
    // guessed at. A base64 body can never contain a quote or a space, so plain textual
    // substitution is safe wherever the URL appears (attribute, style, markdown).
    const DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
    const BLOB_REF_RE = /quorly-blob:[0-9a-f]+/g;

    let db = null;
    let mode = 'pending'; // 'pending' | 'idb' | 'ls'
    let openPromise = null;
    let openReason = '';
    let sweepTimer = null;

    // data URL -> {hash, mime, bytes} for images seen this session. Re-hashing and re-decoding the
    // same 200 KB image on every autosave would be pure waste; the cap stops the map holding an
    // unbounded number of large strings.
    const refCache = new Map();
    const REF_CACHE_MAX = 24;

    // --- small helpers -----------------------------------------------------------------

    function lsGet(key) {
        try { return localStorage.getItem(key); } catch (err) { return null; }
    }

    function lsRemove(key) {
        try { localStorage.removeItem(key); } catch (err) { /* nothing useful to do */ }
    }

    function requestResult(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
        });
    }

    function transactionDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(true);
            tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
            tx.onerror = () => reject(tx.error || new Error('transaction failed'));
        });
    }

    function hex(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
        return out;
    }

    function parseDataURL(url) {
        const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.*)$/i.exec(url);
        if (!m) return null;
        let binary;
        try { binary = atob(m[2]); } catch (err) { return null; }
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return { mime: m[1].toLowerCase(), bytes: bytes };
    }

    // Chunked: a multi-megabyte image would blow the argument limit of fromCharCode.apply.
    function base64FromBytes(bytes) {
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    async function hashBytes(bytes) {
        // crypto.subtle needs a secure context: always present on https and on localhost, so this
        // only matters for a page opened from disk. The fallback is a 64-bit FNV-1a.
        if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
            try {
                const digest = await window.crypto.subtle.digest('SHA-256', bytes);
                return hex(new Uint8Array(digest));
            } catch (err) { /* fall through to the non-crypto hash */ }
        }
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (let i = 0; i < bytes.length; i++) {
            h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
            h2 = Math.imul(h2 ^ ((bytes[i] + i) & 0xff), 0x85ebca6b) >>> 0;
        }
        return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
    }

    // --- open -------------------------------------------------------------------------

    function open() {
        if (openPromise) return openPromise;
        openPromise = new Promise((resolve) => {
            if (typeof indexedDB === 'undefined' || !indexedDB) {
                mode = 'ls';
                openReason = 'no-indexeddb';
                resolve(mode);
                return;
            }
            let settled = false;
            const settle = (value, reason) => {
                if (settled) return;
                settled = true;
                mode = value;
                if (reason) openReason = reason;
                resolve(value);
            };

            let req;
            try {
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (err) {
                settle('ls', 'open-threw');
                return;
            }

            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains(STORE_SNAPSHOTS)) {
                    d.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
                }
                if (!d.objectStoreNames.contains(STORE_VERSIONS)) {
                    const store = d.createObjectStore(STORE_VERSIONS, { keyPath: 'id', autoIncrement: true });
                    store.createIndex('byDoc', 'docId', { unique: false });
                }
                if (!d.objectStoreNames.contains(STORE_BLOBS)) {
                    d.createObjectStore(STORE_BLOBS, { keyPath: 'hash' });
                }
            };
            req.onsuccess = () => {
                db = req.result;
                // Another tab is waiting to upgrade. Close so it can, and let the next operation
                // reopen: a stale connection must never block the library.
                db.onversionchange = () => {
                    try { db.close(); } catch (err) { /* already closed */ }
                    db = null;
                    openPromise = null;
                    mode = 'pending';
                };
                settle('idb');
            };
            req.onerror = () => settle('ls', 'open-error');
            // A blocked open is the only fallback worth reasoning about: it means another tab holds
            // an older version of this database open. It is self-resolving, because the handler
            // above closes a connection the moment a newer version is wanted — and a tab running a
            // build from before the library existed holds no connection at all. So this is
            // insurance rather than a normal path. It is bounded anyway: hanging on a promise that
            // never settles would stall every autosave, and `announceBackend()` tells the user
            // which mode they are in instead of leaving the app quietly degraded.
            req.onblocked = () => { openReason = 'blocked'; };
            setTimeout(() => settle('ls', 'open-timeout'), 8000);
        });
        return openPromise;
    }

    function isIDB() { return mode === 'idb' && !!db; }

    function store(name, txnMode) {
        return db.transaction(name, txnMode || 'readonly').objectStore(name);
    }

    // --- images: data URL <-> stored blob ---------------------------------------------

    async function putBlob(dataURL) {
        const cached = refCache.get(dataURL);
        if (cached) return cached;
        const parsed = parseDataURL(dataURL);
        if (!parsed) return null;
        const hash = await hashBytes(parsed.bytes);
        const record = { hash: hash, mime: parsed.mime, bytes: parsed.bytes.length };
        try {
            const tx = db.transaction(STORE_BLOBS, 'readwrite');
            tx.objectStore(STORE_BLOBS).put({
                hash: record.hash,
                mime: record.mime,
                bytes: record.bytes,
                blob: new Blob([parsed.bytes], { type: parsed.mime }),
            });
            await transactionDone(tx);
        } catch (err) {
            return null;
        }
        if (refCache.size >= REF_CACHE_MAX) refCache.delete(refCache.keys().next().value);
        refCache.set(dataURL, record);
        return record;
    }

    async function getBlob(hash) {
        try {
            const rec = await requestResult(store(STORE_BLOBS).get(hash));
            return rec || null;
        } catch (err) {
            return null;
        }
    }

    async function dataURLsToRefs(text) {
        if (typeof text !== 'string' || text.indexOf('data:image') === -1) return text;
        const urls = Array.from(new Set(text.match(DATA_IMAGE_RE) || []));
        if (!urls.length) return text;
        const refs = new Map();
        for (const url of urls) {
            const rec = await putBlob(url);
            if (rec) refs.set(url, BLOB_SCHEME + rec.hash);
        }
        if (!refs.size) return text;
        return text.replace(DATA_IMAGE_RE, (m) => refs.get(m) || m);
    }

    async function refsToDataURLs(text) {
        if (typeof text !== 'string' || text.indexOf(BLOB_SCHEME) === -1) return text;
        const refs = Array.from(new Set(text.match(BLOB_REF_RE) || []));
        const urls = new Map();
        for (const ref of refs) {
            const rec = await getBlob(ref.slice(BLOB_SCHEME.length));
            if (rec && rec.blob) {
                const bytes = new Uint8Array(await rec.blob.arrayBuffer());
                urls.set(ref, 'data:' + rec.mime + ';base64,' + base64FromBytes(bytes));
            } else {
                // Leave the reference in place rather than substituting a blank image: a broken
                // picture is the honest signal, and the blob store should never lose a live one.
                console.warn('Quorly: a stored image is missing; leaving its reference in place.', ref);
            }
        }
        if (!urls.size) return text;
        return text.replace(BLOB_REF_RE, (m) => urls.get(m) || m);
    }

    // A record with every inline image moved into the blob store. Text-only records are returned
    // untouched, so the common case never parses or copies anything.
    async function extractImages(record) {
        const out = Object.assign({}, record);
        if (typeof out.body === 'string') out.body = await dataURLsToRefs(out.body);
        if (out.titleImage && typeof out.titleImage.src === 'string') {
            const src = await dataURLsToRefs(out.titleImage.src);
            out.titleImage = Object.assign({}, out.titleImage, { src: src });
        }
        return out;
    }

    async function hydrateImages(record) {
        const out = Object.assign({}, record);
        if (typeof out.body === 'string') out.body = await refsToDataURLs(out.body);
        if (out.titleImage && typeof out.titleImage.src === 'string') {
            const src = await refsToDataURLs(out.titleImage.src);
            out.titleImage = Object.assign({}, out.titleImage, { src: src });
        }
        return out;
    }

    // --- snapshots --------------------------------------------------------------------

    function lsSnapshot(id) {
        const raw = lsGet(LS_SNAPSHOT_PREFIX + id);
        if (raw === null) return null;
        try { return JSON.parse(raw); } catch (err) { return null; }
    }

    function lsWriteSnapshot(id, snapshot) {
        try {
            localStorage.setItem(LS_SNAPSHOT_PREFIX + id, JSON.stringify(snapshot));
            return true;
        } catch (err) {
            return false;
        }
    }

    async function getSnapshot(id) {
        if (!isIDB()) return lsSnapshot(id);
        try {
            const rec = await requestResult(store(STORE_SNAPSHOTS).get(id));
            if (rec) return await hydrateImages(rec);
        } catch (err) {
            console.warn('Quorly: could not read a parked document.', err);
        }
        // Read-through: a document parked before the library moved lives in localStorage only.
        return adoptSnapshot(id);
    }

    // Adopt a localStorage snapshot. Only ever called when IndexedDB has no record for this id.
    async function adoptSnapshot(id) {
        const rec = lsSnapshot(id);
        if (!rec) return null;
        if (await putSnapshot(id, rec)) lsRemove(LS_SNAPSHOT_PREFIX + id);
        // The in-memory record already has inline images, which is what the caller needs.
        return rec;
    }

    async function putSnapshot(id, snapshot) {
        if (!isIDB()) return lsWriteSnapshot(id, snapshot);
        let rec;
        try {
            rec = await extractImages(snapshot);
        } catch (err) {
            return false;
        }
        rec.id = id;
        rec.schema = SCHEMA;
        try {
            const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
            tx.objectStore(STORE_SNAPSHOTS).put(rec);
            await transactionDone(tx);
        } catch (err) {
            return false;
        }
        // The new copy is durable, so the localStorage original is now the stale duplicate.
        lsRemove(LS_SNAPSHOT_PREFIX + id);
        return true;
    }

    async function deleteSnapshot(id) {
        lsRemove(LS_SNAPSHOT_PREFIX + id);
        if (!isIDB()) return true;
        try {
            const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
            tx.objectStore(STORE_SNAPSHOTS).delete(id);
            await transactionDone(tx);
            return true;
        } catch (err) {
            return false;
        }
    }

    // --- version history --------------------------------------------------------------

    function lsVersions(docId) {
        try {
            const list = JSON.parse(lsGet(LS_VERSIONS_PREFIX + docId) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (err) {
            return [];
        }
    }

    function lsWriteVersions(docId, list) {
        try {
            localStorage.setItem(LS_VERSIONS_PREFIX + docId, JSON.stringify(list));
            return true;
        } catch (err) {
            return false;
        }
    }

    async function versionsFor(docId) {
        const recs = await requestResult(store(STORE_VERSIONS).index('byDoc').getAll(docId));
        return Array.isArray(recs) ? recs : [];
    }

    async function extractVersion(docId, version) {
        const rec = await extractImages({
            timestamp: version.timestamp || Date.now(),
            title: version.title || 'Untitled',
            body: version.body || '',
            titleImage: version.titleImage || null,
            wordCount: version.wordCount || 0,
        });
        rec.docId = docId;
        rec.schema = SCHEMA;
        return rec;
    }

    async function hydrateVersion(rec) {
        const out = await hydrateImages(rec);
        // The stored bookkeeping (id, docId, schema) is not part of the version shape the app uses.
        return {
            timestamp: out.timestamp,
            title: out.title,
            body: out.body,
            titleImage: out.titleImage || null,
            wordCount: out.wordCount || 0,
        };
    }

    async function listVersions(docId) {
        if (!docId) return [];
        if (!isIDB()) return lsVersions(docId);
        let recs = [];
        try {
            recs = await versionsFor(docId);
        } catch (err) {
            console.warn('Quorly: could not read version history.', err);
        }
        if (recs.length) {
            recs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            const out = [];
            for (const rec of recs) out.push(await hydrateVersion(rec));
            return out;
        }
        return adoptVersions(docId);
    }

    // Adopt a localStorage version list. Only ever called when IndexedDB has none for this
    // document, so the put cannot duplicate anything.
    async function adoptVersions(docId) {
        const list = lsVersions(docId);
        if (!list.length) return list;
        const records = [];
        for (const v of list) records.push(await extractVersion(docId, v));
        // Every await is done before the transaction opens: an IndexedDB transaction commits as
        // soon as the microtask queue drains with no request pending, so awaiting inside one is
        // how you get a "transaction is not active" error.
        try {
            const tx = db.transaction(STORE_VERSIONS, 'readwrite');
            const s = tx.objectStore(STORE_VERSIONS);
            for (const rec of records) s.put(rec);
            await transactionDone(tx);
        } catch (err) {
            return list;
        }
        lsRemove(LS_VERSIONS_PREFIX + docId);
        return list;
    }

    async function appendVersion(docId, version, max) {
        if (!docId) return false;
        if (!isIDB()) {
            const list = lsVersions(docId);
            list.push(version);
            while (list.length > max) list.shift();
            return lsWriteVersions(docId, list);
        }
        const rec = await extractVersion(docId, version);
        try {
            const tx = db.transaction(STORE_VERSIONS, 'readwrite');
            tx.objectStore(STORE_VERSIONS).put(rec);
            await transactionDone(tx);
        } catch (err) {
            return false;
        }
        await pruneVersions(docId, max);
        return true;
    }

    async function pruneVersions(docId, keep) {
        if (!docId) return true;
        if (!isIDB()) {
            const list = lsVersions(docId);
            if (list.length <= keep) return true;
            return lsWriteVersions(docId, list.slice(-keep));
        }
        let recs;
        try {
            recs = await versionsFor(docId);
        } catch (err) {
            return false;
        }
        if (recs.length <= keep) return true;
        recs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const dead = recs.slice(0, recs.length - keep).map((r) => r.id);
        try {
            const tx = db.transaction(STORE_VERSIONS, 'readwrite');
            const s = tx.objectStore(STORE_VERSIONS);
            for (const id of dead) s.delete(id);
            await transactionDone(tx);
            return true;
        } catch (err) {
            return false;
        }
    }

    async function deleteVersions(docId) {
        lsRemove(LS_VERSIONS_PREFIX + docId);
        if (!isIDB() || !docId) return true;
        try {
            const recs = await versionsFor(docId);
            if (recs.length) {
                const tx = db.transaction(STORE_VERSIONS, 'readwrite');
                const s = tx.objectStore(STORE_VERSIONS);
                for (const rec of recs) s.delete(rec.id);
                await transactionDone(tx);
            }
            return true;
        } catch (err) {
            return false;
        }
    }

    // --- housekeeping ------------------------------------------------------------------

    async function evict(ids) {
        for (const id of ids) {
            await deleteSnapshot(id);
            await deleteVersions(id);
        }
        scheduleSweep();
        return ids.length;
    }

    // Move everything an index still points at out of localStorage. Safe to run repeatedly and
    // never required for correctness: reads adopt on their own.
    async function migrate(indexIds) {
        await open();
        if (!isIDB()) return { backend: 'ls', adopted: 0 };
        let adopted = 0;
        for (const id of (Array.isArray(indexIds) ? indexIds : [])) {
            if (!id) continue;
            try {
                if (lsGet(LS_SNAPSHOT_PREFIX + id) !== null && await adoptSnapshot(id)) adopted += 1;
                if (lsGet(LS_VERSIONS_PREFIX + id) !== null) {
                    const existing = await versionsFor(id);
                    if (!existing.length && await adoptVersions(id)) adopted += 1;
                }
            } catch (err) {
                console.warn('Quorly: could not move a document into the library.', err);
            }
        }
        return { backend: 'idb', adopted: adopted };
    }

    function collectRefs(store, into) {
        return new Promise((resolve, reject) => {
            const req = store.openCursor();
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) { resolve(); return; }
                const rec = cursor.value || {};
                const sources = [rec.body, rec.titleImage && rec.titleImage.src];
                for (const src of sources) {
                    if (typeof src !== 'string' || src.indexOf(BLOB_SCHEME) === -1) continue;
                    const found = src.match(/quorly-blob:[0-9a-f]+/g) || [];
                    for (const ref of found) into.add(ref.slice(BLOB_SCHEME.length));
                }
                cursor.continue();
            };
        });
    }

    // Delete blobs no stored record references. Only ever safe because snapshots and versions are
    // the complete list of things that can hold a reference.
    async function sweepBlobs() {
        await open();
        if (!isIDB()) return 0;
        const used = new Set();
        try {
            const tx = db.transaction([STORE_SNAPSHOTS, STORE_VERSIONS], 'readonly');
            await Promise.all([
                collectRefs(tx.objectStore(STORE_SNAPSHOTS), used),
                collectRefs(tx.objectStore(STORE_VERSIONS), used),
            ]);
        } catch (err) {
            return 0;
        }
        let keys;
        try {
            keys = await requestResult(store(STORE_BLOBS).getAllKeys());
        } catch (err) {
            return 0;
        }
        const dead = (keys || []).filter((k) => !used.has(k));
        if (!dead.length) return 0;
        try {
            const tx = db.transaction(STORE_BLOBS, 'readwrite');
            const s = tx.objectStore(STORE_BLOBS);
            for (const k of dead) s.delete(k);
            await transactionDone(tx);
        } catch (err) {
            return 0;
        }
        return dead.length;
    }

    // Sweeping reads every stored body, so it is deliberately late and idle.
    function scheduleSweep() {
        if (sweepTimer !== null) return;
        sweepTimer = setTimeout(() => {
            sweepTimer = null;
            const run = () => { sweepBlobs().catch(() => { /* housekeeping only */ }); };
            if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
            else run();
        }, 3000);
    }

    async function estimate() {
        if (!navigator.storage || !navigator.storage.estimate) return null;
        try { return await navigator.storage.estimate(); } catch (err) { return null; }
    }

    async function persist() {
        if (!navigator.storage || !navigator.storage.persist) return false;
        try { return await navigator.storage.persist(); } catch (err) { return false; }
    }

    // Whether the browser has already agreed to keep this origin's data. Chrome answers this from
    // engagement, so it can be true without this app ever having asked.
    async function persisted() {
        if (!navigator.storage || !navigator.storage.persisted) return false;
        try { return await navigator.storage.persisted(); } catch (err) { return false; }
    }

    window.QuorlyStore = {
        open: open,
        isIDB: isIDB,
        backend: function () { return mode; },
        openReason: function () { return openReason; },

        getSnapshot: getSnapshot,
        putSnapshot: putSnapshot,
        deleteSnapshot: deleteSnapshot,
        evict: evict,

        listVersions: listVersions,
        appendVersion: appendVersion,
        pruneVersions: pruneVersions,
        deleteVersions: deleteVersions,

        migrate: migrate,
        sweepBlobs: sweepBlobs,
        estimate: estimate,
        persist: persist,
        persisted: persisted,
    };
})();
