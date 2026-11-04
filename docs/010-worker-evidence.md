# 010 Worker strategy and artifact evidence

Change: `chg-superagent-worker-evidence-20261103`.
Status: Implemented and locally verified; no live profile or model execution is authorized.
Exact persisted shapes: the strict schemas in `src/app/worker-evidence.ts`.

This extends [004 Prompts](004-prompts.md) and [009 DAL evidence](009-dal-evidence.md)
without changing the Ticket completion policy in [003 Execution](003-execution.md).

## Assignment strategy pins

The first actual model-request assembly of an Assignment durably pins the
superagent-owned worker prompt revision and the content/description digests of its
registered skills. A content-addressed strategy identity binds that manifest;
a separate context digest binds the full superagent-owned section including its
execution environment and Mandate. Preview assembly creates no pin.

Later requests in the same Assignment use the pinned revision. If rendered bytes,
skills or context drift (including changed built-in defaults after an upgrade),
assembly fails rather than silently replacing the pin. A new Assignment can use a
new revision. Router prompts keep their next-request behavior. Saved changes do
not restart or wake workers. Historical Assignments without a pin remain unknown;
the host does not infer which strategy they used. The pin survives host restart.
Existing recovery semantics still apply: a settled Assignment retains its pin;
an interrupted busy Assignment receives a successor that binds independently.

This is not a full runtime generation: inherited DSH prompts, repository
instructions, tool implementations, skill resource files, subagents, model selection and credentials
remain outside its assurance. Older binaries do not enforce this new contract;
deployment/downgrade must retain the matching supervisor version. No HMR,
candidate activation or permission expansion is introduced.

## Host-computed artifact checks

An operator freezes one bounded check contract for the latest Assignment and its
exact strategy identity through the loopback/same-origin management API. Contracts
contain at most 32 uniquely named checks: required literal, forbidden literal, or
exact artifact SHA-256. They contain no command, regex, model, path or executable
code. A conflicting contract cannot overwrite an existing one.

Management routes are `GET tickets/:id/worker-evidence`,
`PUT tickets/:id/artifact-contract` and `POST tickets/:id/artifact-check` under
`/orchestrator/api/`. The typed panel contract lives in `src/app/api.ts`;
strict bodies and persisted records use the schemas above. Contract bodies are
bounded to 256 KiB; file checks accept canonical base64 with 4 KiB of metadata
headroom. The host re-reads the Ticket after receiving the body before checking
the latest Assignment. A malformed request returns 400 and an immutable-binding
conflict returns 409. Evidence reads validate stored bindings rather than display
an unchecked pass. Contracts retain operator-selected literals locally, even
though receipts and the existing DAL export contain no file contents.

The operator supplies a file through the panel, at most 1 MiB, for that exact
contract/Assignment/strategy. Host code computes the checks and an immutable,
content-addressed receipt. Text checks require valid UTF-8; an invalid text encoding
fails those checks. Receipts retain only byte count, artifact digest, criterion
identities, pass/fail results, binding digests and time. Raw artifact bytes and
filenames are not persisted or sent to a model. At most 20 distinct receipts are
retained per Assignment; retries of the same artifact/contract are idempotent.
Re-supplying an existing artifact keeps its receipt identity and original check
time and moves it to the current position; the current result follows the last
supplied artifact, not merely the last distinct artifact ever recorded.

Superseded Assignment requests, wrong generation/contract bindings, malformed or
oversized inputs, duplicate check names and drifted stored evidence fail closed.
The panel shows latest supplied-file results and historical Assignment evidence
separately. Passing means only that the supplied bytes met the frozen literal/hash
criteria. It does not prove worker provenance, semantic task correctness, delivery,
independent-principal execution, holdout quality or promotion eligibility.

The existing metadata-only DAL export is unchanged and remains unverified and
unattested. Host artifact checks do not retroactively turn it into a graded run.
These are operator-local management functions, never new worker tools. Same-origin
checks are not authenticated reviewer identity or confinement from workers running
under the same OS user. Separate authority and isolation remain required for
adversarial workers or any promotion.

## Acceptance and verification

1. Repeated worker requests retain their Assignment's revision and strategy/context
   digests; new Assignments can bind successors; previews do not write pins.
2. Router next-request updates, worker prompt-version read permissions and skills
   remain consistent with the bound revision across restart.
3. Check contracts and receipts bind exact Assignment, strategy and artifact bytes;
   changes, stale requests and malformed stored evidence are rejected.
4. The bilingual panel distinguishes supplied-artifact checks from worker reports
   and whole-task verification; upload/contract failures do not affect Ticket actions.
5. Deterministic unit, simulated-host, HTTP and DOM tests cover these boundaries;
   the full repository check passes without profiles, models or external effects.

## Local evidence — 2026-11-04

| Requirement | Implementation | Automated evidence |
| --- | --- | --- |
| Per-Assignment text/context pin, no preview writes, new Assignment successor | `Sessions`, typed `KV.workerEvidence.strategy` and strict strategy schemas | `tests/worker-evidence.spec.ts`, `tests/runtime.spec.ts` |
| Router next-request behavior, worker read permissions, skill registration and restart | Shared skill-text builder and Assignment-aware `promptVersion` | Simulated-host router/worker, registered-skill, settled-restart and retry tests in `tests/runtime.spec.ts` |
| Frozen contract, exact-byte binding, idempotency and bounds | `ArtifactChecks` and strict contract/upload/receipt schemas | Fifteen deterministic tests in `tests/worker-evidence.spec.ts`; protected routes and bounded requests in `tests/http.spec.ts` |
| Native bilingual controls and clear evidence scope | `src/client/worker-evidence.tsx`, native Ticket DAL section and locale dictionaries | Five DOM tests in `tests/panel-worker-evidence.spec.tsx`; existing Ticket/DAL action tests |
| No new completion or promotion authority | Separate management evidence routes; no Engine lifecycle changes and unchanged DAL projection | Ticket unchanged by artifact checks; DAL export stays unverified, unattested and without promotion authority |

`pnpm check` passes typecheck, 1,239 tests across 63 files and host/client builds.
The documentation gate initially caught a prohibited forward link from an earlier
numbered document; that reference now uses its machine owner, preserving the
repository's document order. One run of the existing recovered-PR notification
test observed a cancellation-order assertion failure; its focused rerun and the
subsequent full gate passed without changing that test or its production path.
This remains a timing uncertainty, not new live-runtime evidence.

The new persisted records need no SQL schema migration; old Assignments without
records remain explicitly unknown. There is no backfill, automatic grader,
candidate activation, live model call, profile mount, service restart, commit or
push in this increment. Independent-principal evaluation, authenticated artifact
provenance and measured reusable improvement remain separate future work.
