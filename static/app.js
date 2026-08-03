/* Bookarr — frontend SPA (i18n via static/locales/{de,en}.json) */
"use strict";

/* ============ i18n ============ */
const SUPPORTED_LANGS = ["de", "en"];
let LANG = (localStorage.getItem("bookarr_lang") || (navigator.language || "de").slice(0, 2).toLowerCase());
if (!SUPPORTED_LANGS.includes(LANG)) LANG = "de";

let CATALOG = {};          // current language
let FALLBACK_CATALOG = {}; // "de" fallback

function lookup(cat, key) {
  let cur = cat;
  for (const p of key.split(".")) {
    if (!cur || typeof cur !== "object" || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function t(key, params = {}) {
  let val = lookup(CATALOG, key);
  if (val === undefined) val = lookup(FALLBACK_CATALOG, key);
  if (val === undefined) return key;
  if (typeof val === "string") {
    for (const [k, v] of Object.entries(params)) {
      val = val.split("{" + k + "}").join(v);
    }
  }
  return val;
}

async function loadCatalog(lang) {
  try {
    const [main, fb] = await Promise.all([
      fetch(`static/locales/${lang}.json`).then(r => r.json()),
      fetch("static/locales/de.json").then(r => r.json()),
    ]);
    CATALOG = main;
    FALLBACK_CATALOG = fb;
  } catch (e) {
    CATALOG = FALLBACK_CATALOG = {};
  }
}

function setLang(l) {
  if (!SUPPORTED_LANGS.includes(l) || l === LANG) return;
  LANG = l;
  localStorage.setItem("bookarr_lang", l);
  _dateFmt = null; // rebuild locale-aware formatter
  loadCatalog(LANG).then(() => {
    document.getElementById("btn-lang").textContent = t("lang.name") + " ▾";
    applyStaticI18n();
    markActiveLang();
    router();
    refreshStatus();
  });
}

/* language switcher dropdown */
document.getElementById("btn-lang").addEventListener("click", e => {
  e.stopPropagation();
  const menu = document.getElementById("lang-menu");
  menu.classList.toggle("hidden");
  markActiveLang();
});
document.getElementById("lang-menu").addEventListener("click", e => {
  const item = e.target.closest("[data-lang]");
  if (!item) return;
  setLang(item.dataset.lang);
  document.getElementById("lang-menu").classList.add("hidden");
});
document.addEventListener("click", () => {
  const menu = document.getElementById("lang-menu");
  if (menu && !menu.classList.contains("hidden")) menu.classList.add("hidden");
});

function markActiveLang() {
  document.querySelectorAll("#lang-menu [data-lang]").forEach(el => {
    el.classList.toggle("active", el.dataset.lang === LANG);
  });
}

function applyStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

/* ============ helpers ============ */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { const j = await res.json(); detail = j.detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.json();
}

function toast(msg, type = "info", ms = 3500) {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

let _dateFmt = null;
function getDateFmt() {
  if (!_dateFmt) {
    try {
      _dateFmt = new Intl.DateTimeFormat(LANG === "de" ? "de-DE" : "en-GB",
        { year: "numeric", month: "2-digit", day: "2-digit" });
    } catch (e) { _dateFmt = null; }
  }
  return _dateFmt;
}

function fmtDate(d) {
  if (!d) return "—";
  const m = String(d).match(/(\d{4})(?:-(\d{2})-(\d{2}))?/);
  if (!m) return "—";
  if (m[2]) {
    try { return getDateFmt().format(new Date(+m[1], +m[2] - 1, +m[3])); }
    catch (e) { return `${m[2]}.${m[3]}.${m[1]}`; }
  }
  return m[1];
}

function isFuture(d) {
  if (!d) return false;
  const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  return new Date(+m[1], +m[2] - 1, +m[3]) > new Date();
}

const STATUS_LABELS = ["have", "wanted", "snatched", "missing", "downloading",
  "completed", "failed", "queued", "searching", "found"];

function statusBadge(status) {
  const map = {
    have: "have", wanted: "wanted", snatched: "snatched",
    missing: "missing", downloading: "downloading", completed: "completed",
    failed: "failed", queued: "queued", searching: "searching", found: "found",
  };
  const cls = map[status] || "monitor-off";
  const label = STATUS_LABELS.includes(status) ? t("status." + status) : status;
  return `<span class="badge ${cls}">${label}</span>`;
}

function coverImg(url, cls = "cover-thumb") {
  if (!url) return `<div class="cover-placeholder">📕</div>`;
  return `<img class="${cls}" src="${esc(url)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover-placeholder'}));this.onerror=null;document.createTextNode('📕');this.parentNode.replaceChild(document.createTextNode('📕'),this)">`;
}

function spinner() {
  return `<span class="spin">⟳</span>`;
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ============ excel-style tables: sorting + column filters ============ */
const TABLE_STATES = {};   // tableId -> {sortKey, sortDir, sortType, filters:{col:Set}}
const TABLE_REFRESH = {};  // tableId -> () => re-render the table container
const TABLE_ROWS = {};     // tableId -> () => raw rows

function tableState(id) {
  if (!TABLE_STATES[id]) {
    TABLE_STATES[id] = { sortKey: null, sortDir: "asc", sortType: "text", filters: {} };
  }
  return TABLE_STATES[id];
}

function registerTable(id, refreshFn, rowsFn) {
  TABLE_REFRESH[id] = refreshFn;
  TABLE_ROWS[id] = rowsFn;
}

function colValues(rows, col) {
  const set = new Set();
  for (const r of rows) set.add(String(r[col] ?? ""));
  return [...set].sort((a, b) => a.localeCompare(b, "de"));
}

function sortRows(rows, key, dir, type, columns) {
  if (!key) return rows;
  const mul = dir === "desc" ? -1 : 1;
  const colDef = (columns || []).find(c => c.key === key);
  return [...rows].sort((a, b) => {
    let va, vb;
    if (colDef && colDef.sortValue) { va = colDef.sortValue(a); vb = colDef.sortValue(b); }
    else { va = a[key]; vb = b[key]; }
    if (type === "number") { va = Number(va) || 0; vb = Number(vb) || 0; }
    else if (type === "date") { va = String(va || ""); vb = String(vb || ""); }
    else { va = String(va ?? "").toLowerCase(); vb = String(vb ?? "").toLowerCase(); }
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return 0;
  });
}

function applyFilters(rows, filters) {
  let out = rows;
  for (const [col, values] of Object.entries(filters)) {
    if (!values || values.size === 0) continue;
    out = out.filter(r => values.has(String(r[col] ?? "")));
  }
  return out;
}

function thSort(col, id, st) {
  if (col.sortable === false) return `<span>${col.label}</span>`;
  const ind = st.sortKey === col.key ? (st.sortDir === "asc" ? " ▲" : " ▼") : "";
  return `<a href="#" class="th-sort" data-table="${id}" data-col="${col.key}" data-type="${col.type || "text"}">${col.label}${ind ? `<span class="sort-ind">${ind}</span>` : ""}</a>`;
}

function thFilter(col, id, st) {
  if (col.filterable === false) return "";
  const active = st.filters[col.key] && st.filters[col.key].size > 0;
  return `<span class="col-filter ${active ? "active" : ""}" data-table="${id}" data-col="${col.key}" title="Filter">▾</span>`;
}

function tableHeader(columns, id) {
  const st = tableState(id);
  return `<thead><tr>` + columns.map(col => {
    const sortable = col.sortable !== false;
    return `<th${sortable ? ' class="sortable"' : ""} data-col="${col.key}">${thSort(col, id, st)}${thFilter(col, id, st)}</th>`;
  }).join("") + `</tr></thead>`;
}

/* sorting + filter interactions (event delegation) */
document.addEventListener("click", e => {
  const s = e.target.closest(".th-sort");
  if (s) {
    e.preventDefault();
    const id = s.dataset.table, col = s.dataset.col, type = s.dataset.type || "text";
    const st = tableState(id);
    if (st.sortKey === col) st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
    else { st.sortKey = col; st.sortDir = "asc"; st.sortType = type; }
    if (TABLE_REFRESH[id]) TABLE_REFRESH[id]();
    return;
  }
  const cf = e.target.closest(".col-filter");
  if (cf) { e.stopPropagation(); openColFilter(cf); }
});

let _cfTable = null, _cfCol = null, _cfAllValues = [];

function openColFilter(icon) {
  _cfTable = icon.dataset.table;
  _cfCol = icon.dataset.col;
  const rows = TABLE_ROWS[_cfTable] ? TABLE_ROWS[_cfTable]() : [];
  _cfAllValues = colValues(rows, _cfCol);
  const st = tableState(_cfTable);
  const sel = st.filters[_cfCol] || new Set();
  const rect = icon.getBoundingClientRect();
  const popup = document.getElementById("col-filter-popup");
  popup.style.left = Math.min(rect.left, window.innerWidth - 235) + "px";
  popup.style.top = (rect.bottom + 4) + "px";
  popup.classList.remove("hidden");
  document.getElementById("cf-search").value = "";
  renderCfOptions(sel, "");
  document.getElementById("cf-search").focus();
}

function renderCfOptions(sel, query) {
  const box = document.getElementById("cf-options");
  const q = query.toLowerCase();
  const vals = _cfAllValues.filter(v => !q || v.toLowerCase().includes(q));
  if (!vals.length) {
    box.innerHTML = `<div class="muted" style="padding:6px;font-size:12px">—</div>`;
    return;
  }
  const rows = TABLE_ROWS[_cfTable] ? TABLE_ROWS[_cfTable]() : [];
  box.innerHTML = vals.map(v => {
    const checked = sel.has(v) ? "checked" : "";
    const count = rows.filter(r => String(r[_cfCol] ?? "") === v).length;
    const label = v === "" ? t("table.blank") : v;
    return `<label><input type="checkbox" value="${esc(v)}" ${checked}> <span>${esc(label)}</span><span class="cf-count">${count}</span></label>`;
  }).join("");
}

document.getElementById("cf-search").addEventListener("input", e => {
  const sel = tableState(_cfTable).filters[_cfCol] || new Set();
  renderCfOptions(sel, e.target.value);
});
document.getElementById("cf-options").addEventListener("change", e => {
  const cb = e.target.closest("input[type=checkbox]");
  if (!cb || !_cfTable) return;
  const st = tableState(_cfTable);
  if (!st.filters[_cfCol]) st.filters[_cfCol] = new Set();
  const sel = st.filters[_cfCol];
  if (cb.checked) sel.add(cb.value); else sel.delete(cb.value);
  if (sel.size === 0) delete st.filters[_cfCol];
  if (TABLE_REFRESH[_cfTable]) TABLE_REFRESH[_cfTable]();
});
document.getElementById("cf-all").addEventListener("click", () => {
  const st = tableState(_cfTable);
  st.filters[_cfCol] = new Set(_cfAllValues);
  if (TABLE_REFRESH[_cfTable]) TABLE_REFRESH[_cfTable]();
  renderCfOptions(st.filters[_cfCol], document.getElementById("cf-search").value);
});
document.getElementById("cf-none").addEventListener("click", () => {
  const st = tableState(_cfTable);
  delete st.filters[_cfCol];
  if (TABLE_REFRESH[_cfTable]) TABLE_REFRESH[_cfTable]();
  renderCfOptions(new Set(), document.getElementById("cf-search").value);
});
document.addEventListener("click", e => {
  const popup = document.getElementById("col-filter-popup");
  if (!popup || popup.classList.contains("hidden")) return;
  if (e.target.closest("#col-filter-popup") || e.target.closest(".col-filter")) return;
  popup.classList.add("hidden");
});

/* ============ router ============ */
const routes = {
  "overview": pageOverview,
  "books": pageBooks,
  "authors": pageAuthors,
  "author": pageAuthor,
  "series": pageSeries,
  "wanted": pageWanted,
  "activity": pageActivity,
  "settings": pageSettings,
  "system": pageSystem,
};

function currentRoute() {
  const hash = location.hash.replace(/^#\//, "") || "overview";
  const [name, param] = hash.split("/");
  return { name, param };
}

function router() {
  const { name, param } = currentRoute();
  document.querySelectorAll("#nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.nav === name || (name === "author" && a.dataset.nav === "authors")));
  document.getElementById("page-title").textContent = t("title." + name);
  const content = document.getElementById("content");
  content.innerHTML = `<div class="empty">${esc(t("common.loading"))}</div>`;
  (routes[name] || pageOverview)(content, param).catch(err => {
    content.innerHTML = `<div class="empty">${esc(t("common.error", { msg: err.message }))}</div>`;
  });
}

window.addEventListener("hashchange", router);

/* ============ status sidebar / polling ============ */
async function refreshStatus() {
  try {
    const s = await api("api/status");
    const c = s.connectivity;
    setDot("dot-prowlarr", c.prowlarr);
    setDot("dot-sabnzbd", c.sabnzbd);
    setDot("dot-irc", c.irc);
    setDot("dot-convert", c.convert);
    const wc = s.counts.wanted;
    const el = document.getElementById("nav-wanted-count");
    if (el) { el.textContent = wc; el.style.display = wc ? "" : "none"; }
    const st = s.scheduler;
    let line = st.loop === "wanted-search" ? t("sidebar.wanted_searching")
      : st.loop === "monitor-sync" ? t("sidebar.sync_running") : t("sidebar.ready");
    if (st.current_book) line += ` (${st.current_book.slice(0, 30)})`;
    document.getElementById("scheduler-state").textContent = line;
  } catch (e) {}
}
function setDot(id, on) {
  const el = document.getElementById(id);
  if (el) el.className = "dot " + (on ? "on" : "off");
}

/* ============ modals ============ */
let _rendition = null; // active epub.js rendition (book viewer)

function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) {
  if (id === "viewer-modal" && _rendition) {
    try { _rendition.destroy(); } catch (e) {}
    _rendition = null;
  }
  document.getElementById(id).classList.add("hidden");
}

document.addEventListener("click", e => {
  if (e.target.classList.contains("modal")) closeModal(e.target.id);
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) closeModal(closeBtn.dataset.close);
});

/* ============ global search ============ */
let searchType = "all";
document.getElementById("btn-search").addEventListener("click", () => {
  document.getElementById("global-search-input").value = "";
  document.getElementById("search-results").innerHTML = "";
  openModal("search-modal");
  setTimeout(() => document.getElementById("global-search-input").focus(), 50);
});
document.getElementById("search-type-seg").addEventListener("click", e => {
  const b = e.target.closest(".seg-btn");
  if (!b) return;
  document.querySelectorAll("#search-type-seg .seg-btn").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  searchType = b.dataset.type;
  runGlobalSearch();
});
document.getElementById("global-search-input").addEventListener("keydown", e => {
  if (e.key === "Enter") runGlobalSearch();
});

let searchSeq = 0;
async function runGlobalSearch() {
  const q = document.getElementById("global-search-input").value.trim();
  const seq = ++searchSeq;
  const box = document.getElementById("search-results");
  if (q.length < 2) { box.innerHTML = `<div class="empty">${esc(t("search.min_chars"))}</div>`; return; }
  box.innerHTML = `<div class="empty">${t("search.running", { spinner: spinner() })}</div>`;
  try {
    const d = await api(`api/search/metadata?q=${encodeURIComponent(q)}&type=${searchType}`);
    if (seq !== searchSeq) return;
    let html = "";
    if (searchType !== "book" && d.authors && d.authors.length) {
      html += `<div class="sr-group-title">${esc(t("search.group_authors"))}</div>`;
      for (const a of d.authors) {
        html += `<div class="sr-row">
          <div style="flex:1">
            <div class="sr-title">${esc(a.name)}</div>
            <div class="sr-sub">${esc(a.birth_date || "")} ${esc(a.death_date ? "– " + a.death_date : "")}</div>
          </div>
          <div class="sr-actions">
            <button class="btn small primary" data-act="add-author" data-key="${esc(a.ol_key)}" data-name="${esc(a.name)}">${esc(t("common.add"))}</button>
          </div>
        </div>`;
      }
    }
    if (searchType !== "author" && d.books && d.books.length) {
      html += `<div class="sr-group-title">${esc(t("search.group_books"))}</div>`;
      for (const b of d.books) {
        html += `<div class="sr-row">
          ${coverImg(b.cover, "sr-thumb")}
          <div style="flex:1">
            <div class="sr-title">${esc(b.title)}</div>
            <div class="sr-sub">${esc((b.authors || []).join(", "))}${b.year ? " · " + b.year : ""}</div>
          </div>
          <div class="sr-actions">
            <button class="btn small primary" data-act="add-book"
              data-title="${esc(b.title)}" data-author="${esc((b.authors || [])[0] || "")}"
              data-key="${esc(b.ol_work_key)}" data-year="${esc(b.year || "")}" data-cover="${esc(b.cover || "")}">${esc(t("common.add"))}</button>
          </div>
        </div>`;
      }
    }
    if (searchType !== "book" && d.wikipedia && d.wikipedia.length) {
      html += `<div class="sr-group-title">${esc(t("search.group_wikipedia", { q }))}</div>`;
      html += `<div class="sr-sub" style="margin-bottom:6px">${esc(t("search.wikipedia_hint"))}</div>`;
      for (const w of d.wikipedia.slice(0, 25)) {
        html += `<div class="sr-row">
          <div style="flex:1">
            <div class="sr-title">${esc(w.title)}</div>
            <div class="sr-sub">${w.year ? w.year + " · " : ""}${esc(t("search.source_wikipedia"))}</div>
          </div>
          <div class="sr-actions">
            <button class="btn small" data-act="add-book"
              data-title="${esc(w.title)}" data-author="${esc(q)}"
              data-year="${esc(w.year || "")}" data-source="wikipedia">${esc(t("common.add"))}</button>
          </div>
        </div>`;
      }
    }
    if (!html) html = `<div class="empty">${esc(t("search.no_results"))}</div>`;
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(t("search.failed", { msg: e.message }))}</div>`;
  }
}

document.addEventListener("click", async e => {
  const addAuthor = e.target.closest("[data-act='add-author']");
  if (addAuthor) {
    addAuthor.disabled = true; addAuthor.innerHTML = spinner();
    try {
      const r = await api("api/authors", {
        method: "POST",
        body: JSON.stringify({ ol_key: addAuthor.dataset.key, languages: ["de", "en"] }),
      });
      toast(t("toast.author_added", { id: r.id }), "success");
      closeModal("search-modal");
      location.hash = `#/author/${r.id}`;
    } catch (err) {
      toast(t("common.error", { msg: err.message }), "error");
      addAuthor.disabled = false; addAuthor.textContent = t("common.add");
    }
    return;
  }
  const addBook = e.target.closest("[data-act='add-book']");
  if (addBook) {
    addBook.disabled = true; addBook.innerHTML = spinner();
    try {
      const r = await api("api/books", {
        method: "POST",
        body: JSON.stringify({
          title: addBook.dataset.title, author_name: addBook.dataset.author,
          ol_work_key: addBook.dataset.key || "", year: addBook.dataset.year || "",
          cover: addBook.dataset.cover || "", wanted: 1,
        }),
      });
      toast(r.duplicate ? t("toast.book_duplicate") : t("toast.book_added"), r.duplicate ? "warn" : "success");
      addBook.textContent = "✓";
    } catch (err) {
      toast(t("common.error", { msg: err.message }), "error");
      addBook.disabled = false; addBook.textContent = t("common.add");
    }
  }
});

/* ============ topbar actions ============ */
document.getElementById("btn-wanted-search").addEventListener("click", async () => {
  try {
    await api("api/wanted/search", { method: "POST" });
    toast(t("toast.wanted_search_started"), "success");
  } catch (e) { toast(t("common.error", { msg: e.message }), "error"); }
});
document.getElementById("btn-sync-all").addEventListener("click", async () => {
  try {
    await api("api/actions/sync-all", { method: "POST" });
    toast(t("toast.sync_started"), "success");
  } catch (e) { toast(t("common.error", { msg: e.message }), "error"); }
});

/* ============ page: overview ============ */
async function pageOverview(content) {
  const d = await api("api/overview");
  const st = await api("api/status");
  const c = st.counts;
  let ovWanted = d.wanted, ovDl = d.active, ovSab = d.sab_queue;
  const WID = "wanted-ov", DID = "downloads-ov", SID = "sab-queue";

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard(c.books, t("overview.stat_books"))}
      ${statCard(c.have, t("overview.stat_have"))}
      ${statCard(c.wanted, t("overview.stat_wanted"))}
      ${statCard(c.authors, t("overview.stat_authors"))}
      ${statCard(c.series, t("overview.stat_series"))}
      ${statCard(c.active_downloads, t("overview.stat_downloads"))}
    </div>
    <div class="panel">
      <div class="panel-head"><span>${t("overview.panel_wanted")}</span>
        <button class="btn small" id="ov-wanted-search">${t("overview.search_now")}</button></div>
      <div class="panel-body" id="ov-wanted-box"></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>${t("overview.panel_downloads")}</span></div>
      <div class="panel-body" id="ov-dl-box">
        <div id="ov-dl-table"></div>
        <div id="ov-sab-box" style="margin-top:14px"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>${t("overview.panel_events")}</span></div>
      <div class="panel-body">${eventsFeed(d.events)}</div>
    </div>`;

  const renderWanted = () => {
    document.getElementById("ov-wanted-box").innerHTML =
      ovWanted.length ? wantedTable(ovWanted, WID) : `<div class="empty">${esc(t("overview.empty_wanted"))}</div>`;
  };
  const renderDl = () => {
    document.getElementById("ov-dl-table").innerHTML =
      ovDl.length ? downloadsTable(ovDl, DID) : `<div class="empty">${esc(t("overview.empty_downloads"))}</div>`;
    const sabBox = document.getElementById("ov-sab-box");
    sabBox.innerHTML = ovSab.length
      ? `<div class="muted" style="margin-bottom:6px;font-size:12px;text-transform:uppercase">${esc(t("overview.sab_queue"))}</div>${sabTable(ovSab, SID)}`
      : "";
  };
  renderWanted();
  renderDl();
  registerTable(WID, renderWanted, () => ovWanted);
  registerTable(DID, renderDl, () => ovDl);
  registerTable(SID, renderDl, () => ovSab);

  document.getElementById("ov-wanted-search").addEventListener("click", async () => {
    try { await api("api/wanted/search", { method: "POST" }); toast(t("toast.wanted_search_started"), "success"); }
    catch (e) { toast(e.message, "error"); }
  });
  // live refresh
  window.__ovTimer = setInterval(async () => {
    if (currentRoute().name !== "overview") { clearInterval(window.__ovTimer); return; }
    try {
      const d2 = await api("api/overview");
      const st2 = await api("api/status");
      const c2 = st2.counts;
      document.querySelectorAll(".stat-card .stat-value").forEach((el, i) => {
        el.textContent = [c2.books, c2.have, c2.wanted, c2.authors, c2.series, c2.active_downloads][i];
      });
      ovWanted = d2.wanted;
      ovDl = d2.active;
      ovSab = d2.sab_queue;
      renderWanted();
      renderDl();
    } catch (e) {}
  }, 8000);
}

function statCard(v, l) {
  return `<div class="stat-card"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`;
}

function wantedColumns() {
  return [
    { key: "_cover", label: "", sortable: false, filterable: false,
      tdAttrs: () => 'class="t-cover"', render: w => coverImg(w.cover_url) },
    { key: "title", label: t("common.title"),
      render: w => `<b>${esc(w.title)}</b>` },
    { key: "author_name", label: t("common.author"),
      render: w => `<span class="muted">${esc(w.author_name || "")}</span>` },
    { key: "language", label: t("common.language"),
      render: w => w.language ? `<span class="lang-tag">${esc(w.language)}</span>` : "—" },
    { key: "publish_date", label: t("common.published"), type: "date",
      sortValue: w => String(w.publish_date || "").match(/\d{4}/)?.[0] || "",
      render: w => `<span class="${isFuture(w.publish_date) ? "future" : ""}">${fmtDate(w.publish_date)}${isFuture(w.publish_date) ? " ⏳" : ""}</span>` },
    { key: "interval_hours", label: t("common.interval"), type: "number",
      render: w => `${w.interval_hours} h` },
    { key: "last_search", label: t("common.last_search"),
      render: w => `<span class="muted">${fmtDate(w.last_search) === "—" ? t("common.never") : esc(w.last_search)}</span>` },
    { key: "_actions", label: t("common.action"), sortable: false, filterable: false,
      tdAttrs: () => 'style="text-align:right"',
      render: w => `<div class="row-actions">
        <button class="btn small" data-act="book-sources" data-id="${w.id}" title="${t("common.search_sources")}">🔍</button>
        <button class="btn small" data-act="book-wanted" data-id="${w.id}" data-w="0" title="${t("book.wanted_remove")}">✓</button>
        <button class="btn small danger" data-act="book-del" data-id="${w.id}" title="${t("common.delete")}">✕</button>
      </div>` },
  ];
}

function wantedTable(wanted, tableId) {
  const columns = wantedColumns();
  const st = tableState(tableId);
  const filtered = applyFilters(wanted, st.filters);
  const sorted = sortRows(filtered, st.sortKey, st.sortDir, st.sortType, columns);
  if (!sorted.length) return `<div class="empty">${esc(t("overview.empty_wanted"))}</div>`;
  let html = `<table class="data">` + tableHeader(columns, tableId) + `<tbody>`;
  for (const w of sorted) {
    html += `<tr>`;
    for (const col of columns) {
      html += `<td${col.tdAttrs ? " " + col.tdAttrs(w) : ""}>${col.render(w)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table>`;
}

function downloadsColumns() {
  return [
    { key: "status", label: t("common.status"), render: d => statusBadge(d.status) },
    { key: "book_title", label: t("common.title"),
      render: d => esc(d.book_title || d.title) },
    { key: "source", label: t("common.source"),
      render: d => `<span class="muted">${esc(d.source)}</span>` },
    { key: "progress", label: t("common.progress"), type: "number",
      render: d => `<div class="progress" style="width:110px"><div class="bar" style="width:${d.progress || 0}%"></div></div>` },
    { key: "message", label: t("common.message"),
      render: d => `<span class="muted">${esc(d.message || "")}</span>` },
  ];
}

function downloadsTable(list, tableId) {
  const columns = downloadsColumns();
  const st = tableState(tableId);
  const filtered = applyFilters(list, st.filters);
  const sorted = sortRows(filtered, st.sortKey, st.sortDir, st.sortType, columns);
  if (!sorted.length) return `<div class="empty">${esc(t("overview.empty_downloads"))}</div>`;
  let html = `<table class="data">` + tableHeader(columns, tableId) + `<tbody>`;
  for (const d of sorted) {
    html += `<tr>`;
    for (const col of columns) {
      html += `<td${col.tdAttrs ? " " + col.tdAttrs(d) : ""}>${col.render(d)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table>`;
}

function sabColumns() {
  return [
    { key: "title", label: t("common.title"), render: s => esc(s.title) },
    { key: "progress", label: t("common.progress"), type: "number",
      render: s => `<div class="progress" style="width:110px"><div class="bar" style="width:${s.progress || 0}%"></div></div>` },
    { key: "size", label: t("common.size"),
      sortValue: s => parseFloat(String(s.size || "").replace(",", ".")) || 0,
      render: s => `<span class="muted">${esc(s.size)}</span>` },
    { key: "speed", label: t("common.speed"),
      render: s => `<span class="muted">${esc(s.speed)}</span>` },
    { key: "eta", label: t("common.eta"),
      render: s => `<span class="muted">${esc(s.eta)}</span>` },
  ];
}

function sabTable(q, tableId) {
  const columns = sabColumns();
  const st = tableState(tableId);
  const filtered = applyFilters(q, st.filters);
  const sorted = sortRows(filtered, st.sortKey, st.sortDir, st.sortType, columns);
  if (!sorted.length) return `<div class="empty">${esc(t("overview.empty_downloads"))}</div>`;
  let html = `<table class="data">` + tableHeader(columns, tableId) + `<tbody>`;
  for (const s of sorted) {
    html += `<tr>`;
    for (const col of columns) {
      html += `<td${col.tdAttrs ? " " + col.tdAttrs(s) : ""}>${col.render(s)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table>`;
}

function eventsFeed(events) {
  if (!events.length) return `<div class="empty">${esc(t("overview.empty_events"))}</div>`;
  return events.map(e => `
    <div class="event-row ${esc(e.level)}">
      <span class="ev-dot ${esc(e.level)}"></span>
      <span class="event-time">${esc(e.time)}</span>
      <span class="event-msg"><b>${esc(e.source)}</b>: ${esc(e.message)}</span>
    </div>`).join("");
}

/* ============ page: books ============ */
async function pageBooks(content) {
  const books = await api("api/books?limit=1000");
  const langs = [...new Set(books.map(b => b.language).filter(Boolean))].sort();
  const TABLE_ID = "books-all";
  let current = books;
  content.innerHTML = `
    <div class="books-table-actions">
      <input type="text" id="bk-q" placeholder="${t("books.filter_placeholder")}">
      <select id="bk-status">
        <option value="">${t("common.all_status")}</option>
        <option value="have">${t("status.have")}</option>
        <option value="wanted">${t("status.wanted")}</option>
        <option value="missing">${t("status.missing")}</option>
        <option value="snatched">${t("status.snatched")}</option>
      </select>
      <select id="bk-lang"><option value="">${t("common.all_languages")}</option>
        ${langs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}
      </select>
      <div class="spacer"></div>
      <span class="muted" id="bk-count">${t("books.count", { n: books.length })}</span>
    </div>
    <div id="bk-table"></div>`;

  const renderBooksTable = () => {
    document.getElementById("bk-table").innerHTML = booksTable(current, TABLE_ID);
  };
  const apply = () => {
    const q = document.getElementById("bk-q").value.toLowerCase();
    const st = document.getElementById("bk-status").value;
    const lg = document.getElementById("bk-lang").value;
    current = books.filter(b =>
      (!q || (b.title || "").toLowerCase().includes(q) || (b.author_name || "").toLowerCase().includes(q)) &&
      (!st || b.status === st) && (!lg || b.language === lg));
    document.getElementById("bk-count").textContent = t("books.count", { n: current.length });
    renderBooksTable();
  };
  renderBooksTable();
  registerTable(TABLE_ID, renderBooksTable, () => current);
  document.getElementById("bk-q").addEventListener("input", debounce(apply, 200));
  document.getElementById("bk-status").addEventListener("change", apply);
  document.getElementById("bk-lang").addEventListener("change", apply);
}

function booksColumns() {
  return [
    { key: "_cover", label: "", sortable: false, filterable: false,
      tdAttrs: () => 'class="t-cover"', render: b => coverImg(b.cover_url) },
    { key: "title", label: t("common.title"),
      render: b => `<b>${esc(b.title)}</b>${b.series_number ? `<span class="muted"> #${esc(b.series_number)}</span>` : ""}` },
    { key: "author_name", label: t("common.author"),
      render: b => `<span class="muted">${esc(b.author_name || "")}</span>` },
    { key: "series_name", label: t("books.col_series"),
      render: b => `<span class="muted">${esc(b.series_name || "—")}</span>` },
    { key: "language", label: t("common.language"),
      render: b => b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—" },
    { key: "publish_date", label: t("common.published"), type: "date",
      sortValue: b => String(b.publish_date || "").match(/\d{4}/)?.[0] || "",
      render: b => `<span class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? " ⏳" : ""}</span>` },
    { key: "status", label: t("common.status"),
      tdAttrs: () => 'data-status-badge', render: b => statusBadge(b.status) },
    { key: "_actions", label: t("common.actions"), sortable: false, filterable: false,
      tdAttrs: () => 'style="text-align:right"',
      render: b => `<div class="row-actions">
        <button class="btn small" data-act="book-sources" data-id="${b.id}" title="${t("common.search_sources")}">🔍</button>
        ${b.wanted ? `<button class="btn small" data-act="book-wanted" data-id="${b.id}" data-w="0" title="${t("book.wanted_remove")}">✓</button>`
                   : `<button class="btn small" data-act="book-wanted" data-id="${b.id}" data-w="1" title="${t("book.wanted_add")}">⏳</button>`}
        <button class="btn small danger" data-act="book-del" data-id="${b.id}" title="${t("common.delete")}">✕</button>
      </div>` },
  ];
}

function booksTable(books, tableId) {
  const columns = booksColumns();
  const st = tableState(tableId);
  const filtered = applyFilters(books, st.filters);
  const sorted = sortRows(filtered, st.sortKey, st.sortDir, st.sortType, columns);
  if (!sorted.length) return `<div class="empty">${esc(t("books.empty"))}</div>`;
  let html = `<table class="data">` + tableHeader(columns, tableId) + `<tbody>`;
  for (const b of sorted) {
    html += `<tr class="clickable" data-act="book-open" data-id="${b.id}">`;
    for (const col of columns) {
      html += `<td${col.tdAttrs ? " " + col.tdAttrs(b) : ""}>${col.render(b)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table>`;
}

/* ============ book detail modal ============ */
let sourcesTimer = null;
document.addEventListener("click", async e => {
  // action buttons inside clickable rows take precedence over book-open
  const wanted = e.target.closest("[data-act='book-wanted']");
  if (wanted) {
    e.stopPropagation();
    const bid = +wanted.dataset.id;
    const wantOn = wanted.dataset.w === "1";
    wanted.disabled = true;
    try {
      const resp = await api(`api/books/${bid}`, {
        method: "PATCH",
        body: JSON.stringify({ wanted: wantOn ? 1 : 0 }),
      });
      const tr = wanted.closest("tr");
      if (tr) {
        if (tr.hasAttribute("data-act")) {
          // books/series table: update row in place → scroll position stays
          const badgeCell = tr.querySelector("[data-status-badge]");
          if (badgeCell) badgeCell.innerHTML = statusBadge(resp.status);
          wanted.dataset.w = wantOn ? "0" : "1";
          wanted.title = wantOn ? t("book.wanted_remove") : t("book.wanted_add");
          wanted.innerHTML = wantOn ? "✓" : "⏳";
        } else {
          // wanted list: remove the row (book is no longer wanted)
          tr.remove();
        }
      }
      toast(wantOn ? t("toast.marked_wanted") : t("toast.unmarked_wanted"), "success");
      refreshStatus();
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
    finally { wanted.disabled = false; }
    return;
  }
  const del = e.target.closest("[data-act='book-del']");
  if (del) {
    e.stopPropagation();
    if (!confirm(t("common.confirm_delete_book"))) return;
    try {
      await api(`api/books/${del.dataset.id}`, { method: "DELETE" });
      toast(t("toast.book_deleted"), "success");
      router();
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
    return;
  }
  const sources = e.target.closest("[data-act='book-sources']");
  if (sources) {
    e.stopPropagation();
    showBookModal(sources.dataset.id, { autoSearch: true });
    return;
  }
  const open = e.target.closest("[data-act='book-open']");
  if (open) { showBookModal(open.dataset.id); return; }
});

async function showBookModal(id, opts = {}) {
  let b;
  try {
    b = await api(`api/books/${id}`);
  } catch (e) {
    toast(t("common.error", { msg: e.message }), "error");
    return;
  }
  openModal("book-modal");
  const body = document.getElementById("bm-body");
  body.innerHTML = `<div class="empty">${esc(t("common.loading"))}</div>`;
  document.getElementById("bm-title").textContent = b.title;
  let srcHtml = `<div class="empty" id="bm-src-placeholder">${esc(t("book.no_sources_yet"))}</div>`;
  if (opts.autoSearch) {
    srcHtml = `<div class="empty">${t("sources.running", { spinner: spinner() })}</div>`;
  }
  body.innerHTML = `
    <div class="bm-grid">
      <div>
        ${coverImg(b.cover_url, "book-thumb-lg")}
        <div style="margin-top:10px" class="row-actions" style="flex-wrap:wrap;justify-content:flex-start">
          ${b.wanted ? `<button class="btn small" id="bm-wanted" data-w="0">${t("book.wanted_remove")}</button>`
                     : `<button class="btn small primary" id="bm-wanted" data-w="1">${t("book.wanted_add")}</button>`}
          ${b.file_path ? `<button class="btn small primary" id="bm-view">${t("book.view")}</button>
          <a class="btn small" id="bm-download" href="api/books/${b.id}/file" download title="${esc(b.file_path)}">${t("book.download")}</a>` : ""}
          <button class="btn small" id="bm-convert" ${b.file_path ? "" : "disabled"} title="${b.file_path ? t("book.convert_title") : t("book.no_file_title")}">${t("book.convert")}</button>
          <button class="btn small danger" id="bm-del">${t("book.delete")}</button>
        </div>
      </div>
      <div>
        <div class="kv"><span class="k">${t("book.author")}</span><span>${esc(b.author_name || "—")}</span></div>
        <div class="kv"><span class="k">${t("book.series")}</span><span>${esc(b.series_name || "—")}${b.series_number ? " #" + esc(b.series_number) : ""}</span></div>
        <div class="kv"><span class="k">${t("book.publish_date")}</span><span class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? t("book.future") : ""}</span></div>
        <div class="kv"><span class="k">${t("book.language")}</span><span>${b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—"}</span></div>
        <div class="kv"><span class="k">${t("book.isbn")}</span><span class="mono">${esc(b.isbn || "—")}</span></div>
        <div class="kv"><span class="k">${t("book.status")}</span><span>${statusBadge(b.status)}</span></div>
        <div class="kv"><span class="k">${t("book.file")}</span><span class="muted" style="word-break:break-all">${esc(b.file_path || "—")}</span></div>
        ${b.description ? `<div class="bm-desc">${esc(b.description)}</div>` : ""}
      </div>
    </div>
    <div style="margin-top:18px">
      <div class="panel-head" style="padding:8px 0;border-bottom:none"><span>${t("book.sources_panel")}</span>
        <button class="btn small primary" id="bm-search-sources">${t("common.search_sources")}</button>
      </div>
      <div id="bm-sources">${srcHtml}</div>
    </div>`;

  document.getElementById("bm-wanted").addEventListener("click", async ev => {
    try {
      await api(`api/books/${b.id}`, { method: "PATCH", body: JSON.stringify({ wanted: +ev.target.dataset.w }) });
      toast(t("common.ok"), "success"); closeModal("book-modal"); router();
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
  });
  document.getElementById("bm-convert").addEventListener("click", async () => {
    try {
      await api(`api/books/${b.id}/convert`, { method: "POST" });
      toast(t("toast.convert_started"), "success");
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
  });
  document.getElementById("bm-del").addEventListener("click", async () => {
    if (!confirm(t("common.confirm_delete_book"))) return;
    await api(`api/books/${b.id}`, { method: "DELETE" });
    closeModal("book-modal"); router();
  });
  document.getElementById("bm-search-sources").addEventListener("click", () => searchSources(b.id, b.title));

  const viewBtn = document.getElementById("bm-view");
  if (viewBtn) viewBtn.addEventListener("click", () => openViewer(b));

  if (opts.autoSearch) searchSources(b.id, b.title);
}

/* ============ book viewer (pdf/txt/html native, epub via epub.js) ============ */
function openViewer(book) {
  const ext = (book.file_path || "").split(".").pop().toLowerCase();
  document.getElementById("vm-title").textContent = book.title;
  const body = document.getElementById("vm-body");
  body.innerHTML = "";
  const url = `api/books/${book.id}/file`;
  if (["pdf", "txt", "html", "htm"].includes(ext)) {
    body.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none"></iframe>`;
  } else if (ext === "epub" && typeof ePub === "function") {
    body.innerHTML = `<div id="vm-epub" style="width:100%;height:100%"></div>`;
    // load the file as an ArrayBuffer — passing the URL directly would make
    // epub.js resolve the epub's internal paths against it (404)
    fetch(url).then(r => r.arrayBuffer()).then(buf => {
      if (!document.getElementById("vm-epub")) return; // modal was closed meanwhile
      _rendition = ePub(buf).renderTo("vm-epub", { width: "100%", height: "100%" });
      _rendition.display();
    }).catch(() => {
      const box = document.getElementById("vm-body");
      if (box) box.innerHTML = `<div class="empty" style="background:var(--bg);height:100%">
        ${esc(t("book.viewer_unsupported", { format: "epub" }))}</div>`;
    });
  } else {
    body.innerHTML = `<div class="empty" style="background:var(--bg);height:100%">
      ${esc(t("book.viewer_unsupported", { format: ext || "?" }))}<br>
      <a class="btn primary" style="margin-top:12px" href="${url}" download>${esc(t("book.download"))}</a></div>`;
  }
  openModal("viewer-modal");
}

async function searchSources(bookId, title) {
  if (sourcesTimer) clearInterval(sourcesTimer);
  const box = document.getElementById("bm-sources");
  if (!box) return;
  box.innerHTML = `<div class="empty">${t("sources.running", { spinner: spinner() })}</div>`;
  try {
    const r = await api(`api/search/downloads?book_id=${bookId}`);
    if (r.done) { renderSources(box, r.results, bookId); return; }
    sourcesTimer = setInterval(async () => {
      // stop polling when the modal was closed
      if (document.getElementById("book-modal").classList.contains("hidden")) {
        clearInterval(sourcesTimer);
        return;
      }
      try {
        const r2 = await api(`api/search/downloads?book_id=${bookId}`);
        if (r2.done) {
          clearInterval(sourcesTimer);
          renderSources(box, r2.results, bookId);
        } else {
          box.innerHTML = `<div class="empty">${t("sources.still_running", { spinner: spinner() })}</div>`;
        }
      } catch (e) { clearInterval(sourcesTimer); box.innerHTML = `<div class="empty">${esc(t("sources.failed", { msg: e.message }))}</div>`; }
    }, 5000);
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(t("sources.failed", { msg: e.message }))}</div>`;
  }
}

function renderSources(box, results, bookId) {
  if (!results.length) {
    box.innerHTML = `<div class="empty">${esc(t("sources.none"))}</div>`;
    return;
  }
  box.innerHTML = results.map((r, i) => `
    <div class="src-row">
      <span class="src-badge ${r.source === "irc" ? "irc" : "nzb"}">${r.source === "irc" ? "IRC" : "NZB"}</span>
      <div class="src-title" title="${esc(r.title)}">${esc(r.title)}</div>
      <div class="src-meta">${r.indexer ? esc(r.indexer) + " · " : ""}${fmtSize(r.size)}</div>
      <button class="btn small primary" data-act="start-dl" data-idx="${i}">${t("common.download")}</button>
    </div>`).join("");
  box.querySelectorAll("[data-act='start-dl']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const r = results[+btn.dataset.idx];
      btn.disabled = true; btn.innerHTML = spinner();
      try {
        await api("api/downloads", {
          method: "POST",
          body: JSON.stringify({
            book_id: bookId, source: r.source, title: r.title,
            url: r.url || "", bot: r.bot || "", size: r.size || "",
          }),
        });
        toast(t("toast.download_started"), "success");
        btn.textContent = "✓";
      } catch (err) {
        toast(t("common.error", { msg: err.message }), "error");
        btn.disabled = false; btn.textContent = t("common.download");
      }
    });
  });
}

/* ============ page: authors ============ */
async function pageAuthors(content) {
  const authors = await api("api/authors");
  content.innerHTML = `
    <div class="books-table-actions">
      <input type="text" id="au-q" placeholder="${t("authors.filter_placeholder")}">
      <div class="spacer"></div>
      <button class="btn" id="au-add">${t("authors.add")}</button>
    </div>
    <div id="au-grid" class="author-grid">${authorCards(authors)}</div>`;
  document.getElementById("au-q").addEventListener("input", debounce(() => {
    const q = document.getElementById("au-q").value.toLowerCase();
    const filtered = authors.filter(a => a.name.toLowerCase().includes(q));
    document.getElementById("au-grid").innerHTML = authorCards(filtered);
  }, 200));
  document.getElementById("au-add").addEventListener("click", () => {
    document.getElementById("global-search-input").value = "";
    document.getElementById("search-type-seg").querySelector("[data-type='author']").click();
    openModal("search-modal");
    setTimeout(() => document.getElementById("global-search-input").focus(), 50);
  });
}

function authorCards(authors) {
  if (!authors.length) return `<div class="empty" style="grid-column:1/-1">${esc(t("authors.empty"))}</div>`;
  return authors.map(a => `
    <div class="author-card" data-nav-author="${a.id}">
      ${a.image_url ? `<img src="${esc(a.image_url)}" class="author-card-img" alt="" loading="lazy">` : ""}
      <div class="a-name">${esc(a.name)}</div>
      <div class="a-sub">${esc(a.birth_date || "")}${a.death_date ? " – " + esc(a.death_date) : ""}</div>
      <div class="a-meta">
        <span class="badge ${a.monitor ? "monitor-on" : "monitor-off"}">${a.monitor ? t("status.monitored") : t("status.not_monitored")}</span>
        <span class="lang-tag">${t("authors.books", { n: a.book_count })}</span>
        ${a.wanted_count ? `<span class="badge wanted">${t("authors.wanted", { n: a.wanted_count })}</span>` : ""}
      </div>
    </div>`).join("");
}

document.addEventListener("click", e => {
  const card = e.target.closest("[data-nav-author]");
  if (card) location.hash = `#/author/${card.dataset.navAuthor}`;
});

/* ============ page: author detail ============ */
async function pageAuthor(content, param) {
  const id = parseInt(param, 10);
  let d;
  try { d = await api(`api/authors/${id}?lang=`); }
  catch (e) { content.innerHTML = `<div class="empty">${esc(t("authors.not_found"))}</div>`; return; }
  const a = d.author;
  const initials = (a.name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();

  content.innerHTML = `
    <div class="author-header">
      ${a.image_url
        ? `<img src="${esc(a.image_url)}" class="author-photo" alt="">`
        : `<div class="cover-placeholder" style="width:90px;height:130px;font-size:32px;flex-shrink:0">${esc(initials)}</div>`}
      <div style="flex:1">
        <div class="ah-name">${esc(a.name)}</div>
        <div class="ah-sub">${esc(a.birth_date || "")}${a.death_date ? " – " + esc(a.death_date) : ""}${a.languages.length ? t("authors.monitored_langs") + a.languages.map(l => `<span class="lang-tag">${esc(l)}</span>`).join(" ") : ""}</div>
        ${a.bio ? `<div class="ah-bio">${esc(a.bio)}</div>` : ""}
        <div class="ah-links" style="margin-top:8px">
          ${a.wikipedia_url ? `<a href="${esc(a.wikipedia_url)}" target="_blank">Wikipedia ↗</a>` : ""}
          ${a.website ? `<a href="${esc(a.website)}" target="_blank">Website ↗</a>` : ""}
          ${a.ol_key ? `<a href="https://openlibrary.org${esc(a.ol_key)}" target="_blank">Open Library ↗</a>` : ""}
        </div>
        <div class="flex" style="margin-top:10px;flex-wrap:wrap">
          <button class="btn small primary" data-act="author-monitor" data-id="${a.id}" title="${t("authors.monitor_title")}">${a.monitor ? t("authors.monitor_btn_on") : t("authors.monitor_btn_off")}</button>
          <button class="btn small" data-act="author-sync" data-id="${a.id}">${t("authors.sync_now")}</button>
          <button class="btn small" data-act="author-wiki" data-id="${a.id}">${t("authors.wiki_scan")}</button>
          <button class="btn small danger" data-act="author-del" data-id="${a.id}">${t("authors.delete")}</button>
        </div>
      </div>
    </div>

    <div class="lang-chips" id="lang-chips">
      <button class="chip ${!stateAuthorLang ? "active" : ""}" data-lang="">${t("authors.all_languages")}</button>
      ${d.languages.map(l => `<button class="chip ${stateAuthorLang === l ? "active" : ""}" data-lang="${esc(l)}">${esc(l)}</button>`).join("")}
    </div>

    ${d.series.length ? `<div class="panel">
      <div class="panel-head"><span>${t("authors.series_panel", { n: d.series.length })}</span>
        <button class="btn small" id="series-toggle-all">${t("series.expand_all")}</button></div>
      <div class="panel-body" id="series-list">
        ${d.series.map(s => seriesBlock(s)).join("")}
      </div>
    </div>` : ""}

    <div class="panel">
      <div class="panel-head"><span id="author-books-head">${t("authors.books_panel", { n: d.books.length })}</span>
        <span class="muted" style="font-weight:400;font-size:12px">${d.languages.length ? t("authors.lang_filter_hint") : ""}</span>
      </div>
      <div class="panel-body" id="author-books"></div>
    </div>`;

  const TABLE_ID = `author-books-${id}`;
  let currentBooks = d.books;
  const renderAuthorBooks = () => {
    document.getElementById("author-books").innerHTML = booksTable(currentBooks, TABLE_ID);
  };
  renderAuthorBooks();
  registerTable(TABLE_ID, renderAuthorBooks, () => currentBooks);
  registerSeriesTables(d.series);
  setupSeriesToggle("series-list", "series-toggle-all");

  document.getElementById("lang-chips").addEventListener("click", async e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    stateAuthorLang = chip.dataset.lang;
    const d2 = await api(`api/authors/${id}?lang=${encodeURIComponent(stateAuthorLang)}`);
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.lang === stateAuthorLang));
    const sb = document.getElementById("series-list");
    if (sb) sb.innerHTML = d2.series.map(seriesBlock).join("");
    registerSeriesTables(d2.series);
    updateSeriesToggleLabel("series-list", "series-toggle-all");
    currentBooks = d2.books;
    renderAuthorBooks();
    document.getElementById("author-books-head").textContent =
      t("authors.books_panel", { n: d2.books.length });
  });
}

