'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');

const source=fs.readFileSync(path.join(__dirname,'../bridge.cjs'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function fixture(){
  const stops=[],styles=new Set();let nextStartError=null,nextStartResult=null,nextRevealResult=null,nextAck=null,sequence=0;
  class Client extends EventEmitter {
    constructor(){super();this.state={state:'preparing',captureHwnd:'100'};}
    request(){const result=nextAck;nextAck=null;return Promise.resolve(result||{captureParked:true});}
    close(){}
  }
  const win={id:1,isDestroyed:()=>false,setBackgroundColor(){},webContents:{
    getURL:()=> 'file:///out/renderer/index.html',
    executeJavaScript(script){
      if(script.startsWith('(async function startBackground')){
        if(nextStartError){const error=nextStartError;nextStartError=null;return Promise.reject(error);}
        const result=nextStartResult;nextStartResult=null;return Promise.resolve(result||{sourceId:'window:200:0'});
      }
      if(script.startsWith('(function stopBackground')){const pending=deferred();stops.push(pending);return pending.promise;}
      if(script.startsWith('(async function revealBackground')){const result=nextRevealResult;nextRevealResult=null;return Promise.resolve(result||{sourceId:'window:200:0'});}
      throw new Error('Unexpected renderer call');
    },
    async insertCSS(){const key='css-'+ ++sequence;styles.add(key);return key;},
    async removeInsertedCSS(key){styles.delete(key);}
  }};
  const electron={app:{getPath:()=>'.',on(){},whenReady:()=>Promise.resolve()},BrowserWindow:{getAllWindows:()=>[]},ipcMain:{on(){},handle(){}},screen:{},dialog:{},nativeTheme:{shouldUseDarkColors:false}};
  const context=vm.createContext({module:{exports:{}},__dirname:path.join(__dirname,'..'),process:{env:{}},setInterval,clearInterval,require(name){
    if(name==='electron')return electron;
    if(name==='node:fs')return {mkdirSync(){},appendFileSync(){}};
    if(name==='node:path')return path;
    if(name==='./native-client.cjs')return {NativeClient:Client};
    if(name==='./library.cjs')return {ConfigStore:class{load(){return {enabled:true,enginePath:'engine',projectPath:'project',opacity:.64,dim:.12};}}};
    if(name==='./appearance.cjs')return {buildAppearanceCss:()=>''};
    if(name==='./background.cjs')return require('../background.cjs');
    throw new Error('Unexpected dependency '+name);
  }});
  vm.runInContext(source+'\nmodule.exports.testApi={connectCapture,applyHost};',context);
  return {api:context.module.exports.testApi,win,Client,stops,styles,failNextStart(){nextStartError=new Error('old capture failed');},rendererResult(stage,result){if(stage==='start')nextStartResult=result;else nextRevealResult=result;},delayAck(){const pending=deferred();nextAck=pending.promise;return pending;}};
}

test('late cleanup from a failed capture cannot overwrite a newer ready source',async()=>{
  const f=fixture(),host={win:f.win,client:new f.Client()};f.failNextStart();
  const old=f.api.connectCapture(host);await drain();assert.equal(f.stops.length,1);
  host.client.state={state:'ready',captureHwnd:'200'};
  await f.api.connectCapture(host);assert.equal(host.captureStatus,'ready');const currentCss=host.css;
  f.stops[0].resolve();await old;
  assert.equal(host.captureStatus,'ready');assert.equal(host.captureError,'');
  assert.equal(host.css,currentCss);assert.ok(f.styles.has(currentCss));
});

test('late native state cleanup cannot remove the style of a newer ready capture',async()=>{
  const f=fixture(),host={win:f.win,client:null};await f.api.applyHost(host,false);
  host.client.state={state:'error',error:'old renderer failed'};host.client.emit('state');
  assert.equal(f.stops.length,1);
  host.client.state={state:'ready',captureHwnd:'200'};host.client.emit('state');await drain();
  assert.equal(host.captureStatus,'ready');const currentCss=host.css;assert.ok(currentCss);
  f.stops[0].resolve();await drain();
  assert.equal(host.captureStatus,'ready');assert.equal(host.css,currentCss);assert.ok(f.styles.has(currentCss));
});

test('current capture superseded during initial acquisition reports interruption and restores ordinary surfaces',async()=>{
  const f=fixture(),host={win:f.win,client:new f.Client()};await f.api.connectCapture(host);
  assert.ok(host.css);f.rendererResult('start',{superseded:true});
  const connect=f.api.connectCapture(host);await drain();assert.equal(f.stops.length,1);
  f.stops[0].resolve();await connect;
  assert.equal(host.captureStatus,'error');assert.match(host.captureError,/连接已中断/);
  assert.equal(host.css,null);assert.equal(f.styles.size,0);
});

test('stream ending during capture-attached acknowledgement cannot stay preparing indefinitely',async()=>{
  const f=fixture(),host={win:f.win,client:new f.Client()};await f.api.connectCapture(host);
  const ack=f.delayAck();f.rendererResult('reveal',{superseded:true});
  const connect=f.api.connectCapture(host);await drain();assert.equal(host.captureStatus,'preparing');
  ack.resolve({captureParked:true});await drain();assert.equal(f.stops.length,1);
  f.stops[0].resolve();await connect;
  assert.equal(host.captureStatus,'error');assert.match(host.captureError,/连接已中断/);
  assert.equal(host.css,null);assert.equal(f.styles.size,0);
});

for(const changed of ['revision','client'])test(`genuinely replaced ${changed} silently ignores stale superseded renderer results`,async()=>{
  for(const stage of ['start','reveal']){
    const f=fixture(),host={win:f.win,client:new f.Client()};await f.api.connectCapture(host);
    const currentCss=host.css,pending=deferred();f.rendererResult(stage,pending.promise);
    const connect=f.api.connectCapture(host);await drain();
    if(changed==='revision')host.captureRevision++;else host.client=new f.Client();
    host.captureStatus='ready';host.captureError='';pending.resolve({superseded:true});await connect;
    assert.equal(host.captureStatus,'ready');assert.equal(host.captureError,'');assert.equal(f.stops.length,0);
    assert.equal(host.css,currentCss);assert.ok(f.styles.has(currentCss));
  }
});
