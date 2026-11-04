# Working in this repository

This file is the harness: the rules a person or a coding agent works under here.
`CLAUDE.md` imports it; other tools read it directly. Keep it short; detail lives in
the files it points to.

## The loop

1. **Spec first.** Behaviour is a row in [`SPEC.md`](SPEC.md) section 6 with a stable ID
   (`SYNC-11`, `SEC-03`) and a "Verified by" column, before any code. A change of
   behaviour starts by adding or amending a row; IDs are never renumbered or reused.
2. **One requirement per commit**, with its test, and the ID in the subject:
   `feat(sync): schedule retry from Retry-After on 429 [SYNC-11]`. Two IDs in one commit
   only when they cannot be split. `docs`, `chore`, `ci`, `build` commits need no ID.
   `scripts/check-commit-msg.sh` enforces this; install it as a hook with
   `cp scripts/check-commit-msg.sh .git/hooks/commit-msg`.
3. **The gate before every commit**: `scripts/gate.sh` runs typecheck, lint, unit and
   integration tests and the requirement trace, and exits 1 on any failure. Never
   commit on red; never weaken a gate step to get past it. CI runs the same gate.
4. **Trace stays complete**: `scripts/trace.sh` lists, for every ID, its commits and
   tests; a non-`manual` ID without a test is a gap to close, not to explain.

## Where things are

| | |
|---|---|
| What the service guarantees and why | [`SPEC.md`](SPEC.md) sections 1–5, decisions `D-nn` |
| The requirements | [`SPEC.md`](SPEC.md) section 6 |
| How to run and configure it | [`service/README.md`](service/README.md) |
| The portal it talks to | [`API.md`](API.md), `docker-compose.yml` |
| What was delegated to AI and where it was wrong | [`PROCESS.md`](PROCESS.md) |

## Rules that bite

- Node 24 runs the TypeScript directly: no enums, no parameter properties, `.ts` in
  import paths. `tsc` only type-checks.
- Tests are three tiers: `test/unit` (no I/O), `test/fake` (PostgreSQL plus an
  in-process fake portal, deterministic), `test/portal` (the real Portal Sol,
  rate-bound, about two minutes). A behaviour that depends on a portal failure is tested
  in `fake`, never by hoping the real portal fails.
- Integration tests truncate `updates` and `sync_jobs` on the configured database.
- Nothing from the outside is trusted unbounded: client bodies, portal headers and
  bodies, the environment. See `D-13` and `SEC-*` before touching an edge.
- Say in `PROCESS.md` when an agent got something wrong and how it was caught.