function setupSeriesToggle(containerId, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener("click", () => {
    const blocks = [...document.querySelectorAll(`#${containerId} .series-block`)];
    const allOpen = blocks.length > 0 && blocks.every(b => b.classList.contains("open"));
    blocks.forEach(b => b.classList.toggle("open", !allOpen));
    btn.textContent = allOpen ? t("series.expand_all") : t("series.collapse_all");
  });
}

function updateSeriesToggleLabel(containerId, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const blocks = [...document.querySelectorAll(`#${containerId} .series-block`)];
  const allOpen = blocks.length > 0 && blocks.every(b => b.classList.contains("open"));
  btn.textContent = allOpen ? t("series.collapse_all") : t("series.expand_all");
}

let stateAuthorLang = "";

function seriesBooksColumns() {
  return [
    { key: "_cover", label: "", sortable: false, filterable: false,
      tdAttrs: () => 'class="t-cover"', render: b => coverImg(b.cover_url) },
    { key: "title", label: t("common.title"),
      render: b => `<b>${esc(b.title)}</b>${b.series_number ? ` <span class="muted">#${esc(b.series_number)}</span>` : ""}` },
    { key: "language", label: t("common.language"),
      render: b => b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—" },
    { key: "publish_date", label: t("common.published"), type: "date",
      sortValue: b => String(b.publish_date || "").match(/\d{4}/)?.[0] || "",
      render: b => `<span class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? " ⏳" : ""}</span>` },
    { key: "status", label: t("common.status"),
      tdAttrs: () => 'data-status-badge', render: b => statusBadge(b.status) },
    { key: "_actions", label: "", sortable: false, filterable: false,
      tdAttrs: () => 'style="text-align:right"',
      render: b => `<div class="row-actions">
        <button class="btn small" data-act="book-sources" data-id="${b.id}" title="${t("common.search_sources")}">🔍</button>
        ${b.wanted ? `<button class="btn small" data-act="book-wanted" data-id="${b.id}" data-w="0" title="${t("book.wanted_remove")}">✓</button>` : ""}
      </div>` },
  ];
}

function seriesBooksTable(books, tableId) {
  const columns = seriesBooksColumns();
  const st = tableState(tableId);
  const filtered = applyFilters(books, st.filters);
  const sorted = sortRows(filtered, st.sortKey, st.sortDir, st.sortType, columns);
  if (!sorted.length) return `<tr><td class="muted">${esc(t("series.no_books"))}</td></tr>`;
  let html = `<table class="data">` + tableHeader(columns, tableId) + `<tbody>`;
  for (const b of sorted) {
    html += `<tr class="clickable" data-act="book-open" data-id="${b.id}">`;
    for (const col of columns) {
      html += `<td${col.tdAttrs ? " " + col.tdAttrs(b) : ""}>${col.render(b)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table>`;
}

function seriesBlock(s) {
  const tableId = `series-${s.id}`;
  return `<div class="series-block ${stateAuthorLang ? "" : "open"}">
    <div class="series-head" data-toggle-series>
      <span class="chev">▶</span>
      <span class="s-name">${esc(s.name)} <span class="muted">(${t("series.volumes", { n: s.book_count })}${s.wanted_count ? ", " + s.wanted_count + " " + t("status.wanted") : ""})</span></span>
      <span class="badge ${s.monitor ? "monitor-on" : "monitor-off"}">${s.monitor ? t("status.monitored") : t("status.not_monitored")}</span>
      <button class="btn small" data-act="series-monitor" data-id="${s.id}" data-mon="${s.monitor}">${s.monitor ? "⚙" : "⏰"}</button>
    </div>
    <div class="series-body" id="series-body-${s.id}">
      ${seriesBooksTable(s.books, tableId)}
    </div>
  </div>`;
}

function registerSeriesTables(seriesList) {
  for (const s of seriesList) {
    const tableId = `series-${s.id}`;
    registerTable(tableId, () => {
      const body = document.getElementById(`series-body-${s.id}`);
      if (body) body.innerHTML = seriesBooksTable(s.books, tableId);
    }, () => s.books);
  }
}

document.addEventListener("click", e => {
  const toggle = e.target.closest("[data-toggle-series]");
  if (toggle) toggle.closest(".series-block").classList.toggle("open");
});

document.addEventListener("click", async e => {
  const mon = e.target.closest("[data-act='series-monitor']");
  if (mon) {
    e.stopPropagation();
    const s = mon.closest(".series-block");
    if (s) s.classList.add("open");
    openSeriesConfig(mon.dataset.id, mon.dataset.mon === "1");
    return;
  }
  const authMon = e.target.closest("[data-act='author-monitor']");
  if (authMon) { openAuthorConfig(authMon.dataset.id); return; }
  const authSync = e.target.closest("[data-act='author-sync']");
  if (authSync) {
    authSync.disabled = true; authSync.innerHTML = spinner();
    try {
      await api(`api/authors/${authSync.dataset.id}/sync`, { method: "POST" });
      toast(t("toast.sync_author_started"), "success");
      setTimeout(() => { authSync.disabled = false; authSync.textContent = t("authors.sync_now"); }, 2000);
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
    return;
  }
  const authWiki = e.target.closest("[data-act='author-wiki']");
  if (authWiki) {
    authWiki.disabled = true; authWiki.innerHTML = spinner();
    try {
      const r = await api(`api/authors/${authWiki.dataset.id}/wikipedia-scan`, { method: "POST" });
      toast(t("toast.wiki_scan", { added: r.added }), "success");
      setTimeout(() => router(), 800);
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
    return;
  }
  const authDel = e.target.closest("[data-act='author-del']");
  if (authDel) {
    if (!confirm(t("common.confirm_delete_author"))) return;
    try {
      await api(`api/authors/${authDel.dataset.id}`, { method: "DELETE" });
      toast(t("toast.author_deleted"), "success");
      location.hash = "#/authors";
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
  }
});

/* ============ monitoring config ============ */
function monitorForm(monitor, interval, kind, id, languages) {
  return `<div class="switch-row"><div class="sw-label"><b>${kind === "author" ? t("monitor.author_label") : t("monitor.series_label")}</b><br><span class="muted">${t("monitor.hint")}</span></div>
    <label class="switch"><input type="checkbox" id="mon-switch" ${monitor ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="form-row"><label>${t("monitor.interval")}</label>
      <input type="number" id="mon-interval" value="${interval || 168}" min="1">
      <div class="hint">${t("monitor.interval_hint")}</div>
    </div>
    ${kind === "author" ? `<div class="form-row"><label>${t("monitor.langs")}</label>
      <div id="mon-langs" style="display:flex;gap:6px;flex-wrap:wrap">
        ${(languages || ["de", "en"]).map(l => `<span class="lang-tag" data-lang-tag="${esc(l)}">${esc(l)} <a href="#" data-rm-lang="${esc(l)}" style="color:var(--error);text-decoration:none">✕</a></span>`).join("")}
      </div>
      <input type="text" id="mon-lang-add" placeholder="${t("monitor.lang_add")}" style="margin-top:6px">
      <div class="hint">${t("monitor.langs_hint")}</div>
    </div>` : ""}`;
}

function openAuthorConfig(aid) {
  document.getElementById("cm-title").textContent = t("monitor.author_title");
  document.getElementById("cm-body").innerHTML =
    `<div class="empty">${esc(t("common.loading"))}</div>`;
  openModal("config-modal");
  api(`api/authors/${aid}`).then(d => {
    const a = d.author;
    document.getElementById("cm-body").innerHTML = monitorForm(a.monitor, a.interval_hours, "author", aid, a.languages);
    setupMonitorForm();
    document.getElementById("cm-body").insertAdjacentHTML("beforeend",
      `<div class="modal-foot" style="padding:12px 0 0">
        <button class="btn" id="cm-cancel">${t("common.cancel")}</button>
        <button class="btn primary" id="cm-save">${t("common.save")}</button>
      </div>`);
    document.getElementById("cm-cancel").addEventListener("click", () => closeModal("config-modal"));
    document.getElementById("cm-save").addEventListener("click", async () => {
      try {
        await api(`api/authors/${aid}`, {
          method: "PATCH",
          body: JSON.stringify({
            monitor: document.getElementById("mon-switch").checked ? 1 : 0,
            interval_hours: +document.getElementById("mon-interval").value || 168,
            languages: [...document.querySelectorAll("#mon-langs .lang-tag")].map(x => x.dataset.langTag),
          }),
        });
        toast(t("common.saved"), "success");
        closeModal("config-modal");
        router();
      } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
    });
  }).catch(e => toast(e.message, "error"));
}

function openSeriesConfig(sid, monitored) {
  document.getElementById("cm-title").textContent = t("monitor.series_title");
  document.getElementById("cm-body").innerHTML = monitorForm(monitored, 168, "series", sid);
  setupMonitorForm();
  document.getElementById("cm-body").insertAdjacentHTML("beforeend",
    `<div class="modal-foot" style="padding:12px 0 0">
      <button class="btn" id="cm-cancel">${t("common.cancel")}</button>
      <button class="btn primary" id="cm-save">${t("common.save")}</button>
    </div>`);
  openModal("config-modal");
  document.getElementById("cm-cancel").addEventListener("click", () => closeModal("config-modal"));
  document.getElementById("cm-save").addEventListener("click", async () => {
    try {
      await api(`api/series/${sid}`, {
        method: "PATCH",
        body: JSON.stringify({
          monitor: document.getElementById("mon-switch").checked ? 1 : 0,
          interval_hours: +document.getElementById("mon-interval").value || 168,
        }),
      });
      toast(t("common.saved"), "success");
      closeModal("config-modal");
      router();
    } catch (err) { toast(t("common.error", { msg: err.message }), "error"); }
  });
}

function setupMonitorForm() {
  const addLang = document.getElementById("mon-lang-add");
  if (addLang) {
    addLang.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const v = addLang.value.trim().toLowerCase();
      if (v && !document.querySelector(`#mon-langs [data-lang-tag="${v}"]`)) {
        const span = document.createElement("span");
        span.className = "lang-tag";
        span.dataset.langTag = v;
        span.innerHTML = esc(v) + ` <a href="#" data-rm-lang="${esc(v)}" style="color:var(--error);text-decoration:none">✕</a>`;
        document.getElementById("mon-langs").appendChild(span);
      }
      addLang.value = "";
    });
  }
  document.addEventListener("click", e => {
    const rm = e.target.closest("[data-rm-lang]");
    if (rm) { e.preventDefault(); rm.closest(".lang-tag").remove(); }
  });
}

/* ============ page: series ============ */
async function pageSeries(content) {
  const authors = await api("api/authors?limit=500");
  const allSeries = [];
  for (const a of authors) {
    try {
      const d = await api(`api/authors/${a.id}?lang=`);
      allSeries.push(...d.series.map(s => ({ ...s, author: a.name })));
    } catch (e) {}
  }
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><span>${t("series.all_panel", { n: allSeries.length })}</span>
        <button class="btn small" id="series-toggle-all">${t("series.expand_all")}</button></div>
      <div class="panel-body" id="series-all"></div>
    </div>`;
  document.getElementById("series-all").innerHTML =
    allSeries.length ? allSeries.map(s => `
      <div class="series-block open">
        <div class="series-head" data-toggle-series>
          <span class="chev">▶</span>
          <span class="s-name">${esc(s.name)} <span class="muted">${t("series.by", { author: esc(s.author) })}</span></span>
          <span class="muted">${t("series.volumes", { n: s.book_count })}</span>
          <span class="badge ${s.monitor ? "monitor-on" : "monitor-off"}">${s.monitor ? t("status.monitored") : t("status.not_monitored")}</span>
          <button class="btn small" data-act="series-monitor" data-id="${s.id}" data-mon="${s.monitor}">⚙</button>
        </div>
        <div class="series-body" id="series-body-${s.id}">
          ${seriesBooksTable(s.books, `series-${s.id}`)}
        </div>
      </div>`).join("") : `<div class="empty">${esc(t("series.empty"))}</div>`;
  registerSeriesTables(allSeries);
  setupSeriesToggle("series-all", "series-toggle-all");
}

/* ============ page: wanted ============ */
async function pageWanted(content) {
  const wanted = await api("api/wanted");
  const TABLE_ID = "wanted-list";
  let current = wanted;
  content.innerHTML = `
    <div class="books-table-actions">
      <span class="muted">${t("wanted.searching_count", { n: wanted.length })}</span>
      <div class="spacer"></div>
      <button class="btn primary" id="wt-search">${t("wanted.search_all")}</button>
    </div>
    <div class="panel"><div class="panel-body" id="wt-box"></div></div>`;
  const renderWanted = () => {
    document.getElementById("wt-box").innerHTML =
      current.length ? wantedTable(current, TABLE_ID) : `<div class="empty">${esc(t("wanted.empty"))}</div>`;
  };
  renderWanted();
  registerTable(TABLE_ID, renderWanted, () => current);
  document.getElementById("wt-search").addEventListener("click", async () => {
    try {
      await api("api/wanted/search", { method: "POST" });
      toast(t("toast.wanted_search_started"), "success");
      setTimeout(() => router(), 1000);
    } catch (e) { toast(e.message, "error"); }
  });
  window.__wtTimer = setInterval(async () => {
    if (currentRoute().name !== "wanted") { clearInterval(window.__wtTimer); return; }
    try {
      current = await api("api/wanted");
      renderWanted();
    } catch (e) {}
  }, 10000);
}

/* ============ page: activity ============ */
function downloadsHistoryTable(downloads, tableId) {
  const columns = [
    { key: "status", label: t("common.status"), render: d => statusBadge(d.status) },
    { key: "book_title", label: t("common.book"),
      render: d => esc(d.book_title || d.title) },
    { key: "source", label: t("common.source"),
      render: d => `<span class="muted">${esc(d.source)}</span>` },
    { key: "progress", label: t("common.progress"), type: "number",
      render: d => `<div class="progress" style="width:100px"><div class="bar" style="width:${d.progress || 0}%"></div></div>` },
    { key: "message", label: t("common.message"),
      render: d => `<span class="muted">${esc(d.message || "")}</span>` },
    { key: "added", label: t("common.date"),
      render: d => `<span class="muted">${esc(d.added || "")}</span>` },
    { key: "_del", label: "", sortable: false, filterable: false,
      tdAttrs: () => 'style="text-align:right"',
      render: d => `<button class="btn small danger" data-act="dl-del" data-id="${d.id}">✕</button>` },
  ];
  const st = tableState(tableId);
  const filtered = applyFilters(downloads, st.filters);
  const sorted = sortRows(filtered, st.sortKey, st.sortDir, st.sortType, columns);
  if (!sorted.length) return `<div class="empty">${esc(t("activity.empty_downloads"))}</div>`;
  let html = `<table class="data">` + tableHeader(columns, tableId) + `<tbody>`;
  for (const d of sorted) {
    html += `<tr>`;
    for (const col of columns) {
      html += `<td${col.tdAttrs ? " " + col.tdAttrs(d) : ""}>${col.render(d)}</td>`;
    }
    html += `</tr>`;
  }
  return html + `</tbody></table>`;
}

async function pageActivity(content) {
  const [downloads, events] = await Promise.all([api("api/downloads?limit=100"), api("api/events?limit=100")]);
  const TABLE_ID = "dl-history";
  let current = downloads;
  content.innerHTML = `
    <div class="tabs">
      <button class="active" data-tab="dl">${t("activity.tab_downloads")}</button>
      <button data-tab="ev">${t("activity.tab_events")}</button>
    </div>
    <div id="tab-dl">
      <div class="panel"><div class="panel-body" id="dl-history-box"></div></div>
    </div>
    <div id="tab-ev" class="hidden">
      <div class="books-table-actions">
        <select id="ev-level">
          <option value="">${t("common.all_levels")}</option>
          <option value="error">${t("activity.level_error")}</option>
          <option value="warn">${t("activity.level_warn")}</option>
          <option value="success">${t("activity.level_success")}</option>
          <option value="info">${t("activity.level_info")}</option>
        </select>
      </div>
      <div class="panel"><div class="panel-body" id="ev-list">${eventsFeed(events)}</div></div>
    </div>`;
  const renderHistory = () => {
    document.getElementById("dl-history-box").innerHTML = downloadsHistoryTable(current, TABLE_ID);
  };
  renderHistory();
  registerTable(TABLE_ID, renderHistory, () => current);
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById("tab-dl").classList.toggle("hidden", b.dataset.tab !== "dl");
    document.getElementById("tab-ev").classList.toggle("hidden", b.dataset.tab !== "ev");
  }));
  document.getElementById("ev-level").addEventListener("change", async e => {
    const lvl = e.target.value;
    const ev = await api(`api/events?limit=100${lvl ? "&level=" + lvl : ""}`);
    document.getElementById("ev-list").innerHTML = eventsFeed(ev);
  });
  document.addEventListener("click", async e => {
    const dl = e.target.closest("[data-act='dl-del']");
    if (dl) {
      await api(`api/downloads/${dl.dataset.id}`, { method: "DELETE" });
      dl.closest("tr").remove();
    }
  });
}

/* ============ page: settings ============ */
let settings = null;
async function pageSettings(content) {
  settings = await api("api/settings");
  content.innerHTML = `
    <div class="tabs">
      <button class="active" data-tab="s-dl">${t("settings.tab_sources")}</button>
      <button data-tab="s-conv">${t("settings.tab_dirs")}</button>
      <button data-tab="s-sched">${t("settings.tab_scheduler")}</button>
    </div>
    <div id="s-dl">
      <div class="panel">
        <div class="panel-head"><span>${t("settings.prowlarr_panel")}</span><button class="btn small" data-test="prowlarr">${t("common.test_connection")}</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>${t("settings.prowlarr_url")}</label><input type="text" id="set-prowlarr-url" value="${esc(settings.prowlarr_url)}" placeholder="http://localhost:9696"></div>
            <div class="form-row"><label>${t("settings.prowlarr_key")}</label><input type="password" id="set-prowlarr-key" value="${esc(settings.prowlarr_key)}"></div>
          </div>
          <div class="form-row"><label>${t("settings.prowlarr_cats")}</label><input type="text" id="set-prowlarr-cats" value="${esc(settings.prowlarr_categories)}">
            <div class="hint">${t("settings.prowlarr_cats_hint")}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>${t("settings.sab_panel")}</span><button class="btn small" data-test="sabnzbd">${t("common.test_connection")}</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>${t("settings.sab_url")}</label><input type="text" id="set-sab-url" value="${esc(settings.sabnzbd_url)}" placeholder="http://localhost:8081"></div>
            <div class="form-row"><label>${t("settings.sab_key")}</label><input type="password" id="set-sab-key" value="${esc(settings.sabnzbd_key)}"></div>
          </div>
          <div class="form-row"><label>${t("settings.sab_cat")}</label><input type="text" id="set-sab-cat" value="${esc(settings.sabnzbd_category)}">
            <div class="hint">${t("settings.sab_cat_hint")}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>${t("settings.irc_panel")}</span><button class="btn small" data-test="irc">${t("common.check_config")}</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>${t("settings.irc_server")}</label><input type="text" id="set-irc-server" value="${esc(settings.irc_server)}" placeholder="irc.irchighway.net:6697"></div>
            <div class="form-row"><label>${t("settings.irc_channel")}</label><input type="text" id="set-irc-channel" value="${esc(settings.irc_channel)}" placeholder="#ebooks"></div>
          </div>
          <div class="form-grid">
            <div class="form-row"><label>${t("settings.irc_nick")}</label><input type="text" id="set-irc-nick" value="${esc(settings.irc_botnick)}">
              <div class="hint">${t("settings.irc_nick_hint")}</div></div>
            <div class="form-row"><label>${t("settings.irc_bots")}</label><input type="number" id="set-irc-bots" value="${esc(settings.max_irc_bots)}" min="1" max="8"></div>
          </div>
          <div class="switch-row"><div class="sw-label"><b>${t("settings.irc_ssl")}</b><br><span class="muted">${t("settings.irc_ssl_hint")}</span></div>
            <label class="switch"><input type="checkbox" id="set-irc-ssl" ${settings.irc_ssl === "1" ? "checked" : ""}><span class="slider"></span></label></div>
          <div class="hint">${t("settings.irc_etiquette")}</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>${t("settings.gb_panel")}</span><button class="btn small" data-test="google_books">${t("common.check")}</button></div>
        <div class="panel-body">
          <div class="form-row"><label>${t("settings.gb_key")}</label><input type="password" id="set-gb-key" value="${esc(settings.google_books_key)}">
            <div class="hint">${t("settings.gb_hint")}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>${t("settings.idx_panel")}</span></div>
        <div class="panel-body">
          <div id="idx-list"></div>
          <button class="btn small" id="idx-add">${t("settings.idx_add")}</button>
        </div>
      </div>
    </div>
    <div id="s-conv" class="hidden">
      <div class="panel">
        <div class="panel-head"><span>${t("settings.dirs_panel")}</span></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>${t("settings.dl_dir")}</label><input type="text" id="set-dl-dir" value="${esc(settings.download_dir)}"></div>
            <div class="form-row"><label>${t("settings.lib_dir")}</label><input type="text" id="set-lib-dir" value="${esc(settings.library_dir)}"></div>
          </div>
          <div class="form-row"><label>${t("settings.sorted_dir")}</label><input type="text" id="set-sorted-dir" value="${esc(settings.sabnzbd_sorted_dir || "")}">
            <div class="hint">${t("settings.sorted_dir_hint")}</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>${t("settings.conv_panel")}</span></div>
        <div class="panel-body">
          <div class="switch-row"><div class="sw-label"><b>${t("settings.conv_auto")}</b><br><span class="muted">${t("settings.conv_auto_hint")}</span></div>
            <label class="switch"><input type="checkbox" id="set-conv-on" ${settings.convert_enabled === "1" ? "checked" : ""}><span class="slider"></span></label></div>
          <div class="form-row"><label>${t("settings.conv_format")}</label>
            <select id="set-conv-fmt">
              ${["epub", "mobi", "azw3", "pdf", "fb2", "txt"].map(f => `<option value="${f}" ${settings.convert_format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}
            </select>
            <div class="hint">${t("settings.conv_format_hint")}</div></div>
        </div>
      </div>
    </div>
    <div id="s-sched" class="hidden">
      <div class="panel">
        <div class="panel-head"><span>${t("settings.sched_panel")}</span></div>
        <div class="panel-body">
          <div class="switch-row"><div class="sw-label"><b>${t("settings.sched_wanted_on")}</b><br><span class="muted">${t("settings.sched_wanted_hint")}</span></div>
            <label class="switch"><input type="checkbox" id="set-ws-on" ${settings.wanted_search_enabled === "1" ? "checked" : ""}><span class="slider"></span></label></div>
          <div class="form-grid">
            <div class="form-row"><label>${t("settings.sched_wanted_interval")}</label><input type="number" id="set-ws-iv" value="${esc(settings.wanted_interval)}" min="1"></div>
            <div class="form-row"><label>${t("settings.sched_monitor_interval")}</label><input type="number" id="set-mon-iv" value="${esc(settings.monitor_interval)}" min="1">
              <div class="hint">${t("settings.sched_monitor_hint")}</div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex" style="justify-content:flex-end;margin-top:6px">
      <button class="btn primary" id="set-save" style="font-size:14px;padding:10px 24px">${t("settings.save")}</button>
    </div>`;

  // render indexer list
  renderIndexers();
  document.getElementById("idx-add").addEventListener("click", () => {
    settings.indexers.push({ name: "", url: "", api_key: "", categories: "7000,7020", enabled: 1, priority: 0 });
    renderIndexers();
  });

  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    ["s-dl", "s-conv", "s-sched"].forEach(id => document.getElementById(id).classList.toggle("hidden", id !== b.dataset.tab));
  }));

  document.querySelectorAll("[data-test]").forEach(btn => btn.addEventListener("click", async () => {
    const name = btn.dataset.test;
    const body = {
      prowlarr: { name, url: document.getElementById("set-prowlarr-url").value, key: document.getElementById("set-prowlarr-key").value },
      sabnzbd: { name, url: document.getElementById("set-sab-url").value, key: document.getElementById("set-sab-key").value },
      irc: { name, server: document.getElementById("set-irc-server").value },
      google_books: { name, key: document.getElementById("set-gb-key").value },
    }[name];
    btn.disabled = true; btn.innerHTML = spinner() + " " + t("common.test");
    try {
      const r = await api("api/settings/test", { method: "POST", body: JSON.stringify(body) });
      toast(`${r.name}: ${r.ok ? "✓ " + r.message : "✗ " + r.message}`, r.ok ? "success" : "error");
    } catch (e) { toast(e.message, "error"); }
    btn.disabled = false; btn.textContent = t("common.test_connection");
  }));

  document.getElementById("set-save").addEventListener("click", async () => {
    try {
      await api("api/settings", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            prowlarr_url: document.getElementById("set-prowlarr-url").value,
            prowlarr_key: document.getElementById("set-prowlarr-key").value,
            prowlarr_categories: document.getElementById("set-prowlarr-cats").value,
            sabnzbd_url: document.getElementById("set-sab-url").value,
            sabnzbd_key: document.getElementById("set-sab-key").value,
            sabnzbd_category: document.getElementById("set-sab-cat").value,
            irc_server: document.getElementById("set-irc-server").value,
            irc_channel: document.getElementById("set-irc-channel").value,
            irc_botnick: document.getElementById("set-irc-nick").value,
            irc_ssl: document.getElementById("set-irc-ssl").checked ? "1" : "0",
            max_irc_bots: document.getElementById("set-irc-bots").value,
            google_books_key: document.getElementById("set-gb-key").value,
            download_dir: document.getElementById("set-dl-dir").value,
            library_dir: document.getElementById("set-lib-dir").value,
            sabnzbd_sorted_dir: document.getElementById("set-sorted-dir").value,
            convert_enabled: document.getElementById("set-conv-on").checked ? "1" : "0",
            convert_format: document.getElementById("set-conv-fmt").value,
            wanted_search_enabled: document.getElementById("set-ws-on").checked ? "1" : "0",
            wanted_interval: document.getElementById("set-ws-iv").value,
            monitor_interval: document.getElementById("set-mon-iv").value,
          },
          indexers: settings.indexers,
        }),
      });
      toast(t("toast.settings_saved"), "success");
      refreshStatus();
    } catch (e) { toast(t("common.error", { msg: e.message }), "error"); }
  });
}

