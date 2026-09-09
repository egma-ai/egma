import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = path.join(root, '.cache/mintlify');
const version = '4.2.882';
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
}, null, 2) + '\n');
const require = createRequire(packageFile);
let installed;
try { installed = JSON.parse(await readFile(require.resolve('mint/package.json'), 'utf8')).version; }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ENOENT') throw error; }
if (installed !== version) {
  await run('npm', ['install', '--prefix', runtime, '--no-audit', '--no-fund'], root, { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' });
}

await run(path.join(runtime, 'node_modules/.bin/mint'), [command, ...args], path.join(root, 'docs'));
