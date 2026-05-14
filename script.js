/* ===== MANGELS — Main Script ===== */

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ── IndexedDB ── */
const DB_NAME = 'MangelsDB';
const DB_VER  = 1;
let db;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('pages')) {
        d.createObjectStore('pages', { keyPath: 'id' }); // id = `${mangaId}_${pageIndex}`
      }
      if (!d.objectStoreNames.contains('covers')) {
        d.createObjectStore('covers', { keyPath: 'mangaId' });
      }
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror   = e => rej(e);
  });
}

function idbPut(store, obj) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(obj);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e);
  });
}

function idbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e);
  });
}

function idbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e);
  });
}

function idbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e);
  });
}

function idbDeleteByPrefix(store, prefix) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const objStore = tx.objectStore(store);
    const req = objStore.openCursor();
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        if (String(cursor.key).startsWith(prefix)) cursor.delete();
        cursor.continue();
      } else { res(); }
    };
    req.onerror = e => rej(e);
  });
}

/* ── Library (localStorage) ── */
function getLibrary() {
  try { return JSON.parse(localStorage.getItem('mangels_library') || '[]'); }
  catch { return []; }
}
function saveLibrary(lib) {
  localStorage.setItem('mangels_library', JSON.stringify(lib));
}
function getSettings() {
  try { return JSON.parse(localStorage.getItem('mangels_settings') || '{}'); }
  catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem('mangels_settings', JSON.stringify(s));
}

/* ── App State ── */
let library      = [];
let settings     = { dir: 'rtl', fit: 'contain', showProgress: true, brightness: 100, spreadMode: false };
let currentManga = null;
let currentPage  = 0;
let zoomLevel    = 1;
let isDragging   = false;
let dragStart    = { x: 0, y: 0 };
let panOffset    = { x: 0, y: 0 };
let lastPan      = { x: 0, y: 0 };
let touchStartX  = 0;
let touchStartY  = 0;
let lastTap      = 0;
let uiVisible    = true;
let contextTarget  = null;
let activeFilter   = 'all';
let sortBy         = 'added';
let searchQuery    = '';
let pageCache      = {};
let readingStartTime = null;
let expandedSeries  = new Set();

/* ── DOM refs ── */
const libraryGrid    = document.getElementById('library-grid');
const emptyState     = document.getElementById('empty-state');
const uploadOverlay  = document.getElementById('upload-overlay');
const fileInput      = document.getElementById('file-input');
const dropZone       = document.getElementById('drop-zone');
const progressFill   = document.getElementById('progress-fill');
const progressLabel  = document.getElementById('progress-label');
const uploadProgress = document.getElementById('upload-progress');
const contextMenu    = document.getElementById('context-menu');
const readerImgB     = document.getElementById('reader-img-b');
const readerImg      = document.getElementById('reader-img');
const readerCanvas   = document.getElementById('reader-canvas');
const readerCanvasWrap = document.getElementById('reader-canvas-wrap');
const readerHeader   = document.getElementById('reader-header');
const readerFooter   = document.getElementById('reader-footer');
const readerTitle    = document.getElementById('reader-title');
const readerPageInfo = document.getElementById('reader-page-info');
const pageSlider     = document.getElementById('page-slider');
const footerPage     = document.getElementById('footer-page');
const dirLabel       = document.getElementById('direction-label');
const readerSettings = document.getElementById('reader-settings');
const toastEl        = document.getElementById('toast');
const searchInput    = document.getElementById('search-input');
const recentsList    = document.getElementById('recents-list');

/* ── Toast ── */
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.classList.add('hidden'), 300);
  }, 2200);
}

/* ── Screen navigation ── */
const screens = {
  library: document.getElementById('screen-library'),
  recents: document.getElementById('screen-recents'),
  settings: document.getElementById('screen-settings'),
  reader:  document.getElementById('screen-reader'),
};
const bottomNav = document.getElementById('bottom-nav');

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle('active', k === name);
  });
  if (name === 'reader') {
    bottomNav.style.display = 'none';
  } else {
    bottomNav.style.display = '';
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    if (name === 'recents') renderRecents();
  }
}

/* ── Tab bar ── */
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.tab));
});

