/* Bookarr — Frontend-SPA */
"use strict";

/* ============ Helfer ============ */
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

function fmtDate(d) {
  if (!d) return "—";
  const m = String(d).match(/(\d{4})(?:-(\d{2})-(\d{2}))?/);
  if (!m) return "—";
  if (m[2]) return `${m[2]}.${m[3]}.${m[1]}`;
  return m[1];
}

function isFuture(d) {
  if (!d) return false;
  const m = String(d).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  return new Date(+m[1], +m[2] - 1, +m[3]) > new Date();
}

function statusBadge(status) {
  const map = {
    have: "have", wanted: "wanted", snatched: "snatched",
    missing: "missing", downloading: "downloading", completed: "completed",
    failed: "failed", queued: "queued", searching: "searching", found: "found",
  };
  const cls = map[status] || "monitor-off";
  const label = { have: "Vorhanden", wanted: "Wanted", snatched: "Geladen",
    missing: "Fehlt", downloading: "Lädt", completed: "Fertig", failed: "Fehler",
    queued: "Wartet", searching: "Suche", found: "Gefunden" }[status] || status;
  return `<span class="badge ${cls}">${label}</span>`;
}

function coverImg(url, cls = "cover-thumb") {
  if (!url) return `<div class="cover-placeholder ${cls === "cover-thumb" ? "" : ""}">📕</div>`;
  return `<img class="${cls}" src="${esc(url)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover-placeholder'}));this.onerror=null;document.createTextNode('📕');this.parentNode.replaceChild(document.createTextNode('📕'),this)">`;
}

function spinner() {
  return `<span class="spin">⟳</span>`;
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ============ Router ============ */
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
  const titles = {
    overview: "Übersicht", books: "Bücher", authors: "Autoren", author: "Autor",
    series: "Serien", wanted: "Wanted", activity: "Aktivität",
    settings: "Einstellungen", system: "System",
  };
  document.getElementById("page-title").textContent = titles[name] || "Bookarr";
  const content = document.getElementById("content");
  content.innerHTML = `<div class="empty">Lade …</div>`;
  (routes[name] || pageOverview)(content, param).catch(err => {
    content.innerHTML = `<div class="empty">Fehler: ${esc(err.message)}</div>`;
  });
}

window.addEventListener("hashchange", router);

/* ============ Status-Sidebar / Polling ============ */
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
    let line = st.loop === "wanted-search" ? "⏳ Wanted-Suche läuft…"
      : st.loop === "monitor-sync" ? "🔄 Sync läuft…" : "Bereit";
    if (st.current_book) line += ` (${st.current_book.slice(0, 30)})`;
    document.getElementById("scheduler-state").textContent = line;
  } catch (e) {}
}
function setDot(id, on) {
  const el = document.getElementById(id);
  if (el) el.className = "dot " + (on ? "on" : "off");
}

/* ============ Modals ============ */
function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

document.addEventListener("click", e => {
  if (e.target.classList.contains("modal") ) closeModal(e.target.id);
  const closeBtn = e.target.closest("[data-close]");
  if (closeBtn) closeModal(closeBtn.dataset.close);
});

/* ============ Global-Suche ============ */
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
  if (q.length < 2) { box.innerHTML = `<div class="empty">Mindestens 2 Zeichen eingeben.</div>`; return; }
  box.innerHTML = `<div class="empty">${spinner()} Suche in Open Library & Wikipedia …</div>`;
  try {
    const d = await api(`api/search/metadata?q=${encodeURIComponent(q)}&type=${searchType}`);
    if (seq !== searchSeq) return;
    let html = "";
    if (searchType !== "book" && d.authors && d.authors.length) {
      html += `<div class="sr-group-title">Autoren (Open Library)</div>`;
      for (const a of d.authors) {
        html += `<div class="sr-row">
          <div style="flex:1">
            <div class="sr-title">${esc(a.name)}</div>
            <div class="sr-sub">${esc(a.birth_date || "")} ${esc(a.death_date ? "– " + a.death_date : "")}</div>
          </div>
          <div class="sr-actions">
            <button class="btn small primary" data-act="add-author" data-key="${esc(a.ol_key)}" data-name="${esc(a.name)}">Hinzufügen</button>
          </div>
        </div>`;
      }
    }
    if (searchType !== "author" && d.books && d.books.length) {
      html += `<div class="sr-group-title">Bücher (Open Library)</div>`;
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
              data-key="${esc(b.ol_work_key)}" data-year="${esc(b.year || "")}" data-cover="${esc(b.cover || "")}">Hinzufügen</button>
          </div>
        </div>`;
      }
    }
    if (searchType !== "book" && d.wikipedia && d.wikipedia.length) {
      html += `<div class="sr-group-title">Wikipedia-Werke (${esc(q)})</div>`;
      html += `<div class="sr-sub" style="margin-bottom:6px">Gefunden in der Werke-Sektion der Wikipedia-Seite:</div>`;
      for (const w of d.wikipedia.slice(0, 25)) {
        html += `<div class="sr-row">
          <div style="flex:1">
            <div class="sr-title">${esc(w.title)}</div>
            <div class="sr-sub">${w.year ? w.year + " · Quelle: Wikipedia" : "Quelle: Wikipedia"}</div>
          </div>
          <div class="sr-actions">
            <button class="btn small" data-act="add-book"
              data-title="${esc(w.title)}" data-author="${esc(q)}"
              data-year="${esc(w.year || "")}" data-source="wikipedia">Hinzufügen</button>
          </div>
        </div>`;
      }
    }
    if (!html) html = `<div class="empty">Keine Treffer.</div>`;
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<div class="empty">Suche fehlgeschlagen: ${esc(e.message)}</div>`;
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
      toast(`Autor angelegt (${r.id})`, "success");
      closeModal("search-modal");
      location.hash = `#/author/${r.id}`;
    } catch (err) {
      toast("Fehler: " + err.message, "error");
      addAuthor.disabled = false; addAuthor.textContent = "Hinzufügen";
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
      toast(r.duplicate ? "Buch bereits vorhanden" : "Buch hinzugefügt", r.duplicate ? "warn" : "success");
      addBook.textContent = "✓";
    } catch (err) {
      toast("Fehler: " + err.message, "error");
      addBook.disabled = false; addBook.textContent = "Hinzufügen";
    }
  }
});

