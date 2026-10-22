'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../background.cjs'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

// A separate realm per test models the renderer. Timers and capture completion
// are controlled explicitly so lifecycle races do not depend on wall-clock time.
function fixture(t){
 const calls=[],requests=[],videos=[],timers=new Map();let sequence=0,nextPlayError=null,nextPlayPromise=null;
 const context=vm.createContext({module:{exports:{}},navigator:{mediaDevices:{getUserMedia(options){const pending=deferred();calls.push(options);requests.push(pending);return pending.promise;}}},
  document:{body:{prepend(video){video.isConnected=true;}},createElement(tag){assert.equal(tag,'video');const playError=nextPlayError,playPromise=nextPlayPromise;nextPlayError=null;nextPlayPromise=null;const video={style:{},isConnected:false,videoWidth:1920,videoHeight:1080,srcObject:null,frame:null,setAttribute(){},remove(){this.isConnected=false;},play(){return playError?Promise.reject(playError):playPromise||Promise.resolve();},requestVideoFrameCallback(callback){this.frame=callback;return 1;},cancelVideoFrameCallback(){this.frame=null;}};videos.push(video);return video;}},
  setTimeout(callback){const id=++sequence;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);}});
 vm.runInContext(source,context);
 const api=context.module.exports;
 function stream(){const listeners=new Map();const track={readyState:'live',stops:0,stop(){this.stops++;this.readyState='ended';},getSettings(){return {frameRate:60};},addEventListener(name,listener){listeners.set(name,listener);},end(){this.readyState='ended';listeners.get('ended')?.();}};return {track,getTracks(){return [track];},getVideoTracks(){return [track];}};}
 async function ready(id='window:12345:0',options) {const promise=api.startBackground(id,options),capture=stream();requests.at(-1).resolve(capture);await drain();const video=videos.at(-1);assert.ok(video.frame,'start waits for a decoded frame');video.frame();const details=await promise;return {capture,video,details};}
 t.after(()=>api.stopBackground());
 return {api,calls,requests,videos,timers,stream,ready,failNextPlay(error){nextPlayError=error;},delayNextPlay(){const wait=deferred();nextPlayPromise=wait.promise;return wait;}};
}

test('source filter rejects screens, zero/negative handles, suffixes and malformed IDs before requesting capture',async t=>{
 const f=fixture(t);
 for(const id of ['screen:0:0','screen:123:0','window:0:0','window:-1:0','window:123:1','window:123:0:extra','window:001:0','123','',null,undefined])await assert.rejects(f.api.startBackground(id),/Invalid owned wallpaper source/);
 assert.equal(f.calls.length,0);
});

test('capture is restricted to the supplied window ID, video only, and a noninteractive DOM layer',async t=>{
 const f=fixture(t),{capture,video,details}=await f.ready();
 assert.equal(f.calls[0].audio,false);
 assert.equal(f.calls[0].video.mandatory.chromeMediaSource,'desktop');
 assert.equal(f.calls[0].video.mandatory.chromeMediaSourceId,'window:12345:0');
 assert.equal(video.srcObject,capture);assert.equal(video.muted,true);
 assert.match(video.style.cssText,/pointer-events:none/);
 assert.equal(video.style.opacity,'1');assert.equal(details.width,1920);assert.equal(details.frameRate,60);
 assert.equal(f.api.backgroundStatus().live,true);
});

test('reapplying a live source reuses its stream and DOM video',async t=>{
 const f=fixture(t),initial=await f.ready();
 assert.equal(await f.api.startBackground('window:12345:0'),initial.details);
 assert.equal(f.calls.length,1);assert.equal(f.videos.length,1);assert.equal(initial.capture.track.stops,0);
});

test('replacement retains the previous frame until the new source has produced a frame',async t=>{
 const f=fixture(t),old=await f.ready();
 const pending=f.api.startBackground('window:67890:0'),replacement=f.stream();f.requests[1].resolve(replacement);await drain();
 assert.equal(old.capture.track.stops,0);assert.equal(old.video.isConnected,true);
 f.videos[1].frame();await pending;
 assert.equal(old.capture.track.readyState,'ended');assert.equal(old.video.isConnected,false);
 assert.equal(f.api.backgroundStatus().details.sourceId,'window:67890:0');
});

