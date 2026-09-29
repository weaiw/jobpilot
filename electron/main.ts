import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppState, KnowledgeQaInput, ModelRequest } from '../shared/types'
import { callModel, ragChat, streamModel } from './model'
import { importKnowledgeFiles, readDocumentText, rebuildEmbeddings, retryKnowledgeDocument, testEmbeddingConnection, upsertKnowledgeQa } from './rag'
import {
  captchaDetectionScript,
  collectBossChatsScript,
  confirmBossReplyScript,
  confirmBossResumeSendScript,
  inspectBossActiveConversationScript,
  openBossConversationScript,
  prepareBossProactiveResumeSendScript,
  prepareBossResumeDialogSendScript,
  prepareBossResumeSelectionScript,
  prepareBossResumeSendScript,
  sendBossReplyScript
} from '../src/boss'
import {
  backupCurrentState,
  clearEmbeddingApiKey,
  clearModelApiKey,
  createPortableDataBundle,
  getNotificationWebhook,
  hasEmbeddingApiKey,
  hasModelApiKey,
  hasNotificationWebhook,
  loadState,
  mergePortableState,
  parsePortableDataBundle,
  saveState,
  setEmbeddingApiKey,
  setModelApiKey,
  setNotificationWebhook
} from './store'

app.setName('jobpilot-desktop')
if (process.platform === 'win32') app.setAppUserModelId('com.jobpilot.desktop')

let mainWindow: BrowserWindow | null = null
let chatSyncWindow: BrowserWindow | null = null
let chatWindowQueue = Promise.resolve()

