// The find bar's page (page/find.js) searches the dashboard's page through the app (find.ts).
import { contextBridge, ipcRenderer } from 'electron'

type Result = { active: number; matches: number }

contextBridge.exposeInMainWorld('brigadeFind', {
  search: (text: string) => ipcRenderer.send('find:search', text),
  step: (forward: boolean) => ipcRenderer.send('find:step', forward),
  close: () => ipcRenderer.send('find:close'),
  onOpen: (handle: (text: string) => void) =>
    ipcRenderer.on('find:open', (_event, text: unknown) => handle(String(text ?? ''))),
  onResult: (handle: (result: Result) => void) =>
    ipcRenderer.on('find:result', (_event, result: Result) => handle(result)),
  onTheme: (handle: (dark: boolean) => void) =>
    ipcRenderer.on('find:theme', (_event, dark: unknown) => handle(dark !== false)),
})
