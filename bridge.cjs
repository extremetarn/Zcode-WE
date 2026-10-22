'use strict';
// Loaded once by the guarded local main-process adapter. No debug port or web server.
const {app,BrowserWindow,ipcMain,screen,dialog,nativeTheme} = require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {NativeClient}=require('./native-client.cjs');
const {startBackground,revealBackground,stopBackground,backgroundStatus}=require('./background.cjs');
const {discover,readProjectProperties,validatePropertyValues,ConfigStore}=require('./library.cjs');
const base=process.env.ZWN_DATA_DIR||path.join(app.getPath('appData'),'ZCodeNativeWallpaper');
const store=new ConfigStore(base);
let config;try{config=store.load();}catch{config={enabled:false,enginePath:'',projectPath:'',opacity:.82,theme:'system',perProjectValues:{}};}
const hosts=new Map();
let panel=null,activeWindow=null;
const log=(message)=>{try{fs.mkdirSync(base,{recursive:true});fs.appendFileSync(path.join(base,'runtime.log'),`${new Date().toISOString()} ${message}\n`);}catch{}};

const {buildAppearanceCss}=require('./appearance.cjs');
function cssFor(){return buildAppearanceCss(config);}
const buttonScript=`(()=>{if(document.getElementById('zwn-button'))return;const b=document.createElement('button');b.id='zwn-button';b.type='button';b.title='壁纸与外观';b.setAttribute('aria-label','壁纸与外观');b.innerHTML='<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="8" cy="8" r="1.3"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>';b.style.cssText='position:fixed;right:22px;bottom:22px;width:46px;height:46px;display:grid;place-items:center;border:1px solid #ffffff30;border-radius:16px;background:#222b3ced;color:#e5edf8;box-shadow:0 6px 24px #0004;z-index:2147483646;cursor:pointer;backdrop-filter:blur(12px);-webkit-app-region:no-drag';b.onclick=()=>window.zcodeWallpaper?.open();document.body.append(b)})()`;
function isMain(win){return !win.isDestroyed()&&(/[/\\]out[/\\]renderer[/\\]index\.html/.test(win.webContents.getURL()) || (process.env.ZWN_DEMO==='1'&&win.webContents.getURL().endsWith('/demo/index.html')));}
function physicalRect(win){return screen.dipToScreenRect(win,win.getBounds());}
function hwnd(win){const buf=win.getNativeWindowHandle();return (buf.length===8?buf.readBigUInt64LE():BigInt(buf.readUInt32LE())).toString();}
function visible(win){return !win.isDestroyed()&&win.isVisible()&&!win.isMinimized();}
function state(){const h=activeWindow&&hosts.get(activeWindow.id);const native=h?.client?.state;const current=native?.state==='ready'?{...native,state:h.captureStatus||'preparing',error:h.captureError||''}:native;return {...(current||{state:'stopped'}),enabled:config.enabled,projectPath:config.projectPath,message:current?.error||({ready:'实时壁纸正在运行',preparing:'正在连接实时画面…',stopped:'壁纸已关闭'}[current?.state]||'选择壁纸后开启')};}
function broadcast(){if(panel&&!panel.isDestroyed())panel.webContents.send('zwn:state',state());}
async function disconnectCapture(host){const revision=host.captureRevision=(host.captureRevision||0)+1;host.captureStatus='stopped';host.captureError='';if(!host.win.isDestroyed())await host.win.webContents.executeJavaScript(`(${stopBackground.toString()})()`).catch(()=>{});return revision;}
async function connectCapture(host){
 const win=host.win,client=host.client;if(win.isDestroyed()||!client)return;
 const revision=host.captureRevision=(host.captureRevision||0)+1;
 const source=client.state.captureHwnd;if(!source||source==='0')throw Error('原生壁纸未提供画面窗口');
 host.captureStatus='preparing';host.captureError='';broadcast();
 try{
  const sourceId='window:'+source+':0';
  const details=await win.webContents.executeJavaScript(`(${startBackground.toString()})(${JSON.stringify(sourceId)},{deferReveal:true,fps:${JSON.stringify(config.fps??60)}})`);
  if(win.isDestroyed()||host.client!==client||host.captureRevision!==revision)return;
  if(details.superseded)throw Error('壁纸画面连接已中断');
  const parked=await client.request('capture-attached',{captureHwnd:source});
  if(win.isDestroyed()||host.client!==client||host.captureRevision!==revision)return;
  if(!parked.captureParked)throw Error('壁纸采集窗口未完成光标隔离');
  const shown=await win.webContents.executeJavaScript(`(${revealBackground.toString()})(${JSON.stringify(sourceId)})`);
  if(win.isDestroyed()||host.client!==client||host.captureRevision!==revision)return;
  if(shown.superseded)throw Error('壁纸画面连接已中断');
  host.captureStatus='ready';await applyStyle(host,true);broadcast();
 }catch(error){
  if(host.captureRevision!==revision||host.client!==client)return;
  const cleanupRevision=await disconnectCapture(host);
  // Renderer IPC can settle after another source has already connected.
  if(win.isDestroyed()||host.captureRevision!==cleanupRevision||host.client!==client)return;
  host.captureStatus='error';host.captureError=error.message;log(error.message);await applyStyle(host,false);broadcast();
 }
}
async function applyStyle(host,enabled){
 const win=host.win;if(win.isDestroyed())return;
 const revision=host.styleRevision=(host.styleRevision||0)+1;
 const previous=host.css;host.css=null;
 if(previous)await win.webContents.removeInsertedCSS(previous).catch(()=>{});
 if(revision!==host.styleRevision||win.isDestroyed())return;
 // Video and UI share Chromium's composition surface. Never expose a second
 // desktop window while loading or moving the app.
 win.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#171b23':'#f8f9fc');
 if(enabled){const key=await win.webContents.insertCSS(cssFor(),{cssOrigin:'user'});if(revision===host.styleRevision)host.css=key;else await win.webContents.removeInsertedCSS(key).catch(()=>{});}
}
async function applyHost(host,restart=true){
 const win=host.win;if(win.isDestroyed()||!isMain(win))return;
 if(!config.enabled||!config.projectPath||!config.enginePath){if(host.client){host.client.close();host.client=null;}await disconnectCapture(host);await applyStyle(host,false);broadcast();return;}
 // WE web screensavers have a global IPC channel; run one owned renderer at a time.
 for(const other of hosts.values())if(other!==host&&other.client){other.client.close();other.client=null;await disconnectCapture(other);await applyStyle(other,false);}
 activeWindow=win;
 if(!host.client){const client=new NativeClient();host.client=client;client.on('state',()=>{if(host.client!==client)return;broadcast();if(['error','stopped','idle','preparing'].includes(client.state.state)){disconnectCapture(host).then(revision=>{if(!win.isDestroyed()&&host.client===client&&host.captureRevision===revision)return applyStyle(host,false);}).catch(()=>{});}else if(client.state.state==='ready')connectCapture(host).catch(error=>log(error.message));});client.on('diagnostic',log);}
 if(!restart&&host.client.state.state==='ready'){if(host.captureStatus==='ready')await applyStyle(host,true);else await connectCapture(host);return;}
 if(!restart&&host.client.state.state==='preparing')return;
 await applyStyle(host,false);
 try{await host.client.request('start',{presentation:'capture',fps:config.fps??60,enginePath:config.enginePath,projectPath:config.projectPath,values:config.perProjectValues?.[config.projectPath]||{},targetHwnd:hwnd(win),rect:physicalRect(win)});await host.client.request('layout',{rect:physicalRect(win),visible:visible(win)});}catch(error){log(error.message);host.client.state={state:'error',error:error.message};broadcast();}
}
function syncLayout(host){if(!host.client||host.win.isDestroyed())return;host.client.request('layout',{rect:physicalRect(host.win),visible:visible(host.win)}).catch(error=>log(error.message));}
async function attach(win){
 if(!isMain(win))return;
 let host=hosts.get(win.id);
 if(!host){host={win,client:null,css:null};hosts.set(win.id,host);
  // The native helper reads the HWND's physical rectangle itself, including
  // during Windows' modal drag loop. DIP round trips must not drive resizing.
  for(const event of ['minimize','restore','show','hide'])win.on(event,()=>syncLayout(host));
  win.on('focus',()=>{activeWindow=win;syncLayout(host);});
  win.once('closed',()=>{host.client?.close();hosts.delete(win.id);if(activeWindow===win)activeWindow=null;if(panel&&!panel.isDestroyed())panel.close();});
  host.mediaTimer=setInterval(async()=>{if(win.isDestroyed()){clearInterval(host.mediaTimer);return;}if(host.captureStatus!=='ready'||host.checkingMedia)return;host.checkingMedia=true;const revision=host.captureRevision,client=host.client;try{const result=await win.webContents.executeJavaScript(`(${backgroundStatus.toString()})()`);if(revision!==host.captureRevision||client!==host.client)return;if(!result.live&&host.captureStatus==='ready'){host.captureStatus='error';host.captureError=result.error||'壁纸画面连接已中断';await applyStyle(host,false);broadcast();}}catch{}finally{host.checkingMedia=false;}},1500);host.mediaTimer.unref();
 }
 activeWindow=win;
 await win.webContents.executeJavaScript(buttonScript).catch(error=>log(error.message));
 await applyHost(host);
}
function openPanel(win){
 activeWindow=win;
 if(panel&&!panel.isDestroyed()){panel.show();panel.focus();return;}
 const bounds=win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
 const width=Math.min(450,area.width),height=Math.min(720,area.height-30);
 panel=new BrowserWindow({width,height,x:Math.max(area.x,Math.min(bounds.x+bounds.width-width-16,area.x+area.width-width)),y:Math.max(area.y,Math.min(bounds.y+bounds.height-height-72,area.y+area.height-height)),parent:win,show:false,frame:false,resizable:true,minWidth:360,minHeight:420,skipTaskbar:true,backgroundColor:'#121722',title:'壁纸与外观',webPreferences:{preload:path.join(__dirname,'settings-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 panel.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 panel.webContents.on('will-navigate',event=>event.preventDefault());
 panel.once('ready-to-show',()=>panel?.show());panel.once('closed',()=>{panel=null;});
 panel.loadFile(path.join(__dirname,'settings.html')).catch(error=>log(error.message));
}
function trusted(event){if(!panel||panel.isDestroyed()||event.sender!==panel.webContents)throw new Error('不允许此来源访问壁纸设置');}
ipcMain.on('zwn:open',event=>{const win=BrowserWindow.fromWebContents(event.sender);if(win&&hosts.has(win.id))openPanel(win);});
ipcMain.handle('zwn:get',(event,options={})=>{trusted(event);const project=options.projectPath||config.projectPath;let properties=[],warning='';try{if(project)properties=readProjectProperties(project).properties;}catch(error){warning=error.message;}return {config,properties,warning};});
ipcMain.handle('zwn:list',async(event,options={})=>{trusted(event);return discover({enginePath:options.enginePath||config.enginePath});});
ipcMain.handle('zwn:status',event=>{trusted(event);return state();});
ipcMain.handle('zwn:close',event=>{trusted(event);panel.close();});
ipcMain.handle('zwn:pick',async event=>{trusted(event);const result=await dialog.showOpenDialog(panel,{title:'选择 Wallpaper Engine 程序',properties:['openFile'],filters:[{name:'Wallpaper Engine',extensions:['exe']}]});return result.canceled?null:result.filePaths[0];});
ipcMain.handle('zwn:save',async(event,patch)=>{
 trusted(event);if(!patch||typeof patch!=='object')throw new Error('设置格式无效');
 const next={...config,...patch};
 if(next.projectPath){const properties=readProjectProperties(next.projectPath).properties;if(patch.perProjectValues){patch.perProjectValues={...config.perProjectValues,...patch.perProjectValues,[next.projectPath]:validatePropertyValues(properties,patch.perProjectValues[next.projectPath]||{})};}}
 if(next.enabled&&(!next.projectPath||!next.enginePath))throw new Error('请先选择 Wallpaper Engine 和壁纸');
 const restart=['enabled','enginePath','projectPath','fps'].some(key=>next[key]!==config[key]) || JSON.stringify(next.perProjectValues?.[next.projectPath]||{})!==JSON.stringify(config.perProjectValues?.[config.projectPath]||{});
 config=store.save(patch);
 if(activeWindow&&!activeWindow.isDestroyed())await applyHost(hosts.get(activeWindow.id),restart);
 broadcast();return {config,...state()};
});
app.on('browser-window-created',(_event,win)=>{win.webContents.on('did-finish-load',()=>attach(win).catch(error=>log(error.stack)));});
app.on('before-quit',()=>{for(const host of hosts.values())host.client?.close();});
app.whenReady().then(()=>{for(const win of BrowserWindow.getAllWindows())attach(win).catch(error=>log(error.stack));});
log('Bridge loaded: stdio IPC, native renderer, no listening ports.');
module.exports={cssFor};
if(process.env.ZWN_VERIFY_DIR){require('./test/live-probe.cjs').install({app,BrowserWindow,hosts,openPanel,getPanel:()=>panel,state,base});}
if(process.env.ZWN_MOTION_VERIFY_DIR){require('./test/motion-probe.cjs').install({app,BrowserWindow,hosts,openPanel,getPanel:()=>panel,state,base});}
