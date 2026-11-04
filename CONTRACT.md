# PerfChecker integration contract

PerfChecker for VS Code is a client of PerfChecker.jl. It does not import,
vendor, or read the Julia package's internal source files.

## Process boundary

For a workspace whose controller project is `perf`, the extension invokes:

```text
julia --startup-file=no --project=<workspace>/perf \
  -e "using PerfChecker; exit(perfchecker_main(ARGS))" -- <command> <arguments>
```

The controller project owns the PerfChecker.jl version and Julia environment.
The measured worker remains isolated by PerfChecker.jl; Node.js and VS Code are
never loaded into a timed worker.
With the default project setting, `perf/controller` is used only when
`perf/Project.toml` is absent and `perf/controller/Project.toml` is present.
Explicit folder-scoped settings take precedence; missing inputs fail before a
controller is launched.

The public VS Code command `perfchecker.openDesignerForWorkspace` requires a
`vscode.Uri | vscode.WorkspaceFolder` argument naming an open local folder.
Companions can detect its contribution in `packageJSON` before activating this
extension. The legacy `perfchecker.openDesigner` accepts an optional
`vscode.Uri | vscode.WorkspaceFolder` argument for an open local workspace folder.
The argument is required in a multi-root window. The CLI plan and factory use that
folder as their working directory and resolve `perfchecker.*` settings for that
folder. Investigation and advisor commands share that selection and reject
multi-root requests made before a folder is selected. Activation alone does not
plan a suite in a multi-root window.

`perfchecker.runLandscapeLiveForWorkspace(folderUri, qualitySlug)` is a separate,
explicit command. It validates the same open folder identity and a current
Beautiful Landscape quality entry, then uses PerfChecker.jl's public
`ExternalCommandSpec`, `run_external_command`, `write_run_bundle`, and
`verify_run_bundle` APIs. A provider at `perf/live_provider.jl` writes
`perfchecker-provider-result/1` to `PERFCHECKER_OUTPUT`; the resulting bundle lives
under `perf/results/live`, outside the CPU suite report directory. The extension
validates quality, effective resolution, timestamps, hardware availability,
submission timing scope and millisecond metric definitions before archival.
Provider failure or cancellation never becomes completed evidence.

Suite, native Testing and investigation controllers accept a portable stdin
cancellation request. Exit 130 means interruption finished after cleanup; other
nonzero exits remain errors. The extension waits up to 60 seconds before forced
termination and warns that cleanup and detached-worker termination are not
guaranteed after that fallback. A local MCP cancellation may leave the remote
agent running.

## Consumed contracts

The stable 1.x extension line accepts these versioned interfaces:

| Interface | Identifier or transport | Purpose |
| --- | --- | --- |
| suite plan | `perfchecker-suite-plan/1` | package, feature, check and target tree |
| suite result | `perfchecker-suite-result/1` | run status and summaries |
| result bundle | `perfchecker-run-bundle/1` | immutable observations and diagnostics |
| version series | `perfchecker-version-series/1` | interactive plots and distributions |
| version comparison | `perfchecker-version-comparison/1` | baseline/candidate deltas |
| UI configuration | `perfchecker-ui-config/1` | selections, targets, policies and document blocks |
| progress | lines prefixed by `PERFCHECKER_PROGRESS ` | streamed JSON progress events |

Unknown major schema identifiers are rejected. Additive fields within a known
schema are ignored unless the extension understands them. This permits
PerfChecker.jl to add evidence without forcing an extension release.

## Files read from a report directory

- `suite-result.json`
- `version-series.json`
- `version-comparison.json` and `version-comparison.md`
- `compatibility.json`
- `bundles/run-*/observations.jsonl`

The extension never mutates a run bundle. It writes selected configuration and
controller reports, plus VS Code state. Reviewed implementation is a separate
explicit workflow that may update workspace source files as described below.

## Compatibility policy

Breaking CLI or schema changes require a new contract identifier and a guarded
adapter in this repository. PerfChecker.jl and the extension may therefore use
independent package and release versions.

# Shared investigation contract

The investigation client consumes public `discover`, `run --catalog`, `diagnose`,
`advise`, and `compare --scenarios` commands. Reports declare their schema version;
unknown versions fail visibly. Selection uses exact `(id, implementation)` pairs.
The implementation identifies target code; the collector identifies measurement.
The extension never evaluates test syntax to adopt a proposal, installs Julia
packages, or changes a project's controller environment automatically.

Run summaries are display projections of saved bundles, with at most 1,000
display samples per metric. They do not replace raw evidence. Availability,
correctness, quality and performance are separate, and diagnostic findings are
advisory until measured before/after. Existing suite/bundle commands stay intact.

## Guided agent workflow and reviewed implementation

The extension projects selected saved bundles through Core's read-only `advise`
command, then calls the explicitly configured MCP tool directly. Result identity,
target revision, canonical measurements, profile records and qualifications come
from saved evidence. Integrity is revalidated before transmission. A captured
suite/series snapshot remains attached to its execution when newer reports are
written. Historical charts read the original bundle and captured plan metadata.

An analysis returns `perfchecker-guided-analysis/1`, with a summary, findings and
separate suggestions. Each finding and suggestion references only selected result
IDs. Suggestions include verification checks. Malformed prose, unknown IDs or
an outdated selection cannot authorize an implementation. Only a selected
suggestion is implemented; optional notes supplement its fixed action context.

MCP requests are bounded to 200 KB; analysis input is bounded to 160 KB and each
returned text to 16,000 Unicode characters. The HTTP client supports explicitly
selected 2025-11-25 and 2026-07-28 revisions, JSON/SSE replies and cancellation.
It does not offer MCP roots, sampling, tasks or elicitation. Source code is not
implicitly attached, but saved profile evidence may include source locations.

