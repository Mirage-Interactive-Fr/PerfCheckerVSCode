# PerfChecker for VS Code

## Measure existing Julia test items

Set `perfchecker.runnerProject` to a Julia environment containing PerfChecker and
TestItemRunner 1.3.2 or later in 1.x. Run **PerfChecker: Discover existing test items**,
then select individual items in the **PerfChecker items** Testing controller.
Untagged items are shared; `:perf_only` is included and `:test_only` is excluded.
`testItemTags` and `testItemExcludeTags` narrow selection. Each item runs once by
default, in an isolated process; `testItemSamples` explicitly changes repetition.
Save workspace changes before measuring. Cancellation stops the measured process tree.

The item timer includes setup, imports, assertions and cleanup. Green means
correctness passed, with measurements retained; no regression budget has been
compared. Ordinary Julia/TestItemRunner execution is unchanged: automatic exclusion
of `:perf_only` in that runner needs upstream support.

The investigation panel connects shared tests, declared performance scenarios, optional analyzers and saved evidence. It also provides a searchable tool catalogue, proposed CI coverage, bounded investigations and optional explanations from a configured model.

Use **PerfChecker: Open investigations**. Discover and select scenarios before measuring or investigating. **Model settings** selects the endpoint, model and Chat Completions/Ollama protocol; advanced Julia providers use an advisor JSON file. Local inference is the default and no model is downloaded or launched automatically. Remote transmission requires explicit opt-in. Generated explanations remain separate from deterministic findings and never alter correctness or performance verdicts.

`perfchecker.investigationMaxExperiments` and `investigationBudgetSeconds` bound work. `advisorInvestigates` optionally lets the configured model choose declared experiments; it is disabled by default. History shows completed and unexecuted experiments. CPU/allocation profiles provide filterable stack evidence. Changing the target implementation still requires an explicit before/after comparison with a stable oracle and measurement contract.

