'use strict';
// Executed only in ZCode's trusted main document. The source is an HWND owned
// by our native helper; the page never receives a source picker or desktop ID.
async function startBackground(sourceId,{deferReveal=false,fps=60}={}) {
 if(!Number.isInteger(fps)||fps<10||fps>120)throw Error('壁纸帧率必须是 10 到 120 之间的整数');
 const key=Symbol.for('zwn.native-background');
 const state=globalThis[key] ||= {revision:0,stream:null,video:null,source:null,error:'',pending:new Set()};
 const revision=++state.revision;state.error='';
 for(const request of state.pending)request.cancel();
 if(state.source===sourceId&&state.details?.requestedFps===fps&&state.stream?.getVideoTracks()[0]?.readyState==='live')return state.details;
 let stream,video,releaseFrameWait;
 const operation={cancel(){stream?.getTracks().forEach(t=>t.stop());video?.remove();releaseFrameWait?.();}};state.pending.add(operation);
 try {
  if(!/^window:[1-9]\d*:0$/.test(sourceId))throw Error('Invalid owned wallpaper source');
  stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:sourceId,minFrameRate:fps,maxFrameRate:fps}}});
  if(state.revision!==revision){stream.getTracks().forEach(t=>t.stop());return {superseded:true};}
  video=document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;video.setAttribute('aria-hidden','true');
  video.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;pointer-events:none;z-index:-2;opacity:0';
  video.srcObject=stream;document.body.prepend(video);
  await video.play();
  if(state.revision!==revision){operation.cancel();return {superseded:true};}
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('壁纸画面连接超时')),12000);const frame=video.requestVideoFrameCallback(()=>{clearTimeout(timer);releaseFrameWait=null;resolve();});releaseFrameWait=()=>{clearTimeout(timer);video.cancelVideoFrameCallback?.(frame);releaseFrameWait=null;resolve();};});
  if(state.revision!==revision){stream.getTracks().forEach(t=>t.stop());video.remove();return {superseded:true};}
  state.stream?.getTracks().forEach(t=>t.stop());state.video?.remove();
  state.stream=stream;state.video=video;state.source=sourceId;video.id='zwn-native-background';video.style.opacity=deferReveal?'0':'1';
  state.details={sourceId,width:video.videoWidth,height:video.videoHeight,requestedFps:fps,frameRate:stream.getVideoTracks()[0].getSettings().frameRate};
  stream.getVideoTracks()[0].addEventListener('ended',()=>{if(state.stream===stream){state.error='壁纸画面连接已中断';video.remove();}});
  return state.details;
 }catch(error){operation.cancel();if(state.revision!==revision)return {superseded:true};state.error=String(error.message||error);throw error;}finally{state.pending.delete(operation);}
}
// Called only after the helper confirms that this exact source has moved outside
// the virtual desktop. Discard queued cursor-bearing frames before displaying it.
async function revealBackground(sourceId){
 const state=globalThis[Symbol.for('zwn.native-background')];
 if(!state||state.source!==sourceId||state.stream?.getVideoTracks()[0]?.readyState!=='live')return {superseded:true};
 const revision=state.revision,video=state.video;let release;
 const operation={cancel(){release?.();}};state.pending.add(operation);
 try{
  await new Promise((resolve,reject)=>{
   let remaining=2,frame;
   const cleanup=()=>{clearTimeout(timer);video.cancelVideoFrameCallback?.(frame);release=null;};
   const timer=setTimeout(()=>{cleanup();reject(Error('壁纸画面连接超时'));},12000);
   release=()=>{cleanup();resolve();};
   const next=()=>{if(--remaining===0){cleanup();resolve();}else frame=video.requestVideoFrameCallback(next);};
   frame=video.requestVideoFrameCallback(next);
  });
  if(state.revision!==revision||state.video!==video||state.stream?.getVideoTracks()[0]?.readyState!=='live')return {superseded:true};
  video.style.opacity='1';return state.details;
 }finally{state.pending.delete(operation);}
}
function stopBackground(){const state=globalThis[Symbol.for('zwn.native-background')];if(!state)return;state.revision++;for(const request of state.pending)request.cancel();state.stream?.getTracks().forEach(t=>t.stop());state.video?.remove();state.stream=null;state.video=null;state.source=null;state.error='';}
function backgroundStatus(){const state=globalThis[Symbol.for('zwn.native-background')];return {live:state?.stream?.getVideoTracks()[0]?.readyState==='live'&&!!state.video?.isConnected,error:state?.error||'',details:state?.details};}
module.exports={startBackground,revealBackground,stopBackground,backgroundStatus};
