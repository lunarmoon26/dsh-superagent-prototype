# 011 End-to-end verification

Change: `chg-superagent-e2e-20261104`.
Status: Implemented and locally verified, with explicit native-service bridges.

This verifies the native Work/evidence flow in [010 Worker evidence](010-worker-evidence.md),
not autonomous improvement or promotion. Paid test calls are operator-authorized;
tests still use bounded calls, isolated state and synthetic tasks only.

## Deterministic full-stack scenario

`pnpm test:e2e` starts the real Runtime and SQLite store with scripted external
DSH/Source boundaries, serves the actual panel and management handlers over a real
ephemeral loopback HTTP port, and drives a headless Chromium browser. Test controls
remain in the test process: no fixture endpoints are added to the production API.
The browser uses the production React panel, not the DOM fake API server.

The scenario receives a synthetic request through a Source adapter, routes it
through the registered main-Session tool, creates a worker Assignment, renders an
actual request section, and produces a synthetic worker file. Browser interactions
freeze a contract and check the file. Host assertions and browser observations
cover unchanged pins after prompt saves, passing and failing bytes, idempotency,
stale Assignment rejection, successor revisions and separate historical evidence.
The browser downloads a DAL observation; the built sibling DAL CLI validates and
immutably ingests it twice. Artifact checks remain prototype-local and the DAL
observation remains unverified/unattested, with no promotion authority.

Runs retain an evidence summary, downloaded snapshot and browser screenshot under
`.artifacts/e2e/`. Cleanup stops the HTTP server, browser and Runtime even on
failure. Model and source scripts do not call a provider, GitHub or Feishu.
Browser failures are failures, never a fallback to DOM mocks or a skipped pass.

## Native smoke boundary

`pnpm test:native` exercises installed DSH Agent loops and the native model adapter
alongside the production Runtime/Executor/Sessions, real HTTP/browser and DAL CLI.
It uses isolated state, a synthetic local Source and a fixed-output data tool.
The Session-controller/workspace bridges and permission-preset shim are test
boundaries: a full production DSH profile and its coding preset are not mounted.
No existing profile is overwritten or restarted; no real Issue, comment, branch
or PR is created. `pnpm test:native:agent` runs the smaller Agent/Sessions smoke.

The model can submit only one fixed output through `write`. It gets no working
shell, arbitrary file reader/writer, subagent, network or account tool. Router-only
inherited tool names are inert refusals; real superagent management tools retain
their production validation. Host preparation is a fixed `git init` in test state,
never a model-generated command. A worker must have an OS/container boundary before
tests mount general coding tools; this smoke does not claim OS isolation.

Credentials remain in the native credential service, which can perform its normal
OAuth refresh; no tokens are copied to test artifacts or model prompts. Shared
credential-format migration is refused. The installed native provider catalog
validates model selection before requests. Each run permits at most eight stream
attempts, 1,024 output tokens per request, 128 KiB request JSON, zero provider
retries and a 180-second model deadline. Parent execution is bounded to 210 seconds.
Only the synthetic task and its superagent prompt/context leave the host.

Native-runtime tests and external-channel tests are separate evidence. A native
smoke with a local Source cannot prove GitHub/Feishu credentials, event delivery,
public posting, or operational permission to deploy. Live output is checked by the
same literal/hash contract; it does not prove general semantic task correctness.

## Full Web-profile startup boundary

`pnpm test:profile` boots the installed DSH Web profile with the built bundle,
native services and native Web shell. It uses a fresh private HOME/DSH_HOME,
no inherited provider keys, no shared credentials and no account configuration.
Both Source plugins are disabled; no Session is prompted and no model or coding
tool runs. The test expects the honest `repositoryUnset` / `setupPending` state,
not operational readiness. Chromium opens Superagent from the real shell sidebar
and verifies the panel and management state, then repeats after a clean restart.
No controller/workspace bridge or permission shim is installed in this test.
The native Workspace controller uses an explicit Documents directory under the
private HOME, avoiding reliance on a desktop user's XDG directory configuration.

Only the disposable profile installs the local bundle link. Existing profiles,
package-script policy and accounts remain unchanged. DSH telemetry uses its
supported `DISABLED` value. Profile boot fails the test on inactive entries,
configuration failures or unclean shutdown. Startup logs redact the disposable
browser bootstrap token after shutdown; it is never included in the receipt.
Evidence lives under `.artifacts/profile-smoke/`. This complements the live-model
test; it does not join real-model work with the production coding preset.

## Independent local coding evaluation seam

The joined native runner also accepts `--task <agent-task.json>` for the separately
owned `dsh-harness-evals` experiment. Its strict version-1 input contains only
`task_id`, `task_sha256` and the public `instruction`. The worker writes at most
32 KiB of Python source to one `solution.py` artifact as data; no generated code
or command runs in this host. The smoke receipt records routing/report completion,
not a task grade. Browser/literal-check/DAL steps are omitted in this mode.
The external evaluator freezes its hidden checks before dispatch, captures the
artifact bytes and grades them only in its no-network Docker sandbox. This seam
does not expose evaluator files, grant access to real accounts, or add a production
management endpoint. It still uses the explicit native service bridges above.

## Local prerequisites and commands

The default browser is `/usr/bin/google-chrome`; set `E2E_CHROMIUM` for another
installed Chromium executable. No browser binary is downloaded implicitly.
Install the pinned Python package in a checkout-local environment:

