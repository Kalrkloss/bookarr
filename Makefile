# Bookarr — canonical dev commands
PY ?= ./venv/bin/python
UIPY ?= /opt/uitest-venv/bin/python
BOOKARR_URL ?= http://127.0.0.1:8788

.PHONY: lint test test-unit test-e2e

## lint: python + JS syntax checks
lint:
	$(PY) -m py_compile app/*.py run.py tests/test_timeouts.py
	node --check static/app.js

## test-unit: timeout-hardening unit tests (isolated temp DB)
test-unit:
	$(PY) -m unittest tests.test_timeouts -v

## test-e2e: Playwright UI test against a running instance
test-e2e:
	BOOKARR_URL=$(BOOKARR_URL) $(UIPY) tests/ui_test.py

## test: everything
test: test-unit test-e2e