/* ── Series detection ── */
function detectSeries(title) {
  const patterns = [
    /^(.+?)\s+[Vv]ol(?:ume)?\.?\s*\d+/,
    /^(.+?)\s+[Cc]h(?:apter)?\.?\s*\d+/,
    /^(.+?)\s+#\d+/,
    /^(.+?)\s+-\s+(?:Vol|Volume|Ch|Chapter)\s*\d+/i,
    /^(.+?)\s+\d+$/,
    /^(.+?)\s+\(\d+\)/,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function groupBySeries(list) {
  const groups = {};
  const standalone = [];
  for (const manga of list) {
    const series = detectSeries(manga.title);
    if (series) {
      if (!groups[series]) groups[series] = [];
      groups[series].push(manga);
    } else {
      standalone.push(manga);
    }
  }
  // Series with only 1 entry → treat as standalone
  Object.entries(groups).forEach(([name, items]) => {
    if (items.length === 1) standalone.push(items[0]);
    else groups[name] = items;
  });
  // Remove singleton groups
  Object.keys(groups).forEach(k => { if (groups[k].length < 2) delete groups[k]; });
  return { groups, standalone };
}

/* ── Library rendering ── */
function getFilteredSorted() {
  let lib = [...library];
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    lib = lib.filter(m => m.title.toLowerCase().includes(q));
  }
  if (activeFilter === 'reading')  lib = lib.filter(m => m.currentPage > 0 && m.currentPage < m.pageCount - 1);
  if (activeFilter === 'unread')   lib = lib.filter(m => m.currentPage === 0);
  if (activeFilter === 'finished') lib = lib.filter(m => m.currentPage >= m.pageCount - 1);

  // Sort
  if (sortBy === 'name')     lib.sort((a,b) => a.title.localeCompare(b.title));
  if (sortBy === 'lastread') lib.sort((a,b) => (b.lastRead || 0) - (a.lastRead || 0));
  if (sortBy === 'progress') lib.sort((a,b) => {
    const pa = a.pageCount > 1 ? a.currentPage / (a.pageCount - 1) : 0;
    const pb = b.pageCount > 1 ? b.currentPage / (b.pageCount - 1) : 0;
    return pb - pa;
  });
  if (sortBy === 'added') lib.sort((a,b) => (b.addedAt || 0) - (a.addedAt || 0));
  return lib;
}

async function buildMangaCard(manga) {
  const card = document.createElement('div');
  card.className = 'manga-card';
  card.dataset.id = manga.id;

  const pct = manga.pageCount > 1
    ? Math.round((manga.currentPage / (manga.pageCount - 1)) * 100)
    : (manga.currentPage >= manga.pageCount - 1 ? 100 : 0);
  const finished = manga.currentPage >= manga.pageCount - 1 && manga.pageCount > 1;

  const coverWrap = document.createElement('div');
  coverWrap.className = 'cover-wrap';

  const coverData = await idbGet('covers', manga.id);
  if (coverData && coverData.blob) {
    const url = URL.createObjectURL(coverData.blob);
    const img = document.createElement('img');
    img.className = 'cover-img';
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    coverWrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'cover-placeholder';
    ph.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg><span>${manga.title}</span>`;
    coverWrap.appendChild(ph);
  }

  const badge = document.createElement('div');
  badge.className = 'cover-badge';
  badge.textContent = manga.type.toUpperCase();
  coverWrap.appendChild(badge);

  if (settings.showProgress && pct > 0) {
    const ps = document.createElement('div'); ps.className = 'progress-strip';
    const pf = document.createElement('div'); pf.className = 'progress-strip-fill';
    pf.style.width = pct + '%'; ps.appendChild(pf); coverWrap.appendChild(ps);
  }
  if (finished) {
    const fo = document.createElement('div'); fo.className = 'finished-overlay';
    fo.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
    coverWrap.appendChild(fo);
  }
  card.appendChild(coverWrap);

  const nameEl = document.createElement('div');
  nameEl.className = 'manga-name';
  nameEl.textContent = manga.title;
  card.appendChild(nameEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'manga-meta';
  const rt = manga.readingTime || 0;
  metaEl.textContent = `${manga.pageCount} pages${rt > 60 ? ' · ' + fmtTime(rt) : ''}`;
  card.appendChild(metaEl);

  card.addEventListener('click', () => openManga(manga.id));
  let pressTimer;
  card.addEventListener('pointerdown', e => { pressTimer = setTimeout(() => showContextMenu(e, manga.id), 550); });
  card.addEventListener('pointerup',   () => clearTimeout(pressTimer));
  card.addEventListener('pointerleave',() => clearTimeout(pressTimer));
  return card;
}

async function renderLibrary() {
  const filtered = getFilteredSorted();
  document.querySelectorAll('.manga-card, .series-group').forEach(c => c.remove());

  if (filtered.length === 0) { emptyState.style.display = ''; return; }
  emptyState.style.display = 'none';

  if (activeFilter === 'series') {
    const { groups, standalone } = groupBySeries(filtered);

    // Render series groups
    for (const [seriesName, items] of Object.entries(groups)) {
      const grp = document.createElement('div');
      grp.className = 'series-group';

      const hdr = document.createElement('div');
      hdr.className = 'series-header';
      const isOpen = expandedSeries.has(seriesName);
      hdr.innerHTML = `
        <div class="series-header-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>
        <div class="series-header-name">${seriesName}</div>
        <div class="series-header-count">${items.length} vols</div>
        <div class="series-chevron ${isOpen ? 'open' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg></div>`;
      grp.appendChild(hdr);

      const grid = document.createElement('div');
      grid.className = `series-grid${isOpen ? '' : ' collapsed'}`;
      if (!isOpen) grid.style.maxHeight = '0';
      hdr.addEventListener('click', () => {
        const chevron = hdr.querySelector('.series-chevron');
        if (expandedSeries.has(seriesName)) {
          expandedSeries.delete(seriesName);
          chevron.classList.remove('open');
          grid.style.maxHeight = grid.scrollHeight + 'px';
          requestAnimationFrame(() => { grid.style.maxHeight = '0'; });
        } else {
          expandedSeries.add(seriesName);
          chevron.classList.add('open');
          grid.style.maxHeight = '0';
          requestAnimationFrame(() => { grid.style.maxHeight = grid.scrollHeight + 'px'; });
        }
      });
      for (const m of items) grid.appendChild(await buildMangaCard(m));
      grp.appendChild(grid);
      libraryGrid.appendChild(grp);
    }

    for (const m of standalone) libraryGrid.appendChild(await buildMangaCard(m));
  } else {
    for (const manga of filtered) libraryGrid.appendChild(await buildMangaCard(manga));
  }
}

