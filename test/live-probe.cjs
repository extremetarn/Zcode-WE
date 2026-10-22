'use strict';
// Local integration harness, enabled only by the explicit ZWN_VERIFY_DIR environment variable.
const fs=require('node:fs');const path=require('node:path');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
exports.install=api=>{
 const folder=path.resolve(process.env.ZWN_VERIFY_DIR);fs.mkdirSync(folder,{recursive:true});
 const quitTimer=setInterval(()=>{if(fs.existsSync(path.join(folder,'quit'))){clearInterval(quitTimer);api.app.quit();}},300);quitTimer.unref();
 let ran=false;
 const write=(name,data)=>fs.writeFileSync(path.join(folder,name),JSON.stringify(data,null,2));
 api.app.on('browser-window-created',(_event,win)=>win.webContents.on('did-finish-load',async()=>{
  if(ran||!win.webContents.getURL().includes('/out/renderer/index.html'))return;ran=true;
  const checks=[];const check=(name,pass,details)=>{checks.push({name,pass,details});write('results.json',{checks});if(!pass)throw Error(name);};
  try{
   for(let i=0;i<80&&!api.hosts.has(win.id);i++)await sleep(250);
   await sleep(1500);
   check('bridge-attached',api.hosts.has(win.id));
   check('no-debug-switch',!api.app.commandLine.hasSwitch('remote-debugging-port'));
   const surface=await win.webContents.executeJavaScript(`({button:!!document.getElementById('zwn-button'),api:typeof window.zcodeWallpaper?.open==='function'})`);
   check('bottom-right-button',surface.button&&surface.api,surface);
   await win.webContents.executeJavaScript(`document.getElementById('zwn-button').click()`);
   for(let i=0;i<40&&!api.getPanel();i++)await sleep(100);
   const panel=api.getPanel();check('panel-opened',!!panel);await sleep(1700);
   check('panel-api',await panel.webContents.executeJavaScript(`typeof window.wallpaper?.list==='function'`));
   const catalog=await panel.webContents.executeJavaScript(`window.wallpaper.list()`);
   write('catalog.json',{enginePath:catalog.enginePath,count:catalog.entries.length,warnings:catalog.warnings});
   check('engine-discovered',!!catalog.enginePath);check('library-populated',catalog.entries.length>0);
   const previous=(await panel.webContents.executeJavaScript(`window.wallpaper.get()`)).config;
   const selected=catalog.entries.find(e=>e.projectPath===previous.projectPath)||catalog.entries.find(e=>e.title==='Shimmering Particles')||catalog.entries.find(e=>e.type==='scene');
   if(!selected)throw Error('No scene for live verification');
   const config={...previous,enabled:true,enginePath:catalog.enginePath,projectPath:selected.projectPath};
   await panel.webContents.executeJavaScript(`window.wallpaper.save(${JSON.stringify(config)})`);
   for(let i=0;i<100&&!['ready','error'].includes(api.state().state);i++)await sleep(400);
   check('native-ready',api.state().state==='ready',api.state());
   const firstPid=api.state().runtimePid;
   await panel.webContents.executeJavaScript(`window.wallpaper.save({opacity:0.44})`);await sleep(300);
   check('appearance-does-not-restart-renderer',api.state().state==='ready'&&api.state().runtimePid===firstPid);
   await panel.webContents.executeJavaScript(`window.wallpaper.save({opacity:${JSON.stringify(config.opacity)}})`);
   await sleep(2500);write('window.json',{bounds:win.getBounds(),hwnd:win.getNativeWindowHandle().readBigUInt64LE().toString(),state:api.state()});
   const computed=await win.webContents.executeJavaScript(`JSON.stringify({rootClass:document.documentElement.className,bodyClass:document.body.className,rootBg:getComputedStyle(document.documentElement).backgroundColor,token:getComputedStyle(document.documentElement).getPropertyValue('--color-background'),points:[[100,200],[500,200],[700,400]].map(([x,y])=>{let e=document.elementFromPoint(x,y),a=[];for(let i=0;e&&i<8;i++,e=e.parentElement)a.push({tag:e.tagName,classes:e.className,bg:getComputedStyle(e).backgroundColor,token:getComputedStyle(e).getPropertyValue('--color-background')});return a;})})`);write('computed-style.json',JSON.parse(computed));
   panel.webContents.reload();await sleep(1700);
   let panelState;for(let i=0;i<40;i++){panelState=await panel.webContents.executeJavaScript(`({state:document.getElementById('status').dataset.state,text:document.getElementById('status-text').textContent})`);if(panelState.state==='ready')break;await sleep(250);}
   check('settings-shows-live-status',panelState.state==='ready',panelState);
   fs.writeFileSync(path.join(folder,'settings.png'),(await panel.webContents.capturePage()).toPNG());
   await panel.webContents.executeJavaScript(`document.querySelector('.presets').scrollIntoView({block:'center'})`);
   fs.writeFileSync(path.join(folder,'settings-appearance.png'),(await panel.webContents.capturePage()).toPNG());
   // CapturePage sees Chromium composition only. Screen screenshots are checked separately.
   fs.writeFileSync(path.join(folder,'renderer.png'),(await win.webContents.capturePage()).toPNG());
   if(process.env.ZWN_VERIFY_QUICK==='1'){
    panel.hide();const wasTop=win.isAlwaysOnTop();win.setAlwaysOnTop(true);win.show();win.focus();await sleep(600);
    const capture=file=>require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'capture-window.ps1'),'-WindowHandle',win.getNativeWindowHandle().readBigUInt64LE().toString(),'-OutputFile',path.join(folder,file)],{windowsHide:true,timeout:15000});
    try{capture('screen-composited.png');await sleep(1300);capture('screen-next-frame.png');}finally{win.setAlwaysOnTop(wasTop);}
    const {nativeImage}=require('electron'),a=nativeImage.createFromPath(path.join(folder,'screen-composited.png')).toBitmap(),b=nativeImage.createFromPath(path.join(folder,'screen-next-frame.png')).toBitmap();let changed=0;for(let i=0;i<Math.min(a.length,b.length);i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>15)changed++;
    write('frame-comparison.json',{pixels:a.length/4,changed,ratio:changed/(a.length/4)});
    panel.show();write('done.json',{ok:true,checks,state:api.state(),windowBounds:win.getBounds()});return;
   }
   panel.hide();win.minimize();await sleep(700);check('minimized',win.isMinimized());
   const h=api.hosts.get(win.id);let status=await h.client.request('status');check('helper-hidden-on-minimize',status.visible===false,status);
   win.restore();await sleep(700);status=await h.client.request('status');check('helper-restored',status.visible===true,status);
   const bounds=win.getBounds();win.setSize(Math.max(800,bounds.width-70),Math.max(600,bounds.height-40));await sleep(1000);
   for(let i=0;i<80&&api.state().state!=='ready';i++)await sleep(400);
   check('resize-reconnected',api.state().state==='ready',api.state());
   win.setBounds(bounds);await sleep(1200);for(let i=0;i<80&&api.state().state!=='ready';i++)await sleep(400);
   const previousTop=win.isAlwaysOnTop();win.setAlwaysOnTop(true);win.show();win.focus();await sleep(800);
   const capture=()=>require('node:child_process').execFileSync('powershell.exe',['-NoProfile','-File',path.join(__dirname,'capture-window.ps1'),'-WindowHandle',win.getNativeWindowHandle().readBigUInt64LE().toString(),'-OutputFile',path.join(folder,'screen-composited.png')],{windowsHide:true,timeout:15000});
   try{capture();}finally{win.setAlwaysOnTop(previousTop);}
   panel.show();write('done.json',{ok:true,checks,state:api.state(),windowBounds:win.getBounds()});
  }catch(error){write('done.json',{ok:false,error:error.stack,checks,state:api.state()});}
 }));
};
