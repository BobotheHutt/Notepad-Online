/* Notepad Online — Markdown in and out.
   NpMarkdown.toHtml(md)   → HTML (run it through NpSanitize before use)
   NpMarkdown.fromDom(el)  → Markdown for the editor's content */
(function () {
  'use strict';

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ================= Markdown → HTML ================= */

  const RE = {
    blank: /^\s*$/,
    fence: /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/,
    heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s{0,3}>/,
    item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
  };

  function inline(src) {
    const keep = [];
    const stash = (html) => '\u0000' + (keep.push(html) - 1) + '\u0000';
    let s = src;
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_, c) => stash(esc(c)));
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, t, c) => stash('<code>' + esc(c.trim()) + '</code>'));
    s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, u) => stash('<a href="' + esc(u) + '">' + esc(u) + '</a>'));
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g,
      (_, alt, url) => stash('<img src="' + url + '" alt="' + alt + '">'));
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g, (_, text, url) => '<a href="' + url + '">' + text + '</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, (_, pre, url) => pre + '<a href="' + url + '">' + url + '</a>');
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
    s = s.replace(/(?: {2,}|\\)\n/g, '<br>').replace(/\n/g, ' ');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  }

  function startsBlock(line) {
    return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.item.test(line);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  }

  function parseList(lines, i) {
    const first = lines[i].match(RE.item);
    const base = first[1].length;
    const ordered = /\d/.test(first[2]);
    const start = ordered ? parseInt(first[2], 10) : 1;
    const items = [];
    let cur = null;
    while (i < lines.length) {
      const line = lines[i];
      if (RE.blank.test(line)) {
        let j = i + 1;
        while (j < lines.length && RE.blank.test(lines[j])) j++;
        const nm = j < lines.length && lines[j].match(RE.item);
        const indented = j < lines.length && /^\s+/.test(lines[j]) && (lines[j].match(/^\s*/)[0].length > base);
        if ((nm && nm[1].length >= base) || indented) { if (cur) cur.sub.push(''); i = j; continue; }
        break;
      }
      const m = line.match(RE.item);
      const indent = line.match(/^\s*/)[0].length;
      if (m && indent === base) {
        if (/\d/.test(m[2]) !== ordered) break;
        cur = { text: m[3], sub: [] };
        items.push(cur);
      } else if ((m && indent > base) || (!m && indent > base)) {
        if (!cur) break;
        cur.sub.push(line);
      } else if (!m && cur && !startsBlock(line)) {
        cur.text += '\n' + line.trim(); // lazy continuation
      } else {
        break;
      }
      i++;
    }

    const isTask = items.some((it) => /^\[[ xX]\]\s+/.test(it.text));
    let html = ordered
      ? '<ol' + (start !== 1 ? ' start="' + start + '"' : '') + '>'
      : '<ul' + (isTask ? ' class="checklist"' : '') + '>';
    for (const it of items) {
      let text = it.text;
      let attr = '';
      const tm = text.match(/^\[([ xX])\]\s+/);
      if (isTask) {
        attr = ' data-checked="' + (tm && tm[1] !== ' ' ? 'true' : 'false') + '"';
        if (tm) text = text.slice(tm[0].length);
      }
      const subLines = it.sub;
      while (subLines.length && RE.blank.test(subLines[subLines.length - 1])) subLines.pop();
      let sub = '';
      if (subLines.length) {
        const min = Math.min(...subLines.filter((l) => !RE.blank.test(l)).map((l) => l.match(/^\s*/)[0].length));
        sub = parseBlocks(subLines.map((l) => l.slice(Math.min(min, l.match(/^\s*/)[0].length))));
      }
      html += '<li' + attr + '>' + inline(text) + sub + '</li>';
    }
    html += ordered ? '</ol>' : '</ul>';
    return [html, i];
  }

  function parseBlocks(lines) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (RE.blank.test(line)) { i++; continue; }

      if ((m = line.match(RE.fence))) {
        const close = m[1];
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(close[0].repeat(close.length)) && lines[i].trim().replace(/[`~]/g, '') === '')) {
          body.push(lines[i]);
          i++;
        }
        i++;
        html += '<pre>' + esc(body.join('\n')) + '</pre>';
        continue;
      }
      if ((m = line.match(RE.heading))) {
        const n = m[1].length;
        html += '<h' + n + '>' + inline(m[2]) + '</h' + n + '>';
        i++;
        continue;
      }
      if (RE.hr.test(line)) { html += '<hr>'; i++; continue; }
      if (RE.quote.test(line)) {
        const body = [];
        while (i < lines.length && RE.quote.test(lines[i])) {
          body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        html += '<blockquote>' + parseBlocks(body) + '</blockquote>';
        continue;
      }
      if (RE.item.test(line)) {
        const [h, next] = parseList(lines, i);
        html += h;
        i = next;
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
        i += 2;
        const cell = (tag, c, k) => '<' + tag + (aligns[k] ? ' style="text-align: ' + aligns[k] + ';"' : '') + '>' + (inline(c) || '<br>') + '</' + tag + '>';
        let t = '<table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>';
        while (i < lines.length && lines[i].includes('|') && !RE.blank.test(lines[i])) {
          const cells = splitRow(lines[i]);
          t += '<tr>' + head.map((_, k) => cell('td', cells[k] || '', k)).join('') + '</tr>';
          i++;
        }
        html += t + '</tbody></table>';
        continue;
      }
      const para = [line];
      i++;
      while (i < lines.length && !RE.blank.test(lines[i]) && !startsBlock(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html += '<p>' + inline(para.join('\n').trim()) + '</p>';
    }
    return html;
  }

  function toHtml(md) {
    return parseBlocks(String(md || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
  }

  /* ================= DOM → Markdown ================= */

  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR']);

  const mdEscape = (s) => s.replace(/([\\`*_[\]])/g, '\\$1');

  function wrap(inner, mark) {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!m[2]) return inner;
    return m[1] + mark + m[2] + mark + m[3];
  }

  function isBold(el) {
    const w = el.style && el.style.fontWeight;
    return el.tagName === 'B' || el.tagName === 'STRONG' || w === 'bold' || parseInt(w, 10) >= 600;
  }
  function isItalic(el) { return el.tagName === 'I' || el.tagName === 'EM' || (el.style && el.style.fontStyle === 'italic'); }
  function isStrike(el) {
    const d = el.style ? (el.style.textDecorationLine || el.style.textDecoration || '') : '';
    return ['S', 'STRIKE', 'DEL'].includes(el.tagName) || d.includes('line-through');
  }

  function inlineMd(node) {
    if (node.nodeType === 3) return mdEscape(node.nodeValue.replace(/ /g, ' '));
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName;
    if (tag === 'BR') return '  \n';
    if (tag === 'IMG') return '![' + (el.getAttribute('alt') || '').replace(/[[\]]/g, '') + '](' + el.getAttribute('src') + ')';
    if (tag === 'CODE') return '`' + el.textContent + '`';
    let inner = Array.from(el.childNodes).map(inlineMd).join('');
    if (tag === 'A' && el.getAttribute('href')) return '[' + inner + '](' + el.getAttribute('href').replace(/\)/g, '%29') + ')';
    if (tag === 'SUP' || tag === 'SUB') return '<' + tag.toLowerCase() + '>' + inner + '</' + tag.toLowerCase() + '>';
    if (isStrike(el)) inner = wrap(inner, '~~');
    if (isItalic(el)) inner = wrap(inner, '*');
    if (isBold(el)) inner = wrap(inner, '**');
    return inner;
  }

  function list(el, depth) {
    const ordered = el.tagName === 'OL';
    const check = el.classList.contains('checklist');
    let n = parseInt(el.getAttribute('start'), 10) || 1;
    const pad = '   '.repeat(depth);
    const out = [];
    for (const child of el.children) {
      if (child.tagName === 'UL' || child.tagName === 'OL') { out.push(list(child, depth + 1)); continue; }
      if (child.tagName !== 'LI') continue;
      let marker = ordered ? (n++) + '. ' : '- ';
      if (check) marker += child.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ';
      const text = [];
      const nested = [];
      for (const c of child.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(list(c, depth + 1));
        else if (c.nodeType === 1 && BLOCK.has(c.tagName)) text.push(Array.from(c.childNodes).map(inlineMd).join(''));
        else text.push(inlineMd(c));
      }
      out.push(pad + marker + text.join(' ').replace(/ {2}\n/g, ' ').trim());
      out.push(...nested);
    }
    return out.join('\n');
  }

  function table(el) {
    const rows = Array.from(el.rows).map((r) => Array.from(r.cells).map((c) => blocks(c).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()));
    if (!rows.length) return '';
    const cols = Math.max(...rows.map((r) => r.length));
    const line = (r) => '| ' + Array.from({ length: cols }, (_, k) => r[k] || '').join(' | ') + ' |';
    return [line(rows[0]), '| ' + Array(cols).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
  }

  function blocks(container) {
    const parts = [];
    let buf = [];
    const flush = () => {
      const s = buf.map(inlineMd).join('').replace(/ {2}\n$/, '');
      if (s.trim()) parts.push(s.trim());
      buf = [];
    };
    for (const node of container.childNodes) {
      if (node.nodeType !== 1 || !BLOCK.has(node.tagName)) { buf.push(node); continue; }
      flush();
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag)) parts.push('#'.repeat(+tag[1]) + ' ' + Array.from(node.childNodes).map(inlineMd).join('').trim());
      else if (tag === 'PRE') parts.push('```\n' + node.textContent.replace(/\n$/, '') + '\n```');
      else if (tag === 'BLOCKQUOTE') {
        const inner = blocks(node);
        if (NpSanitize.isIndentQuote(node)) parts.push(inner);
        else parts.push(inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
      } else if (tag === 'UL' || tag === 'OL') parts.push(list(node, 0));
      else if (tag === 'TABLE') parts.push(table(node));
      else if (tag === 'HR') parts.push('---');
      else { const inner = blocks(node); if (inner) parts.push(inner); }
    }
    flush();
    return parts.join('\n\n');
  }

  function fromDom(root) {
    return blocks(root).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  window.NpMarkdown = { toHtml, fromDom };
})();