/* ── Filter buttons ── */
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderLibrary();
  });
});

/* ── Search ── */
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  renderLibrary();
});

/* ── Upload flow ── */
function openUploadSheet() {
  uploadOverlay.classList.remove('hidden');
  uploadProgress.classList.add('hidden');
  progressFill.style.width = '0%';
}
function closeUploadSheet() {
  uploadOverlay.classList.add('hidden');
}

document.getElementById('btn-upload-top').addEventListener('click', openUploadSheet);
document.getElementById('btn-upload-empty').addEventListener('click', openUploadSheet);
document.getElementById('close-upload').addEventListener('click', closeUploadSheet);
uploadOverlay.addEventListener('click', e => { if (e.target === uploadOverlay) closeUploadSheet(); });

fileInput.addEventListener('change', () => handleFiles(Array.from(fileInput.files)));

/* ── URL import ── */
document.getElementById('btn-url-import').addEventListener('click', importFromURL);
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') importFromURL();
});

async function importFromURL() {
  const raw = document.getElementById('url-input').value.trim();
  if (!raw) { showToast('Paste a URL first'); return; }

  let url;
  try { url = new URL(raw); } catch { showToast('Invalid URL'); return; }

  const ext = url.pathname.split('.').pop().toLowerCase();
  if (!['cbz','cbr','pdf'].includes(ext)) {
    showToast('URL must point to a CBZ, CBR, or PDF file');
    return;
  }

  uploadProgress.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Connecting…';

  let blob;
  try {
    const resp = await fetch(raw);
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

    const total = parseInt(resp.headers.get('content-length') || '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        const dlPct = Math.round((received / total) * 70);
        progressFill.style.width = dlPct + '%';
        progressLabel.textContent = `Downloading… ${Math.round(received / 1024)}KB${total ? ' / ' + Math.round(total / 1024) + 'KB' : ''}`;
      } else {
        progressLabel.textContent = `Downloading… ${Math.round(received / 1024)} KB`;
      }
    }

    blob = new Blob(chunks);
  } catch (err) {
    uploadProgress.classList.add('hidden');
    if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
      showToast('Download blocked — server may not allow cross-origin requests');
    } else {
      showToast('Download failed: ' + err.message);
    }
    return;
  }

  const filename = decodeURIComponent(url.pathname.split('/').pop()) || `import.${ext}`;
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

  progressFill.style.width = '70%';
  progressLabel.textContent = `Processing ${filename}…`;

  try {
    await processMangaFile(file, pct => {
      progressFill.style.width = (70 + pct * 0.3) + '%';
    });
  } catch (err) {
    console.error(err);
    showToast('Failed to process file');
    uploadProgress.classList.add('hidden');
    return;
  }

  progressFill.style.width = '100%';
  progressLabel.textContent = 'Done!';
  document.getElementById('url-input').value = '';
  await renderLibrary();
  setTimeout(() => closeUploadSheet(), 800);
  showToast(`Added ${filename.replace(/\.[^.]+$/, '')}`);
}
document.getElementById('file-label')?.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(Array.from(e.dataTransfer.files));
});

