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

## Consumed contracts

The 0.9 extension line accepts these versioned interfaces:

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

