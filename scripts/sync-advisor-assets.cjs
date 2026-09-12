// Keep the optional advisor panel identical to PerfChecker's web studio.
const fs = require('node:fs');
const path = require('node:path');
if (!process.argv[2]) throw new Error('Usage: node scripts/sync-advisor-assets.cjs /path/to/PerfChecker');
for (const name of ['advisor-panel.js','advisor-panel.css']) {
  const source=path.resolve(process.argv[2],'packages/PerfCheckerWeb/src/assets',name);
  const destination=path.resolve(__dirname,'../media',name);
  fs.copyFileSync(source,destination);
  console.log(`Updated ${name}`);
}
