'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async({api,win,folder,check})=>{
 api.openPanel(win);const panel=api.getPanel();
 for(let i=0;i<100;i++){await sleep(100);if(await panel.webContents.executeJavaScript(`!!window.wallpaper&&!!document.getElementById('fps')&&!document.getElementById('apply').disabled`))break;}
 const initial=(await panel.webContents.executeJavaScript('window.wallpaper.get()')).config;
 const samples=[];
 for(const fps of [30,120,60]){
  await panel.webContents.executeJavaScript(`(()=>{const s=document.getElementById('fps');s.value=${fps};s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const label=await panel.webContents.executeJavaScript(`document.getElementById('fps-value').textContent`);
  check('slider-label-'+fps,label.includes(String(fps)),label);
  const before=(await panel.webContents.executeJavaScript('window.wallpaper.get()')).config.fps;
  check('slider-keeps-unsaved-draft-'+fps,before===(samples.length?samples.at(-1).fps:initial.fps));
  await panel.webContents.executeJavaScript(`document.getElementById('apply').click()`);
  for(let i=0;i<180;i++){await sleep(300);if(api.state().fps===fps&&['ready','error'].includes(api.state().state))break;}
  check('fps-ready-'+fps,api.state().state==='ready'&&api.state().fps===fps,api.state());
  const pid=api.state().runtimePid;
  const executable=execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${Number(pid)}).Path`],{encoding:'utf8',windowsHide:true}).trim();
  const nativeConfig=JSON.parse(fs.readFileSync(path.join(path.dirname(executable),'config.json'),'utf8').replace(/^\uFEFF/,''));
  const nativeFps=Object.values(nativeConfig).find(v=>v?.general?.user)?.general.user.fps;
  const inspect=()=>win.webContents.executeJavaScript(`(()=>{const s=globalThis[Symbol.for('zwn.native-background')];return {requested:s.details.requestedFps,track:s.stream.getVideoTracks()[0].getSettings().frameRate,frames:s.video.getVideoPlaybackQuality().totalVideoFrames,time:performance.now()}})()`);
  const first=await inspect();await sleep(2200);const last=await inspect();
  const saved=(await panel.webContents.executeJavaScript('window.wallpaper.get()')).config;
  check('fps-reaches-engine-capture-and-disk-'+fps,nativeFps===fps&&saved.fps===fps&&first.requested===fps&&first.track===fps,{nativeFps,saved:saved.fps,...first});
  check('fps-stream-keeps-playing-'+fps,last.frames>first.frames,{first,last});
  samples.push({fps,nativeFps,...last,observedFps:(last.frames-first.frames)*1000/(last.time-first.time)});
 }
 if(initial.fps!==60){await panel.webContents.executeJavaScript(`window.wallpaper.save({fps:${initial.fps}})`);for(let i=0;i<180&&api.state().state!=='ready';i++)await sleep(300);}
 panel.webContents.reload();
 for(let i=0;i<100;i++){await sleep(100);if(await panel.webContents.executeJavaScript(`!!document.getElementById('fps')&&!document.getElementById('apply').disabled`))break;}
 check('fps-survives-panel-reopen',Number(await panel.webContents.executeJavaScript(`document.getElementById('fps').value`))===initial.fps);
 await panel.webContents.executeJavaScript(`document.getElementById('fps').scrollIntoView({block:'center'})`);await sleep(150);
 fs.writeFileSync(path.join(folder,'settings-fps.png'),(await panel.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(folder,'fps-evidence.json'),JSON.stringify(samples,null,2));panel.hide();
};