function appendRuntimeLog(scope: string, detail: unknown) {
  try {
    const logPath = path.join(app.getPath('userData'), 'runtime.log')
    const message = detail instanceof Error ? (detail.stack || detail.message) : String(detail)
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${scope}: ${message}\n`, { mode: 0o600 })
  } catch {
    // Runtime logging must not create a second failure path.
  }
}

function pauseAutomationAfterRuntimeFailure(reason: string) {
  try {
    const state = loadState()
    if (state.automationPaused && state.pauseReason === reason) return
    state.automationPaused = true
    state.pauseReason = reason
    state.activities.unshift({
      id: `${Date.now()}-runtime-failure`,
      type: 'system',
      message: reason,
      createdAt: new Date().toISOString()
    })
    state.activities = state.activities.slice(0, 100)
    saveState(state)
  } catch (error) {
    appendRuntimeLog('pause-automation-failed', error)
  }
}

process.on('uncaughtException', error => {
  appendRuntimeLog('uncaught-exception', error)
  pauseAutomationAfterRuntimeFailure('客户端发生未捕获异常，自动化已暂停，请查看运行日志后再恢复。')
})
process.on('unhandledRejection', reason => appendRuntimeLog('unhandled-rejection', reason))
process.on('exit', code => appendRuntimeLog('process-exit', `code=${code}`))

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  appendRuntimeLog('second-instance-blocked', 'another JobPilot instance is already running')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

async function sendWebhookNotification(title: string, message: string, force = false) {
  const state = loadState()
  if (!force && !state.config.notifications.enabled) return { ok: true, skipped: true }
  const webhook = getNotificationWebhook()
  if (!webhook) throw new Error('请先保存通知 Webhook')
  let target: URL
  try {
    target = new URL(webhook)
  } catch {
    throw new Error('Webhook URL 格式无效')
  }
  if (!['https:', 'http:'].includes(target.protocol)) throw new Error('Webhook 只支持 HTTP 或 HTTPS 地址')
  const content = `【${title}】\n${message}\n${new Date().toLocaleString('zh-CN')}`
  const body = state.config.notifications.provider === 'feishu'
    ? { msg_type: 'text', content: { text: content } }
    : state.config.notifications.provider === 'wechat'
      ? { msgtype: 'text', text: { content } }
      : { title, message, timestamp: new Date().toISOString() }
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`Webhook 请求失败（${response.status}）`)
  const responseText = await response.text()
  try {
    const result = JSON.parse(responseText) as { code?: number; StatusCode?: number; errcode?: number; msg?: string; errmsg?: string }
    const code = result.code ?? result.StatusCode ?? result.errcode ?? 0
    if (code !== 0) throw new Error(result.msg || result.errmsg || `Webhook 返回错误码 ${code}`)
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: true }
    throw error
  }
  return { ok: true }
}

function enqueueChatWindowOperation<T>(operation: () => Promise<T>) {
  const result = chatWindowQueue.then(operation, operation)
  chatWindowQueue = result.then(() => undefined, () => undefined)
  return result
}

async function dispatchTrustedClick(window: BrowserWindow, point: { x: number; y: number }) {
  const protocol = window.webContents.debugger
  const attachedHere = !protocol.isAttached()
  if (attachedHere) protocol.attach('1.3')
  try {
    await protocol.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1
    })
    await protocol.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1
    })
  } finally {
    if (attachedHere && protocol.isAttached()) protocol.detach()
  }
}

async function waitForLoad(window: BrowserWindow, url: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BOSS 消息页加载超时')), 20_000)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    window.webContents.once('did-finish-load', done)
    window.loadURL(url).catch(error => {
      clearTimeout(timer)
      window.webContents.removeListener('did-finish-load', done)
      reject(error)
    })
  })
}

async function waitForBossConversationReady(
  target: { externalId: string; recruiter: string; company?: string },
  expectedPreview = '',
  timeoutMs = 10_000
) {
  if (!chatSyncWindow || chatSyncWindow.isDestroyed()) return false
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const ready = await chatSyncWindow.webContents.executeJavaScript(`(() => {
        const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
        const targetId = ${JSON.stringify(target.externalId)}
        const targetName = ${JSON.stringify(target.recruiter)}
        const targetCompany = ${JSON.stringify(target.company || '')}
        const expectedPreview = clean(${JSON.stringify(expectedPreview)}).replace(/\s+/g, '')
        const conversation = document.querySelector('.chat-conversation')
        const messages = document.querySelector('.chat-record, .chat-message, .im-list')
        const header = document.querySelector('.chat-conversation .user-info, .chat-conversation .name-text, .chat-header, .conversation-header')
        const targetItem = [...document.querySelectorAll('.user-list li, .chat-list li, .conversation-list li, .friend-list li, [class*="chat-list"] li, [class*="conversation-list"] li, [class*="user-list"] li')]
          .find(node => [node.getAttribute('data-id'), node.getAttribute('data-uid'), node.getAttribute('data-geek')].includes(targetId))
          || [...document.querySelectorAll('.user-list li, .chat-list li, .conversation-list li, .friend-list li, [class*="chat-list"] li, [class*="conversation-list"] li, [class*="user-list"] li')]
            .find(node => clean(node.querySelector('.name-text')?.textContent) === targetName && (!targetCompany || clean(node.innerText || node.textContent).includes(targetCompany)))
        const targetActive = Boolean(targetItem && (/active|selected|current/.test(String(targetItem.className || '')) || targetItem.querySelector('.active, .selected, .current')))
        const headerMatches = clean(header?.innerText || header?.textContent).includes(targetName)
        if (messages && messages.scrollHeight > messages.clientHeight) messages.scrollTop = messages.scrollHeight
        const messageText = clean(messages?.innerText || messages?.textContent).replace(/\s+/g, '')
        const messageTail = messageText.slice(-Math.min(60, messageText.length))
        const previewMatches = !expectedPreview || Boolean(messageText && (messageText.includes(expectedPreview) || expectedPreview.includes(messageTail)))
        return Boolean(conversation && !conversation.classList.contains('chat-no-data') && messages && (targetActive || headerMatches) && previewMatches)
      })()`, true)
      if (ready) return true
    } catch { /* page is navigating; retry after it settles */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

async function collectBossChatsInBackground(
  target?: { externalId: string; recruiter: string; company?: string },
  forceRefreshOverview = false
) {
  if (!chatSyncWindow || chatSyncWindow.isDestroyed()) {
    chatSyncWindow = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: {
        partition: 'persist:jobpilot-boss',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    chatSyncWindow.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    )
    chatSyncWindow.on('closed', () => { chatSyncWindow = null })
  }
  const currentUrl = chatSyncWindow.webContents.getURL()
  if (!/\/web\/geek\/chat/.test(currentUrl) || (forceRefreshOverview && !target)) {
    try {
      await waitForLoad(chatSyncWindow, 'https://www.zhipin.com/web/geek/chat')
      await new Promise(resolve => setTimeout(resolve, 1_500))
    } catch (error) {
      appendRuntimeLog('boss-chat-load-failed', error)
      throw error
    }
  }
  if (target) {
    const opened = await chatSyncWindow.webContents.executeJavaScript(
      openBossConversationScript(target.externalId, target.recruiter, target.company),
      true
    ) as { ok: boolean; reason?: string; expectedPreview?: string }
    if (!opened.ok) {
      return {
        ok: false,
        url: chatSyncWindow.webContents.getURL(),
        title: chatSyncWindow.webContents.getTitle(),
        conversations: [],
        error: opened.reason || '未在 BOSS 会话列表中找到该联系人'
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1_200))
    const ready = await waitForBossConversationReady(target, opened.expectedPreview || '')
    if (!ready) {
      return {
        ok: false,
        url: chatSyncWindow.webContents.getURL(),
        title: chatSyncWindow.webContents.getTitle(),
        conversations: [],
        error: 'BOSS 目标会话打开超时，请先在 BOSS 消息页手动打开该招聘者后重试。'
      }
    }
    const identity = await chatSyncWindow.webContents.executeJavaScript(
      inspectBossActiveConversationScript(target.recruiter, target.company),
      true
    ) as { ok: boolean }
    if (!identity.ok) {
      return {
        ok: false,
        url: chatSyncWindow.webContents.getURL(),
        title: chatSyncWindow.webContents.getTitle(),
        conversations: [],
        error: 'BOSS 当前会话未同时匹配目标招聘者和公司，已取消操作。'
      }
    }
  }
  try {
    const captcha = await chatSyncWindow.webContents.executeJavaScript(captchaDetectionScript, true)
    if (captcha) {
      return {
        ok: false,
        captcha: true,
        url: chatSyncWindow.webContents.getURL(),
        title: chatSyncWindow.webContents.getTitle(),
        conversations: [],
        error: '检测到 BOSS 安全验证，请在登录窗口中人工完成验证后再恢复任务。'
      }
    }
    const result = await chatSyncWindow.webContents.executeJavaScript(collectBossChatsScript, true) as {
      ok: boolean
      error?: string
      conversations: Array<{ externalId: string; recruiter: string; company: string; active: boolean }>
    }
    if (!result.ok && result.error) appendRuntimeLog('boss-chat-collection-failed', result.error)
    if (target && result.ok) {
      const active = result.conversations.find(conversation => conversation.active)
      if (active) {
        result.conversations.forEach(conversation => { conversation.active = false })
        active.externalId = target.externalId
        active.recruiter = target.recruiter
        active.company = target.company || active.company
        active.active = true
      }
    }
    return result
  } catch (error) {
    const url = chatSyncWindow.webContents.getURL()
    const title = chatSyncWindow.webContents.getTitle()
    console.error('BOSS chat collection script failed', { url, title, error: String(error) })
    return {
      ok: false,
      url,
      title,
      conversations: [],
      error: `页面采集脚本异常：${String(error)}`
    }
  }
}

type InterviewScanConversation = {
  externalId: string
  recruiter: string
  company: string
  jobTitle: string
  jobHref?: string
  href: string
  unreadCount: number
  preview: string
  timeLabel?: string
  active: boolean
  messages: Array<{
    id: string
    direction: 'inbound' | 'outbound'
    content: string
    sender: string
    timeLabel: string
    kind: 'text' | 'resume_request' | 'resume_sent' | 'resume_viewed' | 'system'
    actionAvailable: boolean
  }>
}

type InterviewScanResult = {
  ok: boolean
  url: string
  title: string
  conversations: InterviewScanConversation[]
  scanned?: number
  total?: number
  errors?: number
  captcha?: boolean
  error?: string
}

async function scanBossInterviewInvitationsInBackground(limit = 30): Promise<InterviewScanResult> {
  const overview = await collectBossChatsInBackground() as InterviewScanResult
  if (!overview.ok || !overview.conversations.length) return overview
  const candidates = overview.conversations.slice(0, Math.max(1, Math.min(50, limit)))
  const detailed: InterviewScanConversation[] = []
  let errors = 0
  for (const candidate of candidates) {
    if (candidate.active && candidate.messages.length) {
      detailed.push(candidate)
      continue
    }
    try {
      const result = await collectBossChatsInBackground({
        externalId: candidate.externalId,
        recruiter: candidate.recruiter,
        company: candidate.company
      }) as InterviewScanResult
      if (!result.ok) {
        if (result.captcha) return { ...result, conversations: detailed, scanned: detailed.length, total: candidates.length, errors: errors + 1 }
        errors += 1
        continue
      }
      const active = result.conversations.find(item => item.active && (
        item.externalId === candidate.externalId
        || (item.recruiter === candidate.recruiter && (!candidate.company || item.company === candidate.company))
      )) || result.conversations.find(item => item.active)
      if (active) detailed.push(active)
    } catch (error) {
      appendRuntimeLog('boss-interview-scan-failed', error)
      errors += 1
    }
  }
  const seen = new Set<string>()
  const conversations = detailed.filter(item => {
    if (seen.has(item.externalId)) return false
    seen.add(item.externalId)
    return true
  })
  return {
    ok: true,
    url: overview.url,
    title: overview.title,
    conversations,
    scanned: candidates.length,
    total: overview.total || overview.conversations.length,
    errors
  }
}

async function sendBossConversationInBackground(input: { externalId: string; recruiter: string; company?: string; message: string }) {
  const message = input.message.trim()
  if (!input.externalId || !input.recruiter || !message) throw new Error('发送参数不完整')
  if (message.length > 2_000) throw new Error('消息过长，请缩短后重试')

  const opened = await collectBossChatsInBackground({ externalId: input.externalId, recruiter: input.recruiter, company: input.company }) as {
    ok: boolean
    captcha?: boolean
    conversations: Array<{ externalId: string; recruiter: string; company: string; preview: string; active: boolean; messages: Array<{ direction: string; content: string }> }>
    error?: string
  }
  if (!opened.ok) return { ok: false, captcha: Boolean(opened.captcha), error: opened.error || '无法打开目标会话' }
  if (!chatSyncWindow || chatSyncWindow.isDestroyed()) throw new Error('BOSS 聊天窗口不可用')

  const inspectedIdentity = await chatSyncWindow.webContents.executeJavaScript(
    inspectBossActiveConversationScript(input.recruiter, input.company),
    true
  ) as { ok: boolean }
  if (!inspectedIdentity.ok) {
    return { ok: false, error: '当前 BOSS 会话与目标招聘者或公司不一致，已取消发送。' }
  }

  const cleanIdentity = (value?: string) => (value || '').replace(/\s+/g, '').toLowerCase()
  const active = opened.conversations.find(conversation => conversation.active)
  const recruiterMatches = Boolean(active && cleanIdentity(active.recruiter) === cleanIdentity(input.recruiter))
  const expectedCompany = cleanIdentity(input.company)
  const activeCompany = cleanIdentity(active?.company)
  const companyMatches = !expectedCompany || Boolean(
    activeCompany && (activeCompany.includes(expectedCompany) || expectedCompany.includes(activeCompany))
  )
  if (!active || !recruiterMatches || !companyMatches) {
    return { ok: false, error: '当前 BOSS 会话与目标招聘者或公司不一致，已取消发送。' }
  }

  const clean = (value: string) => value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^(?:已读|送达|未读)\s+/, '')
    .replace(/\s+/g, '')
    .trim()
  const before = opened.conversations
    .find(conversation => conversation.externalId === input.externalId)
    ?.messages.filter(item => item.direction === 'outbound' && clean(item.content) === clean(message)).length || 0
  const beforePreview = opened.conversations.find(conversation => conversation.externalId === input.externalId)?.preview || ''
  const prepared = await chatSyncWindow.webContents.executeJavaScript(sendBossReplyScript(message), true) as {
    ok: boolean
    prepared?: boolean
    beforePageMatches?: number
    sendPoint?: { x: number; y: number }
    reason?: string
  }
  if (!prepared.ok || !prepared.prepared || !prepared.sendPoint) {
    return { ok: false, error: prepared.reason || '未找到可用的发送按钮' }
  }

  await dispatchTrustedClick(chatSyncWindow, prepared.sendPoint)

  const captcha = await chatSyncWindow.webContents.executeJavaScript(captchaDetectionScript, true)
  if (captcha) return { ok: false, captcha: true, error: '检测到 BOSS 安全验证，请人工完成后再恢复任务。' }

  let inputCleared = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 600))
    const confirmation = await chatSyncWindow.webContents.executeJavaScript(confirmBossReplyScript(message), true) as {
      pageMatches: number
      matchingBubbles: number
      inputCleared: boolean
      inputStillContainsMessage: boolean
    }
    inputCleared ||= confirmation.inputCleared
    if (confirmation.inputCleared && confirmation.matchingBubbles > 0 && confirmation.pageMatches > (prepared.beforePageMatches || 0)) {
      return { ok: true }
    }
    if (attempt % 4 === 3) {
      const synced = await chatSyncWindow.webContents.executeJavaScript(collectBossChatsScript, true) as typeof opened
      if (synced.ok) {
        const activeConversation = synced.conversations.find(conversation => conversation.externalId === input.externalId)
          || synced.conversations.find(conversation => conversation.active && conversation.messages.length > 0)
        const after = activeConversation?.messages
          .filter(item => item.direction === 'outbound' && clean(item.content) === clean(message)).length || 0
        const preview = clean(activeConversation?.preview || '')
        const normalizedMessage = clean(message)
        const previewConfirmed = clean(beforePreview) !== preview && preview.length >= 12 && (
          normalizedMessage.startsWith(preview) || preview.startsWith(normalizedMessage)
        )
        if (after > before || previewConfirmed) return { ok: true }
      }
    }
  }
  return {
    ok: false,
    uncertain: inputCleared,
    error: inputCleared
      ? '发送动作已执行但未读取到消息气泡。为避免重复发送，请先同步会话或在 BOSS 页面核对。'
      : '消息仍停留在输入框，未确认发送成功，请稍后重试。'
  }
}

async function sendBossResumeInBackground(input: { externalId: string; recruiter: string; company?: string; knownResumeSent?: boolean; proactive?: boolean }) {
  if (!input.externalId || !input.recruiter) throw new Error('简历发送参数不完整')
  if (input.knownResumeSent) return { ok: true, alreadySent: true }
  const persistedState = loadState()
  const normalizeIdentity = (value?: string) => (value || '').replace(/\s+/g, '').toLowerCase()
  const persistedConversation = persistedState.bossConversations.find(conversation => conversation.externalId === input.externalId)
    || persistedState.bossConversations.find(conversation =>
      normalizeIdentity(conversation.recruiter) === normalizeIdentity(input.recruiter) &&
      (!input.company || !conversation.company || normalizeIdentity(conversation.company).includes(normalizeIdentity(input.company)) || normalizeIdentity(input.company).includes(normalizeIdentity(conversation.company))))
  const hasPersistedResumeEvidence = Boolean(
    persistedConversation?.resumeSentAt || persistedConversation?.messages.some(message =>
      /(?:您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方|对方已查看了您的附件简历)/.test(message.content))
  )
  if (hasPersistedResumeEvidence) return { ok: true, alreadySent: true }
  const hasPersistedRequestEvidence = Boolean(
    persistedConversation?.resumeProactiveRequestedAt || persistedConversation?.messages.some(message =>
      /附件简历请求已发送/.test(message.content))
  )
  if (input.proactive && hasPersistedRequestEvidence) return { ok: true, requested: true, alreadyRequested: true }
  const opened = await collectBossChatsInBackground(input) as {
    ok: boolean
    captcha?: boolean
    conversations?: Array<{ externalId: string; recruiter: string; company: string; active: boolean }>
    error?: string
  }
  if (!opened.ok) return { ok: false, captcha: Boolean(opened.captcha), error: opened.error || '无法打开目标会话' }
  if (!chatSyncWindow || chatSyncWindow.isDestroyed()) throw new Error('BOSS 聊天窗口不可用')
  const clean = (value?: string) => (value || '').replace(/\s+/g, '').toLowerCase()
  const active = opened.conversations?.find(conversation => conversation.active)
  const recruiterMatches = active && clean(active.recruiter) === clean(input.recruiter)
  const companyMatches = !input.company || !active?.company || clean(active.company).includes(clean(input.company)) || clean(input.company).includes(clean(active.company))
  if (!active || !recruiterMatches || !companyMatches) {
    return { ok: false, error: '未能确认当前打开的是目标招聘者会话，已取消附件简历发送。' }
  }

  const prepared = await chatSyncWindow.webContents.executeJavaScript(
    input.proactive ? prepareBossProactiveResumeSendScript : prepareBossResumeSendScript,
    true
  ) as {
    ok: boolean
    prepared?: boolean
    alreadySent?: boolean
    alreadyRequested?: boolean
    requestId?: string
    requestCount?: number
    sentCount?: number
    sendPoint?: { x: number; y: number }
    reason?: string
  }
  if (prepared.alreadySent) return { ok: true, alreadySent: true }
  if (input.proactive && prepared.alreadyRequested) return { ok: true, requested: true, alreadyRequested: true }
  if (!prepared.ok || !prepared.prepared || !prepared.sendPoint) {
    return { ok: false, error: prepared.reason || (input.proactive ? '未找到主动发送附件简历入口' : '未找到可发送的附件简历请求卡片') }
  }

  await dispatchTrustedClick(chatSyncWindow, prepared.sendPoint)
  const captcha = await chatSyncWindow.webContents.executeJavaScript(captchaDetectionScript, true)
  if (captcha) return { ok: false, captcha: true, error: '检测到 BOSS 安全验证，请人工完成后再恢复任务。' }

  let selection: {
    ok: boolean
    prepared?: boolean
    waiting?: boolean
    resumeName?: string
    selectPoint?: { x: number; y: number }
    reason?: string
  } | undefined
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const candidate = await chatSyncWindow.webContents.executeJavaScript(prepareBossResumeSelectionScript, true) as NonNullable<typeof selection>
    selection = candidate
    if (candidate.ok && candidate.prepared && candidate.selectPoint) break
    if (!candidate.waiting) return { ok: false, error: candidate.reason || '无法安全选择 BOSS 附件简历' }
  }
  if (!selection?.ok || !selection.prepared || !selection.selectPoint) {
    return { ok: false, uncertain: true, error: selection?.reason || 'BOSS 简历选择窗口打开超时，未发送附件。' }
  }

  await dispatchTrustedClick(chatSyncWindow, selection.selectPoint)
  const captchaAfterSelection = await chatSyncWindow.webContents.executeJavaScript(captchaDetectionScript, true)
  if (captchaAfterSelection) return { ok: false, captcha: true, error: '检测到 BOSS 安全验证，请人工完成后再恢复任务。' }

  let dialogSend: {
    ok: boolean
    prepared?: boolean
    waiting?: boolean
    resumeName?: string
    sendPoint?: { x: number; y: number }
    reason?: string
  } | undefined
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    const candidate = await chatSyncWindow.webContents.executeJavaScript(prepareBossResumeDialogSendScript, true) as NonNullable<typeof dialogSend>
    dialogSend = candidate
    if (candidate.ok && candidate.prepared && candidate.sendPoint) break
    if (!candidate.waiting) return { ok: false, error: candidate.reason || '无法安全发送 BOSS 附件简历' }
  }
  if (!dialogSend?.ok || !dialogSend.prepared || !dialogSend.sendPoint || dialogSend.resumeName !== selection.resumeName) {
    return { ok: false, uncertain: true, error: dialogSend?.reason || 'BOSS 附件简历选择未确认，未执行发送。' }
  }

  await dispatchTrustedClick(chatSyncWindow, dialogSend.sendPoint)
  const captchaAfterSend = await chatSyncWindow.webContents.executeJavaScript(captchaDetectionScript, true)
  if (captchaAfterSend) return { ok: false, captcha: true, error: '检测到 BOSS 安全验证，请人工完成后再恢复任务。' }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const confirmation = await chatSyncWindow.webContents.executeJavaScript(confirmBossResumeSendScript, true) as { sentCount: number; requestCount: number }
    if (confirmation.sentCount > (prepared.sentCount || 0)) {
      return { ok: true, requestId: prepared.requestId }
    }
    if (input.proactive && confirmation.requestCount > (prepared.requestCount || 0)) {
      return { ok: true, requested: true, requestId: prepared.requestId }
    }
  }
  return {
    ok: false,
    uncertain: true,
    error: input.proactive
      ? '已在 BOSS 中选择附件简历并点击“发送”，但未检测到“附件简历请求已发送”回执。为避免重复操作，已暂停该会话。'
      : '已在 BOSS 中选择附件简历并点击“发送”，但未检测到发送成功消息。为避免重复发送，已暂停该会话。'
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f2ec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  mainWindow.webContents.on('will-attach-webview', (_event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    params.partition = 'persist:jobpilot-boss'
    try {
      const host = new URL(params.src).hostname
      if (host && !host.endsWith('zhipin.com')) params.src = 'about:blank'
    } catch {
      params.src = 'about:blank'
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('zhipin.com')) mainWindow?.loadURL(url)
    else shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendRuntimeLog('renderer-gone', JSON.stringify(details))
    if (details.reason === 'clean-exit') return
    pauseAutomationAfterRuntimeFailure('客户端页面异常退出，自动化已暂停，页面正在恢复。')
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
  })
  mainWindow.on('unresponsive', () => appendRuntimeLog('window-unresponsive', 'main window stopped responding'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) mainWindow.loadURL(devUrl)
  else mainWindow.loadURL(pathToFileURL(path.join(__dirname, '../dist/index.html')).toString())
}

app.whenReady().then(async () => {
  const bossSession = session.fromPartition('persist:jobpilot-boss')
  bossSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  bossSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    callback({ requestHeaders: details.requestHeaders })
  })
  let recoveredState = loadState()
  const failedDocuments = recoveredState.knowledgeDocuments.filter(document => document.status === 'error' && document.path)
  for (const document of failedDocuments) {
    recoveredState = await retryKnowledgeDocument(recoveredState, document.id)
  }
  if (failedDocuments.length) saveState(recoveredState)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('state:get', () => {
  const state = loadState()
  state.config.model.apiKeyConfigured = hasModelApiKey()
  state.config.rag.embeddingApiKeyConfigured = hasEmbeddingApiKey()
  state.config.notifications.webhookConfigured = hasNotificationWebhook()
  return state
})
ipcMain.handle('state:save', (_event, state: AppState) => saveState(state))
ipcMain.handle('data:export', async () => {
  const stamp = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog({
    title: '导出 JobPilot 数据',
    defaultPath: path.join(app.getPath('documents'), `JobPilot-数据备份-${stamp}.jobpilot.json`),
    filters: [{ name: 'JobPilot 数据迁移文件', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  const bundle = createPortableDataBundle()
  fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), { mode: 0o600 })
  return { canceled: false, path: result.filePath, exportedAt: bundle.exportedAt }
})
ipcMain.handle('data:import', async () => {
  const result = await dialog.showOpenDialog({
    title: '导入 JobPilot 数据',
    properties: ['openFile'],
    filters: [{ name: 'JobPilot 数据迁移文件', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const filename = result.filePaths[0]
  const bundle = parsePortableDataBundle(fs.readFileSync(filename, 'utf8'))
  const backupPath = backupCurrentState()
  const crossPlatform = bundle.sourcePlatform !== process.platform
  const next = mergePortableState(loadState(), bundle.state, crossPlatform)
  saveState(next)
  next.config.model.apiKeyConfigured = hasModelApiKey()
  next.config.rag.embeddingApiKeyConfigured = hasEmbeddingApiKey()
  next.config.notifications.webhookConfigured = hasNotificationWebhook()
  return { canceled: false, path: filename, backupPath, crossPlatform, state: next }
})
ipcMain.handle('secret:model:set', (_event, apiKey: string) => setModelApiKey(apiKey.trim()))
ipcMain.handle('secret:model:clear', () => clearModelApiKey())
ipcMain.handle('secret:model:has', () => hasModelApiKey())
ipcMain.handle('secret:embedding:set', (_event, apiKey: string) => setEmbeddingApiKey(apiKey.trim()))
ipcMain.handle('secret:embedding:clear', () => clearEmbeddingApiKey())
ipcMain.handle('secret:notification:set', (_event, webhookUrl: string) => setNotificationWebhook(webhookUrl.trim()))
ipcMain.handle('notification:test', () => sendWebhookNotification('JobPilot 通知测试', 'Webhook 已连接，可以接收人机验证和人工确认提醒。', true))
ipcMain.handle('notification:send', (_event, title: string, message: string) => sendWebhookNotification(title, message))
ipcMain.handle('embedding:test', () => testEmbeddingConnection(loadState()))
ipcMain.handle('model:call', async (_event, request: ModelRequest) => callModel(loadState(), request))
ipcMain.on('model:stream', (event, requestId: unknown, request: ModelRequest) => {
  if (typeof requestId !== 'string' || requestId.length > 120) return
  const send = (payload: Record<string, unknown>) => {
    if (!event.sender.isDestroyed()) event.sender.send('model:stream:event', { requestId, ...payload })
  }
  void streamModel(loadState(), request, delta => send({ type: 'delta', delta }))
    .then(content => send({ type: 'done', content }))
    .catch(error => {
      appendRuntimeLog('model-stream-failed', error)
      send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    })
})
ipcMain.handle('resume:select', async () => {
  const result = await dialog.showOpenDialog({
    title: '选择简历文件',
    properties: ['openFile'],
    filters: [{ name: '简历文件', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const filename = result.filePaths[0]
  const text = await readDocumentText(filename)
  return { path: filename, name: path.basename(filename), type: path.extname(filename).slice(1).toLowerCase(), text }
})
ipcMain.handle('resume:read', async (_event, filename: string) => {
  if (!filename || typeof filename !== 'string') throw new Error('简历路径无效')
  const text = await readDocumentText(filename)
  return { path: filename, name: path.basename(filename), type: path.extname(filename).slice(1).toLowerCase(), text }
})
ipcMain.handle('knowledge:import', async () => {
  const next = await importKnowledgeFiles(loadState())
  saveState(next)
  return next
})
ipcMain.handle('knowledge:delete', (_event, documentId: string) => {
  const next = loadState()
  next.knowledgeDocuments = next.knowledgeDocuments.filter(document => document.id !== documentId)
  next.knowledgeChunks = next.knowledgeChunks.filter(chunk => chunk.documentId !== documentId)
  next.knowledgeQas = next.knowledgeQas.filter(item => item.documentId !== documentId)
  saveState(next)
  return next
})
ipcMain.handle('knowledge:qa:upsert', async (_event, input: KnowledgeQaInput) => {
  const next = await upsertKnowledgeQa(loadState(), input)
  saveState(next)
  return next
})
ipcMain.handle('knowledge:rebuild', async () => {
  const next = await rebuildEmbeddings(loadState())
  saveState(next)
  return next
})
ipcMain.handle('knowledge:retry', async (_event, documentId: string) => {
  const next = await retryKnowledgeDocument(loadState(), documentId)
  saveState(next)
  return next
})
ipcMain.handle('knowledge:chat', (_event, question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
  ragChat(loadState(), question, history))
ipcMain.handle('browser:chat-sync', (_event, forceRefreshOverview?: boolean) =>
  enqueueChatWindowOperation(() => collectBossChatsInBackground(undefined, Boolean(forceRefreshOverview))))
ipcMain.handle('browser:chat-conversation-sync', (_event, externalId: string, recruiter: string, company?: string) =>
  enqueueChatWindowOperation(() => collectBossChatsInBackground({ externalId, recruiter, company })))
ipcMain.handle('browser:interview-scan', (_event, limit?: number) =>
  enqueueChatWindowOperation(() => scanBossInterviewInvitationsInBackground(limit)))
ipcMain.handle('browser:chat-send', (_event, externalId: string, recruiter: string, company: string | undefined, message: string) =>
  enqueueChatWindowOperation(() => sendBossConversationInBackground({ externalId, recruiter, company, message })))
ipcMain.handle('browser:resume-send', (_event, externalId: string, recruiter: string, company?: string, knownResumeSent?: boolean, proactive?: boolean) =>
  enqueueChatWindowOperation(() => sendBossResumeInBackground({ externalId, recruiter, company, knownResumeSent, proactive })))
ipcMain.handle('browser:external', (_event, url: string) => shell.openExternal(url))
ipcMain.handle('browser:login-window', (_event, url: string) => {
  const loginWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: '登录 BOSS 直聘',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: 'persist:jobpilot-boss',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  loginWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  )
  loginWindow.loadURL(url)
  loginWindow.once('ready-to-show', () => loginWindow.maximize())
})
