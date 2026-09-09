import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.join(root, '.cache/mintlify');
const version = '4.2.876';
const args = process.argv.slice(2);
const command = args[0] === 'validate' || args[0] === 'broken-links' ? args.shift() : 'dev';

function run(binary, argv, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { cwd, env, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (signal || code !== 0) reject(new Error(`${binary} ${argv[0]} exited with ${signal ?? code}`));
      else resolve();
    });
  });
}

await run('pnpm', ['docs:generate']);
await mkdir(runtime, { recursive: true });
const packageFile = path.join(runtime, 'package.json');
await writeFile(packageFile, JSON.stringify({
  name: 'egma-mintlify-runtime', private: true,
  dependencies: { mint: version },
  overrides: { '@mintlify/prebuild': '1.0.1286' },
}, null, 2) + '\n');
const require = createRequire(packageFile);
let installed;
try { installed = JSON.parse(await readFile(require.resolve('mint/package.json'), 'utf8')).version; }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ENOENT') throw error; }
if (installed !== version) {
  await run('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund'], root, { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' });
}

// Mint's local validator dereferences its input in place, then tries to JSON
// serialize that same object. Recursive trace spans turn it into a cycle.
// Validate a clone, retaining the original complete OpenAPI reference graph.
// This is a local CLI repair, not an alteration of the published contract.
const prebuild = path.dirname(require.resolve('@mintlify/prebuild/package.json'));
const packageVersion = JSON.parse(await readFile(path.join(prebuild, 'package.json'), 'utf8')).version;
if (packageVersion !== '1.0.1286') throw new Error('Review the Mintlify recursive-schema repair before updating the CLI.');
const original = 'const { schema: openApiDocument } = await validate(overlaid);';
const patched = 'const { schema: openApiDocument } = await validate(structuredClone(overlaid));';
for (const file of ['getOpenApiFiles.js', 'categorizeFilePaths.js']) {
  const target = path.join(prebuild, 'dist/prebuild', file);
  const content = await readFile(target, 'utf8');
  const oldCount = content.split(original).length - 1;
  const newCount = content.split(patched).length - 1;
  if (oldCount + newCount !== 1 || !content.includes('spec: overlaid,')) throw new Error(`Mintlify changed ${file}; review the local repair.`);
  if (oldCount) await writeFile(target, content.replace(original, patched));
}
await run(path.join(runtime, 'node_modules/.bin/mint'), [command, ...args], path.join(root, 'docs'));
