#!/usr/bin/env node
// Writes the auto-update manifest for a GitHub release and uploads it:
//
//   node scripts/release-manifest.mjs [v<version>]    # default: tinyjs.json's version
//
// Run it once the release is published (RELEASING.md): a draft's files aren't
// public yet, so the url checks would fail. It downloads the update archives
// (the macOS zips, not the dmgs), hashes them, writes one manifest covering
// every platform the release HAS (0.1.x is macOS only), uploads it as
// manifest.json and checks each url answers. Apps read it through
// releases/latest/download/manifest.json (tinyjs.json "update.url").
// Adapted from tiny-tally.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(new URL('../tinyjs.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? `v${config.version}`;
const version = tag.replace(/^v/, '');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' });

const release = JSON.parse(gh('release', 'view', tag, '--json', 'assets,body,url'));
const repo = release.url.match(/github\.com\/([^/]+\/[^/]+)\//)[1];
const names = new Set(release.assets.map((a) => a.name));
const files = Object.fromEntries(Object.entries({
  macArm: `${config.name}-${version}-macos-arm64.zip`,
  macIntel: `${config.name}-${version}-macos-x86_64.zip`,
  win: `${config.name}-${version}-win.zip`,
  linuxX64: `${config.name}-${version}-linux-x86_64.tar.gz`,
  linuxArm: `${config.name}-${version}-linux-arm64.tar.gz`,
}).filter(([, f]) => names.has(f)));
if (!files.macArm || !files.macIntel) {
  console.error(`${tag} needs both macOS zips (arm64 and x86_64); it has: ${[...names].join(', ') || 'nothing'}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'tiny-time-manifest-'));
for (const f of Object.values(files)) gh('release', 'download', tag, '--pattern', f, '--dir', dir);
const entry = (file) => ({
  url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
  sha256: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'),
});

// The update banner shows notes as plain text: drop markdown headings and bold.
const notes = (release.body ?? '').split('\n').filter((l) => !/^#+\s/.test(l)).join('\n')
  .replace(/\*\*(.+?)\*\*/g, '$1').trim() || null;

// The top level is what Macs from before the mac block read: the arm64 build.
const manifest = {
  version,
  notes,
  ...entry(files.macArm),
  mac: { arm64: entry(files.macArm), x86_64: entry(files.macIntel) },
  ...(files.win ? { win: { ...entry(files.win), x86_64: entry(files.win) } } : {}),
  ...(files.linuxX64 || files.linuxArm ? { linux: {
    ...(files.linuxX64 ? { x86_64: entry(files.linuxX64) } : {}),
    ...(files.linuxArm ? { arm64: entry(files.linuxArm) } : {}),
  } } : {}),
};
const out = join(dir, 'manifest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
gh('release', 'upload', tag, out, '--clobber');
console.log(`uploaded manifest.json to ${tag}`);

// A dead url is an updater that fails quietly on someone else's machine.
const urls = [`https://github.com/${repo}/releases/download/${tag}/manifest.json`, ...Object.values(files).map((f) => entry(f).url)];
let bad = 0;
for (const url of urls) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  console.log(`${res.ok ? 'ok ' : 'BAD'} ${res.status} ${url}`);
  if (!res.ok) bad++;
}
process.exit(bad ? 1 : 0);