/* ============ Topbar-Aktionen ============ */
document.getElementById("btn-wanted-search").addEventListener("click", async () => {
  try {
    await api("api/wanted/search", { method: "POST" });
    toast("Wanted-Suche gestartet", "success");
  } catch (e) { toast("Fehler: " + e.message, "error"); }
});
document.getElementById("btn-sync-all").addEventListener("click", async () => {
  try {
    await api("api/actions/sync-all", { method: "POST" });
    toast("Sync überwachter Autoren & Serien gestartet", "success");
  } catch (e) { toast("Fehler: " + e.message, "error"); }
});

/* ============ Seite: Übersicht ============ */
async function pageOverview(content) {
  const d = await api("api/overview");
  const st = await api("api/status");
  const c = st.counts;
  content.innerHTML = `
    <div class="stat-grid">
      ${statCard(c.books, "Bücher gesamt")}
      ${statCard(c.have, "Vorhanden")}
      ${statCard(c.wanted, "Wanted")}
      ${statCard(c.authors, "Autoren")}
      ${statCard(c.series, "Serien")}
      ${statCard(c.active_downloads, "Aktive Downloads")}
    </div>
    <div class="panel">
      <div class="panel-head"><span>⏳ Wanted-Bücher</span>
        <button class="btn small" id="ov-wanted-search">Jetzt suchen</button></div>
      <div class="panel-body">${d.wanted.length ? wantedTable(d.wanted) : `<div class="empty">Keine Wanted-Bücher — über Autoren-/Serien-Monitoring oder manuell markieren.</div>`}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>⇅ Aktive Downloads</span></div>
      <div class="panel-body">
        ${d.active.length ? downloadsTable(d.active) : `<div class="empty">Keine aktiven Downloads.</div>`}
        ${d.sab_queue.length ? `<div style="margin-top:14px"><div class="muted" style="margin-bottom:6px;font-size:12px;text-transform:uppercase">SABnzbd-Queue</div>${sabTable(d.sab_queue)}</div>` : ""}
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>🕐 Letzte Ereignisse</span></div>
      <div class="panel-body">${eventsFeed(d.events)}</div>
    </div>`;
  document.getElementById("ov-wanted-search").addEventListener("click", async () => {
    try { await api("api/wanted/search", { method: "POST" }); toast("Wanted-Suche gestartet", "success"); }
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
      const wantBox = document.querySelectorAll(".panel")[0].querySelector(".panel-body");
      wantBox.innerHTML = d2.wanted.length ? wantedTable(d2.wanted) : `<div class="empty">Keine Wanted-Bücher.</div>`;
      const dlBox = document.querySelectorAll(".panel")[1].querySelector(".panel-body");
      dlBox.innerHTML = d2.active.length ? downloadsTable(d2.active) : `<div class="empty">Keine aktiven Downloads.</div>`;
    } catch (e) {}
  }, 8000);
}

function statCard(v, l) {
  return `<div class="stat-card"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`;
}

function wantedTable(wanted) {
  return `<table class="data">
    <thead><tr><th></th><th>Titel</th><th>Autor</th><th>Sprache</th><th>Erscheint</th><th>Intervall</th><th>Letzte Suche</th><th style="text-align:right">Aktion</th></tr></thead>
    <tbody>
      ${wanted.map(w => `<tr>
        <td class="t-cover">${coverImg(w.cover_url)}</td>
        <td><b>${esc(w.title)}</b></td>
        <td class="muted">${esc(w.author_name || "")}</td>
        <td>${w.language ? `<span class="lang-tag">${esc(w.language)}</span>` : "—"}</td>
        <td class="${isFuture(w.publish_date) ? "future" : ""}">${fmtDate(w.publish_date)}${isFuture(w.publish_date) ? " ⏳" : ""}</td>
        <td>${w.interval_hours} h</td>
        <td class="muted">${fmtDate(w.last_search) === "—" ? "nie" : esc(w.last_search)}</td>
        <td><div class="row-actions">
          <button class="btn small" data-act="book-sources" data-id="${w.id}" title="Quellen suchen">🔍</button>
          <button class="btn small" data-act="book-wanted" data-id="${w.id}" data-w="0" title="Wanted entfernen">✓</button>
          <button class="btn small danger" data-act="book-del" data-id="${w.id}" title="Löschen">✕</button>
        </div></td>
      </tr>`).join("")}
    </tbody></table>`;
}

function downloadsTable(list) {
  return `<table class="data">
    <thead><tr><th>Status</th><th>Titel</th><th>Quelle</th><th>Fortschritt</th><th>Meldung</th></tr></thead>
    <tbody>
      ${list.map(d => `<tr>
        <td>${statusBadge(d.status)}</td>
        <td>${esc(d.book_title || d.title)}</td>
        <td class="muted">${esc(d.source)}</td>
        <td><div class="progress" style="width:110px"><div class="bar" style="width:${d.progress || 0}%"></div></div></td>
        <td class="muted">${esc(d.message || "")}</td>
      </tr>`).join("")}
    </tbody></table>`;
}

function sabTable(q) {
  return `<table class="data">
    <thead><tr><th>Titel</th><th>Fortschritt</th><th>Größe</th><th>Geschwindigkeit</th><th>Restzeit</th></tr></thead>
    <tbody>${q.map(s => `<tr>
      <td>${esc(s.title)}</td>
      <td><div class="progress" style="width:110px"><div class="bar" style="width:${s.progress || 0}%"></div></div></td>
      <td class="muted">${esc(s.size)}</td>
      <td class="muted">${esc(s.speed)}</td>
      <td class="muted">${esc(s.eta)}</td>
    </tr>`).join("")}</tbody></table>`;
}

