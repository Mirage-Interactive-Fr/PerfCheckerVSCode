# Changelog

## 1.0.0 — PerfChecker Studio

- Full editor-tab Studio with the canonical documentation logo, a monochrome
  activity-bar mark and consistent branding across the workbench.
- Search, target and target-kind filters; full selection preview and explicit
  counts for selected runs outside the filters. Selection survives plan refreshes.
- Bounded workload rendering for large suites, with complete bulk selection and
  explicit expansion. Branches, tags, commits and grouped comparison targets
  remain available in the visual suite editor.
- Dedicated Julia terminals, native untitled investigation notebooks and Julia
  debugging with folder-scoped controller and scenario environments.
- Conversation with a configured MCP advisor, followed by an explicitly approved
  implementation tool, isolated Git checkpoint, diff review and guarded restore.
- Folder-scoped settings and explicit `openStudioForWorkspace` entry point for
  companion extensions, alongside the existing Étendu live-measurement bridge.
- CSP-compatible allocation colors and normalized plots; one-source allocation
  charts render the full circle, and unavailable normalized ratios retain gaps.
- Expanded unit, browser and real VS Code host qualification.
- Exact Git recovery preserves LF, CRLF, mixed endings and non-UTF8 bytes under
  Git text conversion settings; streamed Julia output preserves Unicode.

Requires PerfChecker.jl 1.0.0 or later. Usage and configuration guides are part of
the stable PerfChecker.jl documentation.

## 0.1.0

- Central package/feature/check/version explorer and native Test Explorer bridge.
- Per-node visual output and streamed worker logs.
- Interactive BenchmarkTools, Chairmarks, allocation and flame-graph views.
- Version-range selection, sorting, labels, check-type controls and drag-and-drop.
- Git-aware target picker for discovered branches, tags and recent commits, plus
  parsing of pasted GitHub/GitLab URLs and repository/reference shorthand.
- Branch, tag and commit targets with exact or grouped comparison policies.
- Shared `perfchecker-ui-config/1` configuration and documentation blocks.
- Mirage Interactive publisher and repository metadata.
