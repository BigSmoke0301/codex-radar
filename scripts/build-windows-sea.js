'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const nodeExe = path.join(root, 'vendor', 'windows', 'node.exe');
const outputDir = path.join(root, 'dist', 'Codex-Radar-Windows');
const outputExe = path.join(outputDir, 'CodexRadar.exe');
const seaBlob = path.join(root, 'build', 'codex-radar-sea.blob');
const postject = path.join(root, 'node_modules', '.bin', 'postject');

for (const required of [nodeExe, postject]) {
  if (!fs.existsSync(required)) throw new Error(`Missing Windows build dependency: ${required}`);
}
fs.mkdirSync(path.dirname(seaBlob), { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (!result || result.status !== 0) {
    throw new Error(`Build command failed (${result ? result.status : 'no status'}): ${command}`);
  }
}

run(process.execPath, ['--experimental-sea-config', path.join(root, 'sea-config.json')]);
fs.copyFileSync(nodeExe, outputExe);
run(postject, [
  outputExe,
  'NODE_SEA_BLOB',
  seaBlob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);
run(process.execPath, [path.join(root, 'scripts', 'prepare-windows-package.js')]);

console.log(`Windows SEA executable created: ${outputExe}`);
