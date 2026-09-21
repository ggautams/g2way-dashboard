# g2way-dashboard developer entry points. `make check` is the gate every change
# must pass. Mirrors the g2way repo's Makefile deliberately — same muscle memory.

.PHONY: check fmt fmt-check lint typecheck test build bundle-check dev start \
        db-generate db-migrate test-pg sync-g2way check-g2way hooks clean

## Quality gate: run before every commit. Must stay green.
## `bundle-check` runs the production build itself, so `build` is not repeated.
check: fmt-check lint typecheck test bundle-check check-g2way

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm run test

build:
	npm run build

## Build with canary secrets and prove none reaches the browser: not in
## .next/static, not in any rendered page or RSC payload.
bundle-check:
	npm run check:bundle

## Run the dashboard locally (pair with a g2way gateway on its admin port).
dev:
	npm run dev

start:
	npm start

## ---- dashboard database (ADR-0003) --------------------------------------

## Write new SQLite and Postgres migrations after editing src/lib/db/schema/.
## NAME is required and names both files: make db-generate NAME=add_widgets
db-generate:
	npm run db:generate -- --name "$(NAME)"

## Apply pending migrations to DATABASE_URL's database (the server also does
## this on startup).
db-migrate:
	npm run db:migrate

## Run the database tests against a throwaway Postgres in Docker, including the
## live node-postgres test that plain `make test` skips.
PG_TEST_CONTAINER := g2way-dashboard-test-pg
PG_TEST_PORT ?= 55432
test-pg:
	@docker rm -f $(PG_TEST_CONTAINER) >/dev/null 2>&1 || true
	docker run -d --rm --name $(PG_TEST_CONTAINER) -e POSTGRES_PASSWORD=test \
		-p 127.0.0.1:$(PG_TEST_PORT):5432 postgres:17-alpine >/dev/null
	@until docker exec $(PG_TEST_CONTAINER) pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do sleep 1; done
	@TEST_POSTGRES_URL=postgres://postgres:test@127.0.0.1:$(PG_TEST_PORT)/postgres \
		npx vitest run src/lib/db; status=$$?; \
		docker rm -f $(PG_TEST_CONTAINER) >/dev/null; exit $$status

## ---- g2way linkage ------------------------------------------------------

## Fail if a watched part of the g2way repo moved since the recorded lock.
## Skips silently when no g2way checkout is present.
check-g2way:
	npm run check:g2way

## Regenerate contracts/ from g2way, append the UPSTREAM.md entry, commit.
sync-g2way:
	npm run sync:g2way

## Install the pre-commit hook (drift check before every commit).
hooks:
	git config core.hooksPath .githooks
	@echo "hooks installed: .githooks"

clean:
	rm -rf .next node_modules
