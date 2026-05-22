import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openFile: (): Promise<{ filePath: string; content: string } | null> =>
    ipcRenderer.invoke('dialog:openFile'),
  saveFile: (filePath: string, content: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', filePath, content),
  saveFileAs: (content: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFileAs', content)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
