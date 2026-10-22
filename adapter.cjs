#!/usr/bin/env node
'use strict';
// Local, opt-in adapter for one inspected ZCode build. No automatic install.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const SUPPORTED = { version: '3.16.2', sha256: '1f960ba24a4a6687bb29090a9ac3273c06e9fc18b14882525f591132650a99a8' };
const MAIN = 'out/main/index.js';
const PRELOAD = 'out/preload/index.cjs';
const ANCHOR = 'process.platform==="win32"?{backgroundColor:"#00000000",frame:!1,backgroundMaterial:"acrylic"}';
const REPLACEMENT = 'process.platform==="win32"?{backgroundColor:"#00000000",transparent:!0,frame:!1,backgroundMaterial:"none"}';
const PRELOAD_ADD = '\n;(()=>{const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("zcodeWallpaper",{open:()=>ipcRenderer.send("zwn:open")});})();\n';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fail(message) { throw new Error(message); }
// Electron fuse wire v1: version byte, fuse-count byte, then ASCII states.
// Fail closed if the inspected executable changes or enables embedded ASAR integrity.
function inspectExecutable(executable) {
  const bytes = fs.readFileSync(executable), marker = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const offset = bytes.indexOf(marker), start = offset + marker.length;
  if (offset < 0 || bytes.indexOf(marker, start) >= 0 || start + 2 > bytes.length) fail('Electron fuse wire missing or ambiguous');
  const version = bytes[start], count = bytes[start + 1];
  if (version !== 1 || count < 6 || start + 2 + count > bytes.length) fail('Unsupported Electron fuse wire');
  const states = bytes.subarray(start + 2, start + 2 + count).toString('ascii');
  if (!/^[01r]+$/.test(states)) fail('Unknown Electron fuse states');
  if (states[4] !== '0') fail('Embedded ASAR integrity is enabled or unavailable; this adapter cannot safely modify the archive');
  return { path: path.resolve(executable), sha256: hash(bytes), version, states, embeddedAsarIntegrity: false };
}
function ensureStopped(executable) {
  if (process.platform !== 'win32') return;
  const script = '$ErrorActionPreference="Stop"; $target=$env:ZWN_TARGET_EXE; @(Get-CimInstance Win32_Process -Filter "Name=\'ZCode.exe\'" | Where-Object { $_.ExecutablePath -eq $target }).Count';
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,ZWN_TARGET_EXE:executable}}).trim();
  if (!/^\d+$/.test(result)) fail('Could not determine whether ZCode is stopped');
  if (Number(result)) fail('Close ZCode before applying or restoring this adapter');
}
function parseAsar(data) {
  if (data.length < 16 || data.readUInt32LE(0) !== 4) fail('Invalid ASAR size pickle');
  const headerSize = data.readUInt32LE(4), stringLength = data.readUInt32LE(12), base = 8 + headerSize;
  if (base > data.length || stringLength > headerSize - 8) fail('Invalid ASAR header bounds');
  const header = JSON.parse(data.subarray(16, 16 + stringLength).toString('utf8'));
  const files = new Map();
  function walk(node, prefix = '') {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const namePath = prefix + name;
      if (entry.files) walk(entry, namePath + '/');
      else files.set(namePath, entry);
    }
  }
  walk(header);
  function read(name) {
    const entry = files.get(name);
    if (!entry || entry.unpacked || entry.link) fail('Expected packed member: ' + name);
    const start = base + Number(entry.offset), end = start + entry.size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < base || end > data.length) fail('Invalid member bounds: ' + name);
    return data.subarray(start, end);
  }
  return { header, files, base, read };
}
function encodeHeader(header) {
  const text = Buffer.from(JSON.stringify(header));
  const payload = Math.ceil((text.length + 4) / 4) * 4;
  const headerSize = payload + 4;
  const result = Buffer.alloc(8 + headerSize);
  result.writeUInt32LE(4, 0);
  result.writeUInt32LE(headerSize, 4);
  result.writeUInt32LE(payload, 8);
  result.writeUInt32LE(text.length, 12);
  text.copy(result, 16);
  return result;
}
function updateIntegrity(entry, bytes) {
  if (!entry.integrity) return;
  if (entry.integrity.algorithm !== 'SHA256') fail('Unsupported ASAR integrity algorithm');
  const size = entry.integrity.blockSize;
  if (!Number.isSafeInteger(size) || size <= 0) fail('Invalid integrity block size');
  entry.integrity.hash = hash(bytes);
  entry.integrity.blocks = [];
  for (let i = 0; i < bytes.length; i += size) entry.integrity.blocks.push(hash(bytes.subarray(i, i + size)));
}
function patchArchive(original, bridgePath, expected = SUPPORTED) {
  if (hash(original) !== expected.sha256) fail('Unsupported archive hash. Refusing to patch a changed or updated ZCode build.');
  const archive = parseAsar(original);
  const pkg = JSON.parse(archive.read('package.json'));
  if (pkg.version !== expected.version || pkg.main !== MAIN || pkg.type !== 'module') fail('Unsupported ZCode package identity');
  let source = archive.read(MAIN).toString('utf8');
  if (source.split(ANCHOR).length !== 2) fail('Main window anchor must occur exactly once');
  if (source.includes('zcode-native-wallpaper')) fail('Archive is already adapted');
  const bridgeUrl = pathToFileURL(path.resolve(bridgePath)).href;
  source = '// zcode-native-wallpaper adapter\nimport ' + JSON.stringify(bridgeUrl) + ';\n' + source.replace(ANCHOR, REPLACEMENT);
  const changes = new Map([[MAIN, Buffer.from(source)], [PRELOAD, Buffer.concat([archive.read(PRELOAD), Buffer.from(PRELOAD_ADD)])]]);
  const entries = [...archive.files.entries()].filter(([, e]) => !e.unpacked && !e.link).sort((a, b) => Number(a[1].offset) - Number(b[1].offset));
  const payload = [], originalBase = archive.base;
  let oldEnd = 0, newOffset = 0;
  for (const [name, entry] of entries) {
    const offset = Number(entry.offset);
    if (offset < oldEnd) fail('Overlapping ASAR members');
    const gap = original.subarray(originalBase + oldEnd, originalBase + offset);
    payload.push(gap); newOffset += gap.length;
    const before = archive.read(name), after = changes.get(name) || before;
    oldEnd = offset + entry.size;
    entry.offset = String(newOffset); entry.size = after.length;
    if (changes.has(name)) updateIntegrity(entry, after);
    payload.push(after); newOffset += after.length;
  }
  payload.push(original.subarray(originalBase + oldEnd));
  const patched = Buffer.concat([encodeHeader(archive.header), ...payload]);
  const verify = parseAsar(patched);
  // Check all original packed members; unchanged file bytes must match exactly.
  const untouched = parseAsar(original);
  for (const [name, entry] of untouched.files) {
    if (entry.unpacked || entry.link) continue;
    const want = changes.get(name) || untouched.read(name);
    if (!want.equals(verify.read(name))) fail('Post-patch member verification failed: ' + name);
  }
  return { patched, changedMembers: [...changes.keys()], memberCount: archive.files.size, bridgeUrl };
}
function absolute(p) { if (!p) fail('Required path is missing'); return path.resolve(p); }
function loadManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== 2 || manifest.originalSha256 !== SUPPORTED.sha256 || manifest.version !== SUPPORTED.version) fail('Unsupported manifest');
  for (const name of ['source', 'patchedArchive', 'bridge']) if (!path.isAbsolute(manifest[name])) fail('Manifest paths must be absolute');
  if (!manifest.executable || !path.isAbsolute(manifest.executable.path) || !/^[a-f0-9]{64}$/.test(manifest.executable.sha256)) fail('Manifest executable identity is missing');
  if (!/^[a-f0-9]{64}$/.test(manifest.patchedSha256) || manifest.patchedSha256 === manifest.originalSha256) fail('Invalid patched archive identity');
  return manifest;
}
function prepare({ source, bridge, out, executable }) {
  source = absolute(source); bridge = absolute(bridge); out = absolute(out);
  const executableIdentity = inspectExecutable(absolute(executable || path.join(path.dirname(source), '..', 'ZCode.exe')));
  if (!fs.statSync(bridge).isFile()) fail('Bridge file must exist');
  if (path.dirname(source) === out) fail('Prepare output must be outside the ZCode resources directory');
  const result = patchArchive(fs.readFileSync(source), bridge);
  fs.mkdirSync(out, { recursive: true });
  const patchedArchive = path.join(out, 'app.patched.asar'), manifestPath = path.join(out, 'manifest.json');
  if (fs.existsSync(patchedArchive) || fs.existsSync(manifestPath)) fail('Prepare output already exists; use a new directory');
  fs.writeFileSync(patchedArchive, result.patched, { flag: 'wx' });
  const manifest = { schema: 2, version: SUPPORTED.version, source, bridge, bridgeSha256: hash(fs.readFileSync(bridge)), executable: executableIdentity, patchedArchive, originalSha256: SUPPORTED.sha256, patchedSha256: hash(result.patched), changedMembers: result.changedMembers, memberCount: result.memberCount, preparedAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { prepared: true, applied: false, manifestPath, ...manifest };
}
function apply({ manifest: file }) {
  const m = loadManifest(absolute(file));
  const sourceHash = hash(fs.readFileSync(m.source));
  if (sourceHash !== m.originalSha256 && sourceHash !== m.patchedSha256) fail('Installed archive changed since prepare; refusing to overwrite');
  if (hash(fs.readFileSync(m.bridge)) !== m.bridgeSha256) fail('Bridge changed since prepare; prepare again');
  if (inspectExecutable(m.executable.path).sha256 !== m.executable.sha256) fail('ZCode executable changed since prepare');
  if (sourceHash === m.patchedSha256) return { applied: true, alreadyApplied: true };
  ensureStopped(m.executable.path);
  const patch = fs.readFileSync(m.patchedArchive);
  if (hash(patch) !== m.patchedSha256) fail('Prepared archive hash mismatch');
  const backup = m.source + '.zwn-original-' + m.originalSha256.slice(0, 12);
  const temporary = m.source + '.zwn-pending-' + process.pid;
  if (fs.existsSync(temporary)) fail('Pending path exists');
  if (fs.existsSync(backup) && hash(fs.readFileSync(backup)) !== m.originalSha256) fail('Existing backup hash mismatch');
  if (!fs.existsSync(backup)) fs.copyFileSync(m.source, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(temporary, patch, { flag: 'wx' });
  // Rename on the same volume; failure leaves the verified original and backup intact.
  try { fs.renameSync(temporary, m.source); } catch (e) { fs.unlinkSync(temporary); throw e; }
  if (hash(fs.readFileSync(m.source)) !== m.patchedSha256) fail('Installed hash verification failed. Verified backup retained at ' + backup + '; inspect the unexpected bytes before restoring.');
  return { applied: true, backup, source: m.source, sha256: m.patchedSha256 };
}
function restore({ manifest: file }) {
  const m = loadManifest(absolute(file)), current = hash(fs.readFileSync(m.source));
  if (current === m.originalSha256) return { restored: true, alreadyOriginal: true };
  if (current !== m.patchedSha256) fail('Installed archive is neither this adapter nor the original; refusing to overwrite an update');
  ensureStopped(m.executable.path);
  const backup = m.source + '.zwn-original-' + m.originalSha256.slice(0, 12), original = fs.readFileSync(backup);
  if (hash(original) !== m.originalSha256) fail('Backup hash mismatch');
  const temporary = m.source + '.zwn-restore-' + process.pid;
  fs.writeFileSync(temporary, original, { flag: 'wx' });
  try { fs.renameSync(temporary, m.source); } catch (e) { fs.unlinkSync(temporary); throw e; }
  if (hash(fs.readFileSync(m.source)) !== m.originalSha256) fail('Restore verification failed');
  return { restored: true, source: m.source, sha256: m.originalSha256, backupRetained: backup };
}
function main(args) {
  const [command, ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z]+$/.test(rest[i]) || !rest[i + 1]) fail('Expected --option value');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  const commands = { prepare, apply, restore };
  if (!commands[command]) fail('Usage: node adapter.cjs prepare --source app.asar --bridge bridge.cjs --out WORK_DIR | apply --manifest manifest.json | restore --manifest manifest.json');
  console.log(JSON.stringify(commands[command](options), null, 2));
}
module.exports = { SUPPORTED, ANCHOR, REPLACEMENT, PRELOAD_ADD, hash, inspectExecutable, parseAsar, encodeHeader, updateIntegrity, patchArchive, prepare, apply, restore };
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