The extension owns a branchable action history with exact explicit inputs,
structured responses, execution snapshots and verification feedback. Workspace
state is bounded to 24 MB, with at most 256 action nodes and 8 MB of history.
Continuing from a checkpoint preserves descendants and source files. A matching
agent connection can use a declared native fork; other connections replay only
that branch's explicit context. This does not clone hidden agent state.

The custom MCP metadata `perfchecker/conversation` declares `provider`,
`connection` and `forkArgument`; `perfchecker/agentSession` returns the child
session's provider, connection and ID. These are optional PerfChecker contracts,
not standard MCP session-fork methods. Codex uses its qualified native CLI fork.
The shared ACP v1 adapter negotiates `sessionCapabilities.fork`, uses
`session/fork`, and exposes the same MCP tools for Vibe, Claude and other agents.
Its file service is scoped to the selected workspace or isolated checkout;
command/network permissions are denied. Agents retain their own credentials.

After diff review, verification runs a fixed `Pkg.test()` command. Passing package
tests permit repetition of the selected performance checks. Compatible operation
medians retain units, definitions, workload fingerprints and scope; profile
weights never become timing gains. Test failures and measured comparisons return
to analysis. Keeping a trial requires successful verification against the same
candidate and unchanged source bytes. Restore uses the retained Git checkpoint.

The older Core `chat` and `implement` CLI adapters remain compatible with their
unstructured narrative contracts. The primary VS Code interface uses the guided
protocol above. Provider responses are rendered as text and never change Core's
deterministic qualifications.

Before sending implementation, the extension requires saved editor buffers, a Git
repository with an existing HEAD, no merge conflicts or submodules, and no absolute
or external symlinks. Git clean/smudge/LFS filters, working-tree encodings and ident
expansion are rejected before filter execution because their on-disk roundtrip
cannot be guaranteed. LF, CRLF and mixed endings are preserved as exact on-disk
bytes even with global/local Git text conversion and `text`/`eol` attributes.
A copied temporary index records raw blobs without filters and snapshots tracked changes,
non-ignored untracked files and ignored files already staged, without modifying
HEAD or the real index. It retains a commit at
`refs/perfchecker/checkpoints/<uuid>` and prepares a separate Git repository in the
OS temporary directory. The containing repository is copied; proposed modifications
must remain inside the selected workspace folder. Ignored untracked files and
unsaved buffers are excluded.

After a successful tool reply, the extension collects the actual Git diff and
retains the candidate at `refs/perfchecker/proposals/<uuid>`. Diff output is bounded
to 32 MB. Apply/restore use its original bytes, including binary/non-UTF8 files;
the text preview reports when replacement characters cannot represent those bytes.
A separate **Apply reviewed changes** action checks that the entire checkpointed
repository tree has not drifted, then applies the reviewed patch without updating
staging or HEAD. Patch application uses private temporary Git metadata with text
conversion disabled; it does not edit the user's Git attributes or configuration.
**Restore previous code** uses the reverse patch and the same drift
guard, removing files introduced by that proposal and restoring previously deleted
untracked files. Later unrelated repository edits also trigger the conservative
drift rejection. Failed or cancelled requests never auto-apply a partial proposal.

Recovery stores only Git references and the applied flag in folder-specific VS Code
workspace state, with a discoverable `refs/perfchecker/active/<workspace-path-hash>`
pointer independent of that storage. Reopening reconstructs the diff and checks
the current tree to detect an interrupted apply. Proposal patch bytes remain in Git; the guided workflow separately retains
its bounded explicit context and response history in workspace state. Closing a proposal removes its
active pointer; checkpoint/proposal refs remain. Starting a new conversation or
changing its attached evidence preserves the current proposal and its restore
action; only explicit proposal abandonment clears the active recovery pointer.
Manual inspection uses
`git show <checkpoint-ref>:relative/path` or
`git diff <checkpoint-ref> <proposal-ref>`; recovery never resets a user's branch.

Companions retain explicit folder selection through `openStudioForWorkspace(uri)`;
chat and implementation use that selected folder and reject an unselected multi-root
workspace. Advice mode can be used without Git. Configuration/transmission and
user-facing recovery instructions are maintained in the canonical PerfChecker
[MCP guide](https://perfchecker.mirageinteractive.fr/mcp-advisor.html).

### Optional local Codex connector

`perfchecker.connectCodex` explicitly connects an installed, authenticated native
CLI; `perfchecker.disconnectCodex` restores the saved provider. This in-memory
override takes precedence over `advisorConfig` and supplies both tool selections
without changing JSON files, settings or saved credentials. Setup saves are
refused while connected. The endpoint is an authenticated POST-only loopback MCP
server with `ask_perfchecker(prompt)` and `implement_perfchecker(prompt, workspace)`;
the implementation path must resolve into a temporary PerfChecker checkout.

The CLI preflight checks version, help capabilities and login status. Calls use
`--no-daemon exec --json --ignore-user-config --ignore-rules`
(with `--ephemeral` for implementation and advice without native forks), explicit
`read-only`/`workspace-write` sandbox policies and `approval_policy="never"`.
Project `.codex` directories are refused, including configurations in ancestors
up to the containing Git root, before CLI invocation. Custom user configuration
and profiles are not inherited; account authentication and CLI default model are
used. Native Windows executables are supported; shell launchers are refused.

The random bearer token exists only in extension memory and a temporary process
environment variable inherited by Julia workers. It is removed from Codex's
environment and on disconnect. Origins are refused. Requests, CLI output and final
replies are bounded; one model call runs at a time. Timeout, client disconnect and
extension disposal terminate the owned local process group/tree and await its
exit. The connector does not control a remote model provider's in-flight work or
promise sandbox support beyond that of the selected CLI and platform.
