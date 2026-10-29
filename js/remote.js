/* Noteshack — files from files.noteshack.org (translation models, fonts).

   Each is downloaded once, checked against its SHA-256 as downloaded, kept in
   the browser (Cache Storage, under the caller's cache name) for next time,
   and unpacked (gzip) here.

   NpRemote.kept(url, cache)                      Promise<whether it is kept>
   NpRemote.get(file, cache, onBytes, messages)   Promise<ArrayBuffer>, unpacked
     file: { url, size, sha }; onBytes(n) as it arrives;
     messages: { failed(status), damaged } for the errors */
(function () {
  'use strict';

  async function keptCopy(url, cache) {
    try { return await (await caches.open(cache)).match(url); } catch (e) { return null; }
  }

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

  async function get(f, cache, onBytes, messages) {
    const tell = onBytes || (() => {});
    const k = await keptCopy(f.url, cache);
    let gz = k ? await k.arrayBuffer() : null;
    if (gz) tell(f.size);
    else {
      const res = await fetch(f.url, { credentials: 'omit' });
      if (!res.ok) throw new Error(messages.failed(String(res.status)));
      const chunks = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        tell(got);
      }
      gz = await new Blob(chunks).arrayBuffer();
      if (hex(await crypto.subtle.digest('SHA-256', gz)) !== f.sha) throw new Error(messages.damaged);
      try { await (await caches.open(cache)).put(f.url, new Response(gz, { headers: { 'content-type': 'application/gzip' } })); } catch (e) { /* used this time only */ }
    }
    return new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  window.NpRemote = { kept: async (url, cache) => !!(await keptCopy(url, cache)), get };
})();
