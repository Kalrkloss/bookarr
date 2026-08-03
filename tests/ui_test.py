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


def check(name, fn):
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
        assert page.locator("#book-modal").is_visible()
        assert page.locator("#bm-title").inner_text().strip() != ""
        page.screenshot(path=f"{SHOTS}/5-book-modal.png")
        page.click("#book-modal [data-close]")
        assert not page.locator("#book-modal").is_visible()
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
        page.locator(".author-card").first.click()
        page.wait_for_selector(".author-header", timeout=10000)
        page.screenshot(path=f"{SHOTS}/6-author.png")
    check("Authors page → author detail", t_author_page)

    browser.close()

print(f"\n=== RESULT: {6 - len(fails)} PASS / {len(fails)} FAIL ===")
if console_errors:
    print("JS console errors:", console_errors[:5])
if fails:
    sys.exit(1)
