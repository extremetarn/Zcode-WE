'use strict';
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const path = require('node:path');

class NativeClient extends EventEmitter {
  constructor(executable = path.join(__dirname,'native','bin','ZCodeWallpaperHost.exe')) {
    super(); this.executable=executable; this.sequence=0; this.pending=new Map(); this.child=null; this.state={state:'stopped'};
  }
  ensureProcess() {
    if(this.child) return;
    const child=spawn(this.executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child; let buffer='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.length>2*1024*1024){child.kill();return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end).replace(/^\uFEFF/,'');buffer=buffer.slice(end+1);if(!line.trim())continue;
        let message;try{message=JSON.parse(line);}catch{this.emit('diagnostic','Invalid helper response');continue;}
        if(message.state){const changed=message.event==='state'||message.state!==this.state.state;this.state=message;if(changed)this.emit('state',message);}
        if(message.id!=null && this.pending.has(message.id)){
          const request=this.pending.get(message.id);this.pending.delete(message.id);clearTimeout(request.timer);
          message.ok===false?request.reject(new Error(message.error||'原生背景启动失败')):request.resolve(message);
        }
      }
    });
    child.stderr.on('data',chunk=>this.emit('diagnostic',String(chunk).trim()));
    const fail=error=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();};
    child.on('error',error=>{fail(error);this.state={state:'error',error:error.message};this.emit('state',this.state);});
    child.on('exit',(code,signal)=>{if(this.child===child)this.child=null;fail(new Error('原生背景进程已退出'));this.state={state:'stopped',code,signal};this.emit('state',this.state);});
    child.stdin.on('error',()=>{});
  }
  request(command,fields={}) {
    this.ensureProcess();const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('原生背景响应超时'));},15000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({...fields,id,command})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
    });
  }
  close() {
    if(!this.child)return;
    const child=this.child;
    child.stdin.end(); // EOF is the lifetime boundary; helper disposes its Windows Job.
    const timer=setTimeout(()=>{if(this.child===child)child.kill();},2500);timer.unref();
  }
}
module.exports={NativeClient};
