import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Companion Config',
      filters: [
        { name: 'Companion Config', extensions: ['companionconfig'] },
        { name: 'JSON', extensions: ['json'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    const content = readFileSync(filePath, 'utf-8')
    return { filePath, content }
  })

  ipcMain.handle('dialog:saveFile', async (_event, filePath: string, content: string) => {
    if (!filePath) {
      const result = await dialog.showSaveDialog({
        title: 'Save Companion Config',
        filters: [{ name: 'Companion Config', extensions: ['companionconfig'] }]
      })
      if (result.canceled || !result.filePath) return null
      filePath = result.filePath
    }
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  })

  ipcMain.handle('dialog:saveFileAs', async (_event, content: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Save Companion Config As',
      filters: [{ name: 'Companion Config', extensions: ['companionconfig'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, content, 'utf-8')
    return result.filePath
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
