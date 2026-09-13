'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const stagingBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-radar-macos-build.'));
const outputRoot = path.join(stagingBase, 'Codex-Radar-macOS-Apple-Silicon');
const app = path.join(outputRoot, 'Codex Radar.app');
const contents = path.join(app, 'Contents');
const executable = path.join(contents, 'MacOS', 'CodexRadar');
const resources = path.join(contents, 'Resources');
const seaBlob = path.join(root, 'build', 'codex-radar-sea.blob');
const postject = path.join(root, 'node_modules', '.bin', 'postject');
const distDir = path.join(root, 'dist');
const zipPath = path.join(distDir, 'Codex-Radar-macOS-Apple-Silicon.zip');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: 'inherit',
  });
  if (!result || result.status !== 0) {
    throw new Error(`Build command failed (${result ? result.status : 'no status'}): ${command}`);
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('This build produces the Apple Silicon app and must run on an arm64 Mac');
}
if (!fs.existsSync(postject)) throw new Error(`Missing postject: ${postject}`);

fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.mkdirSync(path.join(resources, 'public'), { recursive: true });
fs.mkdirSync(path.join(outputRoot), { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

run(process.execPath, ['--experimental-sea-config', path.join(root, 'sea-config.json')]);
fs.copyFileSync(process.execPath, executable);
fs.chmodSync(executable, 0o755);
run(postject, [
  executable,
  'NODE_SEA_BLOB',
  seaBlob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA',
]);

for (const name of ['index.html', 'app.js', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'public', name), path.join(resources, 'public', name));
}
fs.copyFileSync(path.join(root, 'macos', 'Info.plist'), path.join(contents, 'Info.plist'));
fs.copyFileSync(path.join(root, 'MACOS-README.txt'), path.join(outputRoot, 'README-macOS.txt'));
for (const name of ['Install 24小时常驻.command', 'Uninstall 24小时常驻.command']) {
  const target = path.join(outputRoot, name);
  fs.copyFileSync(path.join(root, 'macos', name), target);
  fs.chmodSync(target, 0o755);
}
const stopCommand = path.join(outputRoot, 'Stop Codex Radar.command');
fs.copyFileSync(path.join(root, 'macos', 'Stop Codex Radar.command'), stopCommand);
fs.chmodSync(stopCommand, 0o755);

run('/usr/bin/xattr', ['-cr', app]);
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS.txt'), `${digest}  Codex Radar.app/Contents/MacOS/CodexRadar\n`, 'utf8');
fs.rmSync(zipPath, { force: true });
run('/usr/bin/zip', ['-r', '-X', zipPath, path.basename(outputRoot)], {
  cwd: stagingBase,
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
const zipDigest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${zipDigest}  ${path.basename(zipPath)}\n`, 'utf8');
fs.rmSync(stagingBase, { recursive: true, force: true });
console.log(`macOS package created: ${zipPath}`);
console.log(`SHA-256: ${zipDigest}`);