async function handleFiles(files) {
  const valid = files.filter(f => /\.(cbz|cbr|pdf)$/i.test(f.name));
  if (!valid.length) { showToast('No supported files found'); return; }

  uploadProgress.classList.remove('hidden');

  for (let i = 0; i < valid.length; i++) {
    const file = valid[i];
    progressLabel.textContent = `Processing ${file.name}…`;
    progressFill.style.width = ((i / valid.length) * 100) + '%';
    try {
      await processMangaFile(file, (pct) => {
        progressFill.style.width = ((i / valid.length) * 100 + pct / valid.length) + '%';
      });
    } catch (err) {
      console.error(err);
      showToast(`Failed: ${file.name}`);
    }
  }

  progressFill.style.width = '100%';
  progressLabel.textContent = 'Done!';
  await renderLibrary();
  setTimeout(() => closeUploadSheet(), 800);
  showToast(`Added ${valid.length} manga`);
}

async function processMangaFile(file, onProgress) {
  const ext  = file.name.split('.').pop().toLowerCase();
  const id   = 'manga_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const title = file.name.replace(/\.[^.]+$/, '');

  let pages = []; // array of Blobs

  if (ext === 'pdf') {
    pages = await extractPDF(file, onProgress);
  } else if (ext === 'cbz') {
    pages = await extractCBZ(file, onProgress);
  } else if (ext === 'cbr') {
    pages = await extractCBR(file, onProgress);
  }

  if (!pages.length) throw new Error('No pages extracted');

  // Store pages in IDB
  for (let i = 0; i < pages.length; i++) {
    await idbPut('pages', { id: `${id}_${i}`, blob: pages[i] });
    onProgress(Math.round(((i + 1) / pages.length) * 100));
  }

  // Store cover
  await idbPut('covers', { mangaId: id, blob: pages[0] });

  // Metadata
  const manga = {
    id, title, type: ext,
    pageCount: pages.length,
    currentPage: 0,
    addedAt: Date.now(),
    lastRead: null,
  };
  library.unshift(manga);
  saveLibrary(library);
}

/* ── PDF extraction ── */
async function extractPDF(file, onProgress) {
  const url = URL.createObjectURL(file);
  const pdf = await pdfjsLib.getDocument(url).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement('canvas');
    canvas.width  = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
    pages.push(blob);
    onProgress(Math.round((i / pdf.numPages) * 100));
  }
  URL.revokeObjectURL(url);
  return pages;
}

/* ── CBZ extraction ── */
async function extractCBZ(file, onProgress) {
  const zip = await JSZip.loadAsync(file);
  const imageExts = /\.(jpe?g|png|webp|gif|avif)$/i;
  let entries = Object.values(zip.files)
    .filter(f => !f.dir && imageExts.test(f.name))
    .sort((a, b) => naturalSort(a.name, b.name));

  const pages = [];
  for (let i = 0; i < entries.length; i++) {
    const data = await entries[i].async('blob');
    pages.push(data);
    onProgress(Math.round(((i + 1) / entries.length) * 100));
  }
  return pages;
}

/* ── CBR extraction ── */
async function extractCBR(file, onProgress) {
  // RAR files: attempt basic RAR parsing
  // Many "CBR" files are actually ZIP files renamed — try that first
  try {
    const pages = await extractCBZ(file, onProgress);
    if (pages.length > 0) return pages;
  } catch {}

  // Check RAR signature and attempt extraction via unrar.js if available
  const buf = await file.arrayBuffer();
  const sig = new Uint8Array(buf.slice(0, 7));
  const isRar5 = sig[0]===0x52 && sig[1]===0x61 && sig[2]===0x72 && sig[3]===0x21;

  if (!isRar5) throw new Error('Unrecognized CBR format');

  // Try loading unrar-js dynamically
  try {
    const script = await loadScript('https://cdn.jsdelivr.net/npm/node-unrar-js@2.0.0/dist/js/unrar.min.js');
    const extractor = await window.createExtractorFromData({ data: new Uint8Array(buf) });
    const imageExts = /\.(jpe?g|png|webp|gif)$/i;
    const list = extractor.getFileList();
    const fileHeaders = [...list.fileHeaders].filter(h => imageExts.test(h.flags.name)).sort((a,b) => naturalSort(a.flags.name, b.flags.name));
    const pages = [];
    for (let i = 0; i < fileHeaders.length; i++) {
      const extracted = extractor.extract({ files: [fileHeaders[i].flags.name] });
      const files = [...extracted.files];
      if (files[0] && files[0].extraction) {
        const blob = new Blob([files[0].extraction], { type: 'image/jpeg' });
        pages.push(blob);
      }
      onProgress(Math.round(((i + 1) / fileHeaders.length) * 100));
    }
    return pages;
  } catch (e) {
    console.warn('unrar-js failed:', e);
    throw new Error('CBR/RAR extraction failed. Try converting to CBZ.');
  }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

/* ── Natural sort ── */
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/* ── Context menu ── */
function showContextMenu(e, mangaId) {
  contextTarget = mangaId;
  const x = Math.min(e.clientX, window.innerWidth - 220);
  const y = Math.min(e.clientY, window.innerHeight - 160);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top  = y + 'px';
  contextMenu.classList.remove('hidden');
}

document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
});

