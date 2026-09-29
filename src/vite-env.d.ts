/// <reference types="vite/client" />

import type { AppState, KnowledgeQaInput, ModelRequest, ResumeFile } from '../shared/types'

declare global {
  interface Window {
    jobpilot: {
      getState(): Promise<AppState>
      saveState(state: AppState): Promise<void>
      exportData(): Promise<{ canceled: boolean; path?: string; exportedAt?: string }>
      importData(): Promise<{ canceled: boolean; path?: string; backupPath?: string; crossPlatform?: boolean; state?: AppState }>
      saveModelApiKey(apiKey: string): Promise<void>
      clearModelApiKey(): Promise<void>
      hasModelApiKey(): Promise<boolean>
      saveEmbeddingApiKey(apiKey: string): Promise<void>
      clearEmbeddingApiKey(): Promise<void>
      saveNotificationWebhook(webhookUrl: string): Promise<void>
      testNotificationWebhook(): Promise<{ ok: boolean }>
      sendNotification(title: string, message: string): Promise<{ ok: boolean; skipped?: boolean }>
      testEmbedding(): Promise<{ provider: string; model: string; dimensions: number; latencyMs: number }>
      callModel(request: ModelRequest): Promise<string>
      streamModel(request: ModelRequest, onDelta: (delta: string) => void): Promise<string>
      selectResume(): Promise<ResumeFile | null>
      readResume(filename: string): Promise<ResumeFile>
      importKnowledge(): Promise<AppState>
      deleteKnowledge(documentId: string): Promise<AppState>
      upsertKnowledgeQa(input: KnowledgeQaInput): Promise<AppState>
      rebuildEmbeddings(): Promise<AppState>
      retryKnowledge(documentId: string): Promise<AppState>
      ragChat(question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<{ content: string; sources: string[] }>
      syncBossChats(forceRefreshOverview?: boolean): Promise<unknown>
      syncBossConversation(externalId: string, recruiter: string, company?: string): Promise<unknown>
      scanInterviewInvitations(limit?: number): Promise<unknown>
      sendBossConversation(externalId: string, recruiter: string, company: string | undefined, message: string): Promise<unknown>
      sendBossResume(externalId: string, recruiter: string, company?: string, knownResumeSent?: boolean, proactive?: boolean): Promise<unknown>
      openSystemChrome(url: string): Promise<void>
      openLoginWindow(url: string): Promise<void>
    }
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        useragent?: string
        allowpopups?: boolean
      }
    }
  }
}

export {}
