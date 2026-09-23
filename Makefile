# g2way-dashboard developer entry points. `make check` is the gate every change
# must pass. Mirrors the g2way repo's Makefile deliberately — same muscle memory.

.PHONY: check fmt fmt-check lint typecheck test build bundle-check dev start \
        serve-scratch db-generate db-migrate test-pg ingest test-redis test-prometheus \
        sync-g2way check-g2way hooks clean

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

## Production build served on :3100 against a throwaway SQLite database in a
## fresh temp dir, so a browser pass starts at first-run /setup and can run
## beside `make dev` (Next refuses a second `next dev` per checkout). Point it
## at a gateway with G2_ADMIN_URL / G2_ADMIN_SECRET; without one the degraded
## banner is expected. The database is left in the printed dir for inspection.
SCRATCH_PORT ?= 3100
serve-scratch:
	@dir=$$(mktemp -d "$${TMPDIR:-/tmp}/g2way-dashboard-scratch.XXXXXX"); \
	echo "scratch database: $$dir/dashboard.db"; \
	npm run build && \
	DATABASE_URL="file:$$dir/dashboard.db" \
	G2_ADMIN_URL="$${G2_ADMIN_URL:-http://127.0.0.1:9696}" \
	G2_ADMIN_SECRET="$${G2_ADMIN_SECRET:-scratch-admin-secret}" \
	AUTH_SECRET="$${AUTH_SECRET:-$$(openssl rand -base64 32)}" \
	AUTH_URL="http://localhost:$(SCRATCH_PORT)" \
	npx next start -p $(SCRATCH_PORT)

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

## ---- analytics ingest (ADR-0012) ----------------------------------------

## Run the analytics ingest worker as its own process: drains every
## environment's G2_REDIS_URL / G2_ENV_<ID>_REDIS_URL record list into the
## dashboard database. The server runs the same loop unless
## G2_ANALYTICS_INGEST=off; the gateway needs --analytics-sink redis.
ingest:
	npm run ingest

## Run the analytics tests against a throwaway Redis in Docker, including the
## live queue and end-to-end ingest tests that plain `make test` skips.
REDIS_TEST_CONTAINER := g2way-dashboard-test-redis
REDIS_TEST_PORT ?= 56379
test-redis:
	@docker rm -f $(REDIS_TEST_CONTAINER) >/dev/null 2>&1 || true
	docker run -d --rm --name $(REDIS_TEST_CONTAINER) \
		-p 127.0.0.1:$(REDIS_TEST_PORT):6379 redis:7-alpine >/dev/null
	@until docker exec $(REDIS_TEST_CONTAINER) redis-cli ping >/dev/null 2>&1; do sleep 1; done
	@TEST_REDIS_URL=redis://127.0.0.1:$(REDIS_TEST_PORT) \
		npx vitest run src/lib/analytics; status=$$?; \
		docker rm -f $(REDIS_TEST_CONTAINER) >/dev/null; exit $$status

## Run the Prometheus datasource tests against a throwaway Prometheus in
## Docker (ADR-0015), including the live query_range tests that plain
## `make test` skips. It scrapes only itself, so the tests check the transport
## and Prometheus's error envelope, not g2way's metric.
PROM_TEST_CONTAINER := g2way-dashboard-test-prometheus
PROM_TEST_PORT ?= 59090
test-prometheus:
	@docker rm -f $(PROM_TEST_CONTAINER) >/dev/null 2>&1 || true
	docker run -d --rm --name $(PROM_TEST_CONTAINER) \
		-p 127.0.0.1:$(PROM_TEST_PORT):9090 prom/prometheus:v3.5.0 >/dev/null
	@until curl -sf http://127.0.0.1:$(PROM_TEST_PORT)/-/ready >/dev/null 2>&1; do sleep 1; done
	@sleep 20  # two self-scrapes at the default 15 s interval, so `up` has samples
	@TEST_PROMETHEUS_URL=http://127.0.0.1:$(PROM_TEST_PORT) \
		npx vitest run src/lib/analytics/prometheus.test.ts; status=$$?; \
		docker rm -f $(PROM_TEST_CONTAINER) >/dev/null; exit $$status

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