function eventsFeed(events) {
  if (!events.length) return `<div class="empty">Noch keine Ereignisse.</div>`;
  return events.map(e => `
    <div class="event-row ${esc(e.level)}">
      <span class="ev-dot ${esc(e.level)}"></span>
      <span class="event-time">${esc(e.time)}</span>
      <span class="event-msg"><b>${esc(e.source)}</b>: ${esc(e.message)}</span>
    </div>`).join("");
}

/* ============ Seite: Bücher ============ */
async function pageBooks(content) {
  const books = await api("api/books?limit=500");
  const langs = [...new Set(books.map(b => b.language).filter(Boolean))].sort();
  content.innerHTML = `
    <div class="books-table-actions">
      <input type="text" id="bk-q" placeholder="Titel / Autor filtern …">
      <select id="bk-status">
        <option value="">Alle Status</option>
        <option value="have">Vorhanden</option>
        <option value="wanted">Wanted</option>
        <option value="missing">Fehlt</option>
        <option value="snatched">Geladen</option>
      </select>
      <select id="bk-lang"><option value="">Alle Sprachen</option>
        ${langs.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}
      </select>
      <div class="spacer"></div>
      <span class="muted" id="bk-count">${books.length} Bücher</span>
    </div>
    <div id="bk-table">${booksTable(books)}</div>`;

  const apply = () => {
    const q = document.getElementById("bk-q").value.toLowerCase();
    const st = document.getElementById("bk-status").value;
    const lg = document.getElementById("bk-lang").value;
    const filtered = books.filter(b =>
      (!q || (b.title || "").toLowerCase().includes(q) || (b.author_name || "").toLowerCase().includes(q)) &&
      (!st || b.status === st) && (!lg || b.language === lg));
    document.getElementById("bk-count").textContent = filtered.length + " Bücher";
    document.getElementById("bk-table").innerHTML = booksTable(filtered);
  };
  document.getElementById("bk-q").addEventListener("input", debounce(apply, 200));
  document.getElementById("bk-status").addEventListener("change", apply);
  document.getElementById("bk-lang").addEventListener("change", apply);
}

function booksTable(books) {
  if (!books.length) return `<div class="empty">Keine Bücher gefunden.</div>`;
  return `<table class="data">
    <thead><tr><th></th><th>Titel</th><th>Autor</th><th>Serie</th><th>Sprache</th><th>Erscheint</th><th>Status</th><th style="text-align:right">Aktionen</th></tr></thead>
    <tbody>
      ${books.map(b => `<tr class="clickable" data-act="book-open" data-id="${b.id}">
        <td class="t-cover">${coverImg(b.cover_url)}</td>
        <td><b>${esc(b.title)}</b>${b.series_number ? `<span class="muted"> #${esc(b.series_number)}</span>` : ""}</td>
        <td class="muted">${esc(b.author_name || "")}</td>
        <td class="muted">${esc(b.series_name || "—")}</td>
        <td>${b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—"}</td>
        <td class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? " ⏳" : ""}</td>
        <td>${statusBadge(b.status)}</td>
        <td><div class="row-actions">
          <button class="btn small" data-act="book-sources" data-id="${b.id}" title="Quellen suchen">🔍</button>
          ${b.wanted ? `<button class="btn small" data-act="book-wanted" data-id="${b.id}" data-w="0" title="Wanted entfernen">✓</button>`
                     : `<button class="btn small" data-act="book-wanted" data-id="${b.id}" data-w="1" title="Als Wanted markieren">⏳</button>`}
          <button class="btn small danger" data-act="book-del" data-id="${b.id}" title="Löschen">✕</button>
        </div></td>
      </tr>`).join("")}
    </tbody></table>`;
}

