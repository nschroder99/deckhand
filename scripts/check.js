// Pre-deploy: syntax-check every script, write precache.json, and stamp sw.js with a new VERSION.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const skip = new Set(['node_modules', '.git', 'scripts', 'supabase', '.claude']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(root, p));
  }
})(root);

let bad = 0;
for (const f of files.filter(f => /\.m?js$/.test(f) && !f.startsWith('lib/vendor/'))) {
  try { execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error(`✗ ${f}\n${e.stderr}`); }
}
if (bad) process.exit(1);

const shell = files.filter(f => !/^(precache\.json|README\.md|package\.json|icon\.svg|LICENSE)$/.test(f) && !/\.LICENSE$/.test(f));
writeFileSync(join(root, 'precache.json'), JSON.stringify({ files: ['./', ...shell] }, null, 1) + '\n');
const sw = join(root, 'sw.js');
const version = new Date().toISOString();
writeFileSync(sw, readFileSync(sw, 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`));
console.log(`✓ ${files.length} files, ${shell.length} precached, sw VERSION ${version}`);
