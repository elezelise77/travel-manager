/* 화면(ui/app.html)과 본체(main.js)를 잇는 다리.
 * 화면 쪽에서는 여기 적힌 것만 쓸 수 있습니다. (보안상 파일 접근은 막혀 있습니다) */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trip', {
  getConfig : ()        => ipcRenderer.invoke('config:get'),
  setConfig : (cfg)     => ipcRenderer.invoke('config:set', cfg),
  api       : (url, p)  => ipcRenderer.invoke('api:call', { url, payload: p }),
  openUrl   : (url)     => ipcRenderer.invoke('shell:open', url),
  openGuide : ()        => ipcRenderer.invoke('shell:guide'),
  copy      : (text)    => ipcRenderer.invoke('clip:write', text),
  saveBackup: (name, d) => ipcRenderer.invoke('file:saveBackup', { name, data: d }),

  copyCode   : (which)     => ipcRenderer.invoke('code:copy', which),
  codeVersion: ()          => ipcRenderer.invoke('code:version'),
  roomWindow: (url, title) => ipcRenderer.invoke('room:window', { url, title }),
  clearCache: ()           => ipcRenderer.invoke('cache:clear'),
  info      : ()           => ipcRenderer.invoke('app:info'),
  onFrameFail: (fn)        => ipcRenderer.on('frame:fail', (_e, d) => fn(d))
});
