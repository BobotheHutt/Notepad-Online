/* Noteshack — document storage.
   IndexedDB holds documents and their version history. It has room for
   images (localStorage tops out around 5 MB). If IndexedDB is unavailable
   (some private windows), everything lives in memory for the session and
   NpStore.persistent is false so the app can warn. */
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
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => {
          const d = r.result;
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

  async function allDocs() {
    if (!db) return Array.from(mem.docs.values()).map((d) => Object.assign({}, d));
    return req(db.transaction('docs').objectStore('docs').getAll());
  }

  async function getDoc(id) {
    if (!db) return mem.docs.has(id) ? Object.assign({}, mem.docs.get(id)) : null;
    return (await req(db.transaction('docs').objectStore('docs').get(id))) || null;
  }

  async function putDoc(doc) {
    if (!db) { mem.docs.set(doc.id, Object.assign({}, doc)); return; }
    const tx = db.transaction('docs', 'readwrite');
    tx.objectStore('docs').put(doc);
    await done(tx);
  }

  async function deleteDoc(id) {
    if (!db) {
      mem.docs.delete(id);
      mem.versions = mem.versions.filter((v) => v.docId !== id);
      return;
    }
    const tx = db.transaction(['docs', 'versions'], 'readwrite');
    tx.objectStore('docs').delete(id);
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

  window.NpStore = {
    open,
    get persistent() { return !!db; },
    allDocs, getDoc, putDoc, deleteDoc,
    addVersion, listVersions, getVersion
  };
})();
