// The setup checklist's page (page/setup.js) asks for its steps and runs their actions.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('brigadeSetup', {
  state: () => ipcRenderer.invoke('setup:state'),
  action: (id: string) => ipcRenderer.invoke('setup:action', id),
})
