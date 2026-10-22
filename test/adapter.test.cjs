'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const a = require('../adapter.cjs');
function fixture(anchor = a.ANCHOR) {
  const files = {
    'package.json': Buffer.from(JSON.stringify({version:'3.16.2',type:'module',main:'out/main/index.js'})),
    'out/main/index.js': Buffer.from('const options=' + anchor + ':{};'),
    'out/preload/index.cjs': Buffer.from('console.log("original preload");'),
    'assets/retained.bin': Buffer.from([0,255,1,2,3,0,254]),
  };
  const header = {files:{}}, body=[]; let offset=0;
  for(const [name, bytes] of Object.entries(files)) {
    const parts=name.split('/'); let parent=header;
    for(const part of parts.slice(0,-1)) parent=parent.files[part] ||= {files:{}};
    const entry={offset:String(offset),size:bytes.length,integrity:{algorithm:'SHA256',hash:'',blockSize:16,blocks:[]}};
    a.updateIntegrity(entry,bytes); parent.files[parts.at(-1)]=entry;body.push(bytes);offset+=bytes.length;
  }
  header.files['external.node']={size:20,unpacked:true};
  const original=Buffer.concat([a.encodeHeader(header),...body]);
  return {original, expected:{version:'3.16.2',sha256:a.hash(original)}};
}
test('patch preserves every other member and rehashes changed member blocks',()=>{
  const f=fixture(), before=a.parseAsar(f.original);
  const {patched}=a.patchArchive(f.original,path.resolve('bridge.cjs'),f.expected), after=a.parseAsar(patched);
  assert.ok(after.read('out/main/index.js').toString().includes(a.REPLACEMENT));
  assert.ok(after.read('out/main/index.js').toString().includes('import "file:///'));
  assert.ok(after.read('out/preload/index.cjs').toString().endsWith(a.PRELOAD_ADD));
  for(const name of ['package.json','assets/retained.bin']) assert.deepEqual(before.read(name),after.read(name));
  assert.deepEqual(before.files.get('external.node'),after.files.get('external.node'));
  for(const name of ['out/main/index.js','out/preload/index.cjs']){
    const entry=after.files.get(name),bytes=after.read(name);
    assert.equal(entry.integrity.hash,a.hash(bytes));
    entry.integrity.blocks.forEach((h,i)=>assert.equal(h,a.hash(bytes.subarray(i*16,(i+1)*16))));
  }
});
test('unknown hash, missing anchor, and duplicate anchor fail closed',()=>{
  const f=fixture();assert.throws(()=>a.patchArchive(f.original,'bridge.cjs'),/hash/);
  for(const anchor of ['no-match',a.ANCHOR+a.ANCHOR]){
    const x=fixture(anchor);assert.throws(()=>a.patchArchive(x.original,'bridge.cjs',x.expected),/exactly once/);
  }
});
test('malformed ASAR fails without writes',()=>assert.throws(()=>a.parseAsar(Buffer.alloc(16)),/Invalid/));
function scratch(fn){
 const base=path.resolve('work/zwn-adapter-tests');fs.mkdirSync(base,{recursive:true});
 const dir=fs.mkdtempSync(path.join(base,'case-'));
 try{return fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function fakeExe(file,states='101000011'){
 fs.writeFileSync(file,Buffer.concat([Buffer.from('fixture dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),Buffer.from([1,states.length]),Buffer.from(states)]));
}
test('fuse guard rejects integrity-enabled and malformed executables',()=>scratch(dir=>{
 const exe=path.join(dir,'ZCode.exe');fakeExe(exe);
 assert.equal(a.inspectExecutable(exe).embeddedAsarIntegrity,false);
 fakeExe(exe,'101010011');assert.throws(()=>a.inspectExecutable(exe),/integrity/);
 fs.writeFileSync(exe,'none');assert.throws(()=>a.inspectExecutable(exe),/fuse wire/);
}));
test('prepended CJS bridge executes before original ESM dependency and body',()=>scratch(dir=>{
 const bridge=path.join(dir,'bridge.cjs');fs.writeFileSync(bridge,'globalThis.order=["bridge"];');
 fs.writeFileSync(path.join(dir,'dependency.mjs'),'globalThis.order.push("dependency");');
 const f=fixture(),result=a.patchArchive(f.original,bridge,f.expected);
 const source=a.parseAsar(result.patched).read('out/main/index.js').toString();
 fs.writeFileSync(path.join(dir,'main.mjs'),source+'\nimport "./dependency.mjs";console.log(JSON.stringify(globalThis.order.concat("body")));');
 const order=JSON.parse(execFileSync(process.execPath,[path.join(dir,'main.mjs')],{encoding:'utf8'}));
 assert.deepEqual(order,['bridge','dependency','body']);
}));
test('prepare/apply/restore preserves backup and rejects changed dependencies or installed updates',()=>scratch(dir=>{
 const source=path.join(dir,'resources','app.asar'),bridge=path.join(dir,'bridge.cjs'),exe=path.join(dir,'ZCode.exe');
 fs.mkdirSync(path.dirname(source));const f=fixture();fs.writeFileSync(source,f.original);fs.writeFileSync(bridge,'module.exports={};');fakeExe(exe);
 const saved=a.SUPPORTED.sha256;a.SUPPORTED.sha256=f.expected.sha256;
 try{
  const prepared=a.prepare({source,bridge,out:path.join(dir,'prepared')}),manifest=prepared.manifestPath;
  assert.deepEqual(fs.readFileSync(source),f.original);
  fs.appendFileSync(bridge,'// changed');assert.throws(()=>a.apply({manifest}),/Bridge changed/);
  fs.writeFileSync(bridge,'module.exports={};');
  const applied=a.apply({manifest});assert.equal(a.hash(fs.readFileSync(source)),prepared.patchedSha256);
  assert.deepEqual(fs.readFileSync(applied.backup),f.original);
  assert.equal(a.apply({manifest}).alreadyApplied,true);
  fs.writeFileSync(source,'new app version');assert.throws(()=>a.restore({manifest}),/refusing to overwrite an update/);
  fs.copyFileSync(prepared.patchedArchive,source);
  assert.equal(a.restore({manifest}).restored,true);assert.deepEqual(fs.readFileSync(source),f.original);
  assert.equal(a.restore({manifest}).alreadyOriginal,true);
 }finally{a.SUPPORTED.sha256=saved;}
}));