document.getElementById('ctx-read').addEventListener('click', () => {
  contextMenu.classList.add('hidden');
  if (contextTarget) openManga(contextTarget);
});

document.getElementById('ctx-info').addEventListener('click', () => {
  contextMenu.classList.add('hidden');
  if (contextTarget) openMetaSheet(contextTarget);
});

document.getElementById('ctx-mark-read').addEventListener('click', () => {
  contextMenu.classList.add('hidden');
  if (!contextTarget) return;
  const m = library.find(x => x.id === contextTarget);
  if (m) { m.currentPage = m.pageCount - 1; saveLibrary(library); renderLibrary(); showToast('Marked as read'); }
});

document.getElementById('ctx-delete').addEventListener('click', async () => {
  contextMenu.classList.add('hidden');
  if (!contextTarget) return;
  const idx = library.findIndex(x => x.id === contextTarget);
  if (idx === -1) return;
  const id = contextTarget;
  library.splice(idx, 1);
  saveLibrary(library);
  await idbDeleteByPrefix('pages', id + '_');
  await idbDelete('covers', id);
  clearPageCache();
  renderLibrary();
  showToast('Manga deleted');
});

/* ── Reading time helpers ── */
function fmtTime(secs) {
  if (secs < 60)   return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs/60)}m`;
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
function startReadingTimer() { readingStartTime = Date.now(); }
function stopReadingTimer() {
  if (!readingStartTime || !currentManga) return;
  const elapsed = Math.round((Date.now() - readingStartTime) / 1000);
  if (elapsed > 3) {
    currentManga.readingTime = (currentManga.readingTime || 0) + elapsed;
    if (!currentManga.sessionsCount) currentManga.sessionsCount = 0;
    currentManga.sessionsCount++;
    saveLibrary(library);
  }
  readingStartTime = null;
}

/* ── Open manga / Reader ── */
async function openManga(id) {
  const manga = library.find(m => m.id === id);
  if (!manga) return;
  currentManga = manga;
  currentPage  = manga.currentPage || 0;
  zoomLevel    = 1;
  panOffset    = { x: 0, y: 0 };
  clearPageCache();

  readerTitle.textContent = manga.title;
  pageSlider.max = manga.pageCount - 1;
  pageSlider.value = currentPage;
  dirLabel.textContent = settings.dir.toUpperCase();
  document.querySelectorAll('.tog-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.dir === settings.dir);
  });
  document.querySelectorAll('.fit-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.fit === settings.fit);
  });
  applyFit();
  applySpread();

  showScreen('reader');
  showUI(true);
  await loadPage(currentPage);

  manga.lastRead = Date.now();
  saveLibrary(library);
  startReadingTimer();
}

function clearPageCache() {
  Object.values(pageCache).forEach(url => URL.revokeObjectURL(url));
  pageCache = {};
}

async function getPageURL(index) {
  if (pageCache[index]) return pageCache[index];
  const data = await idbGet('pages', `${currentManga.id}_${index}`);
  if (!data) return null;
  const url = URL.createObjectURL(data.blob);
  pageCache[index] = url;
  // Pre-load adjacent pages
  [index - 1, index + 1].forEach(adj => {
    if (adj >= 0 && adj < currentManga.pageCount && !pageCache[adj]) {
      idbGet('pages', `${currentManga.id}_${adj}`).then(d => {
        if (d) pageCache[adj] = URL.createObjectURL(d.blob);
      });
    }
  });
  return url;
}

async function loadPage(index) {
  if (!currentManga) return;
  index = Math.max(0, Math.min(index, currentManga.pageCount - 1));

  let spinner = readerCanvasWrap.querySelector('.spin-overlay');
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.className = 'spin-overlay';
    spinner.innerHTML = '<div class="spinner"></div>';
    readerCanvasWrap.appendChild(spinner);
  }

  const url = await getPageURL(index);
  if (url) {
    readerImg.src = url;
    readerImg.classList.remove('hidden');
    readerCanvas.classList.add('hidden');
  }

  // Spread mode: load second page
  const isSpread = settings.spreadMode && currentManga.pageCount > 1;
  if (isSpread && index + 1 < currentManga.pageCount) {
    const url2 = await getPageURL(index + 1);
    if (url2) { readerImgB.src = url2; readerImgB.classList.remove('hidden'); }
    else readerImgB.classList.add('hidden');
  } else {
    readerImgB.classList.add('hidden');
    readerImgB.src = '';
  }

  readerImg.onload = () => { spinner?.remove(); applyZoomPan(); };
  if (readerImg.complete) { spinner?.remove(); applyZoomPan(); }

  currentPage = index;
  pageSlider.value = index;
  const step = isSpread ? 2 : 1;
  const displayEnd = Math.min(index + step, currentManga.pageCount);
  footerPage.textContent = isSpread && displayEnd > index + 1
    ? `Pages ${index + 1}–${displayEnd}`
    : `Page ${index + 1}`;
  readerPageInfo.textContent = `${index + 1} / ${currentManga.pageCount}`;

  currentManga.currentPage = index;
  saveLibrary(library);

  const flash = document.getElementById('page-flash');
  flash.classList.remove('hidden');
  setTimeout(() => flash.classList.add('hidden'), 300);
}

/* ── Spread mode ── */
function applySpread() {
  const on = settings.spreadMode;
  readerCanvasWrap.classList.toggle('spread', on);
  document.getElementById('btn-spread').classList.toggle('active-btn', on);
  if (!on) { readerImgB.classList.add('hidden'); readerImgB.src = ''; }
}

document.getElementById('btn-spread').addEventListener('click', () => {
  settings.spreadMode = !settings.spreadMode;
  saveSettings(settings);
  applySpread();
  loadPage(currentPage);
});

/* ── Navigation ── */
// Forward = next page in story = always higher page index
function navigateForward() {
  if (!currentManga) return;
  const step = settings.spreadMode ? 2 : 1;
  if (currentPage < currentManga.pageCount - 1) loadPage(currentPage + step);
  else showToast('Last page');
}

// Backward = previous page in story = always lower page index
function navigateBackward() {
  if (!currentManga) return;
  const step = settings.spreadMode ? 2 : 1;
  if (currentPage > 0) loadPage(currentPage - step);
  else showToast('First page');
}

// Visual left (← arrow / left tap / left swipe):
//   RTL manga → forward in story (next page)
//   LTR manga → backward in story (previous page)
function onVisualLeft() {
  settings.dir === 'rtl' ? navigateForward() : navigateBackward();
}

// Visual right (→ arrow / right tap / right swipe): opposite
function onVisualRight() {
  settings.dir === 'rtl' ? navigateBackward() : navigateForward();
}

/* ── Tap zones ── */
document.getElementById('tap-left').addEventListener('click', () => onVisualLeft());
document.getElementById('tap-right').addEventListener('click', () => onVisualRight());
document.getElementById('tap-center').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastTap < 300) {
    // double tap: reset zoom
    zoomLevel = 1; panOffset = { x: 0, y: 0 }; applyZoomPan();
  } else {
    toggleUI();
  }
  lastTap = now;
});

/* ── UI visibility ── */
function toggleUI() { showUI(!uiVisible); }
function showUI(val) {
  uiVisible = val;
  readerHeader.classList.toggle('hidden-ui', !val);
  readerFooter.classList.toggle('hidden-ui', !val);
}

/* ── Zoom ── */
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  zoomLevel = Math.min(zoomLevel + 0.3, 5);
  applyZoomPan();
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  zoomLevel = Math.max(zoomLevel - 0.3, 0.5);
  if (zoomLevel <= 1) { panOffset = { x: 0, y: 0 }; }
  applyZoomPan();
});

function applyZoomPan() {
  readerCanvasWrap.style.transform = `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`;
}

function applyFit() {
  readerImg.className = 'reader-img';
  if (settings.fit === 'width')  readerImg.classList.add('fit-width');
  if (settings.fit === 'height') readerImg.classList.add('fit-height');
}

/* ── Pinch-to-zoom ── */
let initialPinchDist = null;
let initialZoom = 1;

const viewport = document.getElementById('reader-viewport');

viewport.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    initialPinchDist = getPinchDist(e.touches);
    initialZoom = zoomLevel;
  } else if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    lastPan = { ...panOffset };
  }
}, { passive: true });

viewport.addEventListener('touchmove', e => {
  if (e.touches.length === 2 && initialPinchDist !== null) {
    const dist = getPinchDist(e.touches);
    zoomLevel = Math.max(0.5, Math.min(5, initialZoom * (dist / initialPinchDist)));
    applyZoomPan();
  } else if (e.touches.length === 1 && zoomLevel > 1) {
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    panOffset = { x: lastPan.x + dx, y: lastPan.y + dy };
    applyZoomPan();
  }
}, { passive: true });

viewport.addEventListener('touchend', e => {
  if (e.touches.length < 2) initialPinchDist = null;
});

function getPinchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ── Mouse drag pan ── */
viewport.addEventListener('mousedown', e => {
  if (zoomLevel <= 1) return;
  isDragging = true;
  dragStart  = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  viewport.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  panOffset = { x: e.clientX - dragStart.x, y: e.clientY - dragStart.y };
  applyZoomPan();
});
window.addEventListener('mouseup', () => {
  isDragging = false;
  viewport.style.cursor = '';
});

/* ── Swipe gestures (for page turn at zoom=1) ── */
let swipeStartX = 0;
let swipeStartY = 0;
viewport.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }
}, { passive: true });

viewport.addEventListener('touchend', e => {
  if (zoomLevel > 1.05) return;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
    if (dx < 0) onVisualLeft();   // swipe left  = visual left
    else        onVisualRight();  // swipe right = visual right
  }
}, { passive: true });

/* ── Page slider ── */
pageSlider.addEventListener('input', () => {
  const p = parseInt(pageSlider.value);
  loadPage(p);
});

/* ── Direction toggle ── */
document.getElementById('footer-direction').addEventListener('click', () => {
  settings.dir = settings.dir === 'rtl' ? 'ltr' : 'rtl';
  dirLabel.textContent = settings.dir.toUpperCase();
  saveSettings(settings);
  document.querySelectorAll('.tog-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.dir === settings.dir);
  });
});

/* ── Back button ── */
document.getElementById('btn-back').addEventListener('click', () => {
  stopReadingTimer();
  showScreen('library');
  renderLibrary();
  clearPageCache();
  currentManga = null;
});

window.addEventListener('beforeunload', () => stopReadingTimer());

/* ── Reader settings panel ── */
document.getElementById('btn-settings').addEventListener('click', () => {
  readerSettings.classList.toggle('hidden');
});
document.addEventListener('click', e => {
  if (!readerSettings.classList.contains('hidden') &&
      !readerSettings.contains(e.target) &&
      e.target !== document.getElementById('btn-settings')) {
    readerSettings.classList.add('hidden');
  }
});

document.querySelectorAll('.tog-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.dataset.dir) return;
    settings.dir = btn.dataset.dir;
    dirLabel.textContent = settings.dir.toUpperCase();
    saveSettings(settings);
    document.querySelectorAll('.tog-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.dir === settings.dir));
  });
});
document.querySelectorAll('.fit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.fit = btn.dataset.fit;
    saveSettings(settings);
    applyFit();
    document.querySelectorAll('.fit-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.fit === settings.fit));
  });
});
document.getElementById('brightness-slider').addEventListener('input', e => {
  settings.brightness = parseInt(e.target.value);
  viewport.style.filter = `brightness(${settings.brightness / 100})`;
  saveSettings(settings);
});

/* ── Global settings screen ── */
document.querySelectorAll('[data-global-dir]').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.dir = btn.dataset.globalDir;
    saveSettings(settings);
    document.querySelectorAll('[data-global-dir]').forEach(b =>
      b.classList.toggle('active', b.dataset.globalDir === settings.dir));
  });
});
document.querySelectorAll('[data-global-fit]').forEach(btn => {
  btn.addEventListener('click', () => {
    settings.fit = btn.dataset.globalFit;
    saveSettings(settings);
    document.querySelectorAll('[data-global-fit]').forEach(b =>
      b.classList.toggle('active', b.dataset.globalFit === settings.fit));
  });
});
document.getElementById('toggle-progress').addEventListener('change', e => {
  settings.showProgress = e.target.checked;
  saveSettings(settings);
  renderLibrary();
});
document.getElementById('btn-clear-all').addEventListener('click', () => {
  if (!confirm('This will delete ALL manga and progress data. Are you sure?')) return;
  library = [];
  saveLibrary(library);
  clearPageCache();
  const tx1 = db.transaction('pages', 'readwrite');
  tx1.objectStore('pages').clear();
  const tx2 = db.transaction('covers', 'readwrite');
  tx2.objectStore('covers').clear();
  renderLibrary();
  renderRecents();
  showToast('Library cleared');
});

/* ── Sort buttons ── */
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    sortBy = btn.dataset.sort;
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === sortBy));
    renderLibrary();
  });
});

/* ── Metadata sheet ── */
async function openMetaSheet(mangaId) {
  const manga = library.find(m => m.id === mangaId);
  if (!manga) return;

  document.getElementById('meta-title').textContent = manga.title;
  document.getElementById('meta-format-badge').textContent = manga.type.toUpperCase();

  const series = detectSeries(manga.title);
  const seriesEl = document.getElementById('meta-series-name');
  seriesEl.textContent = series ? `Series: ${series}` : '';

  const pct = manga.pageCount > 1 ? Math.round((manga.currentPage / (manga.pageCount - 1)) * 100) : 0;
  document.getElementById('meta-progress-fill').style.width = pct + '%';
  document.getElementById('meta-progress-label').textContent = pct + '%';

  const rt = manga.readingTime || 0;
  const pagesRead = manga.currentPage || 0;
  const ppm = rt > 0 && pagesRead > 0 ? (pagesRead / (rt / 60)).toFixed(1) : '—';
  const pagesLeft = manga.pageCount - pagesRead;
  const etaSecs = rt > 0 && pagesRead > 0 ? Math.round(pagesLeft / (pagesRead / rt)) : 0;

  document.getElementById('mstat-pages').textContent = manga.pageCount;
  document.getElementById('mstat-time').textContent  = rt > 60 ? fmtTime(rt) : (rt > 0 ? `${rt}s` : '—');
  document.getElementById('mstat-eta').textContent   = etaSecs > 60 ? fmtTime(etaSecs) : (etaSecs > 0 ? `${etaSecs}s` : '—');
  document.getElementById('mstat-added').textContent = manga.addedAt ? new Date(manga.addedAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'2-digit'}) : '—';
  document.getElementById('mstat-lastread').textContent = manga.lastRead ? timeAgo(manga.lastRead) : 'Never';
  document.getElementById('mstat-ppm').textContent  = ppm;

  const coverData = await idbGet('covers', manga.id);
  const coverImg = document.getElementById('meta-cover-img');
  const coverPh  = document.getElementById('meta-cover-ph');
  if (coverData && coverData.blob) {
    const url = URL.createObjectURL(coverData.blob);
    coverImg.src = url;
    coverImg.classList.remove('hidden');
    coverPh.classList.add('hidden');
    coverImg.onload = () => URL.revokeObjectURL(url);
  } else {
    coverImg.classList.add('hidden');
    coverPh.classList.remove('hidden');
  }

  document.getElementById('meta-read-btn').onclick = () => {
    closeMetaSheet();
    openManga(mangaId);
  };

  document.getElementById('meta-overlay').classList.remove('hidden');
}

function closeMetaSheet() {
  document.getElementById('meta-overlay').classList.add('hidden');
}

document.getElementById('close-meta').addEventListener('click', closeMetaSheet);
document.getElementById('meta-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('meta-overlay')) closeMetaSheet();
});

/* ── Recents ── */
function renderRecents() {
  recentsList.innerHTML = '';
  const recent = [...library]
    .filter(m => m.lastRead)
    .sort((a, b) => b.lastRead - a.lastRead)
    .slice(0, 20);

  if (!recent.length) {
    recentsList.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><p class="empty-title">No recent reads</p><p class="empty-sub">Start reading to see your history here</p></div>';
    return;
  }

  recent.forEach(async manga => {
    const item = document.createElement('div');
    item.className = 'recent-item';

    const coverData = await idbGet('covers', manga.id);
    if (coverData && coverData.blob) {
      const url = URL.createObjectURL(coverData.blob);
      const img = document.createElement('img');
      img.className = 'recent-thumb';
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      item.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'recent-thumb-ph';
      ph.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;
      item.appendChild(ph);
    }

    const info = document.createElement('div');
    info.className = 'recent-info';
    const pct = manga.pageCount > 1 ? Math.round((manga.currentPage / (manga.pageCount - 1)) * 100) : 0;
    info.innerHTML = `
      <div class="recent-name">${manga.title}</div>
      <div class="recent-page">Page ${manga.currentPage + 1} of ${manga.pageCount} · ${pct}%</div>
      <div class="recent-time">${timeAgo(manga.lastRead)}</div>
    `;
    item.appendChild(info);

    const arr = document.createElement('div');
    arr.className = 'recent-arrow';
    arr.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`;
    item.appendChild(arr);

    item.addEventListener('click', () => openManga(manga.id));
    recentsList.appendChild(item);
  });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)   return 'Just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', e => {
  if (!currentManga) return;
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); onVisualLeft(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); onVisualRight(); }
  if (e.key === 'Escape') { document.getElementById('btn-back').click(); }
  if (e.key === '+' || e.key === '=') { zoomLevel = Math.min(zoomLevel + 0.3, 5); applyZoomPan(); }
  if (e.key === '-') { zoomLevel = Math.max(zoomLevel - 0.3, 0.5); if (zoomLevel <= 1) panOffset = {x:0,y:0}; applyZoomPan(); }
  if (e.key === '0') { zoomLevel = 1; panOffset = {x:0,y:0}; applyZoomPan(); }
});

/* ── Init ── */
async function init() {
  await openDB();
  library  = getLibrary();
  const saved = getSettings();
  Object.assign(settings, saved);

  document.getElementById('toggle-progress').checked = settings.showProgress !== false;
  document.getElementById('brightness-slider').value = settings.brightness || 100;

  document.querySelectorAll('[data-global-dir]').forEach(b =>
    b.classList.toggle('active', b.dataset.globalDir === settings.dir));
  document.querySelectorAll('[data-global-fit]').forEach(b =>
    b.classList.toggle('active', b.dataset.globalFit === settings.fit));

  await renderLibrary();
}

init().catch(console.error);
