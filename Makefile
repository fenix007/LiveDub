.DEFAULT_GOAL := help

NODE ?= node
PYTHON ?= $(shell command -v python3.12 || command -v python3)

.PHONY: help setup start run dev check check-node gemini-deps extension-zip bench

help:
	@printf '%s\n' \
	  'make setup  — создать .env из .env.example, если его ещё нет' \
	  'make start  — запустить сервер (остановка: Ctrl+C)' \
	  'make run    — то же, что make start' \
	  'make dev    — запуск с перезапуском при изменении серверного кода' \
	  'make gemini-deps — установить Python-зависимость gemini-gateway' \
	  'make check  — проверить синтаксис сервера, Python worker и JavaScript страницы' \
	  'make extension-zip — собрать dist/livedub-extension.zip' \
	  'make bench  — эталонный прогон расширения (macOS; параметры: BENCH="--final yandex,deepseek")' \
	  'make help   — показать команды'

check-node:
	@$(NODE) -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 6)) { console.error("Нужен Node.js 20.6 или новее"); process.exit(1); }'

setup:
	@if [ -e .env ]; then \
	  printf '%s\n' '.env уже существует, оставлен без изменений'; \
	else \
	  cp .env.example .env && printf '%s\n' 'Создан .env. Укажите DEEPGRAM_API_KEY перед запуском.'; \
	fi

start: check-node setup
	$(NODE) --env-file=.env server.js

run: start

dev: check-node setup
	$(NODE) --watch --env-file=.env server.js

gemini-deps:
	$(PYTHON) -m venv .venv
	.venv/bin/python -m pip install --timeout 120 --retries 5 -r requirements.txt

check: check-node
	$(NODE) --check server.js
	$(NODE) --check public/pcm-worklet.js
	$(PYTHON) -m py_compile gemini_worker.py
	@$(NODE) --input-type=module -e 'import { readFileSync } from "node:fs"; import { spawnSync } from "node:child_process"; const html = readFileSync("public/index.html", "utf8"); const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]; if (!scripts.length) throw new Error("В public/index.html не найдены скрипты"); for (const [, input] of scripts) { const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input, encoding: "utf8" }); if (result.error) throw result.error; if (result.status !== 0) { console.error(result.stderr); process.exit(1); } } console.log("Синтаксис JavaScript в public/index.html: OK");'
	@for file in extension/*.js extension/lib/*.js extension/content/*.js; do $(NODE) --check $$file || exit 1; done
	$(NODE) --test tests/*.test.mjs

extension-zip:
	mkdir -p dist
	rm -f dist/livedub-extension.zip
	cd extension && zip -qr ../dist/livedub-extension.zip . -x '.*'
	@echo 'Готово: dist/livedub-extension.zip'

BENCH ?=
bench: check-node
	@test -d node_modules/playwright || npm install
	$(NODE) --env-file=.env bench/run.mjs $(BENCH)