/* ============ Buch-Detail Modal ============ */
let sourcesTimer = null;
document.addEventListener("click", async e => {
  const open = e.target.closest("[data-act='book-open']");
  if (open) { showBookModal(open.dataset.id); return; }
  const sources = e.target.closest("[data-act='book-sources']");
  if (sources) {
    e.stopPropagation();
    const bid = sources.dataset.id;
    // Modal öffnen und direkt Quellen suchen
    showBookModal(bid, { autoSearch: true });
    return;
  }
  const wanted = e.target.closest("[data-act='book-wanted']");
  if (wanted) {
    e.stopPropagation();
    try {
      await api(`api/books/${wanted.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({ wanted: +wanted.dataset.w }),
      });
      toast(wanted.dataset.w === "1" ? "Als Wanted markiert" : "Wanted entfernt", "success");
      router();
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  const del = e.target.closest("[data-act='book-del']");
  if (del) {
    e.stopPropagation();
    if (!confirm("Buch wirklich löschen?")) return;
    try {
      await api(`api/books/${del.dataset.id}`, { method: "DELETE" });
      toast("Buch gelöscht", "success");
      router();
    } catch (err) { toast(err.message, "error"); }
  }
});

async function showBookModal(id, opts = {}) {
  const books = await api(`api/books?id=${id}`);
  const b = books[0];
  if (!b) return;
  openModal("book-modal");
  const body = document.getElementById("bm-body");
  body.innerHTML = `<div class="empty">${spinner()} Lade …</div>`;
  document.getElementById("bm-title").textContent = b.title;
  let srcHtml = `<div class="empty" id="bm-src-placeholder">Noch keine Quellen gesucht.</div>`;
  if (opts.autoSearch) {
    srcHtml = `<div class="empty">${spinner()} Suche NZB & IRC … <span class="muted">(kann bis zu 3 Min. dauern)</span></div>`;
  }
  body.innerHTML = `
    <div class="bm-grid">
      <div>
        ${coverImg(b.cover_url, "book-thumb-lg")}
        <div style="margin-top:10px" class="row-actions" style="flex-wrap:wrap;justify-content:flex-start">
          ${b.wanted ? `<button class="btn small" id="bm-wanted" data-w="0">Wanted entfernen</button>`
                     : `<button class="btn small primary" id="bm-wanted" data-w="1">Als Wanted markieren</button>`}
          <button class="btn small" id="bm-convert" ${b.file_path ? "" : "disabled"} title="${b.file_path ? "In Zielformat konvertieren" : "Keine Datei vorhanden"}">🔄 Konvertieren</button>
          <button class="btn small danger" id="bm-del">Löschen</button>
        </div>
      </div>
      <div>
        <div class="kv"><span class="k">Autor</span><span>${esc(b.author_name || "—")}</span></div>
        <div class="kv"><span class="k">Serie</span><span>${esc(b.series_name || "—")}${b.series_number ? " #" + esc(b.series_number) : ""}</span></div>
        <div class="kv"><span class="k">Erscheinungsdatum</span><span class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? " ⏳ (zukünftig)" : ""}</span></div>
        <div class="kv"><span class="k">Sprache</span><span>${b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—"}</span></div>
        <div class="kv"><span class="k">ISBN</span><span class="mono">${esc(b.isbn || "—")}</span></div>
        <div class="kv"><span class="k">Status</span><span>${statusBadge(b.status)}</span></div>
        <div class="kv"><span class="k">Datei</span><span class="muted" style="word-break:break-all">${esc(b.file_path || "—")}</span></div>
        ${b.description ? `<div class="bm-desc">${esc(b.description)}</div>` : ""}
      </div>
    </div>
    <div style="margin-top:18px">
      <div class="panel-head" style="padding:8px 0;border-bottom:none"><span>🔍 Quellen (NZB + IRC)</span>
        <button class="btn small primary" id="bm-search-sources">${spinner() === "" ? "" : ""}Quellen suchen</button>
      </div>
      <div id="bm-sources">${srcHtml}</div>
    </div>`;

  document.getElementById("bm-wanted").addEventListener("click", async ev => {
    try {
      await api(`api/books/${b.id}`, { method: "PATCH", body: JSON.stringify({ wanted: +ev.target.dataset.w }) });
      toast("OK", "success"); closeModal("book-modal"); router();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("bm-convert").addEventListener("click", async () => {
    try {
      await api(`api/books/${b.id}/convert`, { method: "POST" });
      toast("Konvertierung gestartet", "success");
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("bm-del").addEventListener("click", async () => {
    if (!confirm("Buch wirklich löschen?")) return;
    await api(`api/books/${b.id}`, { method: "DELETE" });
    closeModal("book-modal"); router();
  });
  document.getElementById("bm-search-sources").addEventListener("click", () => searchSources(b.id, b.title));

  if (opts.autoSearch) searchSources(b.id, b.title);
}

async function searchSources(bookId, title) {
  if (sourcesTimer) clearInterval(sourcesTimer);
  const box = document.getElementById("bm-sources");
  if (!box) return;
  box.innerHTML = `<div class="empty">${spinner()} Suche NZB & IRC … <span class="muted">(IRC kann bis zu 3 Min. dauern)</span></div>`;
  try {
    const r = await api(`api/search/downloads?book_id=${bookId}`);
    if (r.done) { renderSources(box, r.results, bookId); return; }
    sourcesTimer = setInterval(async () => {
      try {
        const r2 = await api(`api/search/downloads?book_id=${bookId}`);
        if (r2.done) {
          clearInterval(sourcesTimer);
          renderSources(box, r2.results, bookId);
        } else {
          box.innerHTML = `<div class="empty">${spinner()} Suche läuft noch … <span class="muted">(IRC kann bis zu 3 Min. dauern)</span></div>`;
        }
      } catch (e) { clearInterval(sourcesTimer); box.innerHTML = `<div class="empty">Fehler: ${esc(e.message)}</div>`; }
    }, 5000);
  } catch (e) {
    box.innerHTML = `<div class="empty">Fehler: ${esc(e.message)}</div>`;
  }
}

function renderSources(box, results, bookId) {
  if (!results.length) {
    box.innerHTML = `<div class="empty">Keine Quellen gefunden.</div>`;
    return;
  }
  box.innerHTML = results.map((r, i) => `
    <div class="src-row">
      <span class="src-badge ${r.source === "irc" ? "irc" : "nzb"}">${r.source === "irc" ? "IRC" : "NZB"}</span>
      <div class="src-title" title="${esc(r.title)}">${esc(r.title)}</div>
      <div class="src-meta">${r.indexer ? esc(r.indexer) + " · " : ""}${fmtSize(r.size)}</div>
      <button class="btn small primary" data-act="start-dl" data-idx="${i}">Download</button>
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
        toast("Download gestartet", "success");
        btn.textContent = "✓";
      } catch (err) {
        toast("Fehler: " + err.message, "error");
        btn.disabled = false; btn.textContent = "Download";
      }
    });
  });
}

/* ============ Seite: Autoren ============ */
async function pageAuthors(content) {
  const authors = await api("api/authors");
  content.innerHTML = `
    <div class="books-table-actions">
      <input type="text" id="au-q" placeholder="Autor filtern …">
      <div class="spacer"></div>
      <button class="btn" id="au-add">＋ Autor hinzufügen</button>
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
  if (!authors.length) return `<div class="empty" style="grid-column:1/-1">Noch keine Autoren — über die Suche (🔍) hinzufügen.</div>`;
  return authors.map(a => `
    <div class="author-card" data-nav-author="${a.id}">
      <div class="a-name">${esc(a.name)}</div>
      <div class="a-sub">${esc(a.birth_date || "")}${a.death_date ? " – " + esc(a.death_date) : ""}</div>
      <div class="a-meta">
        <span class="badge ${a.monitor ? "monitor-on" : "monitor-off"}">${a.monitor ? "Überwacht" : "Nicht überwacht"}</span>
        <span class="lang-tag">${a.book_count} Bücher</span>
        ${a.wanted_count ? `<span class="badge wanted">${a.wanted_count} wanted</span>` : ""}
      </div>
    </div>`).join("");
}

document.addEventListener("click", e => {
  const card = e.target.closest("[data-nav-author]");
  if (card) location.hash = `#/author/${card.dataset.navAuthor}`;
});

