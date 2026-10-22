'use strict';
// Opt-in local integration probe; Koffi is supplied by the developer harness,
// never a runtime dependency. Restore the real pointer even if a check fails.
const fs=require('node:fs'),path=require('node:path');
module.exports=async({win,folder,state,library,check})=>{
 const k=require(library),u=k.load('user32.dll');
 const Point=k.struct('ZwnCursorProbePoint',{x:'int',y:'int'});
 const Rect=k.struct('ZwnCursorProbeRect',{left:'int',top:'int',right:'int',bottom:'int'});
 const get=u.func('bool GetCursorPos(_Out_ ZwnCursorProbePoint*)');
 const set=u.func('bool SetCursorPos(int,int)');
 const rect=u.func('bool GetWindowRect(void*,_Out_ ZwnCursorProbeRect*)');
 const metric=u.func('int GetSystemMetrics(int)');
 const sleep=ms=>new Promise(r=>setTimeout(r,ms)),original={};get(original);
 const screen={left:metric(76),top:metric(77),right:metric(76)+metric(78),bottom:metric(77)+metric(79)};
 const nativeRect={};rect(BigInt(state().captureHwnd),nativeRect);
 check('capture-source-outside-virtual-desktop',state().captureParked&&(nativeRect.right<=screen.left||nativeRect.left>=screen.right||nativeRect.bottom<=screen.top||nativeRect.top>=screen.bottom),{nativeRect,screen});
 const samples=[];
 try{
  for(const [index,position] of [[100,100],[250,180],[400,280]].entries()){
   set(...position);await sleep(700);
   const sample=await win.webContents.executeJavaScript(`(()=>{
    const v=globalThis[Symbol.for('zwn.native-background')].video,c=document.createElement('canvas');
    c.width=v.videoWidth;c.height=v.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(v,0,0);
    const p=ctx.getImageData(0,0,c.width,c.height).data;let changed=0;
    if(globalThis.__zwnPreviousPixels)for(let i=0;i<p.length;i+=4)if(Math.abs(p[i]-__zwnPreviousPixels[i])>3||Math.abs(p[i+1]-__zwnPreviousPixels[i+1])>3||Math.abs(p[i+2]-__zwnPreviousPixels[i+2])>3)changed++;
    globalThis.__zwnPreviousPixels=p;
    const crop=document.createElement('canvas');crop.width=160;crop.height=160;crop.getContext('2d').drawImage(c,${position[0]-40},${position[1]-40},160,160,0,0,160,160);
    return {png:c.toDataURL('image/png').split(',')[1],crop:crop.toDataURL('image/png').split(',')[1],changedPixels:changed,frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight};
   })()`);
   fs.writeFileSync(path.join(folder,`cursor-raw-${index}.png`),Buffer.from(sample.png,'base64'));
   fs.writeFileSync(path.join(folder,`cursor-crop-${index}.png`),Buffer.from(sample.crop,'base64'));
   delete sample.png;delete sample.crop;samples.push({...sample,pointer:position});
  }
  check('parked-capture-has-changing-content',samples[2].frames>samples[0].frames&&samples.slice(1).every(s=>s.changedPixels>100),samples);
 }finally{set(original.x,original.y);await win.webContents.executeJavaScript('delete globalThis.__zwnPreviousPixels').catch(()=>{});}
 fs.writeFileSync(path.join(folder,'cursor-evidence.json'),JSON.stringify({nativeRect,screen,samples},null,2));
};
