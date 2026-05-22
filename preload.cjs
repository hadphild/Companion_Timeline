const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveFile: (filePath, content) => ipcRenderer.invoke('dialog:saveFile', filePath, content),
  saveFileAs: (content) => ipcRenderer.invoke('dialog:saveFileAs', content),
  loadFromCompanion: () => ipcRenderer.invoke('companion:loadLive'),
  getActionLibrary: () => ipcRenderer.invoke('companion:getActionLibrary'),
  saveToCompanion: (content) => ipcRenderer.invoke('companion:saveLive', content),
  onCompanionChange: (cb) => {
    const wrapped = (_event, data) => cb(data)
    ipcRenderer.on('companion:changed', wrapped)
    return () => ipcRenderer.removeListener('companion:changed', wrapped)
  },
  saveSilent: (content) => ipcRenderer.invoke('companion:saveSilent', content),
  pausePolling: () => ipcRenderer.invoke('companion:pausePolling'),
  resumePolling: () => ipcRenderer.invoke('companion:resumePolling'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
})
