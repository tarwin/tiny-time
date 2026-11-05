#!/usr/bin/env node
// Lists a published release in Shelf, the tinyjs app store:
//
//   node scripts/shelf.mjs [v<version>] [--no-push]    # default: tinyjs.json's version
//
// Shelf reads its list from catalog.json in the tinyjsapp-examples repo
// (EXAMPLES, default ../tinyjsapp-examples; the icon comes from the
// microsite, MICROSITE as for publish-docs.sh), and only downloads from that
// repo's own releases. So this copies the release's dmgs, Windows zip and
// Linux tarballs to a tiny-time-v<version> release there (with the same
// notes, which Shelf shows), writes Tiny Time's entry into the catalog and
// Shelf's bundled copy of it, then commits and pushes. The entry is marked
// "external": the catalog's own generator keeps it as it is. Platforms
// without a file on the release (0.1.x is macOS only) are left out.
// Adapted from tiny-tally.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const config = JSON.parse(readFileSync(new URL('../tinyjs.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const push = !args.includes('--no-push');
const tag = args.find((a) => a.startsWith('v')) ?? `v${config.version}`;
const version = tag.replace(/^v/, '');
const examples = resolve(process.env.EXAMPLES ?? new URL('../../tinyjsapp-examples', import.meta.url).pathname);
const microsite = resolve(process.env.MICROSITE ?? new URL('../../tarwin-apps-microsites', import.meta.url).pathname);
const EXAMPLES_REPO = 'tarwin/tinyjsapp-examples';
const shelfTag = `${config.name}-v${version}`;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (...a) => run('git', ['-C', examples, ...a]);

if (git('status', '--porcelain').trim()) {
  console.error(`${examples} has uncommitted changes; commit or stash them first.`);
  process.exit(1);
}
// Shelf reads the catalog from main, and pulling here would rebase any other branch.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
if (branch !== 'main') {
  console.error(`${examples} is on ${branch}; switch it to main first.`);
  process.exit(1);
}
git('pull', '--quiet', '--rebase', 'origin', 'main');

const release = JSON.parse(run('gh', ['release', 'view', tag, '--json', 'body,isDraft']));
if (release.isDraft) {
  console.error(`${tag} is still a draft; publish it first.`);
  process.exit(1);
}
const assets = new Set(JSON.parse(run('gh', ['release', 'view', tag, '--json', 'assets'])).assets.map((a) => a.name));
const files = Object.fromEntries(Object.entries({
  macArm: `${config.name}-${version}-macos-arm64.dmg`,
  macIntel: `${config.name}-${version}-macos-x86_64.dmg`,
  win: `${config.name}-${version}-win.zip`,
  linuxX64: `${config.name}-${version}-linux-x86_64.tar.gz`,
  linuxArm: `${config.name}-${version}-linux-arm64.tar.gz`,
}).filter(([, f]) => assets.has(f)));
if (!files.macArm || !files.macIntel) {
  console.error(`${tag} needs both macOS dmgs; it has: ${[...assets].join(', ')}`);
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'tiny-time-shelf-'));
for (const f of Object.values(files)) run('gh', ['release', 'download', tag, '--pattern', f, '--dir', dir]);

// The copy Shelf downloads from.
const notesFile = join(dir, 'notes.md');
writeFileSync(notesFile, release.body ?? '');
try {
  run('gh', ['release', 'view', shelfTag, '-R', EXAMPLES_REPO], { stdio: 'ignore' });
  run('gh', ['release', 'edit', shelfTag, '-R', EXAMPLES_REPO, '--notes-file', notesFile]);
} catch {
  run('gh', ['release', 'create', shelfTag, '-R', EXAMPLES_REPO, '--title', `${config.title} ${version}`, '--notes-file', notesFile]);
}
run('gh', ['release', 'upload', shelfTag, '-R', EXAMPLES_REPO, '--clobber', ...Object.values(files).map((f) => join(dir, f))]);
console.log(`uploaded to ${EXAMPLES_REPO} ${shelfTag}`);

