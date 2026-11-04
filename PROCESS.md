# PROCESS

Built in one sitting with Claude Code as the coding agent.

**What I delegated and what I kept.** I kept the decisions: the design in `SPEC.md`,
the choice to make it atomic requirements with stable IDs and one requirement per
commit with its own test, and every "good enough" call. The agent wrote nearly all
code, tests and docs, one requirement at a time; I read each diff and test run
before the commit. Before cloning, the agent audited the template and the Portal Sol
image without running them (provenance, layers against `node:24-alpine`, the bundled
server, trivy). The bundle showed the portal's hidden defaults; I still measured the
limits empirically (spec section 2) and say so here.

**Where the agent was wrong, and how I noticed.** Twice a commit landed on red: the
shell chained the commit after a `grep` that succeeded whatever the tests did; the
summary in the output gave it away, the commits were amended and the gate now checks
exit codes. A test expected calendar-month chunks where the code correctly chunks by
31 days. A 429 test assumed in-flight calls could be recalled. A failing assertion
hung the run because the worker kept going, fixed with a helper that always stops it
plus per-test timeouts. An update with no jobs derived as "synced". A "stuck"
accommodation in a manual run was a test fixture in the shared database. In the
security pass that followed (SEC-01..12), a heap-growth assertion was flaky because
the fake portal shares the process; it became a counting stream. The first commit
check did not even parse in bash. The linter, added after 40 commits, found one real
thing.

**Left out, in the order I would do them.** A re-queue endpoint for failed jobs; a
shared limiter so a second replica is safe; read-back of the portal after each chunk;
day-level merge of overlapping updates. The `ext-batch` and `ext-circuit-breaker`
image tags on the registry suggest the live round; the worker's outcome switch and the
limiter are the two places that would change.
