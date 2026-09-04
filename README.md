# PerfChecker for VS Code

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
npm run package:pre-release -- --out perfchecker-vscode-0.9.0.vsix
code --install-extension .\perfchecker-vscode-0.9.0.vsix --force
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
npx vsce publish --packagePath .\perfchecker-vscode-0.9.0.vsix --pre-release
```

Publishing requires a free Microsoft identity and Marketplace publisher, not a
paid Azure subscription. Never commit a publication token. The future release
workflow can use Marketplace trusted publishing after the dedicated GitHub
repository exists.

## License

MIT. See [LICENSE](LICENSE).