test('a superseded capture request stops its late stream without mounting a video',async t=>{
 const f=fixture(t),stale=f.api.startBackground('window:100:0');
 const current=await f.ready('window:200:0'),late=f.stream();f.requests[0].resolve(late);
 assert.equal((await stale).superseded,true);assert.equal(late.track.readyState,'ended');
 assert.equal(f.videos.length,1);assert.equal(current.capture.track.readyState,'live');
});

test('a superseded pending first frame never replaces the newer source',async t=>{
 const f=fixture(t),stale=f.api.startBackground('window:100:0'),old=f.stream();f.requests[0].resolve(old);await drain();
 const oldVideo=f.videos[0],current=await f.ready('window:200:0');oldVideo.frame?.();
 assert.equal((await stale).superseded,true);assert.equal(old.track.readyState,'ended');assert.equal(oldVideo.isConnected,false);
 assert.equal(f.api.backgroundStatus().details.sourceId,current.details.sourceId);
});

test('stop disconnects a committed stream and removes its video; late acquisition stays stopped',async t=>{
 const f=fixture(t),old=await f.ready();f.api.stopBackground();
 assert.equal(old.capture.track.readyState,'ended');assert.equal(old.video.isConnected,false);assert.ok(!f.api.backgroundStatus().live);
 const pending=f.api.startBackground('window:200:0'),late=f.stream();f.api.stopBackground();f.requests[1].resolve(late);
 assert.equal((await pending).superseded,true);assert.equal(late.track.readyState,'ended');assert.equal(f.videos.length,1);
});

test('capture denial reports an error without leaving a video',async t=>{
 const f=fixture(t),pending=f.api.startBackground('window:100:0');f.requests[0].reject(new Error('capture denied'));
 await assert.rejects(pending,/capture denied/);assert.equal(f.videos.length,0);assert.equal(f.api.backgroundStatus().error,'capture denied');
});

test('a late error from a superseded acquisition does not poison the current source',async t=>{
 const f=fixture(t),stale=f.api.startBackground('window:100:0');stale.catch(()=>{});
 await f.ready('window:200:0');f.requests[0].reject(new Error('old capture failed'));
 assert.equal((await stale).superseded,true);assert.equal(f.api.backgroundStatus().error,'');
 assert.equal(f.api.backgroundStatus().live,true);assert.equal(f.api.backgroundStatus().details.sourceId,'window:200:0');
});

test('play failure disposes the acquired stream and mounted video',async t=>{
 const f=fixture(t);f.failNextPlay(new Error('decode failed'));
 const pending=f.api.startBackground('window:100:0'),capture=f.stream();f.requests[0].resolve(capture);
 await assert.rejects(pending,/decode failed/);assert.equal(capture.track.readyState,'ended');assert.equal(f.videos[0].isConnected,false);
 assert.equal(f.api.backgroundStatus().error,'decode failed');
});

test('first-frame timeout disposes the acquired stream and mounted video',async t=>{
 const f=fixture(t),pending=f.api.startBackground('window:100:0'),capture=f.stream();f.requests[0].resolve(capture);await drain();
 assert.equal(f.timers.size,1);for(const callback of f.timers.values())callback();
 await assert.rejects(pending,/连接超时/);assert.equal(capture.track.readyState,'ended');assert.equal(f.videos[0].isConnected,false);
});

test('track termination makes status non-live and removes the rendered layer',async t=>{
 const f=fixture(t),{capture,video}=await f.ready();capture.track.end();
 assert.equal(f.api.backgroundStatus().live,false);assert.match(f.api.backgroundStatus().error,/中断/);assert.equal(video.isConnected,false);
});

test('stop immediately disposes a stream waiting for its first frame',async t=>{
 const f=fixture(t),pending=f.api.startBackground('window:100:0'),capture=f.stream();pending.catch(()=>{});
 f.requests[0].resolve(capture);await drain();f.api.stopBackground();
 assert.equal(capture.track.readyState,'ended','turning wallpaper off must stop an acquired capture immediately');
 assert.equal(f.videos[0].isConnected,false,'the pending video must also be removed');
 assert.equal((await pending).superseded,true);assert.equal(f.timers.size,0,'stop must release the first-frame timeout');
});

