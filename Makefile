# g2way-dashboard developer entry points. `make check` is the gate every change
# must pass. Mirrors the g2way repo's Makefile deliberately — same muscle memory.

.PHONY: check fmt fmt-check lint typecheck test build bundle-check dev start \
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
