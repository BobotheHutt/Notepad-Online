/* Notepad Online — icon set (24px stroke icons, injected into [data-icon]). */
(function () {
  'use strict';

  const P = {
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    bold: '<path d="M6 12h8a4 4 0 0 1 0 8H6V4h7a4 4 0 0 1 0 8"/>',
    italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
    underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4M4 20h16"/>',
    strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16"/>',
    color: '<path d="m5 16 7-13 7 13M8 11h8"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    unlink: '<path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71M8 2v3M2 8h3M16 22v-3M22 16h-3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    alignLeft: '<path d="M21 6H3M15 12H3M17 18H3"/>',
    alignCenter: '<path d="M21 6H3M17 12H7M19 18H5"/>',
    alignRight: '<path d="M21 6H3M21 12H9M21 18H7"/>',
    alignJustify: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    bullets: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1.2" fill="currentColor"/><circle cx="4" cy="12" r="1.2" fill="currentColor"/><circle cx="4" cy="18" r="1.2" fill="currentColor"/>',
    numbers: '<path d="M10 6h11M10 12h11M10 18h11M4 4h1v5M4 9h2M6 20H4c0-1.5 2-2.2 2-3.4 0-.8-.6-1.3-1.3-1.3-.5 0-.9.3-1.1.7"/>',
    checklist: '<path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
    indent: '<path d="m3 8 4 4-4 4M21 12H11M21 6H11M21 18H11"/>',
    outdent: '<path d="m7 8-4 4 4 4M21 12H11M21 6H11M21 18H11"/>',
    clear: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/><path d="m3 3 18 18"/>',
    sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    speaker: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    rowAbove: '<rect x="3" y="12" width="18" height="9" rx="1.5"/><path d="M12 2v7M8.5 5.5h7"/>',
    rowBelow: '<rect x="3" y="3" width="18" height="9" rx="1.5"/><path d="M12 15v7M8.5 18.5h7"/>',
    colLeft: '<rect x="12" y="3" width="9" height="18" rx="1.5"/><path d="M2 12h7M5.5 8.5v7"/>',
    colRight: '<rect x="3" y="3" width="9" height="18" rx="1.5"/><path d="M15 12h7M18.5 8.5v7"/>',
    delRow: '<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="m9.5 10.5 5 3M14.5 10.5l-5 3"/>',
    delCol: '<rect x="8" y="3" width="8" height="18" rx="1.5"/><path d="m10.5 9.5 3 5M13.5 9.5l-3 5"/>',
    header: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18" stroke-width="3"/>',
    pointer: '<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
    textCursor: '<path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1M7 22h1a4 4 0 0 0 4-4M7 2h1a4 4 0 0 1 4 4M9 12h6"/>',
    type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
    eraser: '<path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21M22 21H7M5 11l9 9"/>',
    pen: '<path d="M3 17c3-6 5-6 7-2s4 4 7-2 4-6 4-6"/>',
    square: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
    signature: '<path d="M3 16c2-1 3-6 5-6s0 6 2 6 3-7 5-7 1 5 3 5 2-2 3-2M3 21h18"/>',
    zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
    zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>',
    filePlus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 12v6M9 15h6"/>',
    rotateL: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    rotateR: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'
  };

  function svg(name) {
    const body = P[name];
    if (!body) return '';
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  function inject(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone === el.dataset.icon) return;
      el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon));
      el.dataset.iconDone = el.dataset.icon;
    });
  }

  window.NpIcons = { svg, inject };
})();
