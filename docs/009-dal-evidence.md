# 009 DAL evidence

Change: `chg-superagent-dal-evidence-20261103`.
Status: Implemented and locally verified; no profile installation or live execution is implied.

The DAL integration follows the existing Ticket and Assignment model in
[003 Execution](003-execution.md) and the native panel in [005 Panel](005-panel.md).
It adds observation, not another dispatcher or a second completion policy.

The fork's development lock and DSH peer minimum target `0.2.1-rc.5` on Cordis
`4.0.5`, matching the separately approved CLI upgrade. DAL's legacy dependency
pins remain unchanged. Typechecking and simulated-host tests are compatibility
evidence, not proof of a mounted live profile.

The rc.5 adapter uses Host-reported configuration writability rather than the
removed browser-memory mode. Management requests fail closed until the Web server
has an actual bound port. Source-health errors take precedence over late readiness
notifications from the other process stream.

## Work, verification and authority

Each Ticket page separates the worker's latest report from independent
verification and runtime assurance. Independent verification reads **Unverified**;
runtime assurance reads **Unattested**. A ready report, a completed Ticket or a
merged pull request does not upgrade these claims. Existing Ticket actions and
lifecycle remain unchanged. In particular, the existing Eval is work-admission
assessment, not DAL task-quality evaluation.

**Download DAL observation** exports one versioned metadata snapshot of the Ticket
and all its Assignments. The same unchanged snapshot has the same content-addressed
identity. Retried Assignments remain distinct. Hashes attribute the workspace,
Ticket, worker Session, Assignments and mandate policy without exporting their
names, paths or request/report contents. Downloading does not claim that DAL has
stored or graded anything.

The exact `superagent-observation.v1.schema.json` contract and validation semantics
are owned by [DAL](https://github.com/lunarmoon26/dsh-adaptive-loop/blob/main/docs/superagent-observations.md).
The existing loopback/same-origin management surface adds only the read-only
`GET tickets/:id/dal-observation` route. It grants no worker tool, command runner,
model call, grader access or promotion ability. DAL runs separately; its older
Cordis/DSH packages are not loaded into the superagent process.

## Local handoff

With a development build of DAL containing the observation bridge, validate the
download with `dal observe validate <download.json>` and store it with
`dal observe ingest <download.json>`. Identical imports are idempotent. The default
store is `.dal/observations/` in the CLI's working repository. These observations
are deliberately not graded DAL run records and do not train an optimizer.

## Verification and follow-up

The product direction retains this prototype's task controller and native UI,
with DAL as a separate evidence/evaluation boundary, rather than adding a second
agent scheduler. The next views separate **Work** (Tickets, artifacts, questions),
**Learn** (candidate comparisons and reusable experience), and **Govern** (exact
human decisions). These views are proposed, not implemented by this observation slice.

The design uses pinned, statically inspected mechanisms rather than assuming that
coordination or longer execution proves learning:

- Orca `70209b9b1197314cb91521ea79ab0fae511b4896` separates task identity,
  dispatch attempts, inbox delivery and worker resources. This bridge preserves
  distinct Assignment identities; independent grading remains separate.
- Loop Engineering `18b16342aca27b40f3cac0bb0ab42b7df3ee2cd1` contributes bounded
  verification/repair and guardrail-drill patterns, not a sandbox or promotion authority.
- Harness² `1cfe254e8d25b15f37048c3730134686abe60335` separates current-task
  component edits from a library of applicability, lessons and evidence for future
  editing. That library is follow-up work, not automatic memory extraction here.

Task repair, cross-task capability retention and improvement-policy changes use
different evidence and authorization. A successful task does not approve its
workaround for future tasks. Evaluator, permissions, maximum allocations, audit
and promotion policy stay outside worker-editable state.

Projection tests cover deterministic attribution, retries, private-data omission
and unknown assurance. HTTP tests cover the read-only route and origin boundary;
panel tests cover both languages and export failures. Cross-repository verification
uses a fork-generated fixture with the built DAL CLI, without a model or profile.

Independent grading, immutable worker generations, Learn/Govern workbenches and
reusable improvement experience remain future work. A frozen exact-action approval
is still required for deployment or promotion; neither this document nor a Ticket
Mandate grants those capabilities. Worktrees are not an OS security boundary.

## Local evidence — 2026-11-03

- The rc.5 development graph passes `pnpm peers check` without peer conflicts.
- `pnpm check` passes typecheck, 1,216 tests in 61 files and both host/client builds.
- The unchanged malformed-event regression first reproduced a readiness/error race;
  the corrected consumer passes all seven focused consumer tests and the full suite.
- The exporter matches the golden observation in DAL. A newly generated synthetic
  export passes the built DAL CLI's validation, first ingestion and idempotent
  re-ingestion. DAL's full gate passes 1,259 tests with seven opt-in skips.
- The approved global CLI reports `0.2.1-rc.5`. npm did not authorize several native
  dependency install scripts; no allowlist was changed and no native-helper or
  running-profile startup proof is claimed. Development installs disable scripts.
- No profile, credential, plugin mount, running service, external message, model
  request, candidate activation, commit or push is part of this local verification.