```sh
uv venv .artifacts/e2e-venv
uv pip install --python .artifacts/e2e-venv/bin/python -r tests/fixtures/e2e/requirements.txt
pnpm test:e2e
pnpm test:native
pnpm build
pnpm test:profile
```

Do not recreate an existing environment just to run a test. `E2E_PYTHON` overrides
its interpreter. The sibling DAL repository must already have a built
`dist/cli.js`; `DAL_CLI` supplies another absolute CLI path. Native tests require
the installed DSH `0.2.1-rc.5` package and its existing native `openai-codex` OAuth
grant. `DSH_PACKAGE_ROOT`, `NATIVE_CREDENTIAL_STORE` and `NATIVE_MODEL` override
those locations/model without printing credential values. Missing prerequisites
fail before paid execution where they can be checked locally.
The profile-startup test needs the built bundle but no provider grant or DAL CLI.

Default `pnpm check` runs all ordinary tests and skips the explicit browser
scenario; only a successful `pnpm test:e2e` run supplies browser evidence. Paid
tests never run as an implicit dependency of `check`. Native runs retain receipts,
session logs and screenshots under `.artifacts/native-smoke/`.

## Acceptance

1. One explicit deterministic E2E command joins real HTTP, Chromium, Runtime,
   SQLite, Assignment pinning, file checks and the built DAL CLI.
2. Failures, altered files, repeated imports, prompt changes and successor
   Assignments preserve their documented evidence/authority boundaries.
3. Each run reports its actual scripted/native/model/isolation coverage, artifacts
   and limitations. Missing prerequisites fail clearly rather than claim success.
4. Native/paid execution uses capability-limited fixed-output tools (or an OS
   boundary for general coding tools) and bounded budgets;
   unavailable credentials or host capabilities are reported as specific blockers.
5. Existing repository checks remain green. No commit, push, candidate promotion
   or production deployment is performed by the test commands.

## Evidence — 2026-11-04

- Deterministic full-stack E2E passes, including Chromium interactions in English
  and Chinese, real HTTP handlers, SQLite reopen, successor strategy selection,
  negative artifact checks, stale-request rejection and built DAL CLI ingestion.
  Evidence: `.artifacts/e2e/run-fMvVkT/receipts.json` and adjacent screenshots.
- A smaller native Agent/Sessions smoke passes with two real `openai-codex` /
  `gpt-6.1-sol` calls, one fixed-output tool write and an unchanged Assignment
  revision after a mid-turn prompt save. Evidence:
  `.artifacts/native-smoke/run-eqoLDn/receipts.json` (the historical `paid_model`
  flag there denotes live provider use, not a measured monetary charge).
  The current TypeScript runner repeats that pass at
  `.artifacts/native-smoke/run-cR0kYz/receipts.json` with two live calls.
- The joined native flow also passes: the real model routes the synthetic
  request, the production Executor launches a real native worker, the worker
  writes the file and reports ready, Chromium freezes/checks the artifact, and
  the built DAL CLI validates/stores/reimports the downloaded observation.
  Eight native model calls, one successful write and no Agent errors are recorded
  in `.artifacts/native-smoke/run-MlNZ4Z/receipts.json`. Monetary cost is unknown;
  native usage accounting is retained rather than a fabricated dollar amount.
  A repeat joined run also passes at
  `.artifacts/native-smoke/run-AV1HGN/receipts.json`: eight calls, one write,
  187 output tokens reported by the provider, no Agent errors, and DAL
  valid/stored/idempotent results. The final deterministic browser repeat is
  `.artifacts/e2e/run-1XJYjW/receipts.json`.
  The typechecked TypeScript runner also passes the joined native flow at
  `.artifacts/native-smoke/run-Krbw1e/receipts.json` (eight calls, one write).
- The full installed Web-profile startup test passes with no inactive-entry or
  configuration warnings: real native shell, built plugin/client, native default
  Workspace creation, management HTTP, Chromium panel navigation and clean restart
  preserving the main Session identity. Evidence:
  `.artifacts/profile-smoke/run-0gwf84d0/receipts.json` and adjacent screenshots.
  It deliberately remains `setupPending` without accounts or model requests.
  The fixture dismisses the real first-run/sign-in dialogs and supplies a private
  Documents directory; early attempts exposed those environmental prerequisites
  rather than a production superagent failure.
- Browser E2E found a real defect: after valid → invalid → valid uploads, the panel
  previously kept displaying the last *distinct* artifact's failure. Receipt
  identity/time now stays immutable while resupplying an existing artifact makes
  it current. A deterministic regression test and browser assertions cover this.
- One early native test failed before any provider request because an inert tool
  omitted DSH's required output contract; the fixture was corrected. Another
  attempt was killed by the outer shell's 120-second test timeout; it has no
  success receipt and is not counted as a pass. The completed joined run used a
  larger outer timeout within the native runner's own 210-second bound.
- `pnpm check` passes 1,240 ordinary tests with one explicit E2E skip, typecheck
  and host/client builds. `pnpm test:e2e` supplies the separate successful browser
  gate, and `pnpm peers check` reports no conflicts.

No human browser test is required to reproduce this local flow. Model-driven
work under the full production coding preset, general shell/file tools under OS
isolation, real GitHub/Feishu event ingress and public delivery, and measured
improvement/promotion remain outside these smoke results. Independent behavioral
coding checks are owned by the separate `dsh-harness-evals` experiment above;
they are not inferred from this prototype's literal artifact receipts.
A live-channel pilot needs
an operator-designated disposable repository/account and its authorized login;
the tests do not select or repurpose the operator's personal account.
