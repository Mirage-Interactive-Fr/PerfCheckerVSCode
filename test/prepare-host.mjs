// Opt-in integration fixture; only writes into a new directory supplied by the caller.
import fs from 'node:fs/promises';
import path from 'node:path';

const [example, controller, destination] = process.argv.slice(2).map(p => path.resolve(p));
if (!example || !controller || !destination) throw new Error('Usage: node test/prepare-host.mjs EXAMPLE CONTROLLER NEW_WORKSPACE');
await fs.mkdir(destination); // Never overwrite an existing workspace.
await fs.cp(example, destination, {recursive: true});
await fs.mkdir(path.join(destination, '.vscode'), {recursive: true});
await fs.writeFile(path.join(destination, '.vscode', 'settings.json'), JSON.stringify({
  'perfchecker.runnerProject': controller, 'perfchecker.scenarioProject': controller,
  'perfchecker.scenarioCatalog': 'scenarios.toml', 'perfchecker.scenarioSamples': 3,
  'perfchecker.scenarioThreads': 1, 'perfchecker.analysisTimeout': 300,
  'perfchecker.analysisTools': ['jet']
}, null, 2));
await fs.writeFile(path.join(destination, 'ui-cases.jl'),
  'dynamic_ui(p) = (prepare=()->Any[identity, 42], operation=x->x[1](x[2]), verify=(x,r)->r==42)\n' +
  'slow_ui(p) = (prepare=()->42, operation=x->(sleep(60);x), verify=(x,r)->x==r)\n');
await fs.appendFile(path.join(destination, 'scenarios.toml'), `
[[scenarios]]
id = "dynamic-ui"
source = "ui-cases.jl"
factory = "dynamic_ui"
collectors = ["benchmark"]

[[scenarios]]
id = "slow-ui"
source = "ui-cases.jl"
factory = "slow_ui"
collectors = ["benchmark"]
`);
