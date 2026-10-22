'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {discover,readProjectProperties,validatePropertyValues,ConfigStore,normalizeProjectPath,resolveAsset} = require('../library.cjs');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zwn-library-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const write=(relative,content)=>{const full=path.join(dir,relative);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,typeof content==='object'?JSON.stringify(content):content);return full;};
  const project=(relative,extra={})=>{write(path.join(relative,'scene.pkg'),'fixture');return write(path.join(relative,'project.json'),{title:'测试场景',type:'scene',file:'scene.pkg',...extra});};
  return {dir,write,project};
}

test('project paths require a local absolute project.json', t=>{
  const f=fixture(t),project=f.project('wallpaper');
  assert.equal(normalizeProjectPath(path.dirname(project)),project);
  assert.equal(normalizeProjectPath(project),project);
  assert.throws(()=>normalizeProjectPath('relative/project.json'),/绝对路径/);
  assert.throws(()=>normalizeProjectPath('\\\\server\\share\\project.json'),/本地绝对路径/);
  assert.throws(()=>normalizeProjectPath(f.write('other.json','{}')),/project.json/);
});

test('asset resolution rejects escaping paths, URLs and absolute paths', t=>{
  const f=fixture(t),project=f.project('wallpaper'),dir=path.dirname(project);
  const outside=f.write('outside.png','fixture'),inside=f.write('wallpaper/preview.png','fixture');
  assert.equal(resolveAsset(dir,'preview.png'),inside);
  for(const invalid of ['../outside.png','..\\outside.png',outside,'file:///outside.png','https://example.test/preview.png','missing.png'])assert.equal(resolveAsset(dir,invalid),'');
});

test('symlinked project directories cannot escape the library', t=>{
  const f=fixture(t),project=f.project('outside'),link=path.join(f.dir,'linked');
  try {fs.symlinkSync(path.dirname(project),link,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('This host cannot create a test junction');return;}throw error;}
  assert.throws(()=>normalizeProjectPath(link),/链接|重解析/);
  assert.equal(resolveAsset(f.dir,'linked/scene.pkg'),'');
});

test('library discovers valid projects and excludes malformed or escaping assets', t=>{
  const f=fixture(t),root=path.join(f.dir,'Steam');
  const exe=f.write('Steam/steamapps/common/wallpaper_engine/wallpaper64.exe','fixture');
  const workshop='Steam/steamapps/workshop/content/431960';
  const valid=f.project(workshop+'/100',{title:'可用壁纸',preview:'preview.png'});
  f.write(workshop+'/100/preview.png','fixture');
  f.project(workshop+'/101',{file:'../100/scene.pkg'});
  f.project(workshop+'/102',{type:'unknown'});
  f.write(workshop+'/103/project.json','{broken');
  f.project('Steam/steamapps/common/wallpaper_engine/projects/defaultprojects/default');
  const result=discover({steamRoots:[root]});
  assert.equal(result.enginePath,exe);
  assert.equal(result.entries.length,2);
  assert.equal(result.entries.find(item=>item.projectPath===valid).source,'创意工坊');
  assert.ok(result.entries.find(item=>item.projectPath===valid).previewPath.endsWith('preview.png'));
  assert.ok(result.warnings.some(text=>text.includes('3 个')));
});

test('parameter schemas retain type, order and defaults; static text is not editable', t=>{
  const f=fixture(t),project=f.project('wallpaper',{general:{properties:{
    speed:{type:'slider',text:'速度',value:0.5,min:0,max:1,precision:2,order:3},
    heading:{type:'text',value:'说明'},
    text:{type:'textinput',value:'你好',order:1},
    enabled:{type:'bool',value:true,order:0},
    tint:{type:'color',value:'#ff8000',order:2},
    mode:{type:'combo',value:2,options:[{label:'一',value:1},{label:'二',value:2}],order:4},
    bad:{type:'combo',options:[]},
    unknown:{type:'file',value:'anything'}
  }}});
  const {properties}=readProjectProperties(project);
  assert.deepEqual(properties.map(item=>item.key),['enabled','text','tint','speed','mode']);
  assert.equal(properties.find(item=>item.key==='speed').step,0.01);
  assert.equal(properties.find(item=>item.key==='tint').value,'1 0.50196078 0');
  assert.equal(properties.find(item=>item.key==='text').type,'text');
  const valid=validatePropertyValues(properties,{enabled:false,text:'changed',tint:'#00ff00',speed:0.75,mode:1});
  assert.equal(valid.tint,'0 1 0');
  for(const invalid of [{speed:2},{speed:NaN},{enabled:'false'},{mode:'1'},{tint:'1 2 0'},{text:'x\0y'},{missing:true}])assert.throws(()=>validatePropertyValues(properties,invalid));
  assert.throws(()=>validatePropertyValues(properties,JSON.parse('{"__proto__":true}')));
});

test('packaged scenes can use scene.pkg when the safe declared scene source is absent', t=>{
  const f=fixture(t),root=path.join(f.dir,'Steam'),workshop='Steam/steamapps/workshop/content/431960';
  f.write('Steam/steamapps/common/wallpaper_engine/wallpaper64.exe','fixture');
  const valid=f.project(workshop+'/100',{file:'scene.json'});
  f.project(workshop+'/101',{file:'../escaped-scene.json'});
  f.project(workshop+'/102',{file:'https://example.test/scene.json'});
  f.project(workshop+'/103',{file:path.join(f.dir,'missing.json')});
  f.project(workshop+'/104',{type:'web',file:'missing.html'});
  const result=discover({steamRoots:[root]});
  assert.deepEqual(result.entries.map(entry=>entry.projectPath),[valid]);
  assert.equal(result.entries[0].type,'scene');
  assert.ok(result.warnings.some(text=>text.includes('4 个')));
});

