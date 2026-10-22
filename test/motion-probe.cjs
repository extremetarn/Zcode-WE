'use strict';
const fs=require('node:fs'),path=require('node:path');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
exports.install=api=>{
 const folder=path.resolve(process.env.ZWN_MOTION_VERIFY_DIR),cursorLibrary=process.env.ZWN_CURSOR_TEST_KOFFI,selectedProject=process.env.ZWN_TEST_PROJECT;delete process.env.ZWN_MOTION_VERIFY_DIR;delete process.env.ZWN_CURSOR_TEST_KOFFI;delete process.env.ZWN_TEST_PROJECT;fs.mkdirSync(folder,{recursive:true});let ran=false;
 api.app.on('browser-window-created',(_e,win)=>win.webContents.on('did-finish-load',async()=>{
  if(ran||!win.webContents.getURL().includes('/out/renderer/index.html'))return;ran=true;
  const checks=[],check=(name,pass,details)=>{checks.push({name,pass,details});if(!pass)throw Error(name);};
  const inspect=()=>win.webContents.executeJavaScript(`(()=>{const s=globalThis[Symbol.for('zwn.native-background')],v=s?.video,r=v?.getBoundingClientRect();return {live:s?.stream?.getVideoTracks()[0]?.readyState==='live',frames:v?.getVideoPlaybackQuality().totalVideoFrames,source:s?.source,width:v?.videoWidth,height:v?.videoHeight,rect:r&&{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight}}})()`);
  try{
   if(selectedProject){
    for(let i=0;i<180&&api.state().state!=='ready';i++)await sleep(400);
    api.openPanel(win);const panel=api.getPanel();
    for(let i=0;i<100;i++){await sleep(100);if(await panel.webContents.executeJavaScript(`!!window.wallpaper&&document.querySelectorAll('.card').length>0&&!document.getElementById('apply').disabled`))break;}
    const title=await panel.webContents.executeJavaScript(`(async()=>{const entry=(await window.wallpaper.list()).entries.find(e=>e.projectPath===${JSON.stringify(selectedProject)});if(!entry)throw Error('Requested project is not in library');const card=[...document.querySelectorAll('.card')].find(c=>c.title===entry.title);if(!card)throw Error('Project card is missing');card.click();return entry.title})()`);
    for(let i=0;i<100;i++){await sleep(100);if(await panel.webContents.executeJavaScript(`document.getElementById('selected-path').textContent===${JSON.stringify(selectedProject)}&&!document.getElementById('apply').disabled`))break;}
    await panel.webContents.executeJavaScript(`document.getElementById('apply').click()`);
    for(let i=0;i<180;i++){await sleep(400);if(api.state().projectPath===selectedProject&&['ready','error'].includes(api.state().state))break;}
    check('requested-wallpaper-applied-from-settings',api.state().projectPath===selectedProject&&api.state().state==='ready',{title,state:api.state()});
    panel.hide();
   }
   for(let i=0;i<180&&api.state().state!=='ready';i++){if(api.state().state==='error')throw Error(api.state().message);await sleep(400);}
   check('native-and-local-stream-ready',api.state().state==='ready',api.state());
   if(process.env.ZWN_FPS_VERIFY==='1'){delete process.env.ZWN_FPS_VERIFY;await require('./fps-probe.cjs')({api,win,folder,check});}
   const first=await inspect(),pid=api.state().runtimePid;check('video-mounted-in-zcode-document',first.live&&first.width>0&&first.height>0,first);
   if(cursorLibrary)await require('./cursor-probe.cjs')({win,folder,state:api.state,library:cursorLibrary,check});
   await sleep(1200);fs.writeFileSync(path.join(folder,'composed-before.png'),(await win.webContents.capturePage()).toPNG());
   const bounds=win.getBounds(),samples=[];
   try{for(let i=0;i<48;i++){win.setPosition(bounds.x+(i%16)*3,bounds.y+(i%8)*2);await sleep(22);samples.push({pid:api.state().runtimePid,...await inspect()});}}finally{win.setBounds(bounds);}
   const last=await inspect();
   check('movement-keeps-single-renderer',samples.every(s=>s.pid===pid));
   check('background-stays-in-same-surface',samples.every(s=>s.live&&s.rect.x===0&&s.rect.y===0&&Math.abs(s.rect.width-s.viewport.width)<1&&Math.abs(s.rect.height-s.viewport.height)<1));
   check('frames-continue-during-movement',last.frames>samples[0].frames+10,{first:samples[0].frames,last:last.frames});
   // A small real resize must also keep the stream and renderer alive.
   win.setSize(bounds.width-12,bounds.height-8);await sleep(600);const resized=await inspect();
   check('resize-scales-without-engine-reload',api.state().runtimePid===pid&&resized.live);
   win.setBounds(bounds);await sleep(400);
   fs.writeFileSync(path.join(folder,'composed-after.png'),(await win.webContents.capturePage()).toPNG());
   await win.webContents.executeJavaScript(`document.getElementById('zwn-button').click()`);await sleep(1800);
   const panel=api.getPanel();check('settings-still-opens',!!panel&&!panel.isDestroyed());
   if(panel){await panel.webContents.executeJavaScript(`document.querySelector('.presets').scrollIntoView({block:'center'})`);await sleep(150);fs.writeFileSync(path.join(folder,'settings.png'),(await panel.webContents.capturePage()).toPNG());}
   fs.writeFileSync(path.join(folder,'samples.json'),JSON.stringify(samples,null,2));
   fs.writeFileSync(path.join(folder,'done.json'),JSON.stringify({ok:true,checks,state:api.state()},null,2));
  }catch(error){fs.writeFileSync(path.join(folder,'done.json'),JSON.stringify({ok:false,error:error.stack,checks,state:api.state()},null,2));}
 }));
};
