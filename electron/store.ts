import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { defaultState } from '../shared/defaults'
import type { AppState, AutomationSendRecord } from '../shared/types'
import { redactSensitive } from '../shared/security'

function dedupeAutomationSendHistory(records: AutomationSendRecord[]) {
  const result: AutomationSendRecord[] = []
  const ordered = [...records].sort((left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime())
  for (const record of ordered) {
    const sentAt = new Date(record.sentAt).getTime()
    const duplicate = result.find(existing =>
      existing.entityId === record.entityId &&
      Boolean(existing.contentFingerprint) &&
      existing.contentFingerprint === record.contentFingerprint &&
      Math.abs(new Date(existing.sentAt).getTime() - sentAt) < 10 * 60_000
    )
    if (!duplicate) result.push(record)
  }
  return result.sort((left, right) => new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime()).slice(0, 500)
}

function dataPath(filename: string) {
  return path.join(app.getPath('userData'), filename)
}

export function loadState(): AppState {
  const filename = dataPath('state.json')
  try {
    const saved = JSON.parse(fs.readFileSync(filename, 'utf8')) as Partial<AppState>
    const merged: AppState = {
      ...structuredClone(defaultState),
      ...saved,
      config: {
        ...defaultState.config,
        ...saved.config,
        target: { ...defaultState.config.target, ...saved.config?.target },
        automation: { ...defaultState.config.automation, ...saved.config?.automation },
        model: { ...defaultState.config.model, ...saved.config?.model },
        browser: { ...defaultState.config.browser, ...saved.config?.browser },
        notifications: { ...defaultState.config.notifications, ...saved.config?.notifications },
        rag: saved.config?.rag?.embeddingBaseUrl
          ? { ...defaultState.config.rag, ...saved.config.rag }
          : {
              ...defaultState.config.rag,
              chunkSize: saved.config?.rag?.chunkSize ?? defaultState.config.rag.chunkSize,
              chunkOverlap: saved.config?.rag?.chunkOverlap ?? defaultState.config.rag.chunkOverlap,
              topK: saved.config?.rag?.topK ?? defaultState.config.rag.topK,
              minimumScore: saved.config?.rag?.minimumScore ?? defaultState.config.rag.minimumScore
            }
      },
      profile: { ...defaultState.profile, ...saved.profile },
      knowledgeDocuments: saved.knowledgeDocuments || defaultState.knowledgeDocuments,
      knowledgeChunks: saved.knowledgeChunks || defaultState.knowledgeChunks,
      knowledgeQas: saved.knowledgeQas || defaultState.knowledgeQas,
      knowledgeChat: saved.knowledgeChat || defaultState.knowledgeChat,
      bossConversations: (saved.bossConversations || defaultState.bossConversations).map(conversation => ({
        ...conversation,
        followupCount: conversation.followupCount || 0
      })),
      automationSendHistory: dedupeAutomationSendHistory(saved.automationSendHistory || [])
    }
    merged.knowledgeDocuments = merged.knowledgeDocuments.map(document => {
      const normalize = (message?: string) => {
        if (!message) return undefined
        if (/向量请求失败 \((401|403)\)|Incorrect API key/i.test(message)) {
          return '向量接口鉴权失败。文档可重新解析并自动降级为关键词检索。'
        }
        return redactSensitive(message)
      }
      return { ...document, error: normalize(document.error), warning: normalize(document.warning) }
    })
    merged.activities = merged.activities.map(activity => ({ ...activity, message: redactSensitive(activity.message) }))
    fs.writeFileSync(filename, JSON.stringify(merged, null, 2), { mode: 0o600 })
    return merged
  } catch {
    return structuredClone(defaultState)
  }
}

export function saveState(state: AppState) {
  const filename = dataPath('state.json')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const cleanState = structuredClone(state)
  cleanState.automationSendHistory = dedupeAutomationSendHistory(cleanState.automationSendHistory)
  cleanState.knowledgeDocuments = cleanState.knowledgeDocuments.map(document => ({
    ...document,
    error: document.error ? redactSensitive(document.error) : undefined,
    warning: document.warning ? redactSensitive(document.warning) : undefined
  }))
  cleanState.activities = cleanState.activities.map(activity => ({ ...activity, message: redactSensitive(activity.message) }))
  fs.writeFileSync(filename, JSON.stringify({ ...cleanState, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
}

interface SecretFile {
  modelApiKey?: string
  embeddingApiKey?: string
  notificationWebhook?: string
}

export interface PortableDataBundle {
  format: 'jobpilot-data'
  version: 1
  exportedAt: string
  sourcePlatform: NodeJS.Platform
  appVersion: string
  state: AppState
  excluded: string[]
}

export function createPortableDataBundle(): PortableDataBundle {
  const state = structuredClone(loadState())
  // These flags describe credentials on the source machine; the credentials themselves never enter the bundle.
  state.config.model.apiKeyConfigured = false
  state.config.rag.embeddingApiKeyConfigured = false
  state.config.notifications.webhookConfigured = false
  return {
    format: 'jobpilot-data',
    version: 1,
    exportedAt: new Date().toISOString(),
    sourcePlatform: process.platform,
    appVersion: app.getVersion(),
    state,
    excluded: ['modelApiKey', 'embeddingApiKey', 'notificationWebhook', 'bossSession']
  }
}

export function parsePortableDataBundle(raw: string): PortableDataBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('迁移文件不是有效的 JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('迁移文件格式无效')
  const bundle = parsed as Partial<PortableDataBundle>
  if (bundle.format !== 'jobpilot-data' || bundle.version !== 1 || !bundle.state || typeof bundle.state !== 'object') {
    throw new Error('不是 JobPilot v1 数据迁移文件')
  }
  const state = bundle.state as Partial<AppState>
  for (const key of ['jobs', 'activities', 'knowledgeDocuments', 'knowledgeChunks', 'knowledgeQas', 'knowledgeChat', 'bossConversations', 'automationSendHistory'] as const) {
    if (!Array.isArray(state[key])) throw new Error(`迁移文件缺少 ${key} 数据`) 
  }
  return bundle as PortableDataBundle
}

export function backupCurrentState() {
  const source = dataPath('state.json')
  const backupDir = dataPath('migration-backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(backupDir, `state-${stamp}.json`)
  if (fs.existsSync(source)) fs.copyFileSync(source, target)
  else fs.writeFileSync(target, JSON.stringify(loadState(), null, 2), { mode: 0o600 })
  return target
}

export function mergePortableState(current: AppState, incoming: AppState, crossPlatform: boolean) {
  const merged: AppState = {
    ...current,
    ...structuredClone(incoming),
    config: {
      ...current.config,
      ...incoming.config,
      target: { ...current.config.target, ...incoming.config?.target },
      automation: { ...current.config.automation, ...incoming.config?.automation },
      model: { ...current.config.model, ...incoming.config?.model },
      browser: { ...current.config.browser, ...incoming.config?.browser },
      notifications: { ...current.config.notifications, ...incoming.config?.notifications },
      rag: { ...current.config.rag, ...incoming.config?.rag }
    }
  }
  merged.config.model.apiKeyConfigured = false
  merged.config.rag.embeddingApiKeyConfigured = false
  merged.config.notifications.webhookConfigured = false
  if (crossPlatform) {
    merged.profile.resumePath = ''
    if (merged.resumeDiagnosis) merged.resumeDiagnosis.path = ''
    merged.knowledgeDocuments = merged.knowledgeDocuments.map(document => ({
      ...document,
      path: '',
      warning: '此文档来自其他操作系统，原文件路径未迁移；如需重新解析，请在本机重新导入原文件。'
    }))
    merged.activities = [{
      id: `${Date.now()}-portable-import`,
      type: 'system' as const,
      message: '已导入跨平台数据。API Key、Webhook、BOSS 登录态和本机文件路径未迁移，请在本机重新配置、登录和选择简历/知识库原文件。',
      createdAt: new Date().toISOString()
    }, ...merged.activities].slice(0, 100)
  }
  merged.updatedAt = new Date().toISOString()
  return merged
}

function loadSecrets(): SecretFile {
  try {
    return JSON.parse(fs.readFileSync(dataPath('secrets.json'), 'utf8')) as SecretFile
  } catch {
    return {}
  }
}

function saveSecrets(secrets: SecretFile) {
  fs.writeFileSync(dataPath('secrets.json'), JSON.stringify(secrets, null, 2), { mode: 0o600 })
}

export function setModelApiKey(apiKey: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，未保存 API Key')
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64')
  saveSecrets({ ...loadSecrets(), modelApiKey: encrypted })
}

export function getModelApiKey() {
  const encrypted = loadSecrets().modelApiKey
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return process.env.OPENAI_API_KEY || ''
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

export function clearModelApiKey() {
  const secrets = loadSecrets()
  delete secrets.modelApiKey
  saveSecrets(secrets)
}

export function hasModelApiKey() {
  return Boolean(loadSecrets().modelApiKey || process.env.OPENAI_API_KEY)
}

export function setEmbeddingApiKey(apiKey: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，未保存向量 API Key')
  }
  const encrypted = safeStorage.encryptString(apiKey).toString('base64')
  saveSecrets({ ...loadSecrets(), embeddingApiKey: encrypted })
}

export function getEmbeddingApiKey() {
  const encrypted = loadSecrets().embeddingApiKey
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return process.env.SILICONFLOW_API_KEY || ''
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

export function clearEmbeddingApiKey() {
  const secrets = loadSecrets()
  delete secrets.embeddingApiKey
  saveSecrets(secrets)
}

export function hasEmbeddingApiKey() {
  return Boolean(loadSecrets().embeddingApiKey || process.env.SILICONFLOW_API_KEY)
}

export function setNotificationWebhook(webhookUrl: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，未保存 Webhook')
  }
  const encrypted = safeStorage.encryptString(webhookUrl).toString('base64')
  saveSecrets({ ...loadSecrets(), notificationWebhook: encrypted })
}

export function getNotificationWebhook() {
  const encrypted = loadSecrets().notificationWebhook
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return ''
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

export function hasNotificationWebhook() {
  return Boolean(loadSecrets().notificationWebhook)
}