/* ============ Seite: Autor-Detail ============ */
async function pageAuthor(content, param) {
  const id = parseInt(param, 10);
  let d;
  try { d = await api(`api/authors/${id}?lang=`); }
  catch (e) { content.innerHTML = `<div class="empty">Autor nicht gefunden.</div>`; return; }
  const a = d.author;
  const initials = (a.name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const monitorCfg = monitorForm(a.monitor, a.interval_hours, "author", a.id, a.languages);

  content.innerHTML = `
    <div class="author-header">
      <div class="cover-placeholder" style="width:90px;height:130px;font-size:32px;flex-shrink:0">${esc(initials)}</div>
      <div style="flex:1">
        <div class="ah-name">${esc(a.name)}</div>
        <div class="ah-sub">${esc(a.birth_date || "")}${a.death_date ? " – " + esc(a.death_date) : ""}${a.languages.length ? " · überwacht: " + a.languages.map(l => `<span class="lang-tag">${esc(l)}</span>`).join(" ") : ""}</div>
        ${a.bio ? `<div class="ah-bio">${esc(a.bio)}</div>` : ""}
        <div class="ah-links" style="margin-top:8px">
          ${a.wikipedia_url ? `<a href="${esc(a.wikipedia_url)}" target="_blank">Wikipedia ↗</a>` : ""}
          ${a.website ? `<a href="${esc(a.website)}" target="_blank">Website ↗</a>` : ""}
          ${a.ol_key ? `<a href="https://openlibrary.org${esc(a.ol_key)}" target="_blank">Open Library ↗</a>` : ""}
        </div>
        <div class="flex" style="margin-top:10px;flex-wrap:wrap">
          <button class="btn small primary" data-act="author-monitor" data-id="${a.id}" title="Überwachung konfigurieren">${a.monitor ? "🔄 Überwachung an" : "⏰ Überwachung aus"}</button>
          <button class="btn small" data-act="author-sync" data-id="${a.id}">🔄 Jetzt abgleichen</button>
          <button class="btn small" data-act="author-wiki" data-id="${a.id}">📄 Wikipedia-Scan</button>
          <button class="btn small danger" data-act="author-del" data-id="${a.id}">Löschen</button>
        </div>
      </div>
    </div>

    <div class="lang-chips" id="lang-chips">
      <button class="chip ${!stateAuthorLang ? "active" : ""}" data-lang="">Alle Sprachen</button>
      ${d.languages.map(l => `<button class="chip ${stateAuthorLang === l ? "active" : ""}" data-lang="${esc(l)}">${esc(l)}</button>`).join("")}
    </div>

    ${d.series.length ? `<div class="panel">
      <div class="panel-head"><span>🔗 Serien (${d.series.length})</span></div>
      <div class="panel-body" id="series-list">
        ${d.series.map(s => seriesBlock(s)).join("")}
      </div>
    </div>` : ""}

    <div class="panel">
      <div class="panel-head"><span>📖 Bücher (${d.books.length})</span>
        <span class="muted" style="font-weight:400;font-size:12px">${d.languages.length ? "Sprachfilter oben" : ""}</span>
      </div>
      <div class="panel-body" id="author-books">
        ${booksTable(d.books)}
      </div>
    </div>`;

  document.getElementById("lang-chips").addEventListener("click", async e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    stateAuthorLang = chip.dataset.lang;
    const d2 = await api(`api/authors/${id}?lang=${encodeURIComponent(stateAuthorLang)}`);
    document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.lang === stateAuthorLang));
    const sb = document.getElementById("series-list");
    if (sb) sb.innerHTML = d2.series.map(seriesBlock).join("");
    document.getElementById("author-books").innerHTML = booksTable(d2.books);
    const head = document.querySelector(".panel-head span");
    head.textContent = `📖 Bücher (${d2.books.length})`;
  });
}

let stateAuthorLang = "";

function seriesBlock(s) {
  return `<div class="series-block ${stateAuthorLang ? "" : "open"}">
    <div class="series-head" data-toggle-series>
      <span class="chev">▶</span>
      <span class="s-name">${esc(s.name)} <span class="muted">(${s.book_count} Bände${s.wanted_count ? ", " + s.wanted_count + " wanted" : ""})</span></span>
      <span class="badge ${s.monitor ? "monitor-on" : "monitor-off"}">${s.monitor ? "Überwacht" : "Nicht überwacht"}</span>
      <button class="btn small" data-act="series-monitor" data-id="${s.id}" data-mon="${s.monitor}">${s.monitor ? "⚙" : "⏰"}</button>
    </div>
    <div class="series-body">
      <table class="data">
        <tbody>${s.books.length ? s.books.map(b => `
          <tr class="clickable" data-act="book-open" data-id="${b.id}">
            <td class="t-cover">${coverImg(b.cover_url)}</td>
            <td><b>${esc(b.title)}</b>${b.series_number ? ` <span class="muted">#${esc(b.series_number)}</span>` : ""}</td>
            <td>${b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—"}</td>
            <td class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? " ⏳" : ""}</td>
            <td>${statusBadge(b.status)}</td>
            <td><div class="row-actions">
              <button class="btn small" data-act="book-sources" data-id="${b.id}" title="Quellen suchen">🔍</button>
              ${b.wanted ? `<button class="btn small" data-act="book-wanted" data-id="${b.id}" data-w="0" title="Wanted entfernen">✓</button>` : ""}
            </div></td>
          </tr>`).join("") : `<tr><td class="muted">Keine Bücher in dieser Serie.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
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
      toast("Abgleich gestartet", "success");
      setTimeout(() => { authSync.disabled = false; authSync.textContent = "🔄 Jetzt abgleichen"; }, 2000);
    } catch (err) { toast(err.message, "error"); }
    return;
  }
  const authWiki = e.target.closest("[data-act='author-wiki']");
  if (authWiki) {
    authWiki.disabled = true; authWiki.innerHTML = spinner();
    try {
      const r = await api(`api/authors/${authWiki.dataset.id}/wikipedia-scan`, { method: "POST" });
      toast(`Wikipedia-Scan: ${r.added} neue Bücher`, "success");
      setTimeout(() => router(), 800);
    } catch (err) { toast("Fehler: " + err.message, "error"); }
    return;
  }
  const authDel = e.target.closest("[data-act='author-del']");
  if (authDel) {
    if (!confirm("Autor mit allen Büchern löschen?")) return;
    try {
      await api(`api/authors/${authDel.dataset.id}`, { method: "DELETE" });
      toast("Autor gelöscht", "success");
      location.hash = "#/authors";
    } catch (err) { toast(err.message, "error"); }
  }
});

