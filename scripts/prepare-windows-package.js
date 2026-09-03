'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const output = path.join(root, 'dist', 'Codex-Radar-Windows');
const copies = [
  [path.join(root, 'public', 'index.html'), path.join(output, 'public', 'index.html')],
  [path.join(root, 'public', 'app.js'), path.join(output, 'public', 'app.js')],
  [path.join(root, 'public', 'styles.css'), path.join(output, 'public', 'styles.css')],
  [path.join(root, 'assets', 'alarm.wav'), path.join(output, 'assets', 'alarm.wav')],
  [path.join(root, 'vendor', 'windows', 'sqlite3.exe'), path.join(output, 'tools', 'sqlite3.exe')],
  [path.join(root, 'vendor', 'windows', 'SQLITE-NOTICE.txt'), path.join(output, 'tools', 'SQLITE-NOTICE.txt')],
  [path.join(root, 'vendor', 'windows', 'NODE-NOTICE.txt'), path.join(output, 'NODE-NOTICE.txt')],
  [path.join(root, 'WINDOWS-README.txt'), path.join(output, '使用说明.txt')],
];

fs.mkdirSync(output, { recursive: true });
for (const [source, destination] of copies) {
  if (!fs.existsSync(source)) throw new Error(`Missing build input: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const executable = path.join(output, 'CodexRadar.exe');
if (!fs.existsSync(executable)) throw new Error(`Missing packaged executable: ${executable}`);
const header = fs.readFileSync(executable).subarray(0, 2).toString('ascii');
if (header !== 'MZ') throw new Error('Packaged executable is not a Windows PE file');
const checksumFiles = [
  'CodexRadar.exe',
  path.join('assets', 'alarm.wav'),
  path.join('tools', 'sqlite3.exe'),
];
const checksums = checksumFiles.map((relative) => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(output, relative))).digest('hex');
  return `${digest}  ${relative.replace(/\\/g, '/')}`;
});
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');
console.log(`Windows package prepared at ${output}`);
