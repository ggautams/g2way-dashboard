# g2way-dashboard

The control plane UI for [g2way](../g2way) — a free, self-hosted API gateway
dashboard.

g2way is a complete API gateway with a full admin API and, deliberately, no
UI, no user model, no audit log and no analytics storage. This project is that
layer: API and policy design, key management, traffic analytics, a GraphQL
studio, a developer portal, and the RBAC and audit trail an operator needs.

## Status

Early. M0 (scaffolding and the gateway contract layer) is complete; see
`ROADMAP.md` for what is next and `UPSTREAM.md` for gateway-side work this
project is waiting on.

## Quick start

```sh
npm install
make hooks          # once per clone: installs the upstream drift pre-commit hook
make dev
```

Point it at a gateway by setting its admin URL and secret (see `.env.example`
once M1 lands). To run one locally:

```sh
cd ../g2way
make run            # proxy on :8080
```

## Commands

| Command            | What it does                                                   |
| ------------------ | -------------------------------------------------------------- |
| `make check`       | The gate: format, lint, typecheck, test, build, upstream drift |
| `make dev`         | Run the dashboard locally                                      |
| `make check-g2way` | Report whether a watched part of g2way has moved               |
| `make sync-g2way`  | Regenerate `contracts/`, journal the change, commit it         |
| `make hooks`       | Install the pre-commit drift hook                              |

## How this repo tracks the gateway

g2way is the driver. Everything mechanically derivable from it is generated into
`contracts/` and committed — the OpenAPI document, TypeScript types for the whole
admin surface, and a verbatim copy of the gateway's docs and ADRs. Watched areas
of the gateway are fingerprinted by git object ID in `contracts/g2way.lock.json`,
so `make check` fails when one moves and tells you which dashboard surfaces are
affected. `make sync-g2way` regenerates everything, records what changed in
`UPSTREAM.md`, and commits it.

That means you rarely need to read the gateway's Rust at all: start from
`contracts/g2way.d.ts` and `docs/g2way-map.md`. `CLAUDE.md` has the full lookup
order and the session protocol.

## Licence

MPL-2.0, matching g2way.
