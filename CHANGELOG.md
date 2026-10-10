# Changelog

## 1.0.1 — Pluto notebooks and first-use fixes

- MCP connection settings now lead with generic HTTP and local stdio servers.
  Local servers use an explicit executable, argument array, working directory and
  protocol revision; discovered tool schemas guide independent advice and
  implementation selections. Session-only bridges preserve saved providers and
  stop their owned server on cancellation or disconnect. Codex CLI remains an
  optional connector. MCP tools alone do not imply an LLM or filesystem-editing
  capability; interactive OAuth, roots, sampling, tasks and input requests are
  not supported by the local adapter.
- Reloading the suite editor restores its saved selection, order and group colours,
  and reflects an action already in progress without starting another worker.
- Version sorting and target selectors use a consistent order: numeric versions
  (including prereleases and `dev@`), then opaque Git labels, then bare `dev`.
  Anchored numeric parsing preserves Git hashes as labels; a release precedes
  `dev@` at an equal version.
- Explicit Studio setup for a controller and starter suite, including existing
  package environments that do not contain PerfChecker. No package installation
  happens without a user choice; target test dependencies remain explicit.
- Studio refreshes its displayed controller after setup or folder-scoped
  configuration changes, without publishing another workspace's state.
- Require PerfCheckerPluto 1.0.1 for isolated interactive plot documents; the
  separate Pluto environment installer uses its explicit v1.0.1 source tag.
  Existing environments require an explicit upgrade choice.
- Reactive Pluto `.jl` notebooks in editor tabs replace the Jupyter notebook
  path. Feature-suite and investigation dashboards use the official companion,
  a separate Julia environment and explicit measurement controls.
- Managed Pluto sessions preserve authenticated iframe URLs and remote port
  forwarding. Stop, Restart, view closure and Pluto's own shutdown/restart
  controls cancel owned jobs before closing their notebook workers.
- Pluto's Recent shutdown confirmation works inside the editor sandbox.
  Julia/HTML exports and new-context link gestures use the default browser;
  normal notebook navigation stays in the editor with authentication preserved.
- The Save configuration palette command now saves the visual editor's current
  unsaved state, with acknowledgement after writing and guards against stale
  replies. The native Test Explorer entry point uses its official container ID.
- Failed test-item runs expose their dependency and controller diagnostic in
  Testing output as well as the item message. Cancelling controller verification
  ends the setup action without reopening the installation wizard.
- Julia debugging passes the official `project` launch parameter so the saved
  source executes in the selected controller rather than the active workspace.
- Codex cancellation also reclaims descendants after the CLI leader exits. On
  Windows, a private process Job owns descendants before the CLI starts and
  stops them when the extension host or connector disappears.
- MCP chat cancellation and editor closure wait for the controller to stop its
  detached HTTP advisor worker; extension shutdown uses the same cleanup path.
- Controller setup, notebook generation and scenario adoption check workspace
  trust, folder and settings identity before writing. Owned processes also
  request cooperative cleanup when their extension-host pipe closes.
- Native qualification covers fresh installation and backend effects using
  isolated VS Code profiles on Linux, Windows and Intel macOS. Its reports
  distinguish executed features, unavailable prerequisites and remaining gates.

Requires registered PerfChecker.jl 1.0.1 or later. Existing older controller and
Pluto environments show an explicit upgrade action. The extension does not
silently replace a project's benchmark engine or download a model.

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
- Suite and Testing cancellation waits for allocation cleanup, preserves real
  cleanup errors and uses a visible bounded fallback for an unresponsive controller.

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
