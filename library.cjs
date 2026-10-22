'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const LIMIT = 1024 * 1024;
const plainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeKey = k => !['__proto__', 'prototype', 'constructor'].includes(k);

function localPath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^[/\\]{2}/.test(value)) throw new Error('请选择本地绝对路径。');
  if (!path.isAbsolute(value)) throw new Error('路径必须是绝对路径。');
  const result = path.resolve(value);
  if (process.platform === 'win32' && result.slice(2).includes(':')) throw new Error('不支持此路径。');
  return result;
}
function assertPlain(value) {
  const full = localPath(value);
  let cursor = full;
  while (true) {
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error('不读取链接或重解析目录。');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return full;
}
function boundedText(file, max = LIMIT) {
  const full = assertPlain(file), stat = fs.statSync(full);
  if (!stat.isFile() || stat.size > max) throw new Error('文件过大或不是普通文件。');
  return fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
}
function normalizeProjectPath(value) {
  let full = assertPlain(value);
  if (fs.statSync(full).isDirectory()) full = assertPlain(path.join(full, 'project.json'));
  if (path.basename(full).toLowerCase() !== 'project.json') throw new Error('请选择 project.json 项目文件。');
  return full;
}
function assetCandidate(directory, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[a-z]+:/i.test(value)) return '';
  const full = path.resolve(directory, value.replace(/[\\/]/g, path.sep));
  const relative = path.relative(directory, full);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return '';
  return full;
}
function resolveAsset(directory, value) {
  const full = assetCandidate(directory, value);
  if (!full) return '';
  try { assertPlain(full); return fs.statSync(full).isFile() ? full : ''; } catch { return ''; }
}
function missingPlainAsset(directory, value) {
  const full=assetCandidate(directory,value);
  if (!full) return false;
  try {fs.lstatSync(full);return false;} catch(error) {if(error.code!=='ENOENT')return false;}
  // A packaged scene may retain an absent source filename. Still reject links
  // in its existing ancestors before accepting scene.pkg as its payload.
  let cursor=path.dirname(full);
  while (true) {
    try {assertPlain(cursor);return true;} catch(error) {if(error.code!=='ENOENT')return false;}
    const parent=path.dirname(cursor);if(parent===cursor)return false;cursor=parent;
  }
}
function readProject(projectPath) {
  const full = normalizeProjectPath(projectPath);
  const data = JSON.parse(boundedText(full));
  if (!plainObject(data)) throw new Error('项目元数据格式无效。');
  return {full, data, directory: path.dirname(full)};
}
function engineExecutable(value) {
  if (!value) return '';
  try {
    const full = assertPlain(value);
    const candidates = fs.statSync(full).isDirectory() ? ['wallpaper64.exe', 'wallpaper32.exe'].map(n => path.join(full, n)) : [full];
    for (const file of candidates) {
      if (!/^wallpaper(?:32|64)\.exe$/i.test(path.basename(file))) continue;
      try { assertPlain(file); if (fs.statSync(file).isFile()) return file; } catch {}
    }
  } catch {}
  return '';
}
function discover(options = {}) {
  const warnings = [], entries = [], libraries = new Set(), roots = [], seen = new Set();
  const addLibrary = value => { try { const full = assertPlain(value); if (fs.statSync(full).isDirectory() && libraries.size < 64) libraries.add(full); } catch {} };
  let enginePath = engineExecutable(options.enginePath);
  if (enginePath) {
    let ancestor = path.dirname(enginePath);
    for (let i = 0; i < 6; i++, ancestor = path.dirname(ancestor)) if (path.basename(ancestor).toLowerCase() === 'steamapps') { addLibrary(path.dirname(ancestor)); break; }
  }
  if (Array.isArray(options.steamRoots)) options.steamRoots.slice(0, 64).forEach(addLibrary);
  else {
    for (const name of ['ProgramFiles(x86)', 'ProgramFiles']) if (process.env[name]) addLibrary(path.join(process.env[name], 'Steam'));
    if (process.platform === 'win32') {
      for (const [key, field] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath']]) {
        try {
          const result = execFileSync('reg.exe', ['query', key, '/v', field], {encoding:'utf8', windowsHide:true, timeout:1500, maxBuffer:65536});
          const match = result.match(/REG_SZ\s+([^\r\n]+)/); if (match) addLibrary(match[1].trim());
        } catch {}
      }
    }
  }
  for (const library of [...libraries]) for (const rel of ['steamapps/libraryfolders.vdf', 'config/libraryfolders.vdf']) {
    try { for (const match of boundedText(path.join(library, rel), 2 * LIMIT).matchAll(/"(?:path|\d+)"\s*"([^"\r\n]+)"/gi)) addLibrary(match[1].replace(/\\\\/g, '\\')); } catch {}
  }
  if (!enginePath) for (const library of libraries) { enginePath = engineExecutable(path.join(library, 'steamapps', 'common', 'wallpaper_engine')); if (enginePath) break; }
  if (enginePath) for (const [folder, source] of [['defaultprojects', '内置'], ['myprojects', '我的项目']]) roots.push({folder:path.join(path.dirname(enginePath), 'projects', folder), source});
  else warnings.push('未找到 Wallpaper Engine，请选择安装目录。');
  for (const library of libraries) roots.push({folder:path.join(library, 'steamapps', 'workshop', 'content', '431960'), source:'创意工坊'});
  let count = 0, skipped = 0;
  for (const root of roots) {
    let children; try { children = fs.readdirSync(assertPlain(root.folder), {withFileTypes:true}); } catch { continue; }
    for (const child of children) {
      if (++count > 12000) break;
      if (!child.isDirectory() || child.isSymbolicLink() || child.name.toLowerCase().includes('.zcode-native-wallpaper-runtime')) continue;
      try {
        const {full, data, directory} = readProject(path.join(root.folder, child.name, 'project.json'));
        const key = process.platform === 'win32' ? full.toLowerCase() : full;
        if (seen.has(key)) continue; seen.add(key);
        let payload = resolveAsset(directory, data.file);
        if (!payload && String(data.type).toLowerCase()==='scene' && missingPlainAsset(directory,data.file)) payload=resolveAsset(directory,'scene.pkg');
        const type = String(data.type || ({'.pkg':'scene', '.mp4':'video', '.webm':'video', '.html':'web'}[path.extname(payload).toLowerCase()] || '')).toLowerCase();
        if (!payload || !['scene', 'video', 'web'].includes(type)) { skipped++; continue; }
        let previewPath = resolveAsset(directory, data.preview);
        if (previewPath && (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(previewPath) || fs.statSync(previewPath).size > 8 * LIMIT)) previewPath = '';
        entries.push({title:String(data.title || child.name).slice(0, 300), projectPath:full, previewPath, type, source:root.source});
      } catch { skipped++; }
    }
    if (count > 12000) break;
  }
  if (count > 12000) warnings.push('已达到 12000 个目录扫描上限，可直接选择项目文件。');
  if (skipped) warnings.push(`已跳过 ${skipped} 个不完整或不支持的项目。`);
  entries.sort((a,b) => a.title.localeCompare(b.title, 'zh-CN'));
  return {enginePath, entries, warnings};
}
function normalizeValue(def, value) {
  switch (def.type) {
    case 'bool': if (typeof value === 'boolean') return value; break;
    case 'slider': if (typeof value === 'number' && Number.isFinite(value) && value >= def.min && value <= def.max) return value; break;
    case 'text': if (typeof value === 'string' && value.length <= 8192 && !value.includes('\0')) return value; break;
    case 'combo': if (def.options.some(o => o.value === value)) return value; break;
    case 'color': {
      if (typeof value !== 'string') break;
      const parts = /^#[\da-f]{6}$/i.test(value) ? [1,3,5].map(i => parseInt(value.slice(i,i+2),16)/255) : value.trim().split(/\s+/).map(Number);
      if (parts.length === 3 && parts.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return parts.map(v => Number(v.toFixed(8))).join(' ');
      break;
    }
  }
  throw new Error(`请检查「${def.label}」的内容或范围。`);
}
function readProjectProperties(projectPath) {
  const {data} = readProject(projectPath), properties = [];
  const source = data.general?.properties;
  if (plainObject(source)) for (const [key, schema] of Object.entries(source).slice(0,500)) {
    if (!safeKey(key) || !plainObject(schema)) continue;
    // WE's "text" is a static heading. Only textinput is an editable text property.
    const type = schema.type === 'textinput' ? 'text' : schema.type;
    if (!['bool', 'slider', 'color', 'text', 'combo'].includes(type) || schema.type === 'text') continue;
    const finite = (v,f) => typeof v === 'number' && Number.isFinite(v) ? v : f;
    const propertyLabels={ui_browse_properties_scheme_color:'主题颜色',ui_browse_properties_playbackrate:'播放速度',ui_browse_properties_playbackspeed:'播放速度',ui_browse_properties_volume:'音量',ui_browse_properties_audioprocessing:'音频响应',ui_browse_properties_user_properties:'壁纸参数',ui_browse_properties_alignment:'对齐方式',ui_browse_properties_fps:'帧率',ui_browse_properties_brightness:'亮度',ui_browse_properties_contrast:'对比度',ui_browse_properties_saturation:'饱和度'};
    const rawLabel=String(schema.text || key);
    const def = {key,label:(propertyLabels[rawLabel]||rawLabel).slice(0,300),type,value:schema.value,min:finite(schema.min,0),max:finite(schema.max,100),step:finite(schema.step,0),order:finite(schema.order,properties.length),options:[]};
    if (def.max <= def.min) def.max = def.min + 1;
    if (def.step <= 0) def.step = Math.pow(10, -Math.max(0, Math.min(6, finite(schema.precision,0))));
    if (Array.isArray(schema.options)) def.options = schema.options.slice(0,200).filter(o => plainObject(o) && ['string','number','boolean'].includes(typeof o.value)).map(o => ({label:String(o.label ?? o.value).slice(0,300),value:o.value}));
    if (type === 'combo' && !def.options.length) continue;
    try { def.value = normalizeValue(def, def.value); } catch { def.value = type === 'bool' ? false : type === 'slider' ? def.min : type === 'color' ? '1 1 1' : type === 'combo' ? def.options[0].value : ''; }
    properties.push(def);
  }
  properties.sort((a,b) => a.order - b.order);
  return {title:String(data.title || ''), properties};
}
function validatePropertyValues(properties, values) {
  if (!Array.isArray(properties) || !plainObject(values)) throw new Error('壁纸参数格式无效。');
  const definitions = new Map(properties.map(d => [d.key,d])), result = {};
  for (const [key,value] of Object.entries(values)) {
    if (!safeKey(key) || !definitions.has(key)) throw new Error(`不支持的壁纸参数：${key}`);
    result[key] = normalizeValue(definitions.get(key),value);
  }
  return result;
}
const defaults = () => ({enabled:false,enginePath:'',projectPath:'',fps:60,opacity:0.64,dim:0.12,theme:'system',perProjectValues:{}});
function validateConfig(value) {
  if (!plainObject(value)) throw new Error('配置格式无效。');
  const result = defaults();
  for (const key of Object.keys(result)) if (Object.hasOwn(value,key)) result[key] = value[key];
  if (typeof result.enabled !== 'boolean') throw new Error('启用状态无效。');
  if (!Number.isInteger(result.fps) || result.fps < 10 || result.fps > 120) throw new Error('帧率上限必须是 10 到 120 之间的整数。');
  for (const key of ['enginePath','projectPath']) { if (typeof result[key] !== 'string') throw new Error('路径格式无效。'); if (result[key]) result[key] = localPath(result[key]); }
  if (typeof result.opacity !== 'number' || !Number.isFinite(result.opacity) || result.opacity < 0 || result.opacity > 1) throw new Error('内容底色不透明度必须在 0 到 1 之间。');
  if (typeof result.dim !== 'number' || !Number.isFinite(result.dim) || result.dim < 0 || result.dim > 0.6) throw new Error('背景压暗必须在 0 到 0.6 之间。');
  if (!['dark','light','system'].includes(result.theme)) throw new Error('主题无效。');
  if (!plainObject(result.perProjectValues) || Object.keys(result.perProjectValues).length > 200) throw new Error('项目参数数量无效。');
  const saved = {};
  for (const [key, values] of Object.entries(result.perProjectValues)) {
    const full = localPath(key);
    if (!plainObject(values) || Object.keys(values).length > 500) throw new Error('项目参数格式无效。');
    const clean = {};
    for (const [name, item] of Object.entries(values)) {
      if (!safeKey(name) || !['boolean','string','number'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)) || (typeof item === 'string' && (item.length > 8192 || item.includes('\0')))) throw new Error('项目参数值无效。');
      clean[name] = item;
    }
    saved[full] = clean;
  }
  result.perProjectValues = saved;
  return result;
}
class ConfigStore {
  constructor(baseDir) { this.baseDir = localPath(baseDir); this.filePath = path.join(this.baseDir,'config.json'); }
  load() {
    try {
      const saved = JSON.parse(boundedText(this.filePath, 2 * LIMIT));
      // Earlier builds accepted 121–144 FPS. Migrate only that historical
      // range when reading; new writes still enforce the supported 120 cap.
      if (plainObject(saved) && Number.isInteger(saved.fps) && saved.fps > 120 && saved.fps <= 144) saved.fps = 120;
      return validateConfig(saved);
    }
    catch (error) { if (error.code === 'ENOENT') return defaults(); throw new Error('独立壁纸配置无法读取：' + error.message); }
  }
  save(patch) {
    if (!plainObject(patch)) throw new Error('配置更新格式无效。');
    for (const key of Object.keys(patch)) if (!Object.hasOwn(defaults(),key)) throw new Error(`未知配置项：${key}`);
    const next = validateConfig({...this.load(), ...patch}), json = JSON.stringify(next,null,2) + '\n';
    if (Buffer.byteLength(json) > 2 * LIMIT) throw new Error('配置文件过大。');
    fs.mkdirSync(this.baseDir,{recursive:true}); assertPlain(this.baseDir);
    const temp = path.join(this.baseDir,`.config-${process.pid}-${require('node:crypto').randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp,'wx',0o600);
      try { fs.writeFileSync(fd,json,'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp,this.filePath);
    } finally { try { fs.unlinkSync(temp); } catch {} }
    return next;
  }
}
module.exports = {discover, readProjectProperties, validatePropertyValues, ConfigStore, normalizeProjectPath, resolveAsset};