/* ============ Monitor-Konfig ============ */
function monitorForm(monitor, interval, kind, id, languages) {
  return `<div class="switch-row"><div class="sw-label"><b>${kind === "author" ? "Autor überwachen" : "Serie überwachen"}</b><br><span class="muted">Regelmäßig nach neuen Büchern suchen</span></div>
    <label class="switch"><input type="checkbox" id="mon-switch" ${monitor ? "checked" : ""}><span class="slider"></span></label></div>
    <div class="form-row"><label>Suchintervall (Stunden)</label>
      <input type="number" id="mon-interval" value="${interval || 168}" min="1">
      <div class="hint">Intervall für die automatische Suche nach neuen Werken (Standard: 168 = wöchentlich)</div>
    </div>
    ${kind === "author" ? `<div class="form-row"><label>Überwachte Sprachen</label>
      <div id="mon-langs" style="display:flex;gap:6px;flex-wrap:wrap">
        ${(languages || ["de", "en"]).map(l => `<span class="lang-tag" data-lang-tag="${esc(l)}">${esc(l)} <a href="#" data-rm-lang="${esc(l)}" style="color:var(--error);text-decoration:none">✕</a></span>`).join("")}
      </div>
      <input type="text" id="mon-lang-add" placeholder="Sprache hinzufügen (z.B. fr) + Enter" style="margin-top:6px">
      <div class="hint">Nur Bücher dieser Sprachen werden bei neuen Werken als Wanted markiert</div>
    </div>` : ""}`;
}

