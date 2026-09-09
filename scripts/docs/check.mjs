import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = fileURLToPath(new URL('../../docs/', import.meta.url));
const config = JSON.parse(await readFile(path.join(docs, 'docs.json'), 'utf8'));
const pages = [];
function visit(value) {
  if (typeof value === 'string') pages.push(value);
  else if (Array.isArray(value)) value.forEach(visit);
  else if (value && typeof value === 'object') {
    for (const key of ['tabs', 'groups', 'pages']) if (value[key]) visit(value[key]);
  }
}
visit(config.navigation);
assert.equal(new Set(pages).size, pages.length, 'Each page must appear once in navigation.');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name.endsWith('.mdx')) files.push(file);
  }
}
await walk(docs);
const actual = files.map((file) => path.relative(docs, file).replace(/\.mdx$/, '')).sort();
assert.deepEqual([...pages].sort(), actual, 'Navigation must contain every MDX page and no missing page.');

const redirects = new Map(config.redirects.map(({ source, destination }) => [source, destination]));
assert.equal(redirects.size, config.redirects.length, 'Redirect sources must be unique.');
async function checkLink(link, from) {
  if (!link.startsWith('/') || link.startsWith('//')) return;
  const route = decodeURI(link.split(/[?#]/)[0]);
  const relative = route.replace(/^\//, '').replace(/\/$/, '');
  if (pages.includes(relative)) return;
  const asset = path.resolve(docs, relative);
  if (asset.startsWith(docs) && (await stat(asset).catch(() => null))?.isFile()) return;
  if (redirects.has(route) && from !== 'redirect') return;
  throw new Error(`Broken internal link in ${from}: ${link}`);
}
for (const [source, destination] of redirects) {
  assert(!pages.includes(source.slice(1)), `Redirect shadows a page: ${source}`);
  await checkLink(destination, 'redirect');
}
for (const file of files) {
  const content = await readFile(file, 'utf8');
  assert(/^---\n[\s\S]+?\n---(?:\n|$)/.test(content), `Missing frontmatter: ${file}`);
  const prose = content.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  const links = [...prose.matchAll(/(?:href|src)="([^"{}]+)"|\]\(([^\s)]+)(?:\s+[^)]+)?\)/g)];
  for (const match of links) await checkLink(match[1] ?? match[2], path.relative(docs, file));
}
console.log(`Checked ${pages.length} pages, internal links, and ${redirects.size} redirects.`);
