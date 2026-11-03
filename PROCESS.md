# PROCESS

How this was built, in one sitting with Claude Code as the coding agent.

## What I delegated and what I kept

I kept the decisions and the shape of the work: the design in `SPEC.md`, the choice
to turn it into atomic requirements with stable IDs and to make each commit
implement one (or a few coupled) requirements with its own test, and every "is this
good enough" call along the way. The agent wrote nearly all of the code, the tests,
the README and the probe script, one requirement at a time, and I read each diff
and test run before the commit went in.

Before cloning anything I had the agent audit the template repository and the
Portal Sol image without running them: provenance, base-image layers compared with
the official `node:24-alpine`, a read of the bundled server, and a trivy scan.
That read of the bundle also showed the portal's hidden defaults. I chose to keep
measuring the limits empirically (section 2 of the spec) and to say so here, rather
than pretend a black box was still a black box.

## Where the agent got it wrong, and how I noticed

- **Commits landed on red.** Twice a commit went in while a test or the type check
  was failing, because the shell command chained the commit after a `grep` that
  succeeded whatever the test result. The test summary in the output gave it away;
  the commits were amended and the gate was changed to check the runner's exit code.
- **A test asserted the wrong chunk boundary.** The agent expected a 1 Oct to 15 Dec
  update to chunk as calendar months; the code correctly chunks by 31 days
  (Nov 1 to Dec 1). The failing test, not the code, was the bug.
- **The 429 test assumed in-flight calls could be recalled.** With two slots, two
  calls are already out when the first 429 arrives. The assertion was rewritten
  around a third job that must wait out the pause.
- **A failing assertion hung the whole run** because the worker kept running.
  Spotted when the runner never exited; fixed with a `withWorker` helper that
  always stops the worker, plus per-test timeouts in the npm scripts.
- **An update with no jobs derived as "synced"** (`every` on an empty list). The
  unit test for API-05 caught it.
- **A manual run looked stuck** for one accommodation. It was a lease fixture left
  behind by the test suite in the shared database, not a bug; the README now warns
  that tests truncate the database.

## Left out, and next

In the order I would do them: a re-queue endpoint for failed jobs (today an
`UPDATE`); a shared limiter so a second replica is safe; read-back verification of
the portal state after each chunk; merging overlapping updates at day level. The
`ext-batch` and `ext-circuit-breaker` image tags on the registry suggest where the
live session goes; the worker's outcome switch and the limiter are the two places
that would change.
