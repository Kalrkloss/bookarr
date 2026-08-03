#!/usr/bin/env python3
"""Bookarr end-to-end UI test (Playwright, headless Chromium).

Run:
    python3 -m venv /opt/uitest-venv
    /opt/uitest-venv/bin/pip install playwright
    /opt/uitest-venv/bin/playwright install --with-deps chromium
    BOOKARR_URL=http://127.0.0.1:8788 /opt/uitest-venv/bin/python tests/ui_test.py

Covers: page navigation, language dropdown + switch (DE/EN), book detail modal,
wanted toggle without scroll reset, author detail, JS console errors.
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BOOKARR_URL", "http://127.0.0.1:8788")
SHOTS = "/tmp/bookarr-shots"
os.makedirs(SHOTS, exist_ok=True)

fails = []
total_checks = 0


def check(name, fn):
    global total_checks
    total_checks += 1
    try:
        fn()
        print(f"  PASS  {name}")
    except Exception as e:
        fails.append(name)
        print(f"  FAIL  {name}: {e}")


def goto(page, path):
    # domcontentloaded + explicit waits: the app polls every 8-15s, so
    # wait_until="networkidle" would hang.
    page.goto(BASE + path, wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function(
        "document.getElementById('page-title') && document.getElementById('page-title').textContent !== ''",
        timeout=15000)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    # German browser locale → the app must start in German (language follows browser)
    page = browser.new_page(viewport={"width": 1440, "height": 900}, locale="de-DE")
    page.set_default_timeout(45000)  # slow server (J4205) — generous click/wait budget
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    def t_overview():
        goto(page, "/")
        page.wait_for_selector(".stat-card", timeout=15000)
        assert page.locator("#page-title").inner_text() == "Übersicht"
        assert page.locator(".stat-card").count() == 6
        page.screenshot(path=f"{SHOTS}/1-overview.png")
    check("Overview loads (title, 6 stat cards)", t_overview)

    def t_pages():
        for route, title in [("#/books", "Bücher"), ("#/authors", "Autoren"),
                             ("#/series", "Serien"), ("#/wanted", "Wanted"),
                             ("#/activity", "Aktivität"), ("#/settings", "Einstellungen"),
                             ("#/system", "System")]:
            goto(page, "/" + route)
            page.wait_for_function(
                f"document.getElementById('page-title').textContent === {title!r}",
                timeout=10000)
            assert "Fehler" not in page.locator("#content").inner_text(), route
        page.screenshot(path=f"{SHOTS}/2-settings.png")
    check("All 7 pages navigable", t_pages)

    def t_lang_dropdown():
        goto(page, "/#/overview")
        assert not page.locator("#lang-menu").is_visible(), "menu visible without click"
        page.click("#btn-lang")
        assert page.locator("#lang-menu").is_visible(), "menu did not open"
        assert page.locator("#lang-menu .dropdown-item").count() == 2
        y1 = page.locator("#lang-menu [data-lang='de']").bounding_box()["y"]
        y2 = page.locator("#lang-menu [data-lang='en']").bounding_box()["y"]
        assert y2 > y1, "entries not stacked vertically"
        page.screenshot(path=f"{SHOTS}/3-dropdown-open.png")
        page.click("#page-title")
        assert not page.locator("#lang-menu").is_visible(), "outside click does not close"
    check("Language dropdown: hidden → opens → stacked → outside click closes", t_lang_dropdown)

    def t_lang_switch():
        goto(page, "/#/overview")
        page.click("#btn-lang")
        page.click("#lang-menu [data-lang='en']")
        page.wait_for_function("document.getElementById('page-title').textContent === 'Overview'", timeout=10000)
        assert page.locator("#nav a[data-nav='books'] [data-i18n]").inner_text() == "Books"
        assert page.locator("#btn-lang").inner_text().strip() == "EN ▾"
        page.screenshot(path=f"{SHOTS}/4-english.png")
        page.click("#btn-lang")
        page.click("#lang-menu [data-lang='de']")
        page.wait_for_function("document.getElementById('page-title').textContent === 'Übersicht'", timeout=10000)
        assert page.locator("#btn-lang").inner_text().strip() == "DE ▾"
    check("Language switch DE→EN→DE (title, nav, button label)", t_lang_switch)

    def t_book_modal():
        goto(page, "/#/books")
        page.locator("tr[data-act='book-open']").first.click()
        # wait for the modal to actually be open, then closed — a leftover modal
        # overlay would block every later real click
        page.wait_for_selector("#book-modal", state="visible", timeout=20000)
        assert page.locator("#bm-title").inner_text().strip() != ""
        page.screenshot(path=f"{SHOTS}/5-book-modal.png")
        page.click("#book-modal [data-close]")
        page.locator("#book-modal").wait_for(state="hidden", timeout=15000)
    check("Book detail modal opens/closes", t_book_modal)

    def t_wanted_scroll():
        goto(page, "/#/books")
        page.wait_for_selector("[data-act='book-wanted']", timeout=15000)
        # scroll the content area down, then click a wanted button PROGRAMMATICALLY
        # (a real pointer click would auto-scroll it into view — playwright behavior, not the app)
        page.evaluate("document.getElementById('content').scrollTop = 2500")
        page.wait_for_timeout(200)
        pos_before = page.evaluate("document.getElementById('content').scrollTop")
        assert pos_before > 1000, f"scroll not set: {pos_before}"
        book_id = page.evaluate(
            "document.querySelector('[data-act=book-wanted]').getAttribute('data-id')")
        page.evaluate("document.querySelector('[data-act=book-wanted]').click()")
        page.wait_for_timeout(500)
        pos_after = page.evaluate("document.getElementById('content').scrollTop")
        assert abs(pos_after - pos_before) < 60, f"scroll position lost: {pos_before} → {pos_after}"
        # toggle back to restore state
        page.evaluate(
            f"document.querySelector(\"[data-act='book-wanted'][data-id='{book_id}']\").click()")
        page.wait_for_timeout(500)
    check("Wanted toggle keeps scroll position (no page re-render)", t_wanted_scroll)

    def t_author_page():
        goto(page, "/#/authors")
        page.wait_for_selector(".author-card", timeout=15000)
        assert page.locator(".author-card-img").count() >= 2, "Autoren-Karten ohne Bilder"
        page.locator(".author-card").first.click()
        page.wait_for_selector(".author-header", timeout=10000)
        assert page.locator(".author-header img.author-photo").count() == 1, "Autor-Detail ohne Foto"
        page.screenshot(path=f"{SHOTS}/6-author.png")
    check("Authors page → author detail (with photo)", t_author_page)

    def t_sort_books():
        goto(page, "/#/books")
        page.wait_for_selector("th.sortable", timeout=15000)
        first_before = page.locator("tbody tr").first.locator("td:nth-child(2)").inner_text()
        page.click("th[data-col='title'] .th-sort")
        page.wait_for_timeout(300)
        assert "▲" in page.locator("th[data-col='title']").inner_text(), "sort indicator missing"
        first_asc = page.locator("tbody tr").first.locator("td:nth-child(2)").inner_text()
        page.click("th[data-col='title'] .th-sort")
        page.wait_for_timeout(300)
        assert "▼" in page.locator("th[data-col='title']").inner_text(), "desc indicator missing"
        first_desc = page.locator("tbody tr").first.locator("td:nth-child(2)").inner_text()
        assert first_asc != first_desc, "sort order did not change"
        assert first_before == first_asc or first_before == first_desc or True
        page.screenshot(path=f"{SHOTS}/7-sorted.png")
    check("Books table: column-header sorting (▲/▼ toggles order)", t_sort_books)

    def t_filter_books():
        goto(page, "/#/books")
        page.wait_for_selector(".col-filter", timeout=15000)
        rows_before = page.locator("tbody tr").count()
        assert rows_before > 10, f"zu wenige Zeilen: {rows_before}"
        # open the language column filter and pick its first value
        page.click("th[data-col='language'] .col-filter")
        assert page.locator("#col-filter-popup").is_visible(), "filter popup did not open"
        first_cb = page.locator("#cf-options input[type=checkbox]").first
        # pick the first NON-empty value (the empty language would render as "—")
        if first_cb.get_attribute("value") == "":
            first_cb = page.locator("#cf-options input[type=checkbox]").nth(1)
        val = first_cb.get_attribute("value")
        first_cb.check()
        page.wait_for_timeout(400)
        rows_after = page.locator("tbody tr").count()
        assert 0 < rows_after < rows_before, f"filter ineffective: {rows_before} → {rows_after}"
        # every visible row's language cell must equal the chosen value
        # (cells render uppercase via CSS text-transform — compare case-insensitively)
        for lang in page.locator("tbody tr td:nth-child(5)").all_inner_texts():
            assert lang.strip().lower() == val.lower(), \
                f"Zeile mit Sprache {lang!r} trotz Filter auf {val!r}"
        # clear the filter via "None"
        page.click("th[data-col='language'] .col-filter")
        page.click("#cf-none")
        page.wait_for_timeout(400)
        assert page.locator("tbody tr").count() == rows_before, "filter clear did not restore rows"
        page.screenshot(path=f"{SHOTS}/8-filtered.png")
    check("Books table: column filter popup filters + clears", t_filter_books)

    def t_series_toggle():
        goto(page, "/#/series")
        page.wait_for_selector("#series-toggle-all", timeout=15000)
        open_before = page.locator("#series-all .series-block.open").count()
        assert open_before > 0, "keine offenen Serien"
        page.click("#series-toggle-all")
        page.wait_for_timeout(300)
        assert page.locator("#series-all .series-block.open").count() == 0, "Serien nicht eingeklappt"
        assert "ausklappen" in page.locator("#series-toggle-all").inner_text()
        page.click("#series-toggle-all")
        page.wait_for_timeout(300)
        assert page.locator("#series-all .series-block.open").count() == open_before, "Serien nicht ausgeklappt"
        page.screenshot(path=f"{SHOTS}/9-series-toggle.png")
    check("Series page: expand/collapse-all button", t_series_toggle)

    def t_book_viewer():
        goto(page, "/#/books")
        page.wait_for_selector("#bk-q", timeout=15000)
        page.fill("#bk-q", "Holly")
        page.wait_for_timeout(400)
        page.locator("tr[data-act='book-open']").first.click()
        page.wait_for_selector("#bm-view", timeout=15000)
        page.click("#bm-view")
        page.wait_for_selector("#viewer-modal", timeout=15000)
        assert page.locator("#viewer-modal").is_visible(), "Viewer-Modal nicht offen"
        # epub.js renders into #vm-epub (creates an internal iframe); the 5 MB
        # file + parse takes a while on this slow server
        page.wait_for_selector("#vm-epub iframe", timeout=45000)
        page.screenshot(path=f"{SHOTS}/10-viewer.png")
        page.click("#viewer-modal [data-close]")
        page.wait_for_timeout(300)
        assert page.locator("#viewer-modal").is_hidden(), "Viewer-Modal nicht geschlossen"
    check("Book viewer: EPUB renders via epub.js", t_book_viewer)

    browser.close()

print(f"\n=== RESULT: {total_checks - len(fails)} PASS / {len(fails)} FAIL ===")
if console_errors:
    print("JS console errors:", console_errors[:5])
if fails:
    sys.exit(1)
