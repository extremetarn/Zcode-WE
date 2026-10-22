'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {buildAppearanceCss,APPEARANCE_PRESETS}=require('../appearance.cjs');
const {ConfigStore}=require('../library.cjs');

function tokens(css,selector){
  const block=css.slice(css.indexOf(selector)+selector.length).split('}')[0];
  return new Map([...block.matchAll(/(--color-[\w-]+):([^;]+);/g)].map(m=>[m[1],m[2]]));
}
const alpha=value=>Number(value.match(/,([\d.]+)\)!important$/)[1]);

test('light and dark modes retain native text while surfaces have deliberate hierarchy',()=>{
  const css=buildAppearanceCss({opacity:.64,dim:.12});
  for(const [selector,rgb] of [[':root,:host{','255,255,255'],['.dark{','18,18,22']]){
    const map=tokens(css,selector),get=name=>map.get('--color-'+name);
    assert.equal(map.size,12);
    assert.equal(get('background'),'transparent!important');
    assert.equal(get('card'),`rgba(${rgb},0.64)!important`);
    assert.ok(alpha(get('sidebar'))<alpha(get('card')));
    assert.ok(alpha(get('input'))>alpha(get('card')));
    assert.ok(alpha(get('input-focused'))>alpha(get('input')));
    assert.ok(alpha(get('popover'))>alpha(get('input-focused')));
    for(const value of map.values())assert.ok(value.endsWith('!important'));
  }
  assert.doesNotMatch(css,/--color-(foreground|error|warning|danger|primary|accent|border)|(?:^|[;{])\s*color\s*:/);
  assert.doesNotMatch(css,/(?:backdrop-)?filter\s*:|blur\(/);
  assert.equal(buildAppearanceCss({theme:'dark'}),buildAppearanceCss({theme:'light'}));
});

test('opacity limits leave menus readable and never generate invalid alpha',()=>{
  for(const opacity of [0,1,-10,10,NaN,Infinity,'1; color:red']){
    const css=buildAppearanceCss({opacity});
    for(const match of css.matchAll(/rgba\(\d+,\d+,\d+,([\d.]+)\)/g))assert.ok(Number(match[1])>=0&&Number(match[1])<=1);
    assert.doesNotMatch(css,/NaN|Infinity|color:red/);
  }
  const clear=tokens(buildAppearanceCss({opacity:0}),':root,:host{');
  assert.equal(alpha(clear.get('--color-card')),0);
  assert.equal(alpha(clear.get('--color-sidebar')),0);
  assert.equal(alpha(clear.get('--color-popover')),.92);
  const opaque=tokens(buildAppearanceCss({opacity:1}),':root,:host{');
  for(const [key,value] of opaque)if(key!=='--color-background')assert.equal(alpha(value),1);
});

test('dim overlay stays behind content, cannot receive clicks, and is bounded',()=>{
  for(const [dim,expected] of [[0,0],[.6,.6],[-2,0],[9,.6],[NaN,.12]]){
    const css=buildAppearanceCss({dim});
    assert.ok(css.includes(`background:rgba(0,0,0,${expected})!important`));
    assert.match(css,/body\{isolation:isolate!important;/);
    assert.match(css,/body::before\{[^}]*z-index:-1!important;[^}]*pointer-events:none!important;/);
  }
});

test('presets in the standalone menu match exported presets',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../settings.html'),'utf8');
  const expression=html.match(/const presets = (\{[^;]+\});/)[1];
  const ui=JSON.parse(JSON.stringify(vm.runInNewContext('('+expression+')')));
  assert.deepEqual(ui,APPEARANCE_PRESETS);
  for(const name of Object.keys(ui))assert.ok(html.includes(`data-preset="${name}"`));
  assert.ok(html.includes('dim:draft.dim'));
  assert.equal((html.match(/api\.save\(/g)||[]).length,1,'only Apply commits the draft');
});

test('config migration retains saved appearance and adds dim; invalid dim never changes disk',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zwn-appearance-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store=new ConfigStore(directory);
  assert.equal(store.load().opacity,.64);
  assert.equal(store.load().dim,.12);
  assert.equal(store.load().theme,'system');
  fs.writeFileSync(store.filePath,JSON.stringify({enabled:false,opacity:.82,theme:'dark'}));
  assert.equal(store.load().opacity,.82);
  assert.equal(store.load().dim,.12);
  assert.equal(store.load().theme,'dark');
  store.save({dim:0});assert.equal(store.load().dim,0);
  store.save({dim:.6});assert.equal(store.load().dim,.6);
  const before=fs.readFileSync(store.filePath,'utf8');
  for(const dim of [-.1,.61,NaN,Infinity,'0.2',null])assert.throws(()=>store.save({dim}),/背景压暗/);
  assert.equal(fs.readFileSync(store.filePath,'utf8'),before);
});

test('fps slider changes only the draft and is committed through the existing Apply action',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../settings.html'),'utf8');
  assert.ok(html.indexOf('播放与性能')<html.indexOf('界面与氛围'));
  assert.match(html,/<input id="fps" type="range" min="10" max="120" step="1" value="60" list="fps-marks"/);
  const marks=html.match(/<datalist id="fps-marks">([\s\S]*?)<\/datalist>/)[1];
  assert.deepEqual([...marks.matchAll(/value="(\d+)"/g)].map(match=>Number(match[1])),[30,60,90,120]);
  const binding=html.match(/\$\('fps'\)\.addEventListener\('input',\(\)=>\{if\(draft\)\{([^\n]+)\}\}\);/)[1];
  const elements={fps:{value:'90'},'fps-value':{textContent:''}},context={draft:{fps:60},dirty:false,$:id=>elements[id]};
  context.markDirty=()=>{context.dirty=true;};
  vm.runInNewContext(binding,context);
  assert.equal(context.draft.fps,90);assert.equal(elements['fps-value'].textContent,'90 FPS');assert.equal(context.dirty,true);
  assert.doesNotMatch(binding,/api\.|save\(|restart|connect/);
  assert.ok(html.includes('fps:draft.fps'));assert.equal((html.match(/api\.save\(/g)||[]).length,1);
  const render=html.match(/function renderAppearance\(\)\{\s*([^\n]+)/)[1];
  context.draft.fps=120;vm.runInNewContext(render,context);
  assert.equal(elements.fps.value,120);assert.equal(elements['fps-value'].textContent,'120 FPS');
});