function renderIndexers() {
  const box = document.getElementById("idx-list");
  box.innerHTML = settings.indexers.map((i, n) => `
    <div class="src-row" style="background:var(--panel)">
      <label class="switch" style="flex-shrink:0"><input type="checkbox" data-idx="${n}" data-field="enabled" ${i.enabled ? "checked" : ""}><span class="slider"></span></label>
      <input type="text" data-idx="${n}" data-field="name" value="${esc(i.name)}" placeholder="${t("settings.idx_name")}" style="flex:1.2;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 9px;min-width:90px">
      <input type="text" data-idx="${n}" data-field="url" value="${esc(i.url)}" placeholder="http://…/newznab" style="flex:2;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 9px;min-width:140px">
      <input type="password" data-idx="${n}" data-field="api_key" value="${esc(i.api_key)}" placeholder="API-Key" style="flex:1.2;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 9px;min-width:90px">
      <button class="btn small danger" data-idx-rm="${n}">✕</button>
    </div>`).join("");
  box.querySelectorAll("[data-idx]").forEach(el => el.addEventListener("change", e => {
    const n = +el.dataset.idx;
    const f = el.dataset.field;
    settings.indexers[n][f] = el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value;
  }));
  box.querySelectorAll("[data-idx]").forEach(el => el.addEventListener("input", e => {
    if (el.type === "checkbox") return;
    const n = +el.dataset.idx;
    settings.indexers[n][el.dataset.field] = el.value;
  }));
  box.querySelectorAll("[data-idx-rm]").forEach(btn => btn.addEventListener("click", () => {
    settings.indexers.splice(+btn.dataset.idxRm, 1);
    renderIndexers();
  }));
}