const download = (file, name) => {
  const bytes = readFileSync(join(dir, file));
  return {
    [name]: file,
    url: `https://github.com/${EXAMPLES_REPO}/releases/download/${shelfTag}/${file}`,
    bytes: bytes.length,
    size: (bytes.length / 1048576).toFixed(1) + ' MB',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
const RAW = `https://raw.githubusercontent.com/${EXAMPLES_REPO}/main`;
const macArm = { version, ...download(files.macArm, 'dmg') };

// Shaped like the fleet's entries (shelf/gen-catalog.js): the top level is
// the Apple Silicon dmg, for Shelf before 0.2.9.
const linux = {};
if (files.linuxArm) linux.arm64 = download(files.linuxArm, 'tarball');
if (files.linuxX64) linux.x86_64 = download(files.linuxX64, 'tarball');
const entry = {
  dir: config.name,
  title: config.title,
  id: config.id,
  version,
  app: `${config.title}.app`,
  category: 'useful',
  tagline: 'A time tracker that lives in your menu bar, local only',
  desc:
    'Start and stop a timer from the **menu bar**, or drop down a small popover to see your day and log time, and tear it off into ' +
    'its own window when you want it to stay. Track time against **clients, projects and tasks** with hourly rates, then open the ' +
    'dashboard for a weekly timesheet, **reports with charts**, a billing summary that applies each client\'s currency, discount, ' +
    'tax and payment terms, and CSV export. Idle detection, global shortcuts, light and dark, and any accent color. ' +
    'With no window open there\'s no web view running at all, so it uses about **26 MB**. Everything stays in one SQLite file ' +
    'on your Mac, with no account and nothing in the cloud.',
  ...macArm,
  screenshot: 'https://apps.tarwin.art/tiny-time/shots/popover.webp',
  icon: `${RAW}/shelf/src/frontend/icons/${config.name}.png`,
  readme: 'https://apps.tarwin.art/tiny-time/',
  mac: { arm64: macArm, x86_64: { version, ...download(files.macIntel, 'dmg') } },
  platforms: ['macos', files.win && 'windows', (files.linuxArm || files.linuxX64) && 'linux'].filter(Boolean).sort(),
  ...(files.win ? { win: { version, ...download(files.win, 'zip'), folder: config.name, exe: `${config.name}.exe` } } : {}),
  ...(Object.keys(linux).length ? { linux: { version, folder: config.name, bin: config.name, ...linux } } : {}),
  external: true,
};
// Every url in the entry must answer before Shelf sees it.
const urls = [entry.screenshot, entry.readme, entry.mac.arm64.url, entry.mac.x86_64.url, entry.win?.url,
  entry.linux?.arm64?.url, entry.linux?.x86_64?.url].filter(Boolean);
let bad = 0;
for (const url of urls) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  console.log(`${res.ok ? 'ok ' : 'BAD'} ${res.status} ${url}`);
  if (!res.ok) bad++;
}
if (bad) process.exit(1);

// Shelf bundles 128px icons; the live catalog points at the same file.
run('sips', ['-z', '128', '128', join(microsite, `shared/icons/${config.name}.png`), '--out', join(examples, `shelf/src/frontend/icons/${config.name}.png`)]);

const catalogPath = join(examples, 'catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const at = catalog.apps.findIndex((a) => a.dir === entry.dir);
if (at >= 0) catalog.apps[at] = entry;
else catalog.apps.push(entry);
catalog.generated = new Date().toISOString().slice(0, 10);
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
writeFileSync(
  join(examples, 'shelf/src/frontend/catalog.js'),
  '// bundled fallback — regenerate with scripts in repo (gen-catalog)\n' + 'window.CATALOG = ' + JSON.stringify(catalog, null, 2) + ';\n',
);

git('add', 'catalog.json', 'shelf/src/frontend/catalog.js', `shelf/src/frontend/icons/${config.name}.png`);
git('commit', '--quiet', '-m', `catalog: ${config.name} ${version} (from tarwin/${config.name})`);
if (push) {
  git('push', '--quiet', 'origin', 'main');
  git('fetch', '--quiet', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
    console.error(`Pushed, but origin/main doesn't have this commit. Shelf still lists the old version.`);
    process.exit(1);
  }
  console.log(`Shelf lists ${config.title} ${version}.`);
} else console.log(`Committed to ${examples}; not pushed (--no-push).`);
