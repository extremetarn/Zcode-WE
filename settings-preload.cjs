'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Deliberately expose named operations only. The page cannot choose IPC channels.
contextBridge.exposeInMainWorld('wallpaper', Object.freeze({
  get: (options = {}) => ipcRenderer.invoke('zwn:get', {projectPath: options.projectPath}),
  list: (options = {}) => ipcRenderer.invoke('zwn:list', {enginePath: options.enginePath}),
  save: patch => ipcRenderer.invoke('zwn:save', patch),
  pick: () => ipcRenderer.invoke('zwn:pick'),
  status: () => ipcRenderer.invoke('zwn:status'),
  close: () => ipcRenderer.invoke('zwn:close'),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('需要状态回调。');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('zwn:state', listener);
    return () => ipcRenderer.removeListener('zwn:state', listener);
  }
}));