test('mixed-case workshop scene types remain selectable with packed scene content', t=>{
  const f=fixture(t),root=path.join(f.dir,'Steam');
  f.write('Steam/steamapps/common/wallpaper_engine/wallpaper64.exe','fixture');
  const project=f.project('Steam/steamapps/workshop/content/431960/3444143763',{title:'【星之终途】菲莉娅动态壁纸',type:'Scene',file:'scene.json'});
  const result=discover({steamRoots:[root]});
  assert.equal(result.entries.length,1);assert.equal(result.entries[0].projectPath,project);
  assert.equal(result.entries[0].type,'scene');
});

test('config updates preserve prior values and write no temporary residue', t=>{
  const f=fixture(t),store=new ConfigStore(path.join(f.dir,'settings'));
  assert.equal(store.load().enabled,false);
  assert.equal(store.load().opacity,0.64);
  assert.equal(store.load().dim,0.12);
  assert.equal(store.load().theme,'system');
  assert.equal(store.load().fps,60);
  const project=f.project('wallpaper');
  store.save({projectPath:project,perProjectValues:{[project]:{speed:0.5}}});
  store.save({opacity:0.4});
  const config=store.load();
  assert.equal(config.opacity,0.4);
  assert.equal(config.projectPath,project);
  assert.equal(config.perProjectValues[project].speed,0.5);
  assert.equal(config.enabled,false);
  assert.deepEqual(fs.readdirSync(store.baseDir),['config.json']);
});

test('invalid config changes fail without damaging last valid configuration', t=>{
  const f=fixture(t),store=new ConfigStore(path.join(f.dir,'settings'));
  store.save({opacity:0.6});
  for(const invalid of [{opacity:-0.1},{opacity:NaN},{enabled:'yes'},{unknown:true},{enginePath:'relative.exe'},{theme:'invalid'},{perProjectValues:{relative:{speed:1}}}])assert.throws(()=>store.save(invalid));
  assert.equal(store.load().opacity,0.6);
  fs.writeFileSync(store.filePath,'{broken');
  assert.throws(()=>store.load(),/无法读取/);
});

test('oversized project JSON is rejected before parsing', t=>{
  const f=fixture(t),file=f.write('huge/project.json',' '.repeat(1024*1024+1));
  assert.throws(()=>readProjectProperties(file),/文件过大/);
});

test('fps migration preserves older configuration and validates integer frame limits',t=>{
  const f=fixture(t),store=new ConfigStore(path.join(f.dir,'settings'));
  const project=f.project('wallpaper');
  const old={enabled:true,enginePath:'',projectPath:project,opacity:.41,dim:.2,theme:'light',perProjectValues:{[project]:{speed:.5}}};
  fs.mkdirSync(store.baseDir);fs.writeFileSync(store.filePath,JSON.stringify(old));
  assert.deepEqual(store.load(),{...old,fps:60});
  for(const fps of [10,30,60,90,120]){
    assert.equal(store.save({fps}).fps,fps);
    assert.deepEqual(store.load(),{...old,fps});
  }
  const before=fs.readFileSync(store.filePath,'utf8');
  for(const fps of [9,121,59.5,NaN,Infinity,-Infinity,'60',null,true])assert.throws(()=>store.save({fps}),/帧率上限/);
  assert.equal(fs.readFileSync(store.filePath,'utf8'),before);
});

test('legacy 121–144 FPS loads at 120 without discarding other settings or writing until save',t=>{
  const f=fixture(t),store=new ConfigStore(path.join(f.dir,'settings'));
  const project=f.project('wallpaper');
  const legacy={enabled:true,enginePath:'',projectPath:project,fps:144,opacity:.38,dim:.06,theme:'system',perProjectValues:{[project]:{speed:.5}}};
  fs.mkdirSync(store.baseDir);
  for(const fps of [121,130,144]){
    const json=JSON.stringify({...legacy,fps});fs.writeFileSync(store.filePath,json);
    assert.deepEqual(store.load(),{...legacy,fps:120});
    assert.equal(fs.readFileSync(store.filePath,'utf8'),json,'load must be read-only');
  }
  assert.deepEqual(store.save({}),{...legacy,fps:120});
  assert.equal(JSON.parse(fs.readFileSync(store.filePath,'utf8')).fps,120);
  const persisted=fs.readFileSync(store.filePath,'utf8');
  for(const fps of [121,144])assert.throws(()=>store.save({fps}),/帧率上限/);
  assert.equal(fs.readFileSync(store.filePath,'utf8'),persisted);
  for(const fps of [145,120.5,'144']){
    fs.writeFileSync(store.filePath,JSON.stringify({...legacy,fps}));
    assert.throws(()=>store.load(),/无法读取.*帧率上限/);
  }
  fs.writeFileSync(store.filePath,JSON.stringify({...legacy,opacity:-1}));
  assert.throws(()=>store.load(),/无法读取.*不透明度/);
});