/* ============ page: system ============ */
async function pageSystem(content) {
  const [st, logs] = await Promise.all([api("api/status"), api("api/system/logs")]);
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><span>${t("system.connections")}</span></div>
      <div class="panel-body">
        <table class="data">
          <thead><tr><th>${t("system.service")}</th><th>${t("common.status")}</th></tr></thead>
          <tbody>
            ${connRow("Prowlarr", st.connectivity.prowlarr)}
            ${connRow("SABnzbd", st.connectivity.sabnzbd)}
            ${connRow("IRC", st.connectivity.irc)}
            ${connRow("Calibre", st.connectivity.convert)}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>${t("system.scheduler")}</span></div>
      <div class="panel-body">
        <div class="kv"><span class="k">${t("common.status")}</span><span>${st.scheduler.running ? t("status.running") : t("status.stopped")}</span></div>
        <div class="kv"><span class="k">${t("system.current_task")}</span><span>${esc(st.scheduler.loop)}${st.scheduler.current_book ? " — " + esc(st.scheduler.current_book) : ""}${st.scheduler.current_sync ? " — " + esc(st.scheduler.current_sync) : ""}</span></div>
        <div class="kv"><span class="k">${t("system.last_wanted")}</span><span>${esc(st.scheduler.last_wanted || t("status.not_yet"))}</span></div>
        <div class="kv"><span class="k">${t("system.last_sync")}</span><span>${esc(st.scheduler.last_sync || t("status.not_yet"))}</span></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>${t("system.log_panel")}</span><button class="btn small" id="sys-reload">${t("system.refresh")}</button></div>
      <div class="panel-body" id="sys-log" style="max-height:420px;overflow-y:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px">
        ${logs.logs.map(l => `<div class="log-line"><span class="t">${esc(l)}</span></div>`).join("")}
      </div>
    </div>`;
  document.getElementById("sys-reload").addEventListener("click", async () => {
    const l2 = await api("api/system/logs");
    document.getElementById("sys-log").innerHTML = l2.logs.map(l => `<div class="log-line">${esc(l)}</div>`).join("");
  });
}

function connRow(name, ok) {
  return `<tr><td>${esc(name)}</td><td>${ok ? `<span class="badge have">${t("status.reachable")}</span>` : `<span class="badge failed">${t("status.unreachable")}</span>`}</td></tr>`;
}

/* ============ startup ============ */
document.addEventListener("DOMContentLoaded", async () => {
  await loadCatalog(LANG);
  document.getElementById("btn-lang").textContent = t("lang.name") + " ▾";
  markActiveLang();
  applyStaticI18n();
  router();
  refreshStatus();
  setInterval(refreshStatus, 15000);
});