function openAuthorConfig(aid) {
  const cm = document.getElementById("config-modal");
  document.getElementById("cm-title").textContent = "Autor-Überwachung";
  document.getElementById("cm-body").innerHTML =
    `<div class="empty">${spinner()} Lade …</div>`;
  openModal("config-modal");
  api(`api/authors/${aid}`).then(d => {
    const a = d.author;
    document.getElementById("cm-body").innerHTML = monitorForm(a.monitor, a.interval_hours, "author", aid, a.languages);
    setupMonitorForm();
    document.getElementById("cm-body").insertAdjacentHTML("beforeend",
      `<div class="modal-foot" style="padding:12px 0 0">
        <button class="btn" id="cm-cancel">Abbrechen</button>
        <button class="btn primary" id="cm-save">Speichern</button>
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
        toast("Gespeichert", "success");
        closeModal("config-modal");
        router();
      } catch (err) { toast(err.message, "error"); }
    });
  }).catch(e => toast(e.message, "error"));
}

function openSeriesConfig(sid, monitored) {
  const cm = document.getElementById("config-modal");
  document.getElementById("cm-title").textContent = "Serien-Überwachung";
  document.getElementById("cm-body").innerHTML = monitorForm(monitored, 168, "series", sid);
  setupMonitorForm();
  document.getElementById("cm-body").insertAdjacentHTML("beforeend",
    `<div class="modal-foot" style="padding:12px 0 0">
      <button class="btn" id="cm-cancel">Abbrechen</button>
      <button class="btn primary" id="cm-save">Speichern</button>
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
      toast("Gespeichert", "success");
      closeModal("config-modal");
      router();
    } catch (err) { toast(err.message, "error"); }
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

/* ============ Seite: Serien ============ */
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
      <div class="panel-head"><span>🔗 Alle Serien (${allSeries.length})</span></div>
      <div class="panel-body" id="series-all">
        ${allSeries.length ? allSeries.map(s => `
          <div class="series-block open">
            <div class="series-head" data-toggle-series>
              <span class="chev">▶</span>
              <span class="s-name">${esc(s.name)} <span class="muted">von ${esc(s.author)}</span></span>
              <span class="muted">${s.book_count} Bände</span>
              <span class="badge ${s.monitor ? "monitor-on" : "monitor-off"}">${s.monitor ? "Überwacht" : "Nicht überwacht"}</span>
              <button class="btn small" data-act="series-monitor" data-id="${s.id}" data-mon="${s.monitor}">⚙</button>
            </div>
            <div class="series-body">
              <table class="data"><tbody>
                ${s.books.map(b => `<tr class="clickable" data-act="book-open" data-id="${b.id}">
                  <td class="t-cover">${coverImg(b.cover_url)}</td>
                  <td><b>${esc(b.title)}</b>${b.series_number ? ` <span class="muted">#${esc(b.series_number)}</span>` : ""}</td>
                  <td>${b.language ? `<span class="lang-tag">${esc(b.language)}</span>` : "—"}</td>
                  <td class="${isFuture(b.publish_date) ? "future" : ""}">${fmtDate(b.publish_date)}${isFuture(b.publish_date) ? " ⏳" : ""}</td>
                  <td>${statusBadge(b.status)}</td>
                </tr>`).join("")}
              </tbody></table>
            </div>
          </div>`).join("") : `<div class="empty">Keine Serien vorhanden.</div>`}
      </div>
    </div>`;
}

/* ============ Seite: Wanted ============ */
async function pageWanted(content) {
  const wanted = await api("api/wanted");
  content.innerHTML = `
    <div class="books-table-actions">
      <span class="muted">${wanted.length} Bücher werden gesucht</span>
      <div class="spacer"></div>
      <button class="btn primary" id="wt-search">⏳ Jetzt alle suchen</button>
    </div>
    <div class="panel"><div class="panel-body">
      ${wanted.length ? wantedTable(wanted) : `<div class="empty">Keine Wanted-Bücher. Bücher als Wanted markieren oder Autoren/Serien überwachen.</div>`}
    </div></div>`;
  document.getElementById("wt-search").addEventListener("click", async () => {
    try {
      await api("api/wanted/search", { method: "POST" });
      toast("Wanted-Suche gestartet", "success");
      setTimeout(() => router(), 1000);
    } catch (e) { toast(e.message, "error"); }
  });
  window.__wtTimer = setInterval(async () => {
    if (currentRoute().name !== "wanted") { clearInterval(window.__wtTimer); return; }
    try {
      const w2 = await api("api/wanted");
      document.querySelector(".panel-body").innerHTML = w2.length ? wantedTable(w2) : `<div class="empty">Keine Wanted-Bücher.</div>`;
    } catch (e) {}
  }, 10000);
}

/* ============ Seite: Aktivität ============ */
async function pageActivity(content) {
  const [downloads, events] = await Promise.all([api("api/downloads?limit=100"), api("api/events?limit=100")]);
  content.innerHTML = `
    <div class="tabs">
      <button class="active" data-tab="dl">Downloads</button>
      <button data-tab="ev">Ereignisprotokoll</button>
    </div>
    <div id="tab-dl">
      <div class="panel"><div class="panel-body">
        ${downloads.length ? `<table class="data">
          <thead><tr><th>Status</th><th>Buch</th><th>Quelle</th><th>Fortschritt</th><th>Meldung</th><th>Wann</th><th></th></tr></thead>
          <tbody>${downloads.map(d => `<tr>
            <td>${statusBadge(d.status)}</td>
            <td>${esc(d.book_title || d.title)}</td>
            <td class="muted">${esc(d.source)}</td>
            <td><div class="progress" style="width:100px"><div class="bar" style="width:${d.progress || 0}%"></div></div></td>
            <td class="muted">${esc(d.message || "")}</td>
            <td class="muted">${esc(d.added || "")}</td>
            <td><button class="btn small danger" data-act="dl-del" data-id="${d.id}">✕</button></td>
          </tr>`).join("")}</tbody></table>`
        : `<div class="empty">Keine Downloads im Verlauf.</div>`}
      </div></div>
    </div>
    <div id="tab-ev" class="hidden">
      <div class="books-table-actions">
        <select id="ev-level">
          <option value="">Alle Ebenen</option>
          <option value="error">Fehler</option>
          <option value="warn">Warnungen</option>
          <option value="success">Erfolge</option>
          <option value="info">Info</option>
        </select>
      </div>
      <div class="panel"><div class="panel-body" id="ev-list">${eventsFeed(events)}</div></div>
    </div>`;
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

/* ============ Seite: Einstellungen ============ */
let settings = null;
async function pageSettings(content) {
  settings = await api("api/settings");
  content.innerHTML = `
    <div class="tabs">
      <button class="active" data-tab="s-dl">Download-Quellen</button>
      <button data-tab="s-conv">Verzeichnisse & Konvertierung</button>
      <button data-tab="s-sched">Scheduler</button>
    </div>
    <div id="s-dl">
      <div class="panel">
        <div class="panel-head"><span>Prowlarr (Newznab-Indexer)</span><button class="btn small" data-test="prowlarr">Verbindung testen</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>URL</label><input type="text" id="set-prowlarr-url" value="${esc(settings.prowlarr_url)}" placeholder="http://localhost:9696"></div>
            <div class="form-row"><label>API-Key</label><input type="password" id="set-prowlarr-key" value="${esc(settings.prowlarr_key)}"></div>
          </div>
          <div class="form-row"><label>Kategorien (Newznab)</label><input type="text" id="set-prowlarr-cats" value="${esc(settings.prowlarr_categories)}">
            <div class="hint">7000 = eBooks, 7020 = eBooks/andere, 7030 = Hörbücher (kommagetrennt)</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>SABnzbd (NZB-Download)</span><button class="btn small" data-test="sabnzbd">Verbindung testen</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>URL</label><input type="text" id="set-sab-url" value="${esc(settings.sabnzbd_url)}" placeholder="http://localhost:8081"></div>
            <div class="form-row"><label>API-Key</label><input type="password" id="set-sab-key" value="${esc(settings.sabnzbd_key)}"></div>
          </div>
          <div class="form-row"><label>Kategorie</label><input type="text" id="set-sab-cat" value="${esc(settings.sabnzbd_category)}">
            <div class="hint">Muss in SABnzbd existieren (z.B. ebook)</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>IRC (irchighway #ebooks)</span><button class="btn small" data-test="irc">Konfiguration prüfen</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>Server</label><input type="text" id="set-irc-server" value="${esc(settings.irc_server)}" placeholder="irc.irchighway.net:6697"></div>
            <div class="form-row"><label>Channel</label><input type="text" id="set-irc-channel" value="${esc(settings.irc_channel)}" placeholder="#ebooks"></div>
          </div>
          <div class="form-grid">
            <div class="form-row"><label>Bot-Nick</label><input type="text" id="set-irc-nick" value="${esc(settings.irc_botnick)}">
              <div class="hint">Einzigartiger Nick, der nicht von dir selbst benutzt wird (sonst Nick-Kollision)</div></div>
            <div class="form-row"><label>Max. Bots pro Download</label><input type="number" id="set-irc-bots" value="${esc(settings.max_irc_bots)}" min="1" max="8"></div>
          </div>
          <div class="switch-row"><div class="sw-label"><b>SSL verwenden</b><br><span class="muted">irchighway blockt Plaintext — SSL (6697) empfohlen</span></div>
            <label class="switch"><input type="checkbox" id="set-irc-ssl" ${settings.irc_ssl === "1" ? "checked" : ""}><span class="slider"></span></label></div>
          <div class="hint">Etikette: nur 1 Bot-Aktion gleichzeitig, Mindestabstände 30s (Suche) / 60s (Download) werden automatisch eingehalten.</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>Google Books (optional)</span><button class="btn small" data-test="google_books">Prüfen</button></div>
        <div class="panel-body">
          <div class="form-row"><label>API-Key</label><input type="password" id="set-gb-key" value="${esc(settings.google_books_key)}">
            <div class="hint">Optional. Ohne Key ist die Metadaten-Quelle Open Library. Key unter <b>console.cloud.google.com</b> (Books API) anlegen.</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>Direkte Newznab-Indexer (zusätzlich zu Prowlarr)</span></div>
        <div class="panel-body">
          <div id="idx-list"></div>
          <button class="btn small" id="idx-add">＋ Indexer hinzufügen</button>
        </div>
      </div>
    </div>
    <div id="s-conv" class="hidden">
      <div class="panel">
        <div class="panel-head"><span>Verzeichnisse</span></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="form-row"><label>Download-Verzeichnis (Zwischenablage)</label><input type="text" id="set-dl-dir" value="${esc(settings.download_dir)}"></div>
            <div class="form-row"><label>Bibliothek (fertige Bücher)</label><input type="text" id="set-lib-dir" value="${esc(settings.library_dir)}"></div>
          </div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span>Konvertierung (Calibre)</span></div>
        <div class="panel-body">
          <div class="switch-row"><div class="sw-label"><b>Automatisch konvertieren</b><br><span class="muted">Heruntergeladene Bücher nach dem Import in das Zielformat umwandeln</span></div>
            <label class="switch"><input type="checkbox" id="set-conv-on" ${settings.convert_enabled === "1" ? "checked" : ""}><span class="slider"></span></label></div>
          <div class="form-row"><label>Zielformat</label>
            <select id="set-conv-fmt">
              ${["epub", "mobi", "azw3", "pdf", "fb2", "txt"].map(f => `<option value="${f}" ${settings.convert_format === f ? "selected" : ""}>${f.toUpperCase()}</option>`).join("")}
            </select>
            <div class="hint">Erfordert installiertes Calibre (ebook-convert)</div></div>
        </div>
      </div>
    </div>
    <div id="s-sched" class="hidden">
      <div class="panel">
        <div class="panel-head"><span>Automatische Suche</span></div>
        <div class="panel-body">
          <div class="switch-row"><div class="sw-label"><b>Wanted-Suche aktiv</b><br><span class="muted">Bücher mit Status Wanted regelmäßig auf Quellen durchsuchen</span></div>
            <label class="switch"><input type="checkbox" id="set-ws-on" ${settings.wanted_search_enabled === "1" ? "checked" : ""}><span class="slider"></span></label></div>
          <div class="form-grid">
            <div class="form-row"><label>Standard-Intervall Wanted (h)</label><input type="number" id="set-ws-iv" value="${esc(settings.wanted_interval)}" min="1"></div>
            <div class="form-row"><label>Standard-Intervall Monitoring (h)</label><input type="number" id="set-mon-iv" value="${esc(settings.monitor_interval)}" min="1">
              <div class="hint">Gilt für Autoren/Serien ohne eigenes Intervall</div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="flex" style="justify-content:flex-end;margin-top:6px">
      <button class="btn primary" id="set-save" style="font-size:14px;padding:10px 24px">Einstellungen speichern</button>
    </div>`;

  // Indexer-Liste rendern
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
    btn.disabled = true; btn.innerHTML = spinner() + " Test";
    try {
      const r = await api("api/settings/test", { method: "POST", body: JSON.stringify(body) });
      toast(`${r.name}: ${r.ok ? "✓ " + r.message : "✗ " + r.message}`, r.ok ? "success" : "error");
    } catch (e) { toast(e.message, "error"); }
    btn.disabled = false; btn.textContent = "Verbindung testen";
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
            convert_enabled: document.getElementById("set-conv-on").checked ? "1" : "0",
            convert_format: document.getElementById("set-conv-fmt").value,
            wanted_search_enabled: document.getElementById("set-ws-on").checked ? "1" : "0",
            wanted_interval: document.getElementById("set-ws-iv").value,
            monitor_interval: document.getElementById("set-mon-iv").value,
          },
          indexers: settings.indexers,
        }),
      });
      toast("Einstellungen gespeichert", "success");
      refreshStatus();
    } catch (e) { toast("Fehler: " + e.message, "error"); }
  });
}

function renderIndexers() {
  const box = document.getElementById("idx-list");
  box.innerHTML = settings.indexers.map((i, n) => `
    <div class="src-row" style="background:var(--panel)">
      <label class="switch" style="flex-shrink:0"><input type="checkbox" data-idx="${n}" data-field="enabled" ${i.enabled ? "checked" : ""}><span class="slider"></span></label>
      <input type="text" data-idx="${n}" data-field="name" value="${esc(i.name)}" placeholder="Name" style="flex:1.2;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 9px;min-width:90px">
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

/* ============ Seite: System ============ */
async function pageSystem(content) {
  const [st, logs] = await Promise.all([api("api/status"), api("api/system/logs")]);
  content.innerHTML = `
    <div class="panel">
      <div class="panel-head"><span>Verbindungen</span></div>
      <div class="panel-body">
        <table class="data">
          <thead><tr><th>Dienst</th><th>Status</th></tr></thead>
          <tbody>
            ${connRow("Prowlarr", st.connectivity.prowlarr)}
            ${connRow("SABnzbd", st.connectivity.sabnzbd)}
            ${connRow("IRC", st.connectivity.irc)}
            ${connRow("Calibre (Konvertierung)", st.connectivity.convert)}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>Scheduler</span></div>
      <div class="panel-body">
        <div class="kv"><span class="k">Status</span><span>${st.scheduler.running ? "läuft" : "gestoppt"}</span></div>
        <div class="kv"><span class="k">Aktuelle Aufgabe</span><span>${esc(st.scheduler.loop)}${st.scheduler.current_book ? " — " + esc(st.scheduler.current_book) : ""}${st.scheduler.current_sync ? " — " + esc(st.scheduler.current_sync) : ""}</span></div>
        <div class="kv"><span class="k">Letzte Wanted-Suche</span><span>${esc(st.scheduler.last_wanted || "noch nie")}</span></div>
        <div class="kv"><span class="k">Letzter Sync</span><span>${esc(st.scheduler.last_sync || "noch nie")}</span></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span>Log (letzte 100 Zeilen)</span><button class="btn small" id="sys-reload">Aktualisieren</button></div>
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
  return `<tr><td>${esc(name)}</td><td>${ok ? `<span class="badge have">✓ Erreichbar</span>` : `<span class="badge failed">✗ Nicht erreichbar</span>`}</td></tr>`;
}

/* ============ Start ============ */
document.addEventListener("DOMContentLoaded", () => {
  router();
  refreshStatus();
  setInterval(refreshStatus, 15000);
});