test('returning to the current source supersedes an in-flight replacement',async t=>{
 const f=fixture(t),old=await f.ready('window:100:0');
 const replacement=f.api.startBackground('window:200:0');await f.api.startBackground('window:100:0');
 const late=f.stream();f.requests[1].resolve(late);await drain();
 // A broken implementation creates a second video and waits for its frame.
 if(f.videos.length>1)f.videos[1].frame();await replacement;
 assert.equal(f.api.backgroundStatus().details.sourceId,'window:100:0','latest source selection wins even when it reuses a live capture');
 assert.equal(old.capture.track.readyState,'live');assert.equal(late.track.readyState,'ended');
});

test('stop during pending play never starts a first-frame wait after play resolves',async t=>{
 const f=fixture(t),play=f.delayNextPlay(),pending=f.api.startBackground('window:100:0'),capture=f.stream();
 f.requests[0].resolve(capture);await drain();assert.equal(f.videos.length,1);f.api.stopBackground();
 assert.equal(capture.track.readyState,'ended');assert.equal(f.videos[0].isConnected,false);
 play.resolve();await drain();assert.equal(f.timers.size,0,'a cancelled play must not create a fresh timeout');
 assert.equal((await pending).superseded,true);assert.ok(!f.api.backgroundStatus().live);
});

test('capture stays hidden until parking is acknowledged and two fresh frames arrive',async t=>{
 const f=fixture(t),{video}=await f.ready('window:100:0',{deferReveal:true});
 assert.equal(video.style.opacity,'0');
 const shown=f.api.revealBackground('window:100:0');
 video.frame();await drain();assert.equal(video.style.opacity,'0');
 video.frame();await shown;assert.equal(video.style.opacity,'1');
 assert.equal(f.timers.size,0);
});

test('selected frame cap reaches capture constraints and different caps do not reuse old streams',async t=>{
 const f=fixture(t),old=await f.ready('window:100:0',{fps:30});
 assert.equal(f.calls[0].video.mandatory.maxFrameRate,30);assert.equal(old.details.requestedFps,30);
 assert.equal(f.calls[0].video.mandatory.minFrameRate,30);
 const current=await f.ready('window:100:0',{fps:120});
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].video.mandatory.maxFrameRate,120);
 assert.equal(f.calls[1].video.mandatory.minFrameRate,120);
 assert.equal(old.capture.track.readyState,'ended');assert.equal(current.details.requestedFps,120);
});

test('invalid frame caps cannot acquire capture or disturb an existing stream',async t=>{
 const f=fixture(t),old=await f.ready();
 for(const fps of [0,9,121,30.5,NaN,Infinity,'60',null])await assert.rejects(f.api.startBackground('window:200:0',{fps}),/帧率/);
 assert.equal(f.calls.length,1);assert.equal(old.capture.track.readyState,'live');
});

test('a stale parking acknowledgement cannot reveal another source',async t=>{
 const f=fixture(t),{video}=await f.ready('window:200:0',{deferReveal:true});
 assert.equal((await f.api.revealBackground('window:100:0')).superseded,true);
 assert.equal(video.style.opacity,'0');assert.equal(f.timers.size,0);
});

test('turning wallpaper off cancels a pending reveal immediately',async t=>{
 const f=fixture(t),{video,capture}=await f.ready('window:100:0',{deferReveal:true});
 const shown=f.api.revealBackground('window:100:0');f.api.stopBackground();
 assert.equal((await shown).superseded,true);assert.equal(f.timers.size,0);
 assert.equal(video.isConnected,false);assert.equal(capture.track.readyState,'ended');
});

test('switching wallpaper cancels the old pending reveal',async t=>{
 const f=fixture(t),old=await f.ready('window:100:0',{deferReveal:true});
 const shown=f.api.revealBackground('window:100:0');
 const current=await f.ready('window:200:0',{deferReveal:true});
 assert.equal((await shown).superseded,true);assert.equal(old.video.isConnected,false);
 assert.equal(current.video.style.opacity,'0');assert.equal(f.timers.size,0);
});

test('missing fresh frames after parking fail without showing the captured cursor frame',async t=>{
 const f=fixture(t),{video}=await f.ready('window:100:0',{deferReveal:true});
 const shown=f.api.revealBackground('window:100:0');
 for(const callback of f.timers.values())callback();
 await assert.rejects(shown,/连接超时/);assert.equal(video.style.opacity,'0');
});
