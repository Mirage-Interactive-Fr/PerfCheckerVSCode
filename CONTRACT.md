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

## Consumed contracts

The stable 1.0 extension line accepts these versioned interfaces:

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

## MCP conversation and reviewed implementation

The extension requires PerfChecker.jl 1.0.0 or later and its public `chat` and `implement` CLI commands.
Both accept `--source`, `--advisor-config` and `--project`; files live in a private
temporary directory and are removed after the process ends. Requests and provider
configuration are not written into run bundles or conversation logs.

`chat` receives alternating user/assistant messages ending in a user question,
with up to 21 messages, 16,000 Unicode characters per message and 32,000 in total.
The stored transcript retains up to 20 messages/32,000 characters as whole
exchanges. Optional `advice` is explicitly selected saved evidence. The extension
does not automatically attach editor buffers or arbitrary workspace files.

The result must be `perfchecker-narrative/1`, `status=complete`,
`authority=unverified_narrative` and `reference_status=unstructured_not_verified`,
with a nonempty `external_review` string of at most 16,000 characters. Provider
content is rendered as text, including code-looking HTML. It cannot change
deterministic verdicts. JSON responses are bounded to 2 MB and timeouts/cancellation
terminate the local process tree; a remote tool may continue work.

`implement` additionally receives `workspace`, the canonical absolute path to a
temporary checkout, and `workspace_argument`, the configured tool argument name.
The endpoint, revision, credentials and additional MCP arguments come from the
advice configuration, with an explicitly configured implementation tool and prompt
argument. The tool must be able to access and respect that path. MCP is not a
filesystem sandbox. The response remains unverified narrative and declares
`implementation_status=requires_diff_review`; its prose never applies a change.

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
the current tree to detect an interrupted apply. Conversation and source/patch
contents are not duplicated in workspace state. Closing a proposal removes its
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
[MCP guide](https://mirage-interactive-fr.github.io/PerfChecker/stable/mcp-advisor).
