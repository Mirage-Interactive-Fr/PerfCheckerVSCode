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

## Consumed contracts

The 1.0 pre-release extension line accepts these versioned interfaces:

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

The extension never mutates a run bundle. It writes only the user-selected UI
configuration in the package workspace and files under VS Code global storage.

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
