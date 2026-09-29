import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, KnowledgeQaInput, ModelRequest, ResumeFile } from '../shared/types'

contextBridge.exposeInMainWorld('jobpilot', {
  getState: () => ipcRenderer.invoke('state:get') as Promise<AppState>,
  saveState: (state: AppState) => ipcRenderer.invoke('state:save', state) as Promise<void>,
  exportData: () => ipcRenderer.invoke('data:export') as Promise<{ canceled: boolean; path?: string; exportedAt?: string }>,
  importData: () => ipcRenderer.invoke('data:import') as Promise<{ canceled: boolean; path?: string; backupPath?: string; crossPlatform?: boolean; state?: AppState }>,
  saveModelApiKey: (apiKey: string) => ipcRenderer.invoke('secret:model:set', apiKey) as Promise<void>,
  clearModelApiKey: () => ipcRenderer.invoke('secret:model:clear') as Promise<void>,
  hasModelApiKey: () => ipcRenderer.invoke('secret:model:has') as Promise<boolean>,
  saveEmbeddingApiKey: (apiKey: string) => ipcRenderer.invoke('secret:embedding:set', apiKey) as Promise<void>,
  clearEmbeddingApiKey: () => ipcRenderer.invoke('secret:embedding:clear') as Promise<void>,
  saveNotificationWebhook: (webhookUrl: string) => ipcRenderer.invoke('secret:notification:set', webhookUrl) as Promise<void>,
  testNotificationWebhook: () => ipcRenderer.invoke('notification:test') as Promise<{ ok: boolean }>,
  sendNotification: (title: string, message: string) => ipcRenderer.invoke('notification:send', title, message) as Promise<{ ok: boolean; skipped?: boolean }>,
  testEmbedding: () => ipcRenderer.invoke('embedding:test') as Promise<{ provider: string; model: string; dimensions: number; latencyMs: number }>,
  callModel: (request: ModelRequest) => ipcRenderer.invoke('model:call', request) as Promise<string>,
  streamModel: (request: ModelRequest, onDelta: (delta: string) => void) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    return new Promise<string>((resolve, reject) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { requestId?: string; type?: string; delta?: string; content?: string; error?: string }) => {
        if (payload.requestId !== requestId) return
        if (payload.type === 'delta' && typeof payload.delta === 'string') {
          onDelta(payload.delta)
          return
        }
        ipcRenderer.removeListener('model:stream:event', listener)
        if (payload.type === 'done') resolve(payload.content || '')
        else reject(new Error(payload.error || '模型流式请求失败'))
      }
      ipcRenderer.on('model:stream:event', listener)
      ipcRenderer.send('model:stream', requestId, request)
    })
  },
  selectResume: () => ipcRenderer.invoke('resume:select') as Promise<ResumeFile | null>,
  readResume: (filename: string) => ipcRenderer.invoke('resume:read', filename) as Promise<ResumeFile>,
  importKnowledge: () => ipcRenderer.invoke('knowledge:import') as Promise<AppState>,
  deleteKnowledge: (documentId: string) => ipcRenderer.invoke('knowledge:delete', documentId) as Promise<AppState>,
  upsertKnowledgeQa: (input: KnowledgeQaInput) => ipcRenderer.invoke('knowledge:qa:upsert', input) as Promise<AppState>,
  rebuildEmbeddings: () => ipcRenderer.invoke('knowledge:rebuild') as Promise<AppState>,
  retryKnowledge: (documentId: string) => ipcRenderer.invoke('knowledge:retry', documentId) as Promise<AppState>,
  ragChat: (question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    ipcRenderer.invoke('knowledge:chat', question, history) as Promise<{ content: string; sources: string[] }>,
  syncBossChats: (forceRefreshOverview = false) => ipcRenderer.invoke('browser:chat-sync', forceRefreshOverview) as Promise<unknown>,
  syncBossConversation: (externalId: string, recruiter: string, company?: string) =>
    ipcRenderer.invoke('browser:chat-conversation-sync', externalId, recruiter, company) as Promise<unknown>,
  scanInterviewInvitations: (limit?: number) => ipcRenderer.invoke('browser:interview-scan', limit) as Promise<unknown>,
  sendBossConversation: (externalId: string, recruiter: string, company: string | undefined, message: string) =>
    ipcRenderer.invoke('browser:chat-send', externalId, recruiter, company, message) as Promise<unknown>,
  sendBossResume: (externalId: string, recruiter: string, company?: string, knownResumeSent?: boolean, proactive?: boolean) =>
    ipcRenderer.invoke('browser:resume-send', externalId, recruiter, company, knownResumeSent, proactive) as Promise<unknown>,
  openSystemChrome: (url: string) => ipcRenderer.invoke('browser:external', url) as Promise<void>,
  openLoginWindow: (url: string) => ipcRenderer.invoke('browser:login-window', url) as Promise<void>
})
