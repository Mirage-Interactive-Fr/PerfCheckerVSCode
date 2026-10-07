# PerfChecker for VS Code

PerfChecker 1.0.1 brings a full Studio, interactive plots, Julia tools, MCP
conversation, and reviewed agent implementation with Git recovery into VS Code.
Use a controller environment containing PerfChecker.jl 1.0.1 or later.

The user guides are maintained with PerfChecker.jl on its existing documentation host:

- [VS Code guide](https://perfchecker.mirageinteractive.fr/interfaces/vscode.html)
- [Complete extension configuration](https://perfchecker.mirageinteractive.fr/interfaces/vscode-configuration.html)
- [Plots, notebooks and Julia tools](https://perfchecker.mirageinteractive.fr/interfaces/vscode-workflows.html)
- [MCP advice, implementation and recovery](https://perfchecker.mirageinteractive.fr/mcp-advisor.html)

## First use

Open a Julia package folder, then **PerfChecker: Open Studio**. Choose
**Set up workspace and create suite** to select or explicitly create the measurement
environment and starter suite. The setup explains which Julia project it will
modify and asks before downloading packages. An existing package `Project.toml`
alone does not make a measurement controller ready.

Use **Create controller environment**, **Use an existing controller**, or **Read the setup guide**
as appropriate. A controller needs registered PerfChecker.jl 1.0.1 or later.
The starter installs measurement dependencies; add your package and its test
dependencies explicitly to the selected controller before measuring test items.
Add `HTTP` there for an MCP HTTP provider or the local Codex bridge. Optional
analyzers and Julia debugging have their own prerequisites.

For notebooks, select **New Pluto notebook** and choose **Feature suite** or
**Investigation**. The extension uses real reactive Pluto `.jl` notebooks in an
editor tab. Stable Pluto 1.0.4 uses a separate `perf/pluto` Julia environment;
its installation is an explicit choice and does not modify the MCP controller.
Opening the notebook or changing selectors does not launch measurements.
Use its Launch/Cancel/Refresh controls, and **Save completed reports** in a suite
notebook. Pluto saves edited cells to the `.jl` file; the header provides
**Open source**, **Stop session**, and **Restart session**. Stop and closing the
view wait for owned measurement workers and allocation cleanup.

## Measure existing Julia test items

Set `perfchecker.runnerProject` to a Julia environment containing PerfChecker and
TestItemRunner 1.3.2 or later in 1.x. Run **PerfChecker: Discover existing test items**,
then select individual items in the **PerfChecker — measures** Test Explorer controller.
The measurement controller is created only for the chosen folder when discovery is
requested. In a multi-root workspace, the command prompts for a folder; companion
extensions may pass an open folder URI directly to `perfchecker.discoverTestItems`.
Its **PerfChecker — measures** run profile measures items independently of the Julia
extension's functional test controller; it does not intercept Julia test runs.
Untagged items are shared, `:check_only` is measurement-only,
`:perf_only` is its supported alias, and `:test_only` is functional-only. Shared
items may appear in both controllers as
two distinct actions. Set `perfchecker.testItemTags` to `["perf_only"]` to show only
measurement-only items in the PerfChecker controller. `testItemExcludeTags` further
narrows selection. Each item runs once by
default, in an isolated process; `testItemSamples` explicitly changes repetition.
Save workspace changes before measuring. Cancellation asks the Julia controller
to stop and waits for worker cleanup. A cleanup failure remains an error.
After one minute without exit, a visible forced-stop warning explains that
traces, private inventories or detached workers may remain.

The item timer includes setup, imports, assertions and cleanup. Green means
correctness passed, with measurements retained; no regression budget has been
compared. Ordinary Julia/TestItemRunner execution is unchanged: automatic exclusion
of `:check_only`/`:perf_only` in Julia's Test Explorer needs upstream support.
For a measurement-only item that must be safe under Julia's **Run All**, use:

```julia
@testitem "Measured case" tags=[:check_only] skip=(get(ENV, "PERFCHECKER_TESTITEM_MODE", "") != "performance") begin
    @test sum(1:1000) == 500500
end
```

PerfChecker sets this marker only in measured item workers; Julia's ordinary
runner then skips the item. This guard is opt-in per declaration.

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

- Open **PerfChecker: Open Studio** for a full editor workspace with investigations,
  plots, Julia tools and advisor conversation. The sidebar remains a launcher.
- Ask an explicitly configured MCP advice tool, review its answer, then optionally
  ask an implementation tool to prepare changes in an isolated Git checkout.
  Review the diff before applying; restore the checkpoint if the repository has
  not changed. Conversation is kept in memory; Git recovery survives editor restarts.
  Starting a new conversation preserves the current proposal and its restore action.
- Connect an already authenticated Codex CLI from Chat for the same advice and
  reviewed implementation workflow. The temporary local connection preserves
  your saved provider configuration and ends when disconnected or the editor closes.
- Open a folder-scoped Julia terminal and interactive Pluto notebooks inside VS Code.
  Create a feature-suite or investigation notebook with the official PerfCheckerPluto
  interface, then explicitly launch checks. Pluto has a separate Julia environment;
  installation requires your confirmation. Debug saved Julia source with the Julia extension.
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
  containing PerfChecker.jl 1.0.1 or later and a `suite.jl` with `build_suite()`.

The extension invokes the public PerfChecker CLI and reads only versioned JSON,
JSONL and Markdown outputs. See [CONTRACT.md](CONTRACT.md) for the exact boundary.

## Install a local build

```powershell
Set-Location C:\path\to\PerfCheckerVSCode
npm ci
npm test
npm run package -- --out perfchecker-vscode-1.0.1.vsix
code --install-extension .\perfchecker-vscode-1.0.1.vsix --force
```

Reload VS Code, open a Julia package workspace, then select the PerfChecker icon
or run **PerfChecker: Open Studio** from the command palette. Studio also opens
the suite editor and existing report viewers.

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
When the default `perfchecker.runnerProject` is `perf` but `perf/Project.toml` is
absent, PerfChecker selects `perf/controller/Project.toml` if it exists. The
selection is reported in the PerfChecker output channel. An explicitly configured
project always wins, even when its `Project.toml` is missing; that case shows a
path-specific error. `perf/runner` is never selected automatically. The same
rule applies to the default `perfchecker.scenarioProject` for investigations.

### Opening from another VS Code extension

Companion extensions should detect the contributed command
`perfchecker.openDesignerForWorkspace` in the installed extension's `packageJSON`
before activation, then pass an open folder's `vscode.Uri` or
`vscode.WorkspaceFolder`. This command requires the argument. The older
`perfchecker.openDesigner` accepts one optional argument: a `vscode.Uri` or
`vscode.WorkspaceFolder` identifying an open local workspace folder. For example,
`vscode.commands.executeCommand('perfchecker.openDesignerForWorkspace', folder.uri)` opens
that folder's suite with its folder-scoped PerfChecker settings. In a single-folder
window, the command palette and existing no-argument calls keep working. In a
multi-root window, callers must provide the folder explicitly; a missing or foreign
folder is rejected before the suite factory runs. Activation in a multi-root
window does not plan a suite automatically. Opening the designer does plan the
selected suite, so callers should invoke it only after an explicit user action.
Investigation and advisor commands use the same selected folder. Until one is
selected, those commands reject a multi-root window instead of choosing its first
folder. Native test item controllers already belong to individual folders.

### Explicit live graphics measurement

A companion may call `perfchecker.runLandscapeLiveForWorkspace(folder.uri, qualitySlug)`
after the user chooses a Beautiful Landscape quality profile and requests a live
measurement. Both arguments are required. The command checks the open local folder,
the quality contract and `perf/live_provider.jl` before launch. The provider must
write `perfchecker-provider-result/1` JSON to `PERFCHECKER_OUTPUT`, using the
explicit `--quality=<slug>` argument. It runs in the game project; PerfChecker runs
in the folder's configured controller project. The controller must already contain
PerfChecker.jl 1.0.1 or later. No package installation or suite factory runs automatically.

The provider's `suite` is `etendu-beautiful-landscape-live`. Its `environment`
contains `quality_profile`, effective `width` and `height`, `resolution_source`,
`hardware.cpu_name` and `hardware.gpu_name` (use `unavailable` if unknown),
`gpu_timing="unavailable"`, `physical_presentation="unavailable"`,
`scene_sha256`, `scene_file_changed_during_run=false`, and a `timing_boundary` naming
`SDL_SubmitGPUCommandBuffer`. It supplies UTC `started_at` and `finished_at` ending
in `Z`, and numeric millisecond observations in both `landscape.cpu.*` and
`landscape.submit_interval.*` families. GPU duration and physical display FPS are
not observations without corresponding instruments.

PerfChecker archives a verified `perfchecker-run-bundle/1` at
`perf/results/live/run-<uuid>/` and opens its manifest. This evidence is separate
from the CPU suite's `suite-result.json` and VS Code's Testing results. A failed,
cancelled, stale, or incomplete provider does not produce a completed live bundle.

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
configurations remain visible. Cancel waits for the investigation controller to
exit after cleanup, with the same one-minute forced-stop fallback. Closing its
panel requests cancellation too. Cancelling a local MCP request does not guarantee
that a remote agent stops.

The existing suite editor, result viewer and bundle commands remain available.
Projects such as Étendu3D keep their own pinned controller and workspace settings;
this extension does not migrate or replace their environments. Test it with a
separate extension development profile before choosing a deployment.

### Extension host integration test (opt-in)

Prepare a controller containing PerfChecker.jl 1.0.1 or later, SharedScenarioDemo,
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

### Chat, implementation and recovery qualification

`npm test` includes the chat model and Git checkpoint tests, including dirty/staged
state, ignored-but-staged files, binary/non-UTF8 byte preservation, drift, nested
folder boundaries, split indexes, linked worktrees and diff limits. Browser tests
are opt-in and use an existing Playwright/Chromium installation:

```sh
PERFCHECKER_PLAYWRIGHT_MODULE=/existing/playwright \
PERFCHECKER_BROWSER=/existing/chromium node test/advisor-chat.browser.cjs
```

The Linux native-host fixtures deliberately require a **new sacrificial** Git
workspace named `/tmp/perfchecker-chat-host-*`, with an initial HEAD,
`.perfchecker-test-fixture` containing `sacrificial` and a final newline,
`source.jl` containing saved text, and `untracked.txt` containing
`original untracked` and a final newline. Add an ignored file containing
`PRIVATE_NOT_ATTACHED` and stage a version of `source.jl` before changing its
on-disk content. In `.vscode/settings.json`, set absolute `juliaExecutable`,
`runnerProject` and `scenarioProject` paths. The prepared controller must contain
PerfChecker.jl 1.0.1 or later and HTTP; no package installation occurs in
these tests. Use new profile/extensions directories and keep their paths for the
second process. Workspace-trust disabling below belongs only to these fixtures.

```sh
PERFCHECKER_HOST_RESULT=/tmp/chat-host-result.json code \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/advisor-chat-host.cjs" \
  --user-data-dir=/tmp/chat-test-profile --extensions-dir=/tmp/chat-test-extensions \
  --disable-extensions --disable-workspace-trust /tmp/perfchecker-chat-host-FIXTURE

# After the first test succeeds, reuse that exact profile, extensions and workspace.
PERFCHECKER_HOST_RESULT=/tmp/chat-recovery-result.json code \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test/advisor-chat-recovery-host.cjs" \
  --user-data-dir=/tmp/chat-test-profile --extensions-dir=/tmp/chat-test-extensions \
  --disable-extensions --disable-workspace-trust /tmp/perfchecker-chat-host-FIXTURE
```

The first test starts a local MCP mock and exercises actual VS Code/Julia
conversation, privacy, tool errors, cancellation, isolated edits, reviewed apply
and restore. The second reconstructs the proposal in a fresh extension host and
applies/restores it without the MCP server or stored conversation.

`test/agent-mcp-host.cjs` instead requires a real responding agent. Create a fresh
`/tmp/perfchecker-agent-host-*` Git fixture with the same marker/settings, and
`source.jl` defining `score(xs) = sum([x * x for x in xs])`. Supply a new private
`PERFCHECKER_AGENT_BRIDGE_DIR=/tmp/perfchecker-agent-bridge-*`, the output variable
`PERFCHECKER_HOST_RESULT`, and launch it with `--extensionTestsPath` as above using
its own profile. The bridge writes `ready.json` and then `request-N.json`; a
separately operated agent reads each request and writes `response-N.json` containing
`{"text":"its actual reply"}`. For the implementation request, that agent edits
only the supplied checkout and runs its chosen validation. The host waits up to
600 seconds, then verifies unchanged advice-mode source, reviewed application,
the Julia result, warm allocation reduction and restoration. The extension does
not automatically connect an agent. The optional local Codex connector below
offers an explicitly selected alternative to that manual bridge.

Inspect the result JSON, then remove the sacrificial workspace, profile,
extensions, bridge and result files. Do not run these destructive fixture checks
against an existing project or your normal editor profile.

## Build locally

```powershell
npm ci
npm test
npm run package -- --out perfchecker-vscode.vsix
```

`npm test` compiles TypeScript and runs the model/contract tests. The generated
`dist` directory and VSIX archives are intentionally not committed.

## Marketplace publication

Publish the stable extension only after PerfChecker.jl 1.0.1 is available in
Julia's General registry. Build and test the exact VSIX before publishing it.

The immutable Marketplace identity is
`mirage-interactive-fr.perfchecker-vscode`. Repository extraction therefore does
not change extension settings, commands, or installations.

For a manual stable release:

```powershell
npx vsce login mirage-interactive-fr
npx vsce publish --packagePath .\perfchecker-vscode-1.0.0.vsix
```

Publishing requires a free Microsoft identity and Marketplace publisher, not a
paid Azure subscription. Never commit a publication token. The future release
workflow can use Marketplace identity-based publishing after its identity and
publisher permissions have been configured.

## License

MIT. See [LICENSE](LICENSE).

## Optional MCP advice

Open **PerfChecker: Configure advisor and manage models** for the guided panel.
Discover and configure an MCP HTTP advice tool in text mode, then open
**PerfChecker: Chat with performance advisor**. Nothing is generated on opening.
Source files are not attached automatically; typed messages and explicitly selected
bounded evidence are sent when requested. Replies remain unverified advice.

Implementation requires a separate explicit tool configuration in the chat's
**Implementation** tab. The supplied checkout is not an operating-system sandbox:
use a trusted agent that respects the path and can access the local filesystem.
Preparation creates a checkpoint; application requires a separate reviewed action.
The extension uses the controller's public `chat` and `implement` commands, which
are supplied by PerfChecker.jl 1.0.1 or later; an older controller fails
visibly instead of providing an implementation fallback. The extension does not
install an agent backend. Its explicit **Connect Codex CLI** action starts an
authenticated installed CLI on demand through a temporary local MCP endpoint;
generic external MCP agents remain supported.

See the canonical [MCP guide](https://perfchecker.mirageinteractive.fr/mcp-advisor.html)
for provider configuration, credentials, supported revisions, transmission,
cancellation and recovery. Stdio and OAuth login are not supported by this adapter.

### Connect an installed Codex CLI

Authenticate your CLI using `codex login` in your own terminal. Set
`perfchecker.codexExecutable` if `codex` is not on VS Code's PATH, open Chat, then
choose **Connect Codex CLI**. Version, supported flags and login status are checked
without starting a model turn. This requires `--no-daemon`, `--ignore-user-config`
and `--ignore-rules`, in addition to the standard `exec` sandbox/ephemeral/output
flags; Codex CLI 0.159.2 was qualified. Unsupported executables fail explicitly.
Windows requires the native `.exe`; npm `.cmd`/`.bat` launchers are unsupported.

The connector uses the existing account and default CLI model. Custom user
profiles, model/provider configuration, MCP servers, hooks and rules are not
inherited. Workspaces or implementation copies containing project `.codex`
configuration are refused. CLI sandbox support depends on the installation and
platform; a copied checkout does not itself provide an operating-system sandbox.
The agent can inspect files under its working directory; your configured model
provider processes the requested context and ordinary CLI usage charges apply.

Advice uses `read-only`; implementation uses `workspace-write` only in a canonical
temporary PerfChecker checkout. Both run without the shared Codex daemon.
The loopback endpoint and its automatic authentication token live only for this
editor session. **Disconnect Codex** restores your previous provider settings;
reconnect after reloading the editor. Git proposals and checkpoints remain
recoverable without the agent connection. Never save the temporary endpoint.

After compiling, reproduce the opt-in named-agent qualification in a sacrificial
Node/Git workspace with your already authenticated CLI:

```sh
PERFCHECKER_TEST_CODEX=/path/to/codex node --test test/codex-real.test.mjs
```

This sends real model requests and verifies advice, isolated editing, Node
semantics, diff, apply, byte-identical restoration and cancellation after a turn
starts. It removes its temporary files. The default tests use a sacrificial CLI
to verify errors, limits, process-tree termination and authentication separately.

The complete opt-in editor/controller qualification uses a prepared controller:

```sh
PERFCHECKER_TEST_CODEX=/path/to/codex \
PERFCHECKER_TEST_CONTROLLER=/path/to/prepared/controller \
PERFCHECKER_TEST_JULIA=/path/to/julia \
PERFCHECKER_VSCODE_EXECUTABLE=/path/to/code node test/run-codex-host.mjs
```

It opens an isolated editor profile and sacrificial Git workspace, checks the real
Julia MCP conversation and reviewed changes, then confirms that disconnect restores
an existing saved provider. It uses the account's model quota and removes its fixtures.
