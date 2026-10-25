/* Noteshack — document storage.
   IndexedDB holds documents and their version history. It has room for
   images (localStorage tops out around 5 MB). If IndexedDB is unavailable
   (some private windows), everything lives in memory for the session and
   NpStore.persistent is false so the app can warn.
   A PDF's original file (its sources) is kept in a store of its own and
   written only when it changes, not on every save of the edits; records
   come back without it, and getSources fetches it when the PDF is opened.
   The link to a file on disk that Save writes to (a FileSystemFileHandle,
   Chrome and Edge only) is kept apart too, and read only when Save needs
   it, never while the app starts. */
(function () {
  'use strict';

  const DB_NAME = 'notepad-online';
  const KEEP_VERSIONS = 40;

  let db = null;
  const mem = { docs: new Map(), versions: [], seq: 1 };

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    });
  }

  async function open() {
    if (!('indexedDB' in window)) return false;
    try {
      db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 3);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('handles')) d.createObjectStore('handles');
          if (!d.objectStoreNames.contains('sources')) d.createObjectStore('sources');
          if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('versions')) {
            const v = d.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true });
            v.createIndex('docId', 'docId');
          }
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('blocked'));
      });
      db.onversionchange = () => db.close();
      return true;
    } catch (e) {
      db = null;
      return false;
    }
  }

  // the sources last written for each document, and how many there were
  // (pages inserted from another PDF add to the same list)
  const written = new Map();

  async function allDocs() {
    if (!db) return Array.from(mem.docs.values()).map((d) => Object.assign({}, d));
    return req(db.transaction('docs').objectStore('docs').getAll());
  }

  async function getDoc(id) {
    if (!db) return mem.docs.has(id) ? Object.assign({}, mem.docs.get(id)) : null;
    return (await req(db.transaction('docs').objectStore('docs').get(id))) || null;
  }

  // A PDF's original file. A record saved before sources had a store of
  // their own still carries them, and moves them there on its next save.
  async function getSources(doc) {
    if (doc.sources) return doc.sources;
    if (!db) return null;
    const src = (await req(db.transaction('sources').objectStore('sources').get(doc.id))) || null;
    if (src) written.set(doc.id, { src, n: src.length });
    return src;
  }

  async function putDoc(doc) {
    if (!db) { mem.docs.set(doc.id, Object.assign({}, doc)); return; }
    const src = doc.sources;
    const w = written.get(doc.id);
    const fresh = src && !(w && w.src === src && w.n === src.length);
    const tx = db.transaction(fresh ? ['docs', 'sources'] : 'docs', 'readwrite');
    if (src) {
      const rec = Object.assign({}, doc);
      delete rec.sources;
      tx.objectStore('docs').put(rec);
      if (fresh) tx.objectStore('sources').put(src, doc.id);
    } else tx.objectStore('docs').put(doc);
    await done(tx);
    if (fresh) written.set(doc.id, { src, n: src.length });
  }

  async function deleteDoc(id) {
    if (!db) {
      mem.docs.delete(id);
      mem.versions = mem.versions.filter((v) => v.docId !== id);
      return;
    }
    const tx = db.transaction(['docs', 'versions', 'sources', 'handles'], 'readwrite');
    tx.objectStore('docs').delete(id);
    tx.objectStore('sources').delete(id);
    tx.objectStore('handles').delete(id);
    written.delete(id);
    const idx = tx.objectStore('versions').index('docId');
    idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { tx.objectStore('versions').delete(c.primaryKey); c.continue(); }
    };
    await done(tx);
  }

  async function addVersion(docId, html, title, reason) {
    const v = { docId, html, title, reason: reason || '', time: Date.now() };
    if (!db) {
      v.vid = mem.seq++;
      mem.versions.push(v);
      const mine = mem.versions.filter((x) => x.docId === docId);
      if (mine.length > KEEP_VERSIONS) {
        const drop = new Set(mine.slice(0, mine.length - KEEP_VERSIONS).map((x) => x.vid));
        mem.versions = mem.versions.filter((x) => !drop.has(x.vid));
      }
      return;
    }
    const tx = db.transaction('versions', 'readwrite');
    const store = tx.objectStore('versions');
    store.add(v);
    const keys = await req(store.index('docId').getAllKeys(IDBKeyRange.only(docId)));
    keys.sort((a, b) => a - b);
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_VERSIONS))) store.delete(k);
    await done(tx);
  }

  // Newest first, without the HTML (that can be large); fetch one with getVersion.
  async function listVersions(docId) {
    let list;
    if (!db) list = mem.versions.filter((v) => v.docId === docId);
    else list = await req(db.transaction('versions').objectStore('versions').index('docId').getAll(IDBKeyRange.only(docId)));
    return list.map((v) => ({ vid: v.vid, time: v.time, title: v.title, reason: v.reason, size: v.html.length })).sort((a, b) => b.time - a.time);
  }

  async function getVersion(vid) {
    if (!db) return mem.versions.find((v) => v.vid === vid) || null;
    return (await req(db.transaction('versions').objectStore('versions').get(vid))) || null;
  }

  // the file on disk a document saves to; null removes it
  const handles = new Map(); // this visit's, so a Save need not read storage
  async function putHandle(id, handle) {
    if (handle) handles.set(id, handle); else handles.delete(id);
    if (!db) return;
    const tx = db.transaction('handles', 'readwrite');
    if (handle) tx.objectStore('handles').put(handle, id); else tx.objectStore('handles').delete(id);
    await done(tx);
  }
  async function getHandle(id) {
    if (handles.has(id) || !db) return handles.get(id) || null;
    const h = (await req(db.transaction('handles').objectStore('handles').get(id))) || null;
    if (h) handles.set(id, h);
    return h;
  }

  window.NpStore = {
    open,
    get persistent() { return !!db; },
    allDocs, getDoc, getSources, putDoc, deleteDoc, putHandle, getHandle,
    addVersion, listVersions, getVersion
  };
})();