[PerfChecker.jl](https://github.com/Mirage-Interactive-Fr/PerfChecker.jl) turns
performance checks into reproducible package, suite and version comparisons.
This repository contains its independent VS Code client.

The extension is the central graphical workspace for package developers. It
consumes PerfChecker's versioned plans and result bundles; it does not bundle
the Julia package or enter measured workers.

## Features

- Browse `package → business feature → check type → target` in the activity bar
  and native Test Explorer.
- Select BenchmarkTools, Chairmarks, allocations, CPU/wall-time profiles and
  network checks per business feature.
- Filter version ranges, sort and colour-label checks, and drag execution order.
- Add releases, branches, tags, commits and grouped comparison targets.
- Launch a whole suite or any selection with live progress and worker output.
- Open the exact Julia workload behind a check.
- Inspect interactive distributions, version curves, allocation pies and flame
  graphs with hover details for narrow points and frames.
- Save selections, comparison policies and documentation blocks in the shared
  `perfchecker-ui-config/1` format.

## Requirements

- VS Code 1.96 or newer.
- Julia available as `julia`, or configured through
  `perfchecker.juliaExecutable`.
- A controller environment in the opened package workspace, normally `perf`,
  containing PerfChecker.jl and a `suite.jl` with `build_suite()`.

The extension invokes the public PerfChecker CLI and reads only versioned JSON,
JSONL and Markdown outputs. See [CONTRACT.md](CONTRACT.md) for the exact boundary.

## Install a local build

```powershell
Set-Location C:\path\to\PerfCheckerVSCode
npm ci
npm test
npm run package:pre-release -- --out perfchecker-vscode-0.1.0.vsix
code --install-extension .\perfchecker-vscode-0.1.0.vsix --force
```

Reload VS Code, open a Julia package workspace, then select the PerfChecker icon
or run **PerfChecker: Open visual suite editor** from the command palette.

## Workspace defaults

```text
perf/Project.toml
perf/suite.jl
perf/perfchecker-ui.json
perf/results/vscode/
```

Every path is configurable in VS Code settings. The controller environment owns
the PerfChecker.jl version, so upgrading the extension does not silently change
the benchmark engine used by a project.

## Development

## Shared scenarios and investigations

**PerfChecker: Open investigations** opens the investigation workspace.
Use **Discover scenarios from tests** first: discovery parses source files without
running the project. Declared scenarios are executable; inferred test cases remain
proposals. Prepare a proposal as an unsaved Julia draft, implement its ordinary
factory and oracle, then adopt its declaration with parameters, fixtures and
collectors. Adoption preserves existing catalog text and rejects stale discovery.

The sidebar, Julia CodeLens and Testing view expose the same declared cases.
Select implementations independently, then measure or diagnose. The workspace
shows timing samples, allocation summaries, separate qualifications and saved
advice. JET/AllocCheck findings appear in Problems with source navigation and an
action to open their evidence. These actions offer experiments; they do not apply
speculative edits or performance budgets. Save Julia edits before running checks.

Settings for this workflow:

| Setting | Purpose |
|---|---|
| `perfchecker.runnerProject` | Controller environment containing this PerfChecker version |
| `perfchecker.scenarioProject` | Prepared target/collector/analyzer environment |
| `perfchecker.scenarioCatalog` | Shared TOML catalog (default `perf/scenarios.toml`) |
| `perfchecker.analysisTools` | Requested diagnostic tools; absent tools remain unavailable |
| `perfchecker.analysisTimeout` | Deadline per worker, including startup |
| `perfchecker.scenarioSamples` | Fresh samples, one evaluation each |
| `perfchecker.scenarioThreads` | Julia threads per worker |

History is stored inside the workspace. Read JSON/Markdown, regenerate advice
without running the target, or compare two saved measurements. Unmeasured
configurations remain visible. Cancel stops the investigation's own process tree.

The existing suite editor, result viewer and bundle commands remain available.
Projects such as Étendu3D keep their own pinned controller and workspace settings;
this lab build does not migrate or replace their environments. Test it with a
separate extension development profile before choosing a deployment.

### Extension host integration test (opt-in)

Prepare a controller containing the lab PerfChecker, SharedScenarioDemo,
BenchmarkTools, Chairmarks and JET. Then create a **new** scratch workspace:

```text
node test/prepare-host.mjs /path/to/PerfChecker/examples/shared-scenarios /path/to/controller /path/to/new-workspace
```

After `npm test`, launch your official VS Code executable with
`--extensionDevelopmentPath=/path/to/this/repo`,
`--extensionTestsPath=/path/to/this/repo/test/extension-host.cjs`,
`--user-data-dir=/path/to/scratch-profile`,
`--extensions-dir=/path/to/scratch-extensions`, `--disable-extensions`,
and the new workspace path. Set `PERFCHECKER_HOST_RESULT` to an output JSON path.
The test exercises real Julia discovery, measurement, JET findings, CodeLens,
Problems, evidence actions and cancellation. Do not use your normal editor profile.

## Build locally

```powershell
npm ci
npm test
npm run package:pre-release -- --out perfchecker-vscode.vsix
```

`npm test` compiles TypeScript and runs the model/contract tests. The generated
`dist` directory and VSIX archives are intentionally not committed.

## Marketplace publication

The immutable Marketplace identity is
`mirage-interactive-fr.perfchecker-vscode`. Repository extraction therefore does
not change extension settings, commands, or installations.

For a manual pre-release:

```powershell
npx vsce login mirage-interactive-fr
npx vsce publish --packagePath .\perfchecker-vscode-0.1.0.vsix --pre-release
```

Publishing requires a free Microsoft identity and Marketplace publisher, not a
paid Azure subscription. Never commit a publication token. The future release
workflow can use Marketplace trusted publishing after the dedicated GitHub
repository exists.

## License

MIT. See [LICENSE](LICENSE).

## Optional MCP advice

Open **PerfChecker: Configure advisor and manage models** for the guided panel.
It supports connection checks, selection from discovered MCP tools or models,
custom instructions, deterministic-only mode, and bounded investigation settings.
Local Ollama models can be downloaded, unloaded or removed after an explicit
confirmation; sizes are reported by the server and may include shared layers.
The panel does not install Ollama itself or download anything on opening.
Configuration is saved to the selected advisor file or `perf/advisor.json`.
Use a credential environment variable name, never a token, in the panel.

In **Model settings**, choose `mcp_http`, the MCP endpoint, an explicit advice
tool (`advisorMcpTool`) and its prompt argument (`advisorMcpPromptArgument`).
`advisorInstructions` customizes the request; `advisorMcpArguments` supplies
other required arguments. Use protocol revision `2026-07-28` or `2025-11-25`
according to the server. A remote HTTPS server requires `advisorAllowRemote`
and optionally `advisorKeyEnvironment` (the variable name, never the key).

`advisorMcpResponse=text` is the default: **Explain with configured model**
displays unverified advice without executing suggestions. To select declared
experiments, use `structured` and explicitly enable `advisorInvestigates`, with
count/time limits. `advisorConfig` can instead point to a shared provider JSON
file and takes precedence over these individual settings.

The server must provide an assistant/advice tool. The extension does not install
or start it. Stdio and OAuth login are not supported by this HTTP adapter.
