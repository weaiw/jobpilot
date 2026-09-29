import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  BriefcaseBusiness,
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Gauge,
  Inbox,
  KeyRound,
  LibraryBig,
  MapPin,
  Maximize2,
  MessageCircleMore,
  Minimize2,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Upload,
  UserRound,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
  Zap
} from 'lucide-react'
import type { AppState, AutomationSendRecord, BossChatMessage, BossConversation, CandidateProfile, ChatIntent, ChatMessage, ChatReplyMode, JobRecord, ResumeDiagnosis, ResumeDiagnosisPriority, ResumeFile, ResumeSendMode, SendMode } from '../shared/types'
import jobpilotLogo from '../assets/icons/jobpilot.png'
import {
  bossExpectationStateScript,
  captchaDetectionScript,
  collectJobDetailScript,
  collectJobsScript,
  fillBossReplyScript,
  openBossConversationScript,
  selectBossExpectationScript,
  sendGreetingScript,
  type CapturedBossConversation,
  type CapturedJob
} from './boss'
import {
  daysFromNow,
  chatIntentLabel,
  detectConversationEnd,
  detectChatIntent,
  fingerprint,
  formatDate,
  hasUnconfirmedResumeClaim,
  extractInterviewInvitation,
  jobLocationAllowsAutoSend,
  jobLocationFit,
  jobMatchesLocationConstraint,
  isLocationConfirmationPrompt,
  isResumeSendRequest,
  localScore,
  parseModelJson,
  targetSalaryMatches
} from './utils'

type Page = 'radar' | 'followups' | 'interviews' | 'knowledge' | 'resume' | 'profile' | 'settings'
type Toast = { type: 'success' | 'error' | 'info'; message: string }
type AddressEnrichmentResult = { completed: number; descriptions: number; failed: number; blocked: boolean }
type CapturedJobDetail = { address: string; description: string; detailVersion?: number }
type ResumeSourceId = 'upload' | string

const sendModeLabels: Record<SendMode, string> = {
  draft_only: '仅生成草稿',
  review_each: '逐条确认发送',
  review_batch: '批量确认发送',
  auto_above_score: '高分岗位自动发送'
}

const chatReplyModeLabels: Record<ChatReplyMode, string> = {
  draft_only: '仅生成草稿',
  review_each: '逐条确认',
  auto_safe: '非敏感自动发送'
}

const sensitiveIntentOptions: Array<{ value: ChatIntent; label: string }> = [
  { value: 'salary', label: '薪资' },
  { value: 'availability', label: '到岗' },
  { value: 'contact', label: '联系方式' },
  { value: 'interview', label: '面试安排' },
  { value: 'resignation', label: '离职原因' },
  { value: 'location', label: '工作地点' }
]

const MAX_PENDING_GREETING_REVIEWS = 10
const CURRENT_GREETING_VERSION = 2
const MANUAL_TAKEOVER_PAUSE_REASON = '检测到你在 BOSS 手动回复，已暂停该会话的 AI。'
const DUPLICATE_REPLY_PAUSE_REASON = '检测到同一条招聘消息后连续发送了多条回复，已暂停 AI，请人工核对后继续。'
const LEGACY_DUPLICATE_GREETING_RECIPIENT_PAUSE_REASON = '检测到同一公司会话收到多条招呼语，已停止该公司的自动发送和跟进。'
const DUPLICATE_GREETING_RECIPIENT_PAUSE_REASON = '检测到同一岗位会话重复发送招呼语，已停止该岗位的自动发送和跟进。'
const LOCATION_CONFIRMATION_PAUSE_REASON = '检测到 BOSS 工作地点确认卡片，已暂停 AI，请在 BOSS 中手动确认是否接受该工作地点。'
const SCRIPT_RECOVERY_AUTOMATION_PAUSE_REASON = '已修复旧会话定位脚本，自动化暂时挂起，等待验证一条跟进消息后恢复。'

const qaSuggestions = [
  { category: '求职状态', question: '你目前是否已经离职？' },
  { category: '薪资期望', question: '你的期望薪资范围是多少？' },
  { category: '到岗时间', question: '如果面试通过，最快什么时候可以到岗？' },
  { category: '工作地点', question: '你接受的工作城市和通勤范围是什么？' },
  { category: '离职原因', question: '你离开上一份工作的原因是什么？' }
]

function visibleChatContent(content: string) {
  return content
    .replace(/\n?#{1,6}\s*(?:参考来源|参考资料|资料来源|来源)\s*[：:]?[\s\S]*$/i, '')
    .replace(/\n?(?:参考来源|参考资料|资料来源|来源)\s*[：:]\s*[\s\S]*$/i, '')
    .replace(/[^。！？\n]*(?:需要|需|待|由|请)\s*本人(?:进一步)?\s*(?:确认|核实)[^。！？\n]*[。！？]?/g, '')
    .trim()
}

function followupGreeting(recruiter: string) {
  const name = recruiter.trim()
  return name && /(?:先生|女士|老师|经理)$/.test(name) ? `${name}您好，` : '您好，'
}

function conversationFollowupFallback(conversation: BossConversation) {
  const greeting = followupGreeting(conversation.recruiter)
  if (conversation.followupCount > 0) {
    return `${greeting}想再确认一下之前沟通的岗位目前是否还在推进？方便时回复我就好。`
  }
  const hasResumeContext = conversation.messages.some(message =>
    message.kind === 'resume_sent'
    || message.kind === 'resume_viewed'
    || /(?:简历已收到|已发送给对方|已发送给Boss|查看了您的附件简历)/.test(message.content)
  )
  return hasResumeContext
    ? `${greeting}想跟进一下之前发送的简历，请问岗位目前有新的进展吗？如需补充信息，我可以及时提供。`
    : `${greeting}想跟进一下之前沟通的岗位，请问目前还在推进吗？方便时回复我就好。`
}

function jobFollowupFallback(job: JobRecord) {
  const title = job.title.trim() || '之前沟通的'
  return `您好，想跟进一下${title}岗位，请问目前还在推进吗？方便时回复我就好。`
}

function followupDraftNeedsRewrite(content: string, interviewMentioned = false) {
  const cleaned = visibleChatContent(content).replace(/\s+/g, '')
  const questionCount = (cleaned.match(/[？?]/g) || []).length
  return cleaned.length < 20
    || cleaned.length > 90
    || questionCount > 1
    || /(?:已|此前|之前)?提交(?:的)?(?:简历|材料)|(?:简历|材料)中(?:提到|写到|显示)|从0到1|产品矩阵|岗位要求与|用人部门目前是否已有反馈/.test(cleaned)
    || /我(?:有|曾|具备|负责|主导).{0,28}(?:经验|产品|项目|规划|研发|落地)/.test(cleaned)
    || (!interviewMentioned && /(?:面试.*安排|安排.*面试)/.test(cleaned))
}

function sanitizeFollowupDraft(content: string, fallback: string, interviewMentioned = false) {
  const cleaned = visibleChatContent(content)
    .replace(/^[\s>*#-]+/, '')
    .replace(/\*\*/g, '')
    .trim()
  return followupDraftNeedsRewrite(cleaned, interviewMentioned) ? fallback : cleaned
}

function sanitizeResumeActionDraft(content: string, status: 'not_sent' | 'request_pending' | 'sent') {
  const cleaned = content.trim()
  if (!/(?:简历|附件)/.test(cleaned)) return cleaned
  if (!/(?:我)?(?:正|正在|已经|已通过|发起|请求|等待|稍后|马上)/.test(cleaned)) return cleaned
  if (status === 'request_pending') return '可以的，麻烦您点下同意，我用附件简历发您。'
  if (status === 'sent') return '简历已发您附件了，辛苦查收。'
  return '可以的，我发您附件简历。'
}

function sanitizeGreetingDraft(content: string) {
  const cleaned = content.trim()
  return cleaned.replace(
    /[^。！？\n]*[？?]\s*$/,
    '岗位要求与我的经历较契合，希望有机会进一步沟通。'
  ).trim()
}

function normalizeResumeDiagnosis(raw: string, file: ResumeFile): ResumeDiagnosis {
  const parsed = parseModelJson<Partial<ResumeDiagnosis>>(raw)
  const list = (value: unknown, limit: number) => Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit)
    : []
  const recommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations.slice(0, 6).map(item => {
      const candidate = (item || {}) as Partial<ResumeDiagnosis['recommendations'][number]>
      const priority: ResumeDiagnosisPriority = candidate.priority === 'high' || candidate.priority === 'low' ? candidate.priority : 'medium'
      return {
        priority,
        title: String(candidate.title || '未命名修改项').trim(),
        detail: String(candidate.detail || '').trim(),
        location: String(candidate.location || '').trim() || undefined,
        currentText: String(candidate.currentText || '').trim() || undefined,
        example: String(candidate.example || '').trim() || undefined
      }
    }).filter(item => item.title && item.detail)
    : []
  const score = Number(parsed.score)
  return {
    path: file.path,
    name: file.name,
    analyzedAt: new Date().toISOString(),
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    verdict: String(parsed.verdict || '建议根据优先级逐项优化后再投递。').trim(),
    summary: String(parsed.summary || '').trim(),
    strengths: list(parsed.strengths, 4),
    risks: list(parsed.risks, 5),
    recommendations,
    matchedKeywords: list(parsed.matchedKeywords, 12),
    missingKeywords: list(parsed.missingKeywords, 12)
  }
}

function normalizeCandidateProfile(raw: string, fallback: CandidateProfile, target: AppState['config']['target'], file: ResumeFile): CandidateProfile {
  const parsed = parseModelJson<Partial<CandidateProfile>>(raw)
  const list = (value: unknown, limit: number) => Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit)
    : []
  const yearsExperience = Number(parsed.yearsExperience)
  return {
    name: String(parsed.name || fallback.name || '').trim(),
    headline: String(parsed.headline || fallback.headline || '').trim(),
    yearsExperience: Number.isFinite(yearsExperience) ? Math.max(0, Math.round(yearsExperience)) : fallback.yearsExperience,
    targetRole: String(parsed.targetRole || fallback.targetRole || target.keywords[0] || '').trim(),
    targetCity: String(parsed.targetCity || fallback.targetCity || target.city || '').trim(),
    summary: String(parsed.summary || fallback.summary || '').trim(),
    strengths: list(parsed.strengths, 6),
    skills: list(parsed.skills, 18),
    achievements: list(parsed.achievements, 6),
    experienceHighlights: list(parsed.experienceHighlights, 8),
    resumePath: file.path
  }
}

function resumeSourceOptions(state: AppState) {
  return state.knowledgeDocuments
    .filter(document => document.type !== 'qa' && Boolean(document.path))
    .map(document => ({ id: document.id, label: document.name, path: document.path }))
}

function normalizeOutboundContent(value?: string) {
  return (value || '')
    .replace(/^(?:\[?(?:已读|送达|未读)\]?)\s*/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
}

function outboundContentFingerprint(value?: string) {
  const normalized = normalizeOutboundContent(value)
  return normalized ? fingerprint(normalized) : undefined
}

function jobGreetingFingerprint(job: Pick<JobRecord, 'href' | 'company' | 'title' | 'recruiter'>) {
  const detailId = job.href.match(/\/job_detail\/([^/?#]+)/)?.[1]
  const identity = detailId
    ? `boss:${detailId}`
    : [job.company, job.title, job.recruiter]
      .map(value => value.replace(/\s+/g, '').toLowerCase())
      .join('|')
  return fingerprint(identity)
}

function normalizedGreetingCompany(value?: string) {
  return (value || '').replace(/[\s·・]/g, '').replace(/\.{2,}|…+/g, '').toLowerCase()
}

function isDuplicateGreetingPauseReason(reason?: string) {
  return reason === DUPLICATE_GREETING_RECIPIENT_PAUSE_REASON
    || reason === LEGACY_DUPLICATE_GREETING_RECIPIENT_PAUSE_REASON
}

function jobGreetingRecipientKey(job: Pick<JobRecord, 'href' | 'company' | 'title' | 'recruiter'>) {
  const company = normalizedGreetingCompany(job.company)
  return company ? `company:${company}` : `job:${jobGreetingFingerprint(job)}`
}

function greetingAlreadySent(state: AppState, job: JobRecord) {
  const cutoff = Date.now() - Math.max(1, state.config.automation.dedupeDays) * 86_400_000
  const identity = jobGreetingFingerprint(job)
  const company = normalizedGreetingCompany(job.company)
  const hasSendRecord = state.automationSendHistory.some(record => {
    if (record.kind !== 'greeting' || new Date(record.sentAt).getTime() < cutoff) return false
    if (record.entityId === job.id || record.entityFingerprint === identity) return true
    const recordedJob = state.jobs.find(item => item.id === record.entityId)
    if (!recordedJob) return false
    return jobGreetingFingerprint(recordedJob) === identity
      || Boolean(company && normalizedGreetingCompany(recordedJob.company) === company)
  })
  if (hasSendRecord) return true
  return state.bossConversations.some(conversation =>
    conversation.messages.some(message => message.direction === 'outbound') && (
      conversation.jobId === job.id
      || Boolean(company && normalizedGreetingCompany(conversation.company) === company)
    )
  )
}

function quarantineDuplicateGreetingRecipients(state: AppState) {
  const cutoff = Date.now() - Math.max(1, state.config.automation.dedupeDays) * 86_400_000
  const jobsById = new Map(state.jobs.map(job => [job.id, job]))
  const greetingRecordsByJob = new Map<string, AutomationSendRecord[]>()
  state.automationSendHistory.forEach(record => {
    if (record.kind !== 'greeting' || new Date(record.sentAt).getTime() < cutoff) return
    if (!jobsById.has(record.entityId)) return
    const records = greetingRecordsByJob.get(record.entityId) || []
    records.push(record)
    greetingRecordsByJob.set(record.entityId, records)
  })
  const duplicateJobIds = new Set(
    [...greetingRecordsByJob.entries()]
      .filter(([, records]) => records.length > 1)
      .map(([jobId]) => jobId)
  )
  state.jobs.forEach(job => {
    const greeting = normalizeOutboundContent(job.greetingDraft || '')
    if (!greeting) return
    const matchingOutboundSourceIds = new Set(state.bossConversations
      .filter(conversation => conversation.jobId === job.id)
      .flatMap(conversation => conversation.messages)
      .filter(message => message.direction === 'outbound' && normalizeOutboundContent(message.content) === greeting)
      .map(message => bossMessageSourceId(message.id)))
    if (matchingOutboundSourceIds.size > 1) duplicateJobIds.add(job.id)
  })

  let changed = 0
  state.jobs.forEach(job => {
    if (!duplicateJobIds.has(job.id)) return
    if (job.nextFollowupAt || job.followupDraft || job.status === 'followup_due') changed += 1
    job.nextFollowupAt = undefined
    job.followupDraft = undefined
    if (job.status === 'followup_due') job.status = job.lastContactAt ? 'sent' : 'new'
  })
  state.bossConversations.forEach(conversation => {
    const linkedJob = conversation.jobId ? jobsById.get(conversation.jobId) : undefined
    const isDuplicate = Boolean(linkedJob && duplicateJobIds.has(linkedJob.id))
    if (conversation.status === 'ended') return
    if (isDuplicate) {
      const alreadyQuarantined = conversation.aiPaused
        && isDuplicateGreetingPauseReason(conversation.pauseReason)
        && !conversation.nextFollowupAt
      if (!alreadyQuarantined) changed += 1
      conversation.aiPaused = true
      conversation.status = 'paused'
      conversation.pauseReason = DUPLICATE_GREETING_RECIPIENT_PAUSE_REASON
      conversation.nextFollowupAt = undefined
      if (conversation.draftKind === 'followup') {
        conversation.draftReply = undefined
        conversation.draftKind = undefined
        conversation.draftCreatedAt = undefined
        conversation.draftSourceMessageId = undefined
      }
      return
    }
    if (isDuplicateGreetingPauseReason(conversation.pauseReason)) {
      conversation.aiPaused = false
      conversation.pauseReason = undefined
      conversation.status = conversation.draftReply
        ? 'draft_ready'
        : conversation.messages.at(-1)?.direction === 'outbound' ? 'replied' : 'new'
      changed += 1
    }
  })
  return changed
}

function conversationHasJobPilotSend(state: AppState, conversation: BossConversation) {
  return state.automationSendHistory.some(record => {
    if (record.kind === 'greeting') {
      return Boolean(conversation.jobId && record.entityId === conversation.jobId)
    }
    return record.entityId === conversation.id && (record.kind === 'chat_reply' || record.kind === 'followup')
  })
}

function conversationEligibleForFollowup(state: AppState, conversation: BossConversation) {
  const detectedEnd = detectConversationEnd(conversation.messages)
  return conversation.status !== 'ended'
    && (!detectedEnd || conversation.endDetectionDismissedForMessageId === detectedEnd.messageId)
    && conversationHasJobPilotSend(state, conversation)
}

function jobEligibleForFollowup(state: AppState, job: JobRecord) {
  const linkedConversations = state.bossConversations.filter(conversation => conversation.jobId === job.id)
  if (linkedConversations.some(conversation => {
    const detectedEnd = detectConversationEnd(conversation.messages)
    return conversation.status === 'ended'
      || Boolean(detectedEnd && conversation.endDetectionDismissedForMessageId !== detectedEnd.messageId)
  })) {
    return false
  }
  return state.automationSendHistory.some(record =>
    (record.kind === 'greeting' && record.entityId === job.id)
    || (linkedConversations.some(conversation => conversation.id === record.entityId)
      && (record.kind === 'chat_reply' || record.kind === 'followup'))
  )
}

function clearConversationFollowupPlan(state: AppState, conversation: BossConversation) {
  let changed = Boolean(conversation.nextFollowupAt || (conversation.draftKind === 'followup' && conversation.draftReply))
  conversation.nextFollowupAt = undefined
  if (conversation.draftKind === 'followup') {
    conversation.draftReply = undefined
    conversation.draftKind = undefined
    conversation.draftEditedManually = undefined
    conversation.draftCreatedAt = undefined
    conversation.draftSourceMessageId = undefined
    conversation.draftRequiresReview = false
    if (conversation.status === 'draft_ready') {
      conversation.status = conversation.aiPaused
        ? 'paused'
        : conversation.messages.at(-1)?.direction === 'outbound' ? 'replied' : 'new'
    }
  }
  const linkedJob = conversation.jobId ? state.jobs.find(job => job.id === conversation.jobId) : undefined
  if (linkedJob) {
    changed ||= Boolean(linkedJob.nextFollowupAt || linkedJob.followupDraft || linkedJob.status === 'followup_due')
    linkedJob.nextFollowupAt = undefined
    linkedJob.followupDraft = undefined
    if (linkedJob.status === 'followup_due') {
      linkedJob.status = conversation.messages.at(-1)?.direction === 'inbound' ? 'replied' : 'sent'
    }
  }
  return changed
}

function bossMessageTime(timeLabel: string | undefined, referenceAt: string) {
  const label = (timeLabel || '').trim()
  if (!label) return undefined
  const reference = new Date(referenceAt)
  if (!Number.isFinite(reference.getTime())) return undefined
  const applyTime = (date: Date, hours: number, minutes: number) => {
    date.setHours(hours, minutes, 0, 0)
    return date
  }
  const full = label.match(/(\d{1,2})(?:-|\/|月)(\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})/)
  if (full) {
    const date = applyTime(new Date(reference), Number(full[3]), Number(full[4]))
    date.setMonth(Number(full[1]) - 1, Number(full[2]))
    if (date.getTime() > reference.getTime() + 7 * 24 * 60 * 60_000) date.setFullYear(date.getFullYear() - 1)
    return date
  }
  const clock = label.match(/(\d{1,2}):(\d{2})/)
  if (!clock) {
    const dateOnly = label.match(/(\d{1,2})(?:-|\/|月)(\d{1,2})(?:日)?/)
    if (!dateOnly) return undefined
    const date = applyTime(new Date(reference), 12, 0)
    date.setMonth(Number(dateOnly[1]) - 1, Number(dateOnly[2]))
    if (date.getTime() > reference.getTime() + 7 * 24 * 60 * 60_000) date.setFullYear(date.getFullYear() - 1)
    return date
  }
  const date = applyTime(new Date(reference), Number(clock[1]), Number(clock[2]))
  if (/昨天/.test(label)) date.setDate(date.getDate() - 1)
  else if (date.getTime() > reference.getTime() + 5 * 60_000) date.setDate(date.getDate() - 1)
  return date
}

function normalizeCapturedMessageTimes(
  item: CapturedBossConversation,
  syncedAt: string,
  profileName: string
): BossChatMessage[] {
  const messages = item.messages.filter(message => !isBossUiArtifact(message.content))
  const directTimes = messages.map(message => bossMessageTime(message.timeLabel, syncedAt))
  const conversationTime = bossMessageTime(item.timeLabel, syncedAt)
  let previousTime: Date | undefined
  return messages.map((message, index) => {
    const directTime = directTimes[index]
    if (directTime) previousTime = directTime
    const nextTime = directTimes.slice(index + 1).find(Boolean)
    const inferredTime = directTime
      || (!nextTime && conversationTime ? conversationTime : previousTime)
      || nextTime
    return {
      id: `${item.externalId}-${message.id}`,
      direction: message.direction,
      content: message.content,
      sender: message.sender || (message.direction === 'inbound' ? item.recruiter : profileName),
      sentAt: inferredTime?.toISOString() || syncedAt,
      timeLabel: message.timeLabel,
      timeUnknown: !inferredTime,
      kind: message.kind,
      actionAvailable: message.actionAvailable
    }
  })
}

function repairImportedMessageTimes(conversation: BossConversation) {
  const referenceAt = conversation.lastSyncedAt || conversation.lastMessageAt
  const referenceTime = new Date(referenceAt).getTime()
  let previousParsed: Date | undefined
  let changed = false
  conversation.messages.forEach(message => {
    const parsed = bossMessageTime(message.timeLabel, referenceAt)
    if (parsed) previousParsed = parsed
    const inferred = parsed || previousParsed
    const currentTime = new Date(message.sentAt).getTime()
    if (!inferred) {
      if (!message.timeLabel && Math.abs(currentTime - referenceTime) <= 5 * 60_000 && !message.timeUnknown) {
        message.timeUnknown = true
        changed = true
      }
      return
    }
    if (message.timeUnknown) {
      message.timeUnknown = false
      changed = true
    }
    if (Math.abs(currentTime - referenceTime) > 5 * 60_000) return
    if (currentTime === inferred.getTime()) return
    message.sentAt = inferred.toISOString()
    changed = true
  })
  if (!changed) return false
  const latestMessage = conversation.messages.at(-1)
  const latestInbound = [...conversation.messages].reverse().find(message => message.direction === 'inbound')
  const latestOutbound = [...conversation.messages].reverse().find(message => message.direction === 'outbound')
  if (latestMessage) conversation.lastMessageAt = latestMessage.sentAt
  conversation.lastInboundAt = latestInbound?.sentAt
  conversation.lastOutboundAt = latestOutbound?.sentAt
  return true
}

function conversationSortTime(conversation: BossConversation) {
  return conversation.messages.at(-1)?.timeUnknown ? 0 : new Date(conversation.lastMessageAt).getTime()
}

function conversationDisplayTime(conversation: BossConversation) {
  return conversation.messages.at(-1)?.timeUnknown ? '历史' : formatDate(conversation.lastMessageAt)
}

function bossMessageSourceId(messageId: string) {
  return messageId.split('-').at(-1) || messageId
}

function interviewInvitationAlreadyCaptured(state: AppState, message: BossChatMessage) {
  const sourceId = bossMessageSourceId(message.id)
  return state.jobs.some(job =>
    job.interviewInvitation
    && bossMessageSourceId(job.interviewInvitation.sourceMessageId) === sourceId
  )
}

function automationRecordMatchesOutbound(record: AutomationSendRecord, message: Pick<BossChatMessage, 'content' | 'timeLabel'>, syncedAt: string) {
  const messageFingerprint = outboundContentFingerprint(message.content)
  if (record.contentFingerprint) return messageFingerprint === record.contentFingerprint
  const messageAt = bossMessageTime(message.timeLabel, syncedAt)
  return Boolean(messageAt && Math.abs(messageAt.getTime() - new Date(record.sentAt).getTime()) <= 2 * 60_000)
}

function automationHistoryMatchesOutbound(
  state: AppState,
  conversation: Pick<BossConversation, 'id' | 'jobId'>,
  message: Pick<BossChatMessage, 'content' | 'timeLabel'>,
  syncedAt: string
) {
  const messageFingerprint = outboundContentFingerprint(message.content)
  if (!messageFingerprint) return false
  const normalized = normalizeOutboundContent(message.content)
  const messageAt = bossMessageTime(message.timeLabel, syncedAt)
  return state.automationSendHistory.some(record => {
    if (record.kind === 'resume') return false
    if (record.entityId === conversation.id || record.entityId === conversation.jobId) {
      return automationRecordMatchesOutbound(record, message, syncedAt)
    }
    // BOSS occasionally returns the active chat detail under a different
    // conversation shell. Exact content fingerprints from JobPilot's send
    // history are still trusted and must not trigger manual-takeover pause.
    if (record.contentFingerprint === messageFingerprint) return true
    // Older history rows may not have content fingerprints. For automated
    // followups, a close timestamp match is still strong enough to avoid
    // treating our own send echo as a phone-side manual takeover.
    return Boolean(
      record.automated &&
      record.kind === 'followup' &&
      !record.contentFingerprint &&
      normalized.length >= 20 &&
      messageAt &&
      Math.abs(messageAt.getTime() - new Date(record.sentAt).getTime()) <= 2 * 60_000
    )
  })
}

function clearTrustedManualTakeoverPause(state: AppState, conversation: BossConversation) {
  if (conversation.status === 'ended' || conversation.pauseReason !== MANUAL_TAKEOVER_PAUSE_REASON) return false
  const latestOutbound = [...conversation.messages].reverse().find(message => message.direction === 'outbound')
  if (!latestOutbound || !automationHistoryMatchesOutbound(state, conversation, latestOutbound, conversation.lastSyncedAt)) return false
  conversation.aiPaused = false
  conversation.pauseReason = undefined
  conversation.status = conversation.draftReply ? 'draft_ready' : 'replied'
  return true
}

function outboundAppearedAfterLastSync(message: Pick<BossChatMessage, 'timeLabel'>, previousLastSyncedAt: string | undefined, syncedAt: string) {
  if (!previousLastSyncedAt) return false
  const messageAt = bossMessageTime(message.timeLabel, syncedAt)
  if (!messageAt) return false
  return messageAt.getTime() >= new Date(previousLastSyncedAt).getTime() - 60_000
}

function backfillAutomationSendFingerprints(state: AppState) {
  let backfilled = 0
  let recovered = 0

  state.automationSendHistory.forEach(record => {
    if (record.kind === 'greeting' && !record.entityFingerprint) {
      const job = state.jobs.find(item => item.id === record.entityId)
      if (job) {
        record.entityFingerprint = jobGreetingFingerprint(job)
        backfilled += 1
      }
    }
    if (record.contentFingerprint || record.kind === 'resume') return
    let content: string | undefined
    if (record.kind === 'greeting') {
      content = state.jobs.find(job => job.id === record.entityId)?.greetingDraft
    } else {
      const conversation = state.bossConversations.find(item => item.id === record.entityId)
      const outbound = conversation?.messages.filter(message => message.direction === 'outbound') || []
      const referenceAt = conversation?.lastSyncedAt || record.sentAt
      const timedMatch = outbound
        .map(message => ({ message, at: bossMessageTime(message.timeLabel, referenceAt) }))
        .filter(candidate => candidate.at && Math.abs(candidate.at.getTime() - new Date(record.sentAt).getTime()) <= 2 * 60_000)
        .sort((a, b) => Math.abs(a.at!.getTime() - new Date(record.sentAt).getTime()) - Math.abs(b.at!.getTime() - new Date(record.sentAt).getTime()))[0]
      if (timedMatch) content = timedMatch.message.content
      else if (
        conversation?.lastOutboundAt &&
        Math.abs(new Date(conversation.lastOutboundAt).getTime() - new Date(record.sentAt).getTime()) <= 2 * 60_000
      ) {
        content = outbound.at(-1)?.content
      }
    }
    const contentFingerprint = outboundContentFingerprint(content)
    if (!contentFingerprint) return
    record.contentFingerprint = contentFingerprint
    backfilled += 1
  })

  state.bossConversations.forEach(conversation => {
    if (conversation.status === 'ended' || conversation.pauseReason !== MANUAL_TAKEOVER_PAUSE_REASON) return
    const latestOutbound = [...conversation.messages].reverse().find(message => message.direction === 'outbound')
    if (!latestOutbound) return
    const trusted = automationHistoryMatchesOutbound(state, conversation, latestOutbound, conversation.lastSyncedAt)
    if (!trusted) return
    conversation.aiPaused = false
    conversation.pauseReason = undefined
    conversation.status = conversation.draftReply ? 'draft_ready' : 'replied'
    recovered += 1
  })

  return { backfilled, recovered }
}

function recoverScriptExecutionPausedFollowups(state: AppState) {
  let recovered = 0
  state.bossConversations.forEach(conversation => {
    if (
      conversation.status === 'ended'
      || !conversation.aiPaused
      || conversation.draftKind !== 'followup'
      || !conversation.draftReply
      || !/^自动发送未确认成功：.*Script failed to execute/.test(conversation.pauseReason || '')
    ) return
    conversation.aiPaused = false
    conversation.pauseReason = undefined
    conversation.status = 'draft_ready'
    recovered += 1
  })
  if (recovered) {
    state.automationPaused = true
    state.pauseReason = SCRIPT_RECOVERY_AUTOMATION_PAUSE_REASON
  }
  return recovered
}

function jobMatchesRadarFilters(job: JobRecord, state: AppState) {
  const keywordHit = state.config.target.keywords.some(keyword => job.title.toLowerCase().includes(keyword.toLowerCase()))
  const cityHit = !job.city || job.city.includes(state.config.target.city)
  return keywordHit && cityHit && targetSalaryMatches(job.salary, state)
}

function hasDetailedJobDescription(job: Pick<JobRecord, 'description' | 'detailVersion'>) {
  return job.detailVersion === 2 && job.description.trim().length >= 60
}

function dedupeBossConversations(conversations: BossConversation[], state?: AppState) {
  const normalizePreview = (value: string) => value
    .replace(/^\[(?:已读|送达|未读)\]\s*/, '')
    .replace(/\s+/g, '')
  const quality = (conversation: BossConversation) =>
    Number(Boolean(conversation.company)) + Number(Boolean(conversation.jobTitle)) + Number(conversation.recruiter !== '当前会话')
  const merged: BossConversation[] = []

  for (const candidate of [...conversations].sort((a, b) => quality(b) - quality(a))) {
    if (state) clearTrustedManualTakeoverPause(state, candidate)
    const preview = normalizePreview(candidate.preview)
    const existing = merged.find(conversation => conversation.externalId === candidate.externalId)
      || merged.find(conversation => {
        if (!preview || normalizePreview(conversation.preview) !== preview) return false
        const hasPlaceholderIdentity = conversation.recruiter === '当前会话' || candidate.recruiter === '当前会话'
        if (!hasPlaceholderIdentity) return false
        const companyMatches = !conversation.company || !candidate.company
          || conversation.company.includes(candidate.company)
          || candidate.company.includes(conversation.company)
        return companyMatches
      })
    if (!existing) {
      merged.push(candidate)
      continue
    }

    const messageIds = new Set(existing.messages.map(message => message.id))
    existing.messages = [...existing.messages, ...candidate.messages.filter(message => !messageIds.has(message.id))]
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime())
      .slice(-100)
    existing.unreadCount = Math.max(existing.unreadCount, candidate.unreadCount)
    existing.draftReply ||= candidate.draftReply
    existing.draftKind ||= candidate.draftKind
    existing.draftCreatedAt ||= candidate.draftCreatedAt
    existing.draftSourceMessageId ||= candidate.draftSourceMessageId
    existing.replyPendingMessageId ||= candidate.replyPendingMessageId
    existing.lastRepliedInboundMessageId ||= candidate.lastRepliedInboundMessageId
    existing.resumeRequestMessageId ||= candidate.resumeRequestMessageId
    existing.resumeRequestPending ||= candidate.resumeRequestPending
    existing.resumeProactiveSendPending ||= candidate.resumeProactiveSendPending
    existing.resumeProactiveSourceMessageId ||= candidate.resumeProactiveSourceMessageId
    existing.resumeProactiveRequestedAt ||= candidate.resumeProactiveRequestedAt
    existing.resumeSentAt ||= candidate.resumeSentAt
    existing.lastInboundAt = [existing.lastInboundAt, candidate.lastInboundAt].filter(Boolean).sort().at(-1)
    existing.lastOutboundAt = [existing.lastOutboundAt, candidate.lastOutboundAt].filter(Boolean).sort().at(-1)
    existing.lastMessageAt = [existing.lastMessageAt, candidate.lastMessageAt].sort().at(-1)!
    existing.lastSyncedAt = [existing.lastSyncedAt, candidate.lastSyncedAt].sort().at(-1)!
    if (state) clearTrustedManualTakeoverPause(state, existing)
    if (candidate.aiPaused && candidate.pauseReason) {
      const trustedManualPause = candidate.pauseReason === MANUAL_TAKEOVER_PAUSE_REASON
        && state
        && clearTrustedManualTakeoverPause(state, candidate)
      if (!trustedManualPause) {
        existing.aiPaused ||= candidate.aiPaused
        existing.pauseReason ||= candidate.pauseReason
      }
    } else if (candidate.aiPaused) {
      existing.aiPaused ||= candidate.aiPaused
    }
    existing.endedAt ||= candidate.endedAt
    existing.endReason ||= candidate.endReason
    existing.endSource ||= candidate.endSource
    existing.endMessageId ||= candidate.endMessageId
    existing.endDetectionDismissedForMessageId ||= candidate.endDetectionDismissedForMessageId
    if (existing.endedAt || candidate.status === 'ended') existing.status = 'ended'
    if (state) clearTrustedManualTakeoverPause(state, existing)
  }
  return merged
}

function applyConversationEndDetection(conversation: BossConversation) {
  const detected = detectConversationEnd(conversation.messages)
  if (!detected || conversation.endDetectionDismissedForMessageId === detected.messageId) return false
  const changed = conversation.status !== 'ended' || conversation.endMessageId !== detected.messageId
  conversation.status = 'ended'
  conversation.aiPaused = true
  conversation.pauseReason = detected.reason
  conversation.endedAt ||= new Date().toISOString()
  conversation.endReason = detected.reason
  conversation.endSource = detected.source
  conversation.endMessageId = detected.messageId
  conversation.draftReply = undefined
  conversation.draftKind = undefined
  conversation.draftEditedManually = undefined
  conversation.draftCreatedAt = undefined
  conversation.draftSourceMessageId = undefined
  conversation.replyPendingMessageId = undefined
  conversation.resumeProactiveSendPending = false
  conversation.draftRequiresReview = false
  conversation.nextFollowupAt = undefined
  return changed
}

function applyResumeRequestState(conversation: BossConversation, syncedAt: string) {
  const nativeRequestIndex = conversation.messages.map(message => message.kind === 'resume_request').lastIndexOf(true)
  const textRequestIndex = conversation.messages.map(message =>
    message.direction === 'inbound' &&
    (message.kind || 'text') === 'text' &&
    isResumeSendRequest(message.content)
  ).lastIndexOf(true)
  const requestIndex = Math.max(nativeRequestIndex, textRequestIndex)
  const proactiveRequestedIndex = conversation.messages.map(message =>
    /附件简历请求已发送/.test(message.content)
  ).lastIndexOf(true)
  const sentIndex = conversation.messages.map(message =>
    message.kind === 'resume_sent' ||
    message.kind === 'resume_viewed' ||
    /(?:您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方|对方已查看了您的附件简历)/.test(message.content)
  ).lastIndexOf(true)
  const previousRequestId = conversation.resumeRequestMessageId
  if (requestIndex >= 0) conversation.resumeRequestMessageId = conversation.messages[requestIndex].id
  if (sentIndex >= 0 && sentIndex > requestIndex) {
    conversation.resumeRequestPending = false
    conversation.resumeProactiveSendPending = false
    conversation.resumeSentAt ||= conversation.messages[sentIndex].sentAt || syncedAt
    conversation.resumeSendError = undefined
    if (conversation.aiPaused && /^附件简历自动发送未确认：/.test(conversation.pauseReason || '')) {
      conversation.aiPaused = false
      conversation.pauseReason = undefined
      if (conversation.status !== 'ended') conversation.status = 'replied'
    }
    return
  }
  if (proactiveRequestedIndex >= 0) {
    conversation.resumeProactiveSendPending = false
    conversation.resumeProactiveRequestedAt ||= conversation.messages[proactiveRequestedIndex].sentAt || syncedAt
    conversation.resumeSendError = undefined
  }
  if (textRequestIndex >= 0) {
    const request = conversation.messages[textRequestIndex]
    const requestIsNewerThanProactiveReceipt = proactiveRequestedIndex < textRequestIndex
    if (!conversation.resumeSentAt && (!conversation.resumeProactiveRequestedAt || requestIsNewerThanProactiveReceipt)) {
      conversation.intent = 'resume'
      conversation.resumeProactiveSendPending = true
      conversation.resumeProactiveSourceMessageId = request.id
      conversation.resumeSendError = undefined
      conversation.replyPendingMessageId = undefined
    }
  }
  if (nativeRequestIndex < 0) return
  const request = conversation.messages[nativeRequestIndex]
  if (conversation.resumeSentAt && (!previousRequestId || previousRequestId === request.id)) {
    conversation.resumeRequestPending = false
    conversation.resumeSendError = undefined
    return
  }
  conversation.resumeRequestPending = Boolean(request.actionAvailable)
  if (conversation.resumeRequestPending) {
    conversation.resumeSentAt = undefined
    conversation.resumeSendError = undefined
    conversation.intent = 'resume'
  }
}

function isBossUiArtifact(content: string) {
  return /^你与该职位竞争者PK情况$/.test(content.replace(/\s+/g, ''))
}

function latestUnansweredInbound(conversation: BossConversation) {
  let lastOutboundIndex = -1
  let lastResumeRequestIndex = -1
  let latestInboundIndex = -1
  conversation.messages.forEach((message, index) => {
    if (message.direction === 'outbound') lastOutboundIndex = index
    if (message.kind === 'resume_request') lastResumeRequestIndex = index
    if (
      message.direction === 'inbound' &&
      !['resume_request', 'resume_sent', 'resume_viewed', 'system'].includes(message.kind || 'text')
    ) latestInboundIndex = index
  })
  if (latestInboundIndex <= Math.max(lastOutboundIndex, lastResumeRequestIndex)) return undefined
  const latest = conversation.messages[latestInboundIndex]
  if (latest.id === conversation.lastRepliedInboundMessageId) return undefined
  return latest
}

function hasDuplicateOutboundsAfterLatestInbound(conversation: BossConversation) {
  let latestInboundIndex = -1
  conversation.messages.forEach((message, index) => {
    if (message.direction === 'inbound' && !['resume_request', 'resume_sent', 'resume_viewed', 'system'].includes(message.kind || 'text')) {
      latestInboundIndex = index
    }
  })
  const fingerprints = conversation.messages
    .slice(latestInboundIndex + 1)
    .filter(message => message.direction === 'outbound')
    .map(message => normalizeOutboundContent(message.content))
    .filter(Boolean)
  return new Set(fingerprints).size < fingerprints.length
}

function latestLocationConfirmationPrompt(conversation: BossConversation) {
  const latestInbound = [...conversation.messages].reverse().find(message =>
    message.direction === 'inbound' &&
    (message.kind || 'text') === 'text'
  )
  return latestInbound && isLocationConfirmationPrompt(latestInbound.content) ? latestInbound : undefined
}

function applyLocationConfirmationHold(conversation: BossConversation, trigger = latestLocationConfirmationPrompt(conversation)) {
  if (!trigger || conversation.status === 'ended') return false
  const alreadyPaused = conversation.aiPaused && conversation.pauseReason === LOCATION_CONFIRMATION_PAUSE_REASON
  conversation.intent = 'location'
  conversation.aiPaused = true
  conversation.status = 'paused'
  conversation.pauseReason = LOCATION_CONFIRMATION_PAUSE_REASON
  conversation.draftReply = undefined
  conversation.draftKind = undefined
  conversation.draftEditedManually = undefined
  conversation.draftCreatedAt = undefined
  conversation.draftSourceMessageId = undefined
  conversation.draftRequiresReview = true
  conversation.replyPendingMessageId = undefined
  conversation.nextFollowupAt = undefined
  return !alreadyPaused
}

function readableModelError(error: unknown) {
  const raw = String(error).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '').trim()
  if (/524|网关超时|<!doctype\s+html|<html[\s>]/i.test(raw)) {
    return '模型网关超时（524），面试指南未生成。请稍后重试，或在设置中换用响应更快的模型。'
  }
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || '模型请求失败，请稍后重试。'
}

function shouldRetryInterviewGuide(error: unknown) {
  const raw = String(error)
  return /524|网关超时|请求超时|超过\s*120\s*秒|Timeout|非 JSON|Failed to fetch|模型请求失败（5\d\d）/i.test(raw)
}

function App() {
  const [state, setState] = useState<AppState | null>(null)
  const stateRef = useRef<AppState | null>(null)
  const [page, setPage] = useState<Page>('radar')
  const [toast, setToast] = useState<Toast | null>(null)
  const [busy, setBusy] = useState('')
  const [browserReady, setBrowserReady] = useState(false)
  const [browserFocus, setBrowserFocus] = useState(false)
  const [browserZoom, setBrowserZoom] = useState(0.86)
  const [browserUrl, setBrowserUrl] = useState('https://www.zhipin.com/web/geek/job')
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [resumeFile, setResumeFile] = useState<ResumeFile | null>(null)
  const [profileResumeFile, setProfileResumeFile] = useState<ResumeFile | null>(null)
  const browserRef = useRef<any>(null)
  const chatSyncInFlightRef = useRef(false)
  const chatSyncPendingTargetRef = useRef<BossConversation | null>(null)
  const chatSyncPendingOverviewRef = useRef<{ forceRefresh: boolean } | null>(null)
  const chatSyncPendingInterviewScanRef = useRef(false)
  const automationQueueInFlightRef = useRef(false)
  const jobCollectionInFlightRef = useRef(false)
  const conversationSendInFlightRef = useRef(new Set<string>())
  const resumeSendInFlightRef = useRef(new Set<string>())
  const jobSendInFlightRef = useRef(new Set<string>())
  const interviewGuideInFlightRef = useRef(new Set<string>())

  useEffect(() => {
    window.jobpilot.getState().then(loaded => {
      let resumeStateChanged = false
      let removedArtifactCount = 0
      let historicalInterviewCount = 0
      let staleInterviewCount = 0
      let staleInterviewPlaceholderCount = 0
      let locationPausedCount = 0
      let locationConfirmationPausedCount = 0
      let sanitizedInterviewErrorCount = 0
      let newlyEndedConversationCount = 0
      let clearedFollowupPlanCount = 0
      let duplicatePauseRecoveredCount = 0
      let rewrittenFollowupDraftCount = 0
      let removedHistoricalShellCount = 0
      let repairedHistoricalTimeCount = 0
      const sendHistoryMigration = backfillAutomationSendFingerprints(loaded)
      const duplicateGreetingQuarantineCount = quarantineDuplicateGreetingRecipients(loaded)
      const scriptFailureRecoveredCount = recoverScriptExecutionPausedFollowups(loaded)
      const conversationsBeforeHistoricalCleanup = loaded.bossConversations.length
      loaded.bossConversations = loaded.bossConversations.filter(conversation =>
        conversation.messages.length > 0
        || conversation.unreadCount > 0
        || Boolean(conversation.draftReply)
        || Boolean(conversation.resumeRequestPending || conversation.resumeProactiveSendPending)
        || conversationHasJobPilotSend(loaded, conversation)
      )
      removedHistoricalShellCount = conversationsBeforeHistoricalCleanup - loaded.bossConversations.length
      loaded.bossConversations.forEach(conversation => {
        if (repairImportedMessageTimes(conversation)) repairedHistoricalTimeCount += 1
      })
      loaded.bossConversations.sort((left, right) => conversationSortTime(right) - conversationSortTime(left))
      const staleInterviewPlaceholderIds = new Set<string>()
      loaded.jobs.forEach(job => {
        if (job.interviewGuideError) {
          const cleaned = readableModelError(job.interviewGuideError)
          if (cleaned !== job.interviewGuideError) {
            job.interviewGuideError = cleaned
            sanitizedInterviewErrorCount += 1
          }
        }
        const removablePlaceholder = job.title === '岗位待确认'
          && !job.interviewGuide
          && !job.sentAt
          && job.href === job.chatHref
          && !loaded.automationSendHistory.some(record => record.entityId === job.id)
        if (!job.interviewInvitation) {
          if (removablePlaceholder) staleInterviewPlaceholderIds.add(job.id)
          return
        }
        if (extractInterviewInvitation(job.interviewInvitation.message)) return
        job.interviewInvitation = undefined
        job.interviewGuideSourceMessageId = undefined
        job.interviewGuideGeneratedAt = undefined
        job.interviewGuideError = undefined
        if (!job.interviewGuide) job.status = job.lastContactAt ? 'replied' : 'sent'
        if (removablePlaceholder) staleInterviewPlaceholderIds.add(job.id)
        staleInterviewCount += 1
      })
      if (staleInterviewPlaceholderIds.size) {
        loaded.jobs = loaded.jobs.filter(job => !staleInterviewPlaceholderIds.has(job.id))
        loaded.bossConversations.forEach(conversation => {
          if (conversation.jobId && staleInterviewPlaceholderIds.has(conversation.jobId)) conversation.jobId = undefined
        })
        staleInterviewPlaceholderCount = staleInterviewPlaceholderIds.size
      }
      loaded.bossConversations.forEach(conversation => {
        const before = [conversation.resumeRequestMessageId, conversation.resumeRequestPending, conversation.resumeProactiveSendPending, conversation.resumeProactiveRequestedAt, conversation.resumeSentAt].join('|')
        applyResumeRequestState(conversation, conversation.lastSyncedAt || new Date().toISOString())
        if (clearLegacyUnknownLocationResumePause(conversation)) resumeStateChanged = true
        if (applyLocationConfirmationHold(conversation)) locationConfirmationPausedCount += 1
        const after = [conversation.resumeRequestMessageId, conversation.resumeRequestPending, conversation.resumeProactiveSendPending, conversation.resumeProactiveRequestedAt, conversation.resumeSentAt].join('|')
        if (before !== after) resumeStateChanged = true
        const artifactWasLatest = Boolean(conversation.messages.at(-1) && isBossUiArtifact(conversation.messages.at(-1)!.content))
        const messages = conversation.messages.filter(message => !isBossUiArtifact(message.content))
        removedArtifactCount += conversation.messages.length - messages.length
        if (messages.length === conversation.messages.length) return
        conversation.messages = messages
        const latestMessage = messages.at(-1)
        const latestInbound = [...messages].reverse().find(message => message.direction === 'inbound')
        const latestOutbound = [...messages].reverse().find(message => message.direction === 'outbound')
        conversation.lastInboundAt = latestInbound?.sentAt
        conversation.lastOutboundAt = latestOutbound?.sentAt
        if (latestMessage) conversation.lastMessageAt = latestMessage.sentAt
        if (isBossUiArtifact(conversation.preview)) conversation.preview = latestMessage?.content || ''
        conversation.intent = latestInbound ? detectChatIntent(latestInbound.content) : 'general'
        if ((artifactWasLatest || !latestInbound) && conversation.draftKind === 'reply' && !conversation.draftEditedManually) {
          conversation.draftReply = undefined
          conversation.draftKind = undefined
          conversation.draftCreatedAt = undefined
          conversation.draftRequiresReview = false
        }
        if (conversation.status !== 'ended') {
          conversation.status = conversation.aiPaused
            ? 'paused'
            : conversation.draftReply
              ? 'draft_ready'
              : latestMessage?.direction === 'outbound' ? 'replied' : 'new'
        }
      })
      loaded.bossConversations.forEach(conversation => {
        if (applyConversationEndDetection(conversation)) newlyEndedConversationCount += 1
        if (!conversationEligibleForFollowup(loaded, conversation) && clearConversationFollowupPlan(loaded, conversation)) {
          clearedFollowupPlanCount += 1
        }
      })
      loaded.jobs.forEach(job => {
        if (jobEligibleForFollowup(loaded, job)) return
        if (!job.nextFollowupAt && !job.followupDraft && job.status !== 'followup_due') return
        job.nextFollowupAt = undefined
        job.followupDraft = undefined
        if (job.status === 'followup_due') job.status = job.lastContactAt ? 'sent' : 'new'
        clearedFollowupPlanCount += 1
      })
      loaded.bossConversations.forEach(conversation => {
        if (
          conversation.status === 'ended'
          || conversation.pauseReason !== DUPLICATE_REPLY_PAUSE_REASON
          || hasDuplicateOutboundsAfterLatestInbound(conversation)
        ) return
        conversation.aiPaused = false
        conversation.pauseReason = undefined
        conversation.status = conversation.draftReply
          ? 'draft_ready'
          : conversation.messages.at(-1)?.direction === 'outbound' ? 'replied' : 'new'
        duplicatePauseRecoveredCount += 1
      })
      loaded.bossConversations.forEach(conversation => {
        if (conversation.draftKind !== 'followup' || !conversation.draftReply) return
        const interviewMentioned = conversation.messages.some(message => /面试|邀约/.test(message.content))
        const rewritten = sanitizeFollowupDraft(
          conversation.draftReply,
          conversationFollowupFallback(conversation),
          interviewMentioned
        )
        if (rewritten === conversation.draftReply) return
        conversation.draftReply = rewritten
        const linkedJob = conversation.jobId ? loaded.jobs.find(job => job.id === conversation.jobId) : undefined
        if (linkedJob) linkedJob.followupDraft = rewritten
        rewrittenFollowupDraftCount += 1
      })
      loaded.jobs.forEach(job => {
        if (!job.followupDraft) return
        const rewritten = sanitizeFollowupDraft(job.followupDraft, jobFollowupFallback(job))
        if (rewritten === job.followupDraft) return
        job.followupDraft = rewritten
        rewrittenFollowupDraftCount += 1
      })
      const recoveredInterviewSourceIds = new Set(
        loaded.jobs
          .map(job => job.interviewInvitation?.sourceMessageId)
          .filter((id): id is string => Boolean(id))
          .map(bossMessageSourceId)
      )
      loaded.bossConversations.forEach(conversation => {
        if (conversation.status === 'ended') return
        const invitationMessage = [...conversation.messages].reverse().find(message =>
          message.direction === 'inbound' &&
          (message.kind || 'text') === 'text' &&
          Boolean(extractInterviewInvitation(message.content))
        )
        if (!invitationMessage) return
        const sourceId = bossMessageSourceId(invitationMessage.id)
        if (recoveredInterviewSourceIds.has(sourceId)) return
        const linkedJob = conversation.jobId ? loaded.jobs.find(job => job.id === conversation.jobId) : undefined
        if (linkedJob?.interviewInvitation?.sourceMessageId === invitationMessage.id) return
        const receivedAt = bossMessageTime(invitationMessage.timeLabel, conversation.lastSyncedAt)?.toISOString()
          || invitationMessage.sentAt
          || conversation.lastSyncedAt
        const interviewJobId = captureInterviewInvitation(loaded, conversation, invitationMessage, receivedAt, false)
        if (interviewJobId) {
          recoveredInterviewSourceIds.add(sourceId)
          historicalInterviewCount += 1
        }
      })
      loaded.bossConversations.forEach(conversation => {
        if (conversation.status === 'ended' || conversation.aiPaused || !hasDuplicateOutboundsAfterLatestInbound(conversation)) return
        conversation.aiPaused = true
        conversation.status = 'paused'
        conversation.pauseReason = DUPLICATE_REPLY_PAUSE_REASON
        conversation.draftReply = undefined
        conversation.draftKind = undefined
        conversation.draftEditedManually = undefined
        conversation.draftCreatedAt = undefined
        conversation.draftSourceMessageId = undefined
        conversation.replyPendingMessageId = undefined
        loaded.activities.unshift({
          id: `${Date.now()}-duplicate-reply-${conversation.id}`,
          type: 'system',
          message: `${conversation.recruiter} 的会话检测到连续重复回复，已暂停 AI，请人工核对。`,
          createdAt: new Date().toISOString()
        })
        locationPausedCount += 1
      })
      loaded.bossConversations.forEach(conversation => {
        if (conversation.status === 'ended' || conversation.aiPaused) return
        const hasAutomatedSend = loaded.automationSendHistory.some(record =>
          record.entityId === conversation.id && record.automated && record.kind !== 'greeting'
        )
        if (!hasAutomatedSend) return
        const reason = conversation.resumeRequestPending || conversation.resumeProactiveSendPending
          ? conversationResumeBlockReason(loaded, conversation)
          : conversationAutoReplyBlockReason(loaded, conversation)
        if (!reason) return
        conversation.aiPaused = true
        conversation.status = 'paused'
        conversation.pauseReason = reason
        locationPausedCount += 1
        loaded.activities.unshift({
          id: `${Date.now()}-location-pause-${conversation.id}`,
          type: 'system',
          message: `${conversation.recruiter} 的历史自动发送会话已暂停：${reason}`,
          createdAt: new Date().toISOString()
        })
      })
      const missingDetailDrafts = loaded.jobs.filter(job =>
        job.status === 'pending_review' && Boolean(job.greetingDraft) && !hasDetailedJobDescription(job)
      )
      const invalidDrafts = loaded.jobs.filter(job =>
        job.status === 'pending_review' && Boolean(job.greetingDraft) && (
          !hasDetailedJobDescription(job) || job.greetingVersion !== CURRENT_GREETING_VERSION
        )
      )
      if (invalidDrafts.length) {
        invalidDrafts.forEach(job => {
          job.greetingDraft = undefined
          job.greetingVersion = undefined
          job.status = 'new'
        })
        if (missingDetailDrafts.length) loaded.lastCollectionAt = undefined
        loaded.activities.unshift({
          id: `${Date.now()}-invalidate-greetings`,
          type: 'system',
          message: `已作废 ${invalidDrafts.length} 条旧版招呼语，将按岗位匹配重新生成。`,
          createdAt: new Date().toISOString()
        })
      }
      if (removedArtifactCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-remove-boss-ui-artifacts`,
          type: 'system',
          message: `已清理 ${removedArtifactCount} 条误识别为消息的 BOSS 竞争者 PK 卡片及相关 AI 草稿。`,
          createdAt: new Date().toISOString()
        })
      }
      if (sendHistoryMigration.recovered) {
        loaded.activities.unshift({
          id: `${Date.now()}-recover-trusted-outbound`,
          type: 'system',
          message: `已修复 ${sendHistoryMigration.recovered} 个被历史可信发送误暂停的会话。`,
          createdAt: new Date().toISOString()
        })
      }
      if (duplicateGreetingQuarantineCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-quarantine-duplicate-greetings`,
          type: 'system',
          message: `检测到同一岗位存在重复招呼发送记录，已处理 ${duplicateGreetingQuarantineCount} 个相关岗位或会话并清除跟进计划。`,
          createdAt: new Date().toISOString()
        })
      }
      if (scriptFailureRecoveredCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-recover-script-failed-followups`,
          type: 'system',
          message: `已恢复 ${scriptFailureRecoveredCount} 条因旧会话定位脚本异常而暂停的跟进草稿；总自动化暂时挂起，待验证一条后恢复。`,
          createdAt: new Date().toISOString()
        })
      }
      if (historicalInterviewCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-recover-interviews`,
          type: 'interview',
          message: `已从历史对话补录 ${historicalInterviewCount} 条明确面试邀约。`,
          createdAt: new Date().toISOString()
        })
      }
      if (staleInterviewCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-remove-stale-interviews`,
          type: 'system',
          message: `已清理 ${staleInterviewCount} 条说明性面试话术，未将其误标为正式邀约。`,
          createdAt: new Date().toISOString()
        })
      }
      if (staleInterviewPlaceholderCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-remove-stale-interview-placeholders`,
          type: 'system',
          message: `已移除 ${staleInterviewPlaceholderCount} 个由说明性面试话术误建的空岗位占位。`,
          createdAt: new Date().toISOString()
        })
      }
      if (locationConfirmationPausedCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-location-confirmation-hold`,
          type: 'system',
          message: `已暂停 ${locationConfirmationPausedCount} 个待人工确认工作地点的会话，避免 AI 自动回复。`,
          createdAt: new Date().toISOString()
        })
      }
      if (sanitizedInterviewErrorCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-sanitize-interview-errors`,
          type: 'system',
          message: `已清理 ${sanitizedInterviewErrorCount} 条面试指南模型错误展示。`,
          createdAt: new Date().toISOString()
        })
      }
      if (newlyEndedConversationCount || clearedFollowupPlanCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-followup-eligibility-cleanup`,
          type: 'system',
          message: `已清理 ${clearedFollowupPlanCount} 条不符合条件的历史跟进计划，并补标 ${newlyEndedConversationCount} 个已结束会话。`,
          createdAt: new Date().toISOString()
        })
      }
      if (duplicatePauseRecoveredCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-recover-valid-multiple-outbounds`,
          type: 'system',
          message: `已恢复 ${duplicatePauseRecoveredCount} 个被正常多段沟通或跟进误暂停的会话。`,
          createdAt: new Date().toISOString()
        })
      }
      if (rewrittenFollowupDraftCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-rewrite-followup-drafts`,
          type: 'system',
          message: `已将 ${rewrittenFollowupDraftCount} 条生硬的旧跟进草稿改为简短自然的进度询问。`,
          createdAt: new Date().toISOString()
        })
      }
      if (removedHistoricalShellCount || repairedHistoricalTimeCount) {
        loaded.activities.unshift({
          id: `${Date.now()}-historical-chat-baseline-cleanup`,
          type: 'system',
          message: `已移除 ${removedHistoricalShellCount} 个无消息的历史会话占位，并修正 ${repairedHistoricalTimeCount} 个历史会话的消息时间。`,
          createdAt: new Date().toISOString()
        })
      }
      if (invalidDrafts.length || resumeStateChanged || removedArtifactCount || sendHistoryMigration.backfilled || sendHistoryMigration.recovered || duplicateGreetingQuarantineCount || scriptFailureRecoveredCount || historicalInterviewCount || staleInterviewCount || staleInterviewPlaceholderCount || locationPausedCount || locationConfirmationPausedCount || sanitizedInterviewErrorCount || newlyEndedConversationCount || clearedFollowupPlanCount || duplicatePauseRecoveredCount || rewrittenFollowupDraftCount || removedHistoricalShellCount || repairedHistoricalTimeCount) {
        void window.jobpilot.saveState(loaded)
      }
      setState(loaded)
      stateRef.current = loaded
      setBrowserUrl(loaded.config.browser.homeUrl)
      void generatePendingInterviewGuides(loaded)
    }).catch(error => showToast('error', String(error)))
  }, [])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (state) void generatePendingInterviewGuides(state)
  }, [state?.jobs, state?.config.automation.enabled, state?.config.automation.interviewAutoGuideEnabled, state?.config.model.apiKeyConfigured])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = stateRef.current
      if (!current?.config.automation.enabled || !current.config.automation.followupEnabled || current.automationPaused) return
      const now = Date.now()
      updateState(next => {
        let changed = false
        next.jobs.forEach(job => {
          if (
            job.status === 'sent' &&
            job.nextFollowupAt &&
            new Date(job.nextFollowupAt).getTime() <= now &&
            job.followupCount < next.config.automation.maxFollowups &&
            jobEligibleForFollowup(next, job)
          ) {
            job.status = 'followup_due'
            changed = true
          }
        })
        if (changed) addActivity(next, 'followup', '有岗位到达跟进时间，已加入待跟进队列。')
      }, false)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!browserReady) return
    const timer = window.setInterval(async () => {
      const current = stateRef.current
      if (!current?.config.automation.enabled || !current.config.automation.pauseOnCaptcha || current.automationPaused) return
      try {
        const detected = await browserRef.current?.executeJavaScript(captchaDetectionScript)
        if (detected) {
          updateState(next => {
            next.automationPaused = true
            next.pauseReason = '检测到安全验证，请在内置浏览器中手动完成后恢复任务。'
            addActivity(next, 'captcha', '检测到 BOSS 安全验证，自动化已暂停。')
          })
          showToast('error', '检测到安全验证，已暂停自动化')
        }
      } catch {
        // Browser navigation can invalidate an in-flight script. Retry on next interval.
      }
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [browserReady])

  useEffect(() => {
    const checkCollectionSchedule = () => {
      const current = stateRef.current
      if (
        !browserReady ||
        !current?.config.automation.enabled ||
        !current.config.automation.collectionEnabled ||
        current.automationPaused ||
        !isWithinAutomationWindow(current) ||
        automationQueueInFlightRef.current ||
        jobCollectionInFlightRef.current
      ) return
      const intervalMs = Math.max(5, current.config.automation.collectionIntervalMinutes) * 60_000
      const lastAttemptAt = current.lastCollectionAt ? new Date(current.lastCollectionAt).getTime() : 0
      if (Number.isFinite(lastAttemptAt) && Date.now() - lastAttemptAt < intervalMs) return
      void collectJobs(true)
    }
    checkCollectionSchedule()
    const timer = window.setInterval(checkCollectionSchedule, 15_000)
    return () => window.clearInterval(timer)
  }, [browserReady, state?.config.automation.collectionEnabled, state?.config.automation.collectionIntervalMinutes])

  useEffect(() => {
    const seconds = Math.max(15, stateRef.current?.config.automation.chatPollingSeconds || 30)
    const timer = window.setInterval(() => {
      const current = stateRef.current
      if (!current?.config.automation.enabled || !current.config.automation.chatSyncEnabled || current.automationPaused) return
      void syncBossChats(true)
    }, seconds * 1000)
    return () => window.clearInterval(timer)
  }, [state?.config.automation.chatPollingSeconds, state?.config.automation.chatSyncEnabled])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void processAutomationQueue()
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  function showToast(type: Toast['type'], message: string) {
    setToast({ type, message })
  }

  function notifyUser(title: string, message: string, kind: 'captcha' | 'manual') {
    const notifications = stateRef.current?.config.notifications
    if (
      !notifications?.enabled ||
      !notifications.webhookConfigured ||
      (kind === 'captcha' && !notifications.notifyCaptcha) ||
      (kind === 'manual' && !notifications.notifyManualReview)
    ) return
    void window.jobpilot.sendNotification(title, message).catch(() => {
      // Notification delivery must never block the local automation safety path.
    })
  }

  function addActivity(next: AppState, type: AppState['activities'][number]['type'], message: string) {
    next.activities.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      message,
      createdAt: new Date().toISOString()
    })
    next.activities = next.activities.slice(0, 100)
    if (type === 'captcha') notifyUser('JobPilot 需要人机验证', message, 'captcha')
    else if (/等待你手动确认|需人工确认|工具状态冲突/.test(message)) {
      notifyUser('JobPilot 需要人工处理', message, 'manual')
    }
  }

  function updateState(mutator: (next: AppState) => void, persist = true) {
    setState(current => {
      if (!current) return current
      const next = structuredClone(current)
      mutator(next)
      next.updatedAt = new Date().toISOString()
      stateRef.current = next
      if (persist) void window.jobpilot.saveState(next)
      return next
    })
  }

  function isWithinAutomationWindow(current: AppState) {
    const now = new Date().toTimeString().slice(0, 5)
    return now >= current.config.automation.workdayStart && now <= current.config.automation.workdayEnd
  }

  function automationSendCount(current: AppState) {
    const today = new Date().toDateString()
    return current.automationSendHistory.filter(item => new Date(item.sentAt).toDateString() === today).length
  }

  function automationBlockReason(current: AppState, automated: boolean) {
    if (!automated) return ''
    if (!current.config.automation.enabled) return '自动任务未启用'
    if (current.automationPaused) return current.pauseReason || '自动化已暂停'
    if (!isWithinAutomationWindow(current)) return `当前不在执行时段 ${current.config.automation.workdayStart}-${current.config.automation.workdayEnd}`
    if (automationSendCount(current) >= current.config.automation.dailyLimit) return `已达到每日发送上限 ${current.config.automation.dailyLimit}`
    const latest = [...current.automationSendHistory].sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())[0]
    if (latest?.nextAllowedAt && new Date(latest.nextAllowedAt).getTime() > Date.now()) return '还未到达下一次自动发送间隔'
    return ''
  }

  function conversationAutoReplyBlockReason(current: AppState, conversation: BossConversation) {
    if (!current.config.target.locationConstraintEnabled) return ''
    const linkedJob = conversation.jobId ? current.jobs.find(job => job.id === conversation.jobId) : undefined
    if (!linkedJob) {
      return '未确认该会话对应岗位的城市/地址，已暂停自动回复，请人工核对后继续。'
    }
    const fit = jobLocationFit(linkedJob, current)
    if (fit === 'outside' || fit === 'excluded') {
      return `该岗位不在通勤范围内（${linkedJob.city || linkedJob.workAddress || '外地'}），已暂停自动回复。`
    }
    if (fit === 'unknown' && current.config.target.requireKnownLocationForAutoSend) {
      return '该岗位地址尚未确认，已暂停自动回复，请先核对工作地点。'
    }
    return ''
  }

  // Resume requests can arrive before a BOSS chat is linked to a collected
  // job. Unknown location must not stall that explicit attachment workflow.
  function conversationResumeBlockReason(current: AppState, conversation: BossConversation) {
    if (!current.config.target.locationConstraintEnabled) return ''
    const linkedJob = conversation.jobId ? current.jobs.find(job => job.id === conversation.jobId) : undefined
    if (!linkedJob) return ''
    const fit = jobLocationFit(linkedJob, current)
    if (fit === 'outside' || fit === 'excluded') {
      return `该岗位不在通勤范围内（${linkedJob.city || linkedJob.workAddress || '外地'}），已暂停自动发送附件简历。`
    }
    return ''
  }

  function isLegacyUnknownLocationPause(reason?: string) {
    return Boolean(reason && (
      reason.startsWith('未确认该会话对应岗位的城市/地址')
      || reason.startsWith('该岗位地址尚未确认')
    ))
  }

  function clearLegacyUnknownLocationResumePause(conversation: BossConversation) {
    if (
      (!conversation.resumeRequestPending && !conversation.resumeProactiveSendPending)
      || !conversation.aiPaused
      || !isLegacyUnknownLocationPause(conversation.pauseReason)
    ) return false
    conversation.aiPaused = false
    conversation.status = conversation.status === 'paused' ? 'replied' : conversation.status
    conversation.pauseReason = undefined
    conversation.resumeSendError = undefined
    return true
  }

  function pauseConversationForAutomationBlock(conversationId: string, reason: string) {
    updateState(next => {
      const target = next.bossConversations.find(item => item.id === conversationId)
      if (!target || target.status === 'ended') return
      target.aiPaused = true
      target.status = 'paused'
      target.pauseReason = reason
      addActivity(next, 'system', `${target.recruiter} 的自动化已暂停：${reason}`)
    })
  }

  function nextConversationFollowupAt(current: AppState, followupCount: number) {
    if (!current.config.automation.followupEnabled) return undefined
    const days = current.config.automation.followupDays.filter(day => Number.isFinite(day) && day > 0)
    const delay = days[followupCount] ?? (days.length ? days[days.length - 1] : 3)
    return daysFromNow(delay)
  }

  function linkConversationToSentJob(next: AppState, conversation: BossConversation) {
    const normalize = (value?: string) => (value || '').replace(/\s+/g, '').toLowerCase()
    const normalizeMessage = (value?: string) => normalize(value)
      .replace(/^(?:\[?(?:已读|送达|未读)\]?)/, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
    const overlaps = (left?: string, right?: string) => {
      const a = normalize(left)
      const b = normalize(right)
      return Boolean(a && b && (a.includes(b) || b.includes(a)))
    }
    const allJobs = [...next.jobs]
      .sort((a, b) => new Date(b.sentAt || b.capturedAt).getTime() - new Date(a.sentAt || a.capturedAt).getTime())
    const sentJobs = allJobs.filter(job => Boolean(job.sentAt))
    const outboundContents = conversation.messages
      .filter(message => message.direction === 'outbound')
      .map(message => normalizeMessage(message.content))
    const preview = normalizeMessage(conversation.preview)
    const greetingMatches = (job: JobRecord) => {
      const greeting = normalizeMessage(job.greetingDraft)
      return Boolean(greeting && (outboundContents.includes(greeting) || preview === greeting))
    }
    const greetingMatched = sentJobs.find(job => greetingMatches(job) && overlaps(job.company, conversation.company))
      || sentJobs.find(greetingMatches)
    const linked = conversation.jobId ? sentJobs.find(job => job.id === conversation.jobId) : undefined
    const sentCompanyMatches = sentJobs.filter(job => overlaps(job.company, conversation.company))
    const uniqueSentCompanyMatch = sentCompanyMatches.length === 1 ? sentCompanyMatches[0] : undefined
    const matched = linked || greetingMatched || uniqueSentCompanyMatch || allJobs.find(job => {
      const recruiterMatches = overlaps(job.recruiter, conversation.recruiter)
      const companyMatches = overlaps(job.company, conversation.company)
      const titleMatches = overlaps(job.title, conversation.jobTitle)
      return (companyMatches && titleMatches) || (recruiterMatches && (companyMatches || titleMatches))
    })
    if (!matched) return undefined

    conversation.jobId = matched.id
    matched.chatHref = conversation.href || matched.chatHref
    const lastDirection = conversation.messages.at(-1)?.direction
    if (lastDirection === 'inbound' && matched.status !== 'interview') {
      matched.status = 'replied'
      matched.nextFollowupAt = undefined
      conversation.nextFollowupAt = undefined
    } else if (
      lastDirection === 'outbound' &&
      matched.status !== 'interview' &&
      matched.nextFollowupAt &&
      !conversation.nextFollowupAt &&
      conversationEligibleForFollowup(next, conversation)
    ) {
      conversation.nextFollowupAt = matched.nextFollowupAt
      conversation.followupCount = Math.max(conversation.followupCount, matched.followupCount)
    }
    if (matched.status === 'interview') {
      matched.nextFollowupAt = undefined
      conversation.nextFollowupAt = undefined
    }
    if (lastDirection === 'outbound' && matched.status !== 'interview' && conversation.status !== 'ended' && !conversation.aiPaused) {
      conversation.status = 'replied'
    }
    return matched
  }

  function linkConversationToCollectedJob(next: AppState, conversation: BossConversation) {
    const matched = linkConversationToSentJob(next, conversation)
    if (matched) return matched
    if (!conversation.jobHref || !conversation.jobTitle || !conversation.company) return undefined
    const existing = next.jobs.find(job => job.href === conversation.jobHref)
    if (existing) {
      conversation.jobId = existing.id
      existing.chatHref = conversation.href || existing.chatHref
      return existing
    }
    const now = new Date().toISOString()
    const job: JobRecord = {
      id: `${Date.now()}-${fingerprint(conversation.jobHref)}`,
      fingerprint: fingerprint(conversation.jobHref),
      title: conversation.jobTitle,
      company: conversation.company,
      salary: '',
      city: '',
      experience: '',
      education: '',
      description: '',
      recruiter: conversation.recruiter,
      href: conversation.jobHref,
      chatHref: conversation.href,
      source: 'boss',
      status: 'new',
      capturedAt: now,
      followupCount: 0
    }
    next.jobs.unshift(job)
    conversation.jobId = job.id
    addActivity(next, 'collect', `从 BOSS 会话发现岗位：${job.company} · ${job.title}，已加入岗位雷达待补全。`)
    return job
  }

  function createInterviewJobFromConversation(next: AppState, conversation: BossConversation, invitationMessage: string) {
    const companyFromInvitation = invitationMessage.match(/^\s*(.{2,40}?)邀请您(?:现场|视频|电话|线上|线下)?面试/)?.[1]?.trim()
    const company = companyFromInvitation || conversation.company || '公司待确认'
    const rawTitle = conversation.jobTitle.trim()
    const title = !rawTitle || /^(?:招聘者|招聘经理|招聘专员|人事|HR|BOSS|经理)$/i.test(rawTitle)
      ? '岗位待确认'
      : rawTitle
    const existing = next.jobs.find(job =>
      job.interviewInvitation?.sourceConversationId === conversation.id
      || (job.company === company && job.title === title && job.chatHref === conversation.href)
    )
    if (existing) {
      conversation.jobId = existing.id
      return existing
    }
    const now = new Date().toISOString()
    const identity = `interview|${conversation.externalId}|${company}|${title}`
    const job: JobRecord = {
      id: `${Date.now()}-${fingerprint(identity)}`,
      fingerprint: fingerprint(identity),
      title,
      company,
      salary: '',
      city: '',
      experience: '',
      education: '',
      description: '',
      recruiter: conversation.recruiter,
      href: conversation.jobHref || conversation.href,
      chatHref: conversation.href,
      source: 'boss',
      status: 'new',
      capturedAt: now,
      followupCount: 0
    }
    next.jobs.unshift(job)
    conversation.jobId = job.id
    addActivity(next, 'collect', `从 BOSS 面试邀约建立岗位占位：${job.company} · ${job.title}，可在面试准备中继续补充。`)
    return job
  }

  function captureInterviewInvitation(next: AppState, conversation: BossConversation, message: BossChatMessage, receivedAt: string, logUnlinked = true) {
    const details = extractInterviewInvitation(message.content)
    if (!details) return undefined
    const job = (conversation.jobId ? next.jobs.find(item => item.id === conversation.jobId) : undefined)
      || linkConversationToSentJob(next, conversation)
      || linkConversationToCollectedJob(next, conversation)
      || createInterviewJobFromConversation(next, conversation, message.content)
    const isNewInvitation = job.interviewInvitation?.sourceMessageId !== message.id
    job.interviewInvitation = {
      sourceConversationId: conversation.id,
      sourceMessageId: message.id,
      receivedAt,
      ...details
    }
    job.status = 'interview'
    job.nextFollowupAt = undefined
    job.followupDraft = undefined
    conversation.nextFollowupAt = undefined
    if (isNewInvitation) {
      job.interviewGuideError = undefined
      addActivity(next, 'interview', `检测到 ${job.company} · ${job.title} 的面试邀请，已加入面试作战室。`)
    }
    return job.id
  }

  function recordAutomationSend(next: AppState, kind: 'greeting' | 'chat_reply' | 'followup' | 'resume', entityId: string, automated: boolean, content?: string) {
    const now = new Date()
    const min = Math.max(0, next.config.automation.intervalMinSeconds)
    const max = Math.max(min, next.config.automation.intervalMaxSeconds)
    const delay = automated ? Math.round((min + Math.random() * (max - min)) * 1000) : 0
    next.automationSendHistory.unshift({
      id: `${now.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      entityId,
      sentAt: now.toISOString(),
      automated,
      contentFingerprint: outboundContentFingerprint(content),
      entityFingerprint: kind === 'greeting'
        ? (() => {
            const job = next.jobs.find(item => item.id === entityId)
            return job ? jobGreetingFingerprint(job) : undefined
          })()
        : undefined,
      nextAllowedAt: automated ? new Date(now.getTime() + delay).toISOString() : undefined
    })
    next.automationSendHistory = next.automationSendHistory.slice(0, 500)
  }

  function replaceState(next: AppState) {
    stateRef.current = next
    setState(next)
  }

  async function prepareTargetExpectation(current: AppState) {
    const jobsUrl = 'https://www.zhipin.com/web/geek/jobs'
    const currentUrl = browserRef.current?.getURL?.() || ''
    if (!/\/web\/geek\/jobs(?:[/?#]|$)/.test(currentUrl)) {
      setBrowserUrl(jobsUrl)
      await waitForBrowserLoad(jobsUrl)
      await new Promise(resolve => window.setTimeout(resolve, 600))
    }
    const role = current.config.target.keywords.find(keyword => keyword.trim()) || current.profile.targetRole
    const city = current.config.target.city || current.profile.targetCity
    const selected = await browserRef.current.executeJavaScript(selectBossExpectationScript(role, city)) as {
      ok: boolean
      label: string
      active?: boolean
      changed?: boolean
      signature: string
    }
    if (!selected.ok) throw new Error(`未找到 BOSS 求职期望标签“${selected.label}”，请先在 BOSS 中添加该求职期望`)
    const startedAt = Date.now()
    let ready = false
    let stableSignature = ''
    let stableChecks = 0
    while (Date.now() - startedAt < 10_000) {
      await new Promise(resolve => window.setTimeout(resolve, 300))
      const page = await browserRef.current.executeJavaScript(bossExpectationStateScript(role, city)) as {
        found: boolean
        active: boolean
        signature: string
        jobCount: number
      }
      if (!page.found || !page.jobCount || !page.signature) {
        stableSignature = ''
        stableChecks = 0
        continue
      }
      if (page.signature === stableSignature) stableChecks += 1
      else {
        stableSignature = page.signature
        stableChecks = 1
      }
      const transitionFinished = !selected.changed
        || page.signature !== selected.signature
        || Date.now() - startedAt >= 5_000
      if (Date.now() - startedAt >= 900 && transitionFinished && stableChecks >= 2) {
        ready = true
        break
      }
    }
    if (!ready) throw new Error(`BOSS 求职期望“${selected.label}”的职位列表加载超时，请重试`)
    setBrowserUrl(browserRef.current?.getURL?.() || jobsUrl)
    return selected.label
  }

  async function collectJobs(quiet = false) {
    const current = stateRef.current
    if (!current) return
    if (jobCollectionInFlightRef.current) {
      if (!quiet) showToast('info', '岗位采集正在进行中')
      return
    }
    if (automationQueueInFlightRef.current) {
      if (!quiet) showToast('info', '自动消息队列正在处理，请稍后再采集')
      return
    }
    if (current.config.browser.mode === 'system_chrome') {
      await window.jobpilot.openSystemChrome(current.config.browser.homeUrl)
      if (!quiet) showToast('info', '系统 Chrome 已打开。系统 Chrome 模式暂不支持页面采集。')
      return
    }
    if (!browserRef.current) {
      if (!quiet) showToast('error', '内置浏览器尚未就绪')
      return
    }
    jobCollectionInFlightRef.current = true
    setBusy(quiet ? 'collect-auto' : 'collect')
    let sourceUrl = browserRef.current.getURL?.() || browserUrl
    try {
      const expectationLabel = await prepareTargetExpectation(current)
      sourceUrl = browserRef.current.getURL?.() || sourceUrl
      const captured = await browserRef.current.executeJavaScript(collectJobsScript) as CapturedJob[]
      if (!captured.length) throw new Error(`BOSS 求职期望“${expectationLabel}”当前没有可采集的岗位`)
      const now = new Date().toISOString()
      const dedupeCutoff = Date.now() - current.config.automation.dedupeDays * 86_400_000
      const existing = new Set(current.jobs
        .filter(job => new Date(job.capturedAt).getTime() >= dedupeCutoff)
        .map(job => job.fingerprint))
      const normalizedJobs = captured
        .map(job => ({ ...job, fingerprint: fingerprint(job.href || `${job.company}|${job.title}`) }))
      const refreshedCount = normalizedJobs.filter(job => existing.has(job.fingerprint)).length
      const newJobs = normalizedJobs
        .filter(job => !existing.has(job.fingerprint))
        .map<JobRecord>(job => ({
          id: `${Date.now()}-${job.fingerprint}`,
          fingerprint: job.fingerprint,
          title: job.title,
          company: job.company,
          salary: job.salary,
          city: job.city,
          experience: job.experience,
          education: job.education,
          description: job.description,
          recruiter: job.recruiter,
          href: job.href,
          source: 'boss',
          status: 'new',
          score: localScore(job, current),
          capturedAt: now,
          followupCount: 0
        }))
      updateState(next => {
        for (const source of normalizedJobs) {
          const target = next.jobs.find(job => job.fingerprint === source.fingerprint)
          if (!target) continue
          target.salary = source.salary || target.salary
          target.city = source.city || target.city
          target.experience = source.experience || target.experience
          target.education = source.education || target.education
          if (source.description && (
            !hasDetailedJobDescription(target) || source.description.length > target.description.length
          )) target.description = source.description
          target.recruiter = source.recruiter || target.recruiter
          if (['new', 'scored'].includes(target.status)) target.score = localScore(target, next)
        }
        next.jobs.unshift(...newJobs)
        addActivity(next, 'collect', `从求职期望“${expectationLabel}”采集 ${captured.length} 个岗位，新增 ${newJobs.length} 个，刷新 ${refreshedCount} 个。`)
      })
      await new Promise(resolve => window.setTimeout(resolve, 0))
      const collectedFingerprints = new Set(normalizedJobs.map(job => job.fingerprint))
      const addressTargets = (stateRef.current?.jobs || []).filter(job => collectedFingerprints.has(job.fingerprint))
      const addressResult = await enrichCandidateAddresses(addressTargets, {
        quiet: true,
        restoreUrl: sourceUrl,
        includeAllMissing: true
      })
      if (!quiet && !addressResult.blocked) {
        showToast(
          addressResult.failed ? 'info' : 'success',
          `已从“${expectationLabel}”采集：新增 ${newJobs.length} 个，刷新 ${refreshedCount} 个，读取地址 ${addressResult.completed} 个、职位描述 ${addressResult.descriptions} 个${addressResult.failed ? `，未识别 ${addressResult.failed} 个` : ''}`
        )
      }
    } catch (error) {
      if (quiet) {
        updateState(next => addActivity(next, 'collect', `定时采集失败：${String(error)}`))
      } else showToast('error', `采集失败：${String(error)}`)
    } finally {
      updateState(next => { next.lastCollectionAt = new Date().toISOString() })
      jobCollectionInFlightRef.current = false
      setBusy('')
    }
  }

  async function syncBossChats(
    quiet = false,
    targetConversation?: BossConversation,
    mode: 'normal' | 'interview' = 'normal',
    forceRefreshOverview = false
  ) {
    const current = stateRef.current
    if (!current) return
    const interviewScan = mode === 'interview' && !targetConversation
    if (chatSyncInFlightRef.current) {
      if (targetConversation) chatSyncPendingTargetRef.current = targetConversation
      else if (interviewScan) {
        chatSyncPendingInterviewScanRef.current = true
        if (!quiet) setBusy('interview-scan')
      } else {
        chatSyncPendingOverviewRef.current = {
          forceRefresh: Boolean(chatSyncPendingOverviewRef.current?.forceRefresh || forceRefreshOverview)
        }
        if (!quiet) {
          setBusy('chat-sync')
          showToast('info', '上一轮同步仍在读取会话详情，完整列表刷新已排队。')
        }
      }
      return
    }
    chatSyncInFlightRef.current = true
    let detailTargets: BossConversation[] = []
    const priorityDetailTargetIds = new Set<string>()
    if (!quiet) setBusy(interviewScan ? 'interview-scan' : 'chat-sync')
    try {
      const captured = await (targetConversation
        ? window.jobpilot.syncBossConversation(targetConversation.externalId, targetConversation.recruiter, targetConversation.company)
        : interviewScan
          ? window.jobpilot.scanInterviewInvitations(30)
        : window.jobpilot.syncBossChats(forceRefreshOverview)) as {
        ok: boolean
        url: string
        title: string
        conversations: CapturedBossConversation[]
        captcha?: boolean
        error?: string
        scanned?: number
        total?: number
        errors?: number
      }
      if (captured.captcha) {
        updateState(next => {
          if (!next.automationPaused) addActivity(next, 'captcha', '后台同步检测到 BOSS 安全验证，自动化已暂停。')
          next.automationPaused = true
          next.pauseReason = captured.error || '检测到安全验证，请人工完成后恢复任务。'
        })
        if (!quiet) showToast('error', captured.error || '检测到安全验证，自动化已暂停')
        return
      }
      if (!captured.ok) throw new Error(captured.error || '当前页面不是 BOSS 直聘聊天页')
      if (!captured.conversations.length) {
        if (!quiet) showToast('info', interviewScan ? '暂未读取到最近会话，请先在 BOSS 消息页确认已登录后重试' : '聊天页已打开，但暂未识别到会话；请打开一位招聘者的对话后重试')
        return
      }

      const syncedAt = new Date().toISOString()
      const draftIds: string[] = []
      const resumeRequestIds = new Set<string>()
      const proactiveResumeIds = new Set<string>()
      const interviewGuideJobIds = new Set<string>()
      let newConversationCount = 0
      let newInboundCount = 0
      updateState(next => {
        for (const [capturedIndex, item] of captured.conversations.entries()) {
          const existing = next.bossConversations.find(conversation => conversation.externalId === item.externalId)
            || next.bossConversations.find(conversation =>
              conversation.recruiter.includes(item.recruiter) && conversation.preview === item.preview)
          const normalizedMessages = normalizeCapturedMessageTimes(item, syncedAt, next.profile.name)
          if (!existing) {
            const overviewMessageTime = bossMessageTime(item.timeLabel, syncedAt)
            const overviewAge = overviewMessageTime
              ? new Date(syncedAt).getTime() - overviewMessageTime.getTime()
              : Number.POSITIVE_INFINITY
            const isRecentOverviewConversation = overviewAge >= -5 * 60_000 && overviewAge <= 3 * 86_400_000
            const isRecentEmptyConversation = capturedIndex < 5 && !item.preview
            if (
              !item.active &&
              item.unreadCount === 0 &&
              !normalizedMessages.length &&
              !isRecentOverviewConversation &&
              !isRecentEmptyConversation
            ) continue
            const lastMessage = normalizedMessages.at(-1)
            const intent = lastMessage?.direction === 'inbound' ? detectChatIntent(lastMessage.content) : 'general'
            const id = `boss-chat-${fingerprint(item.externalId)}`
            next.bossConversations.push({
              id,
              externalId: item.externalId,
              recruiter: item.recruiter || '招聘者',
              company: item.company,
              jobTitle: item.jobTitle,
              jobHref: item.jobHref,
              href: item.href || captured.url,
              unreadCount: item.unreadCount,
              preview: item.preview || lastMessage?.content || '',
              messages: normalizedMessages.slice(-100),
              status: lastMessage?.direction === 'outbound' ? 'replied' : 'new',
              intent,
              draftRequiresReview: next.config.automation.sensitiveChatIntents.includes(intent),
              aiPaused: false,
              lastMessageAt: lastMessage?.sentAt || overviewMessageTime?.toISOString() || syncedAt,
              lastInboundAt: [...normalizedMessages].reverse().find(message => message.direction === 'inbound')?.sentAt,
              lastOutboundAt: [...normalizedMessages].reverse().find(message => message.direction === 'outbound')?.sentAt,
              followupCount: 0,
              lastSyncedAt: syncedAt,
              lastDetailedSyncAt: item.active ? syncedAt : undefined
            })
            const created = next.bossConversations.at(-1)!
            applyResumeRequestState(created, syncedAt)
            applyConversationEndDetection(created)
            linkConversationToCollectedJob(next, created)
            const latestInbound = [...created.messages].reverse().find(message =>
              message.direction === 'inbound' && !['resume_request', 'resume_sent', 'resume_viewed', 'system'].includes(message.kind || 'text'))
            if (latestInbound && isLocationConfirmationPrompt(latestInbound.content)) {
              if (applyLocationConfirmationHold(created, latestInbound)) {
                addActivity(next, 'system', `${created.recruiter} 发来工作地点确认卡片，已暂停 AI，等待你手动确认。`)
              }
            } else if (latestInbound) {
              const interviewJobId = captureInterviewInvitation(next, created, latestInbound, syncedAt)
              if (interviewJobId) interviewGuideJobIds.add(interviewJobId)
            }
            newConversationCount += 1
            if (!item.active && !normalizedMessages.length && created.status !== 'ended') {
              priorityDetailTargetIds.add(id)
            }
            if (created.resumeRequestPending) resumeRequestIds.add(id)
            if (item.unreadCount > 0 && lastMessage?.direction === 'inbound' && created.status !== 'ended' && !created.aiPaused) {
              const latestInbound = latestUnansweredInbound(created)
              const proactiveResumeRequest = Boolean(
                latestInbound && isResumeSendRequest(latestInbound.content) && !created.resumeSentAt && !created.resumeProactiveRequestedAt
              )
              if (proactiveResumeRequest && latestInbound) {
                created.intent = 'resume'
                created.resumeProactiveSendPending = true
                created.resumeProactiveSourceMessageId = latestInbound.id
                created.replyPendingMessageId = undefined
                proactiveResumeIds.add(id)
              } else {
                created.replyPendingMessageId = created.resumeRequestPending || created.resumeProactiveSendPending
                  ? undefined
                  : latestInbound?.id
                if (!created.resumeRequestPending && !created.resumeProactiveSendPending && created.replyPendingMessageId) draftIds.push(id)
              }
            }
            continue
          }

          existing.externalId = item.externalId
          existing.jobHref ||= item.jobHref
          const previousPreview = existing.preview
          const messageKey = (message: { content: string; timeLabel?: string }) => {
            const content = message.content.trim().replace(/^(?:已读|送达|未读)\s+/, '')
            return `${content}|${message.timeLabel || ''}`
          }
          const knownKeys = new Set(existing.messages.map(messageKey))
          const newMessages = normalizedMessages.filter(message => !knownKeys.has(messageKey(message)))
          const newInbound = newMessages.filter(message =>
            message.direction === 'inbound' && !['resume_sent', 'resume_viewed', 'system'].includes(message.kind || 'text'))
          const newOutbound = newMessages.filter(message => message.direction === 'outbound')
          const hadMessagesBeforeSync = existing.messages.length > 0
          // Keep the pre-sync send context. A single BOSS refresh can contain both
          // our newly sent message and the recruiter's reply; inbound handling below
          // intentionally clears the draft, so outbound reconciliation must use this
          // snapshot instead of the mutable conversation object.
          const draftBeforeSync = existing.draftReply
          const draftKindBeforeSync = existing.draftKind
          const draftSourceMessageIdBeforeSync = existing.draftSourceMessageId
          const lastAutomatedMessageBeforeSync = existing.lastAutomatedMessage
          const previousLastSyncedAt = existing.lastSyncedAt
          const actionableInbound = newInbound.filter(message =>
            item.unreadCount > 0
            || (hadMessagesBeforeSync && new Date(message.sentAt).getTime() >= new Date(previousLastSyncedAt).getTime() - 60_000)
          )
          existing.recruiter = item.recruiter || existing.recruiter
          existing.company = item.company || existing.company
          existing.jobTitle = item.jobTitle || existing.jobTitle
          existing.href = item.href || existing.href || captured.url
          existing.unreadCount = item.unreadCount
          existing.preview = item.preview || newMessages.at(-1)?.content || existing.preview
          existing.lastSyncedAt = syncedAt
          if (item.active) existing.lastDetailedSyncAt = syncedAt
          const normalizePreview = (value?: string) => (value || '')
            .replace(/^(?:\[?(?:已读|送达|未读)\]?)\s*/, '')
            .replace(/\s+/g, '')
          if (
            !item.active &&
            item.preview &&
            normalizePreview(item.preview) !== normalizePreview(previousPreview) &&
            existing.status !== 'ended'
          ) {
            priorityDetailTargetIds.add(existing.id)
          }
          if (newMessages.length) {
            existing.messages = [...existing.messages, ...newMessages].slice(-100)
            existing.lastMessageAt = newMessages.at(-1)?.sentAt || syncedAt
          }
          if (item.active && normalizedMessages.length) {
            const hadLegacyArtifacts = existing.messages.some(message =>
              /^(?:已读|送达|未读)\s+/.test(message.content) || message.content.includes('你与该职位竞争者PK情况'))
            const previousMessages = existing.messages
            existing.messages = normalizedMessages.map(message => {
              const known = previousMessages.find(previous => messageKey(previous) === messageKey(message))
              return known && message.timeUnknown
                ? { ...message, sentAt: known.sentAt, timeUnknown: known.timeUnknown }
                : message
            }).slice(-100)
            if (hadLegacyArtifacts && existing.pauseReason === '检测到你在 BOSS 手动回复，已暂停该会话的 AI。') {
              existing.aiPaused = false
              existing.pauseReason = undefined
              existing.status = 'new'
            }
          }
          const latestSyncedMessage = existing.messages.at(-1)
          const latestSyncedInbound = [...existing.messages].reverse().find(message => message.direction === 'inbound')
          const latestSyncedOutbound = [...existing.messages].reverse().find(message => message.direction === 'outbound')
          if (latestSyncedMessage) existing.lastMessageAt = latestSyncedMessage.sentAt
          existing.lastInboundAt = latestSyncedInbound?.sentAt
          existing.lastOutboundAt = latestSyncedOutbound?.sentAt
          applyResumeRequestState(existing, syncedAt)
          clearLegacyUnknownLocationResumePause(existing)
          if (existing.resumeRequestPending) resumeRequestIds.add(existing.id)
          const linkedSentJob = linkConversationToSentJob(next, existing)
          const latestInterviewInvitation = [...existing.messages].reverse().find(message =>
            message.direction === 'inbound'
            && (message.kind || 'text') === 'text'
            && Boolean(extractInterviewInvitation(message.content))
          )
          if (latestInterviewInvitation && !interviewInvitationAlreadyCaptured(next, latestInterviewInvitation)) {
            const receivedAt = bossMessageTime(latestInterviewInvitation.timeLabel, syncedAt)?.toISOString()
              || latestInterviewInvitation.sentAt
              || syncedAt
            if (Date.now() - new Date(receivedAt).getTime() <= 30 * 86_400_000) {
              const interviewJobId = captureInterviewInvitation(next, existing, latestInterviewInvitation, receivedAt)
              if (interviewJobId) interviewGuideJobIds.add(interviewJobId)
            }
          }
          const matchesReply = (message: BossChatMessage) =>
            normalizeOutboundContent(message.content) === normalizeOutboundContent(draftBeforeSync) ||
            normalizeOutboundContent(message.content) === normalizeOutboundContent(lastAutomatedMessageBeforeSync)
          const matchesGreeting = (message: BossChatMessage) => Boolean(
            linkedSentJob?.greetingDraft &&
            normalizeOutboundContent(message.content) === normalizeOutboundContent(linkedSentJob.greetingDraft)
          )
          const matchesHistory = (message: BossChatMessage) => automationHistoryMatchesOutbound(next, existing, message, syncedAt)
          const matchingKnownReply = newOutbound.find(matchesReply)
          const matchesKnownReply = Boolean(matchingKnownReply)
          const hasConfidentManualOutbound = newOutbound.some(message =>
            !matchesReply(message) &&
            !matchesGreeting(message) &&
            !matchesHistory(message) &&
            outboundAppearedAfterLastSync(message, previousLastSyncedAt, syncedAt)
          )
          const duplicateReplyDetected = hasDuplicateOutboundsAfterLatestInbound(existing)
          const outboundMessages = existing.messages.filter(message => message.direction === 'outbound')
          const onlyOutboundIsGreeting = Boolean(
            linkedSentJob?.greetingDraft &&
            outboundMessages.length === 1 &&
            normalizeOutboundContent(outboundMessages[0].content) === normalizeOutboundContent(linkedSentJob.greetingDraft)
          )
          const latestOutbound = outboundMessages.at(-1)
          const pausedOutboundMatchesHistory = Boolean(
            latestOutbound &&
            existing.pauseReason === MANUAL_TAKEOVER_PAUSE_REASON &&
            matchesHistory(latestOutbound)
          )
          if ((onlyOutboundIsGreeting || pausedOutboundMatchesHistory) && existing.pauseReason === MANUAL_TAKEOVER_PAUSE_REASON) {
            existing.aiPaused = false
            existing.pauseReason = undefined
            existing.status = 'replied'
          }
          if (actionableInbound.length) {
            const latest = actionableInbound.at(-1)!
            const locationConfirmation = [...actionableInbound].reverse().find(message =>
              (message.kind || 'text') === 'text' && isLocationConfirmationPrompt(message.content)
            )
            const proactiveResumeRequest = Boolean(
              !locationConfirmation &&
              (latest.kind || 'text') === 'text' &&
              isResumeSendRequest(latest.content) &&
              !existing.resumeSentAt &&
              !existing.resumeProactiveRequestedAt
            )
            existing.lastInboundAt = latest.sentAt
            if (locationConfirmation) {
              if (applyLocationConfirmationHold(existing, locationConfirmation)) {
                addActivity(next, 'system', `${existing.recruiter} 发来工作地点确认卡片，已暂停 AI，等待你手动确认。`)
              }
            } else {
              existing.intent = proactiveResumeRequest ? 'resume' : detectChatIntent(latest.content)
              if (existing.intent === 'interview') {
                const interviewJobId = captureInterviewInvitation(next, existing, latest, syncedAt)
                if (interviewJobId) interviewGuideJobIds.add(interviewJobId)
              }
              existing.draftReply = undefined
              existing.draftKind = undefined
              existing.draftEditedManually = undefined
              existing.draftCreatedAt = undefined
              existing.draftSourceMessageId = undefined
              if (proactiveResumeRequest) {
                existing.replyPendingMessageId = undefined
                existing.resumeProactiveSendPending = true
                existing.resumeProactiveSourceMessageId = latest.id
                clearLegacyUnknownLocationResumePause(existing)
              } else {
                existing.replyPendingMessageId = existing.resumeRequestPending || existing.resumeProactiveSendPending
                  ? undefined
                  : latest.id
              }
              existing.draftRequiresReview = next.config.automation.sensitiveChatIntents.includes(existing.intent)
              existing.status = existing.status === 'ended' ? 'ended' : (existing.aiPaused ? 'paused' : 'new')
              existing.followupCount = 0
              existing.nextFollowupAt = undefined
            }
            newInboundCount += actionableInbound.length
            if (proactiveResumeRequest) proactiveResumeIds.add(existing.id)
            else if (!locationConfirmation && !existing.aiPaused && existing.status !== 'ended' && !existing.resumeRequestPending && !existing.resumeProactiveSendPending) draftIds.push(existing.id)
          }
          if (newOutbound.length) {
            existing.lastOutboundAt = newOutbound.at(-1)?.sentAt || syncedAt
            existing.replyPendingMessageId = undefined
            if (existing.status !== 'ended') existing.status = 'replied'
            if (matchesKnownReply) {
              const recentlyRecorded = next.automationSendHistory.some(record =>
                record.entityId === existing.id &&
                record.kind !== 'resume' &&
                Boolean(matchingKnownReply && automationRecordMatchesOutbound(record, matchingKnownReply, syncedAt)) &&
                Date.now() - new Date(record.sentAt).getTime() < 10 * 60_000
              )
              if (!recentlyRecorded) {
                recordAutomationSend(
                  next,
                  draftKindBeforeSync === 'followup' ? 'followup' : 'chat_reply',
                  existing.id,
                  false,
                  matchingKnownReply?.content
                )
                addActivity(next, 'send', `已从 BOSS 会话确认发送给 ${existing.recruiter} 的消息。`)
              }
              existing.draftReply = undefined
              existing.draftKind = undefined
              existing.draftEditedManually = undefined
              existing.draftCreatedAt = undefined
              existing.lastRepliedInboundMessageId = draftSourceMessageIdBeforeSync || existing.lastRepliedInboundMessageId
              existing.draftSourceMessageId = undefined
              existing.replyPendingMessageId = undefined
              existing.draftRequiresReview = false
              existing.lastAutomatedMessage = undefined
            }
            if (
              existing.status !== 'ended' &&
              ((next.config.automation.manualTakeoverPause && hasConfidentManualOutbound) || duplicateReplyDetected)
            ) {
              existing.aiPaused = true
              existing.status = 'paused'
              existing.pauseReason = duplicateReplyDetected ? DUPLICATE_REPLY_PAUSE_REASON : MANUAL_TAKEOVER_PAUSE_REASON
            }
            if (existing.status !== 'ended' && !existing.aiPaused && conversationEligibleForFollowup(next, existing)) {
              existing.nextFollowupAt = nextConversationFollowupAt(next, existing.followupCount)
            } else if (!conversationEligibleForFollowup(next, existing)) {
              clearConversationFollowupPlan(next, existing)
            }
          }
          applyConversationEndDetection(existing)
          if (!conversationEligibleForFollowup(next, existing)) clearConversationFollowupPlan(next, existing)
          linkConversationToCollectedJob(next, existing)
        }
        next.bossConversations = dedupeBossConversations(next.bossConversations, next)
          .sort((a, b) => conversationSortTime(b) - conversationSortTime(a))
        addActivity(next, 'system', interviewScan
          ? `获取面试邀约：扫描 ${captured.scanned || captured.conversations.length} 个最近会话，读取 ${captured.conversations.length} 个详情，发现 ${interviewGuideJobIds.size} 个新邀约。`
          : `同步 BOSS 对话：识别 ${captured.conversations.length} 个会话，新增 ${newConversationCount} 个，收到 ${newInboundCount} 条新消息。`)
      })

      await new Promise(resolve => window.setTimeout(resolve, 0))
      const latestState = stateRef.current
      if (!interviewScan && !targetConversation && latestState) {
        const eligible = latestState.bossConversations.filter(conversation =>
          conversation.status !== 'ended' && (
            conversation.unreadCount > 0
            || priorityDetailTargetIds.has(conversation.id)
            || conversationHasJobPilotSend(latestState, conversation)
            || Boolean(conversation.draftReply)
            || Boolean(conversation.resumeRequestPending || conversation.resumeProactiveSendPending)
          )
        )
        const priority = eligible
          .filter(conversation => conversation.unreadCount > 0 || priorityDetailTargetIds.has(conversation.id))
          .sort((a, b) => Number(b.unreadCount > 0) - Number(a.unreadCount > 0))
        const priorityIds = new Set(priority.map(conversation => conversation.id))
        const rotation = eligible
          .filter(conversation => !priorityIds.has(conversation.id))
          .sort((a, b) => {
            const detailedDelta = new Date(a.lastDetailedSyncAt || 0).getTime() - new Date(b.lastDetailedSyncAt || 0).getTime()
            if (detailedDelta) return detailedDelta
            return conversationSortTime(b) - conversationSortTime(a)
          })
        detailTargets = [...priority, ...rotation].slice(0, 5)
      }
      if (!interviewScan && latestState?.config.automation.enabled && latestState.config.automation.resumeSendMode === 'auto') {
        for (const id of [...resumeRequestIds].slice(0, 2)) {
          // The native BOSS card/receipt is the complete response for a resume
          // request. Never enqueue a second conversational status message.
          await sendConversationResume(id, true)
        }
        for (const id of [...proactiveResumeIds].slice(0, 2)) {
          await sendConversationResume(id, true)
        }
      }
      if (!interviewScan && latestState?.config.model.apiKeyConfigured) {
        for (const id of [...new Set(draftIds)].slice(0, 5)) {
          const conversation = stateRef.current?.bossConversations.find(item => item.id === id)
          if (conversation && !conversation.aiPaused && conversation.status !== 'ended') await draftConversationReply(conversation, true)
        }
      }
      const guideState = stateRef.current
      if (
        guideState?.config.automation.enabled &&
        guideState.config.automation.interviewAutoGuideEnabled &&
        guideState.config.model.apiKeyConfigured
      ) {
        for (const id of [...interviewGuideJobIds].slice(0, 3)) {
          const job = stateRef.current?.jobs.find(item => item.id === id)
          const sourceMessageId = job?.interviewInvitation?.sourceMessageId
          if (job && sourceMessageId && job.interviewGuideSourceMessageId !== sourceMessageId) {
            await generateInterviewGuide(job, true)
          }
        }
      }
      if (!quiet) showToast('success', interviewScan
        ? `面试邀约获取完成：扫描 ${captured.scanned || captured.conversations.length} 个会话，发现 ${interviewGuideJobIds.size} 个新邀约${captured.errors ? `，${captured.errors} 个会话读取失败` : ''}`
        : `已同步 ${captured.conversations.length} 个 BOSS 会话`)
    } catch (error) {
      if (!quiet) showToast('error', `${interviewScan ? '获取面试邀约失败' : '对话同步失败'}：${String(error)}`)
    } finally {
      chatSyncInFlightRef.current = false
      if (!quiet) setBusy('')
    }
    const pendingOverview = chatSyncPendingOverviewRef.current
    chatSyncPendingOverviewRef.current = null
    if (pendingOverview) {
      await syncBossChats(false, undefined, 'normal', pendingOverview.forceRefresh)
      return
    }
    const pendingTarget = chatSyncPendingTargetRef.current
    chatSyncPendingTargetRef.current = null
    if (pendingTarget) await syncBossChats(true, pendingTarget)
    for (const conversation of detailTargets) await syncBossChats(true, conversation)
    if (chatSyncPendingInterviewScanRef.current) {
      chatSyncPendingInterviewScanRef.current = false
      await syncBossChats(false, undefined, 'interview')
    }
  }

  async function fetchInterviewInvitations() {
    await syncBossChats(false, undefined, 'interview')
  }

  async function syncGreetingConversation(job: JobRecord) {
    await syncBossChats(true)
    const latest = stateRef.current
    if (!latest) return
    const normalize = (value?: string) => (value || '').replace(/\s+/g, '').toLowerCase()
    const recruiter = normalize(job.recruiter)
    const company = normalize(job.company)
    const title = normalize(job.title)
    const conversation = latest.bossConversations.find(item => recruiter && normalize(item.recruiter) === recruiter)
      || latest.bossConversations.find(item => {
        const itemCompany = normalize(item.company)
        const itemTitle = normalize(item.jobTitle)
        const companyMatches = company && (itemCompany.includes(company) || company.includes(itemCompany))
        const titleMatches = title && (itemTitle.includes(title) || title.includes(itemTitle))
        return Boolean(companyMatches && titleMatches)
      })
      || latest.bossConversations.find(item => company && normalize(item.company).includes(company))
    if (!conversation) return
    updateState(next => {
      const targetConversation = next.bossConversations.find(item => item.id === conversation.id)
      const targetJob = next.jobs.find(item => item.id === job.id)
      if (!targetConversation || !targetJob) return
      targetConversation.jobId = targetJob.id
      targetConversation.company ||= targetJob.company
      targetConversation.jobTitle ||= targetJob.title
      if (conversationEligibleForFollowup(next, targetConversation)) {
        targetConversation.nextFollowupAt ||= targetJob.nextFollowupAt || nextConversationFollowupAt(next, 0)
      } else {
        clearConversationFollowupPlan(next, targetConversation)
      }
      targetJob.chatHref = targetConversation.href
    })
    await new Promise(resolve => window.setTimeout(resolve, 0))
    const linkedConversation = stateRef.current?.bossConversations.find(item => item.id === conversation.id)
    if (linkedConversation) await syncBossChats(true, linkedConversation)
  }

  async function draftConversationReply(conversation: BossConversation, quiet = false) {
    const current = stateRef.current
    if (!current) return
    if (conversation.status === 'ended') {
      if (!quiet) showToast('info', '该会话已标记结束，不会生成跟进草稿；如需继续，请先恢复会话。')
      return
    }
    if (conversation.aiPaused) {
      if (!quiet) showToast('error', conversation.pauseReason || '该会话已暂停 AI')
      return
    }
    if (conversation.resumeRequestPending || conversation.resumeProactiveSendPending) {
      if (!quiet) showToast('info', '招聘者正在索要附件简历，请先处理简历请求')
      return
    }
    const latestInbound = [...conversation.messages].reverse().find(message =>
      message.direction === 'inbound' && !['resume_sent', 'resume_viewed', 'system'].includes(message.kind || 'text'))
    if (!latestInbound) {
      if (!quiet) showToast('info', '请先在 BOSS 打开该联系人并同步完整消息')
      return
    }
    if (isLocationConfirmationPrompt(latestInbound.content)) {
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversation.id)
        if (!target) return
        if (applyLocationConfirmationHold(target, latestInbound)) {
          addActivity(next, 'system', `${target.recruiter} 发来工作地点确认卡片，已暂停 AI，等待你手动确认。`)
        }
      })
      if (!quiet) showToast('info', '这是 BOSS 工作地点确认卡片，请在 BOSS 中手动确认')
      return
    }
    if (!current.config.model.apiKeyConfigured) {
      if (!quiet) showToast('error', '生成回复草稿需要先配置模型')
      return
    }
    if (!quiet) setBusy(`chat-draft-${conversation.id}`)
    try {
      const intent = detectChatIntent(latestInbound.content)
      const resumeDeliveryStatus = conversation.resumeSentAt
        ? 'sent'
        : conversation.resumeProactiveRequestedAt ? 'request_pending' : 'not_sent'
      const history = conversation.messages
        .filter(message => !['resume_sent', 'resume_viewed', 'system'].includes(message.kind || 'text'))
        .slice(-12).map(message => ({
        role: message.direction === 'inbound' ? 'user' : 'assistant',
        content: message.content
      }))
      const draft = await window.jobpilot.callModel({
        task: 'draft_reply',
        payload: {
          recruiter: conversation.recruiter,
          company: conversation.company,
          jobTitle: conversation.jobTitle,
          latestMessage: latestInbound.content,
          intent,
          resumeDeliveryStatus,
          history
        }
      })
      const visibleDraft = sanitizeResumeActionDraft(visibleChatContent(draft), resumeDeliveryStatus)
      if (!conversation.resumeSentAt && hasUnconfirmedResumeClaim(visibleDraft)) {
        throw new Error('工具状态冲突：模型草稿声称附件简历已经发送，但 BOSS 尚无发送成功回执。')
      }
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversation.id)
        if (!target) return
        target.intent = intent
        target.draftReply = visibleDraft
        target.draftKind = 'reply'
        target.draftEditedManually = false
        target.draftCreatedAt = new Date().toISOString()
        target.draftSourceMessageId = latestInbound.id
        target.draftRequiresReview = next.config.automation.chatReplyMode !== 'auto_safe' || next.config.automation.sensitiveChatIntents.includes(intent)
        target.status = 'draft_ready'
      })
      await new Promise(resolve => window.setTimeout(resolve, 0))
      const latest = stateRef.current
      const ready = latest?.bossConversations.find(item => item.id === conversation.id)
      if (ready?.draftRequiresReview) {
        notifyUser('JobPilot 有消息待确认', `${ready.recruiter} · ${ready.company || ready.jobTitle || 'BOSS 对话'} 有一条 AI 回复草稿需要你确认。`, 'manual')
      }
      if (ready && latest?.config.automation.enabled && latest.config.automation.chatReplyMode === 'auto_safe' && !ready.draftRequiresReview) {
        await sendConversationReply(ready.id, 'chat_reply', true)
      }
      if (!quiet) showToast('success', 'AI 回复草稿已生成')
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '')
      if (message.startsWith('工具状态冲突：')) {
        updateState(next => {
          const target = next.bossConversations.find(item => item.id === conversation.id)
          if (!target) return
          target.aiPaused = true
          target.status = 'paused'
          target.pauseReason = message
          addActivity(next, 'system', `${target.recruiter} 的 AI 草稿因工具状态冲突被阻止发送。`)
        })
      }
      if (!quiet) showToast('error', message)
    } finally {
      if (!quiet) setBusy('')
    }
  }

  async function sendConversationReply(conversationId: string, kind: 'chat_reply' | 'followup' = 'chat_reply', automated = false) {
    const current = stateRef.current
    const conversation = current?.bossConversations.find(item => item.id === conversationId)
    if (!current || !conversation) return false
    if (kind === 'followup' && !conversationEligibleForFollowup(current, conversation)) {
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversationId)
        if (!target) return
        applyConversationEndDetection(target)
        clearConversationFollowupPlan(next, target)
      })
      if (!automated) showToast('info', '该会话不是由 JobPilot 发起或已结束，不会发送跟进。')
      return false
    }
    if (conversation.status === 'ended') {
      if (!automated) showToast('info', '该会话已结束，不会发送消息。')
      return false
    }
    if (!conversation.draftReply?.trim()) {
      if (!automated) showToast('info', '请先生成或输入回复内容。')
      return false
    }
    if (!automated && automationSendCount(current) >= current.config.automation.dailyLimit) {
      showToast('error', `已达到每日发送上限 ${current.config.automation.dailyLimit}`)
      return false
    }
    if (automated) {
      if (conversation.resumeRequestPending || conversation.resumeProactiveSendPending) return false
      const modeAllowed = kind === 'chat_reply'
        ? current.config.automation.chatReplyMode === 'auto_safe' && !conversation.draftEditedManually && !current.config.automation.sensitiveChatIntents.includes(conversation.intent)
        : current.config.automation.followupEnabled && current.config.automation.followupSendMode === 'auto_above_score' && !conversation.draftEditedManually && !current.config.automation.sensitiveChatIntents.includes(conversation.intent)
      if (!modeAllowed) return false
      if (conversation.aiPaused) return false
      const blocked = automationBlockReason(current, true)
      if (blocked) return false
      if (kind === 'chat_reply') {
        if (hasDuplicateOutboundsAfterLatestInbound(conversation)) {
          pauseConversationForAutomationBlock(conversationId, DUPLICATE_REPLY_PAUSE_REASON)
          return false
        }
        if (conversation.lastRepliedInboundMessageId && !latestUnansweredInbound(conversation)) return false
      }
      const locationBlocked = conversationAutoReplyBlockReason(current, conversation)
      if (locationBlocked) {
        pauseConversationForAutomationBlock(conversationId, locationBlocked)
        return false
      }
    }
    if (current.config.browser.mode !== 'embedded') {
      await window.jobpilot.openSystemChrome(conversation.href || 'https://www.zhipin.com/web/geek/chat')
      if (!automated) showToast('info', '系统 Chrome 已打开，请在 BOSS 页面核对并发送草稿。')
      return false
    }
    if (conversationSendInFlightRef.current.has(conversationId)) return false
    conversationSendInFlightRef.current.add(conversationId)

    const message = conversation.draftReply.trim()
    const normalizeMessage = (value: string) => value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim()
    const knownOutboundCount = conversation.messages.filter(item =>
      item.direction === 'outbound' && normalizeMessage(item.content) === normalizeMessage(message)
    ).length
    if (!automated) setBusy(`chat-send-${conversation.id}`)
    try {
      const result = await window.jobpilot.sendBossConversation(conversation.externalId, conversation.recruiter, conversation.company, message) as {
        ok: boolean
        captcha?: boolean
        uncertain?: boolean
        error?: string
      }
      if (result.captcha) {
        updateState(next => {
          next.automationPaused = true
          next.pauseReason = result.error || '检测到 BOSS 安全验证，请人工完成后恢复任务。'
          addActivity(next, 'captcha', '发送前检测到 BOSS 安全验证，自动化已暂停。')
        })
        showToast('error', result.error || '检测到安全验证，自动化已暂停')
        return false
      }
      if (!result.ok && result.uncertain) {
        await syncBossChats(true, conversation)
        const synced = stateRef.current?.bossConversations.find(item => item.id === conversationId)
        const syncedOutboundCount = synced?.messages.filter(item =>
          item.direction === 'outbound' && normalizeMessage(item.content) === normalizeMessage(message)
        ).length || 0
        if (syncedOutboundCount <= knownOutboundCount) {
          updateState(next => addActivity(next, 'system', `${conversation.recruiter} 的发送结果暂未确认，已阻止重复发送。`))
          if (!automated) showToast('info', result.error || '发送结果暂未确认，请先在 BOSS 页面核对')
          return false
        }
      } else if (!result.ok) throw new Error(result.error || '发送失败，草稿仍保留在本地')
      const sentAt = new Date().toISOString()
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversationId)
        if (!target) return
        target.lastOutboundAt = sentAt
        target.lastMessageAt = sentAt
        target.preview = message
        target.lastRepliedInboundMessageId = target.draftSourceMessageId || latestUnansweredInbound(target)?.id
        target.replyPendingMessageId = undefined
        target.draftReply = undefined
        target.draftKind = undefined
        target.draftEditedManually = undefined
        target.draftCreatedAt = undefined
        target.draftSourceMessageId = undefined
        target.draftRequiresReview = false
        // Both automatic sends and user-confirmed sends in JobPilot are trusted local outbound messages.
        target.lastAutomatedMessage = message
        target.status = target.aiPaused ? 'paused' : 'replied'
        if (kind === 'followup') {
          target.followupCount += 1
          const days = next.config.automation.followupDays.filter(day => day > 0)
          if (target.followupCount >= next.config.automation.maxFollowups || !days[target.followupCount]) {
            target.nextFollowupAt = undefined
          } else {
            const previousDay = days[target.followupCount - 1] || 0
            target.nextFollowupAt = daysFromNow(Math.max(1, days[target.followupCount] - previousDay))
          }
        } else {
          target.followupCount = 0
          target.nextFollowupAt = nextConversationFollowupAt(next, 0)
        }
        const linkedJob = target.jobId ? next.jobs.find(job => job.id === target.jobId) : undefined
        if (linkedJob) {
          linkedJob.followupCount = target.followupCount
          linkedJob.followupDraft = undefined
          linkedJob.lastContactAt = sentAt
          linkedJob.nextFollowupAt = target.nextFollowupAt
          if (linkedJob.status !== 'interview') linkedJob.status = kind === 'followup' ? 'sent' : 'replied'
        }
        recordAutomationSend(next, kind, conversationId, automated, message)
        addActivity(next, automated ? 'send' : 'send', `${automated ? '自动' : '确认'}发送给 ${target.recruiter}：${kind === 'followup' ? '跟进消息' : '对话回复'}。`)
      })
      if (!automated) showToast('success', '消息已发送')
      return true
    } catch (error) {
      if (automated) {
        updateState(next => {
          const target = next.bossConversations.find(item => item.id === conversationId)
          if (!target) return
          target.aiPaused = true
          target.status = 'paused'
          target.pauseReason = `自动发送未确认成功：${String(error)}`
          addActivity(next, 'system', `${target.recruiter} 的自动发送未确认成功，已暂停该会话。`)
        })
      } else showToast('error', String(error))
      return false
    } finally {
      conversationSendInFlightRef.current.delete(conversationId)
      if (!automated) setBusy('')
    }
  }

  async function sendConversationResume(conversationId: string, automated = false) {
    const current = stateRef.current
    const conversation = current?.bossConversations.find(item => item.id === conversationId)
    const proactive = Boolean(conversation?.resumeProactiveSendPending && !conversation.resumeRequestPending)
    if (!current || !conversation || conversation.status === 'ended' || (!conversation.resumeRequestPending && !proactive)) return false
    if (automated) {
      if (!current.config.automation.enabled || current.config.automation.resumeSendMode !== 'auto' || conversation.aiPaused) return false
      const blocked = automationBlockReason(current, true)
      if (blocked) return false
      const locationBlocked = conversationResumeBlockReason(current, conversation)
      if (locationBlocked) {
        pauseConversationForAutomationBlock(conversationId, locationBlocked)
        return false
      }
    } else if (current.config.automation.resumeSendMode === 'off') {
      showToast('info', '附件简历发送策略当前为“不发送”')
      return false
    }
    if (resumeSendInFlightRef.current.has(conversationId)) return false
    resumeSendInFlightRef.current.add(conversationId)
    if (!automated) setBusy(`resume-send-${conversationId}`)
    try {
      const result = await window.jobpilot.sendBossResume(
        conversation.externalId,
        conversation.recruiter,
        conversation.company,
        Boolean(conversation.resumeSentAt),
        proactive
      ) as { ok: boolean; captcha?: boolean; uncertain?: boolean; alreadySent?: boolean; requested?: boolean; alreadyRequested?: boolean; error?: string }
      if (result.captcha) {
        updateState(next => {
          next.automationPaused = true
          next.pauseReason = result.error || '检测到 BOSS 安全验证，请人工完成后恢复任务。'
          addActivity(next, 'captcha', '发送附件简历时检测到 BOSS 安全验证，自动化已暂停。')
        })
        showToast('error', result.error || '检测到安全验证，自动化已暂停')
        return false
      }
      if (!result.ok) throw new Error(result.error || '附件简历发送失败')
      const sentAt = new Date().toISOString()
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversationId)
        if (!target) return
        if (result.requested && !result.alreadySent) {
          target.resumeProactiveSendPending = false
          target.resumeProactiveRequestedAt ||= sentAt
          target.lastRepliedInboundMessageId = target.resumeProactiveSourceMessageId || target.lastRepliedInboundMessageId
          target.replyPendingMessageId = undefined
        } else {
          target.resumeRequestPending = false
          target.resumeProactiveSendPending = false
          target.resumeSentAt ||= sentAt
        }
        target.resumeSendError = undefined
        target.intent = 'resume'
        const pausedForResumeFailure = target.aiPaused && /^附件简历自动发送未确认：/.test(target.pauseReason || '')
        if (pausedForResumeFailure) {
          target.aiPaused = false
          target.pauseReason = undefined
        }
        if (target.status !== 'ended' && !target.aiPaused) target.status = 'replied'
        const recentlyRecorded = next.automationSendHistory.some(record =>
          record.entityId === conversationId && record.kind === 'resume' && Date.now() - new Date(record.sentAt).getTime() < 24 * 60 * 60_000
        )
        if (!result.alreadySent && !result.alreadyRequested && !recentlyRecorded) {
          recordAutomationSend(next, 'resume', conversationId, automated)
          addActivity(next, 'send', result.requested
            ? `${automated ? '自动' : '确认'}向 ${target.recruiter} 发起附件简历发送请求。`
            : `${automated ? '自动' : '确认'}向 ${target.recruiter} 发送附件简历。`)
        } else if (result.alreadySent) {
          addActivity(next, 'system', `BOSS 已确认 ${target.recruiter} 的附件简历此前发送成功。`)
        } else if (result.alreadyRequested) {
          addActivity(next, 'system', `BOSS 已确认 ${target.recruiter} 的附件简历发送请求此前已发出。`)
        }
      })
      if (!automated) showToast('success', result.alreadySent
        ? '附件简历此前已发送'
        : result.requested ? '附件简历发送请求已发出，等待对方同意' : '附件简历已发送')
      return true
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, '')
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversationId)
        if (!target) return
        target.resumeSendError = message
        if (automated) {
          target.aiPaused = true
          target.status = 'paused'
          target.pauseReason = `附件简历自动发送未确认：${message}`
          addActivity(next, 'system', `${target.recruiter} 的附件简历发送未确认，已暂停该会话。`)
        }
      })
      if (!automated) showToast('error', message)
      return false
    } finally {
      resumeSendInFlightRef.current.delete(conversationId)
      if (!automated) setBusy('')
    }
  }

  async function draftConversationFollowup(conversation: BossConversation, quiet = false) {
    const current = stateRef.current
    if (!current || conversation.status === 'ended' || conversation.aiPaused) return false
    if (!conversationEligibleForFollowup(current, conversation)) {
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversation.id)
        if (target) clearConversationFollowupPlan(next, target)
      })
      if (!quiet) showToast('info', '只有通过 JobPilot 打招呼或回复过的会话才会跟进。')
      return false
    }
    if (!current.config.model.apiKeyConfigured) {
      if (!quiet) showToast('error', '生成跟进需要先配置模型')
      return false
    }
    if (!quiet) setBusy(`chat-followup-${conversation.id}`)
    try {
      const history = conversation.messages.slice(-12).map(message => ({
        role: message.direction === 'inbound' ? 'user' : 'assistant',
        content: message.content
      }))
      const interviewMentioned = conversation.messages.some(message => /面试|邀约/.test(message.content))
      const draft = await window.jobpilot.callModel({
        task: 'draft_followup',
        payload: {
          recruiter: conversation.recruiter,
          company: conversation.company,
          jobTitle: conversation.jobTitle,
          history,
          priorGreeting: conversation.messages.find(message => message.direction === 'outbound')?.content || ''
        }
      })
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversation.id)
        if (!target || !conversationEligibleForFollowup(next, target)) {
          if (target) clearConversationFollowupPlan(next, target)
          return
        }
        target.draftReply = sanitizeFollowupDraft(draft, conversationFollowupFallback(target), interviewMentioned)
        target.draftKind = 'followup'
        target.draftEditedManually = false
        target.draftCreatedAt = new Date().toISOString()
        target.draftRequiresReview = next.config.automation.followupSendMode !== 'auto_above_score' || next.config.automation.sensitiveChatIntents.includes(target.intent)
        target.status = 'draft_ready'
        const linkedJob = target.jobId ? next.jobs.find(job => job.id === target.jobId) : undefined
        if (linkedJob) {
          linkedJob.followupDraft = target.draftReply
          if (linkedJob.status !== 'interview') linkedJob.status = 'followup_due'
        }
        addActivity(next, 'followup', `${target.recruiter} 已生成第 ${target.followupCount + 1} 次对话跟进草稿。`)
      })
      await new Promise(resolve => window.setTimeout(resolve, 0))
      const reviewReady = stateRef.current?.bossConversations.find(item => item.id === conversation.id)
      if (reviewReady?.draftRequiresReview) {
        notifyUser('JobPilot 有跟进待确认', `${reviewReady.recruiter} · ${reviewReady.company || reviewReady.jobTitle || 'BOSS 对话'} 的跟进草稿需要你确认。`, 'manual')
      }
      const latest = stateRef.current
      const ready = latest?.bossConversations.find(item => item.id === conversation.id)
      if (ready && latest?.config.automation.enabled && latest.config.automation.followupSendMode === 'auto_above_score' && !ready.draftRequiresReview) {
        await sendConversationReply(ready.id, 'followup', true)
      }
      if (!quiet) showToast('success', '跟进草稿已生成')
      return true
    } catch (error) {
      if (!quiet) showToast('error', String(error))
      return false
    } finally {
      if (!quiet) setBusy('')
    }
  }

  async function processAutomationQueue() {
    if (automationQueueInFlightRef.current || jobCollectionInFlightRef.current) return
    const current = stateRef.current
    if (!current || !current.config.automation.enabled || current.automationPaused || !isWithinAutomationWindow(current)) return
    automationQueueInFlightRef.current = true
    try {
      const pendingResume = current.bossConversations.find(conversation =>
        conversation.resumeRequestPending &&
        conversation.status !== 'ended' &&
        !conversation.aiPaused &&
        current.config.automation.resumeSendMode === 'auto'
      )
      if (pendingResume) {
        await sendConversationResume(pendingResume.id, true)
        return
      }
      const pendingProactiveResume = current.bossConversations.find(conversation =>
        conversation.resumeProactiveSendPending &&
        conversation.status !== 'ended' &&
        !conversation.aiPaused &&
        current.config.automation.resumeSendMode === 'auto'
      )
      if (pendingProactiveResume) {
        await sendConversationResume(pendingProactiveResume.id, true)
        return
      }
      const readyReply = current.bossConversations.find(conversation =>
        conversation.status === 'draft_ready' &&
        conversation.draftKind !== 'followup' &&
        Boolean(conversation.draftReply) &&
        !conversation.aiPaused &&
        !conversation.draftEditedManually &&
        !current.config.automation.sensitiveChatIntents.includes(conversation.intent) &&
        current.config.automation.chatReplyMode === 'auto_safe'
      )
      if (readyReply) {
        await sendConversationReply(readyReply.id, 'chat_reply', true)
        return
      }
      const unansweredConversation = current.bossConversations.find(conversation =>
        conversation.status !== 'ended' &&
        !conversation.aiPaused &&
        !conversation.resumeRequestPending &&
        !conversation.resumeProactiveSendPending &&
        !conversation.draftReply &&
        !conversation.lastAutomatedMessage &&
        Boolean(conversation.replyPendingMessageId) &&
        latestUnansweredInbound(conversation)?.id === conversation.replyPendingMessageId &&
        !isLocationConfirmationPrompt(latestUnansweredInbound(conversation)?.content || '')
      )
      if (unansweredConversation) {
        await draftConversationReply(unansweredConversation, true)
        return
      }
      const due = current.bossConversations.find(conversation =>
        conversation.status !== 'ended' &&
        !conversation.aiPaused &&
        conversationEligibleForFollowup(current, conversation) &&
        conversation.nextFollowupAt &&
        new Date(conversation.nextFollowupAt).getTime() <= Date.now() &&
        conversation.followupCount < current.config.automation.maxFollowups &&
        current.config.automation.followupEnabled &&
        !(conversation.draftKind === 'followup' && conversation.draftReply && (
          conversation.draftRequiresReview || current.config.automation.followupSendMode !== 'auto_above_score'
        ))
      )
      if (due) {
        if (due.draftKind === 'followup' && due.draftReply) {
          await sendConversationReply(due.id, 'followup', true)
          return
        } else {
          if (await draftConversationFollowup(due, true)) return
        }
      }
      const dueJob = current.jobs.find(job =>
        job.status === 'followup_due' &&
        !job.followupDraft &&
        job.followupCount < current.config.automation.maxFollowups &&
        current.config.automation.followupEnabled &&
        jobEligibleForFollowup(current, job)
      )
      if (dueJob) {
        await draftFollowup(dueJob, true)
        return
      }
      const pendingGreetingReviews = current.jobs.filter(job =>
        job.status === 'pending_review' && Boolean(job.greetingDraft)
      ).length
      if (
        current.config.automation.sendMode !== 'auto_above_score' &&
        pendingGreetingReviews >= MAX_PENDING_GREETING_REVIEWS
      ) return
      if (current.config.automation.sendMode === 'auto_above_score') {
        const readyGreeting = current.jobs.find(job =>
          job.status === 'pending_review' &&
          Boolean(job.greetingDraft) &&
          (job.score || 0) >= current.config.automation.autoScoreThreshold &&
          jobLocationAllowsAutoSend(job, current) &&
          !greetingAlreadySent(current, job)
        )
        if (readyGreeting) {
          await sendGreeting(readyGreeting, true)
          return
        }
      }
      await runAutomationRound(true, 1)
    } finally {
      automationQueueInFlightRef.current = false
    }
  }

  function editConversationDraft(conversationId: string, value: string) {
    updateState(next => {
      const conversation = next.bossConversations.find(item => item.id === conversationId)
      if (!conversation) return
      conversation.draftReply = value
      conversation.draftKind ||= 'reply'
      conversation.draftEditedManually = true
      conversation.draftCreatedAt = new Date().toISOString()
      conversation.draftSourceMessageId ||= latestUnansweredInbound(conversation)?.id
      conversation.status = 'draft_ready'
      conversation.draftRequiresReview = true
    })
  }

  function toggleConversationAi(conversationId: string) {
    updateState(next => {
      const conversation = next.bossConversations.find(item => item.id === conversationId)
      if (!conversation) return
      conversation.aiPaused = !conversation.aiPaused
      conversation.status = conversation.aiPaused ? 'paused' : (conversation.draftReply ? 'draft_ready' : 'new')
      conversation.pauseReason = conversation.aiPaused ? '你已手动暂停该会话的 AI。' : undefined
    })
  }

  function toggleConversationEnded(conversationId: string) {
    updateState(next => {
      const conversation = next.bossConversations.find(item => item.id === conversationId)
      if (!conversation) return
      if (conversation.status === 'ended') {
        conversation.endDetectionDismissedForMessageId = conversation.endMessageId
        conversation.endedAt = undefined
        conversation.endReason = undefined
        conversation.endSource = undefined
        conversation.endMessageId = undefined
        conversation.aiPaused = false
        conversation.pauseReason = undefined
        conversation.status = conversation.draftReply ? 'draft_ready' : 'new'
        addActivity(next, 'system', `${conversation.recruiter} 的会话已恢复，可继续生成草稿和跟进。`)
      } else {
        conversation.status = 'ended'
        conversation.endedAt = new Date().toISOString()
        conversation.endReason = '你已手动标记该会话结束，后续不会再跟进。'
        conversation.endSource = 'candidate'
        conversation.aiPaused = true
        conversation.pauseReason = conversation.endReason
        conversation.draftReply = undefined
        conversation.draftKind = undefined
        conversation.draftEditedManually = undefined
        conversation.draftCreatedAt = undefined
        conversation.draftSourceMessageId = undefined
        conversation.replyPendingMessageId = undefined
        clearConversationFollowupPlan(next, conversation)
        addActivity(next, 'system', `${conversation.recruiter} 的会话已标记结束，不再跟进。`)
      }
    })
  }

  async function openBossConversation(conversation: BossConversation, fillDraft = false) {
    if (stateRef.current?.config.browser.mode !== 'embedded') {
      await window.jobpilot.openSystemChrome(conversation.href || 'https://www.zhipin.com/web/geek/chat')
      return
    }
    setPage('radar')
    setBrowserFocus(false)
    setBusy(`chat-open-${conversation.id}`)
    try {
      for (let attempt = 0; attempt < 15 && !browserRef.current; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 100))
      }
      if (!browserRef.current) throw new Error('内置浏览器未就绪')
      await waitForBrowserLoad('https://www.zhipin.com/web/geek/chat')
      setBrowserUrl('https://www.zhipin.com/web/geek/chat')
      await new Promise(resolve => window.setTimeout(resolve, 900))
      const opened = await browserRef.current.executeJavaScript(openBossConversationScript(conversation.externalId, conversation.recruiter, conversation.company)) as { ok: boolean; reason?: string }
      if (!opened.ok) throw new Error(opened.reason || '打开会话失败')
      await new Promise(resolve => window.setTimeout(resolve, 1_200))
      await syncBossChats(true, conversation)
      if (fillDraft) {
        if (!conversation.draftReply) throw new Error('该会话还没有回复草稿')
        const filled = await browserRef.current.executeJavaScript(fillBossReplyScript(conversation.draftReply)) as { ok: boolean; reason?: string }
        if (!filled.ok) throw new Error(filled.reason || '填入草稿失败')
        showToast('success', '草稿已填入 BOSS 输入框，请检查后手动发送')
      } else {
        showToast('success', '已打开对应 BOSS 会话')
      }
    } catch (error) {
      showToast('error', String(error))
    } finally {
      setBusy('')
    }
  }

  async function scoreJob(job: JobRecord) {
    const current = stateRef.current
    if (!current) return
    setBusy(`score-${job.id}`)
    try {
      if (!current.config.model.apiKeyConfigured) {
        updateState(next => {
          const target = next.jobs.find(item => item.id === job.id)
          if (!target) return
          target.score = localScore(target, next)
          target.matchReason = '使用本地规则完成初筛；配置模型后可获得更细致的岗位职责与能力差距分析。'
          target.status = 'scored'
          addActivity(next, 'score', `${target.company} · ${target.title} 已完成本地评分。`)
        })
      } else {
        const raw = await window.jobpilot.callModel({ task: 'score_job', payload: { job } })
        const result = parseModelJson(raw)
        updateState(next => {
          const target = next.jobs.find(item => item.id === job.id)
          if (!target) return
          target.score = Math.round(result.score)
          target.matchReason = result.matchReason
          target.gaps = result.gaps || []
          target.status = 'scored'
          addActivity(next, 'score', `${target.company} · ${target.title} 匹配分 ${target.score}。`)
        })
      }
      showToast('success', '岗位评分完成')
    } catch (error) {
      showToast('error', String(error))
    } finally {
      setBusy('')
    }
  }

  function fallbackGreeting(job: JobRecord, current: AppState) {
    const aiRelated = /ai|人工智能|大模型|智能|agent/i.test(`${job.title} ${job.description}`)
    const focus = aiRelated
      ? '我有 AI 销售、AI 心理服务及 Agent 产品从 0 到 1 落地经验'
      : '我有 12 年 C/B/G 端产品与 SaaS、增长商业化经验'
    return `您好，关注到贵公司的${job.title}岗位。${focus}，并能独立完成产品规划、原型、PRD 与研发推进。岗位要求与我的经历较契合，希望有机会进一步沟通。`
  }

  async function draftGreeting(job: JobRecord) {
    const current = stateRef.current
    if (!current) return
    if (!hasDetailedJobDescription(job)) {
      showToast('info', '请先点击“查看岗位”读取完整职位描述，再生成招呼语')
      return
    }
    setBusy(`draft-${job.id}`)
    try {
      const draft = sanitizeGreetingDraft(current.config.model.apiKeyConfigured
        ? await window.jobpilot.callModel({ task: 'draft_greeting', payload: { job } })
        : fallbackGreeting(job, current))
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (!target) return
        target.greetingDraft = draft
        target.greetingVersion = CURRENT_GREETING_VERSION
        target.status = 'pending_review'
        addActivity(next, 'draft', `${target.company} · ${target.title} 已生成招呼语草稿。`)
      })
      showToast('success', '招呼语已生成')
    } catch (error) {
      showToast('error', String(error))
    } finally {
      setBusy('')
    }
  }

  async function draftConversationGreeting(conversation: BossConversation) {
    const current = stateRef.current
    if (!current) return
    if (conversation.status === 'ended') {
      showToast('info', '该会话已结束，不会生成招呼语。')
      return
    }
    if (conversation.aiPaused) {
      showToast('error', conversation.pauseReason || '该会话已暂停 AI')
      return
    }
    const job = conversation.jobId ? current.jobs.find(item => item.id === conversation.jobId) : undefined
    if (!job) {
      showToast('info', '该会话尚未关联岗位，请先在岗位雷达采集并查看对应岗位。')
      return
    }
    if (!hasDetailedJobDescription(job)) {
      showToast('info', '请先在岗位雷达点击“查看岗位”，读取完整职位描述后再生成招呼语。')
      return
    }
    setBusy(`chat-draft-${conversation.id}`)
    try {
      const draft = sanitizeGreetingDraft(current.config.model.apiKeyConfigured
        ? await window.jobpilot.callModel({ task: 'draft_greeting', payload: { job } })
        : fallbackGreeting(job, current))
      updateState(next => {
        const target = next.bossConversations.find(item => item.id === conversation.id)
        if (!target) return
        target.draftReply = draft
        target.draftKind = 'reply'
        target.draftEditedManually = false
        target.draftCreatedAt = new Date().toISOString()
        target.draftSourceMessageId = undefined
        target.draftRequiresReview = next.config.automation.chatReplyMode !== 'auto_safe'
          || next.config.automation.sensitiveChatIntents.includes(target.intent)
        target.status = 'draft_ready'
        addActivity(next, 'draft', `${target.recruiter} 的空会话已根据 ${job.company} · ${job.title} 生成招呼语草稿。`)
      })
      showToast('success', '已根据对应岗位生成招呼语草稿')
    } catch (error) {
      showToast('error', String(error))
    } finally {
      setBusy('')
    }
  }

  async function waitForBrowserLoad(url: string) {
    const webview = browserRef.current
    if (!webview) throw new Error('内置浏览器未就绪')
    if (!url) throw new Error('岗位缺少详情链接，请先在浏览器打开岗位详情')
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('岗位页面加载超时')), 20_000)
      const done = () => {
        window.clearTimeout(timeout)
        webview.removeEventListener('did-finish-load', done)
        resolve()
      }
      webview.addEventListener('did-finish-load', done)
      webview.loadURL(url)
    })
  }

  async function waitForJobDetail(timeoutMs = 8_000): Promise<CapturedJobDetail> {
    const deadline = Date.now() + timeoutMs
    let best: CapturedJobDetail = { address: '', description: '', detailVersion: 2 }
    while (Date.now() < deadline) {
      try {
        const captured = await browserRef.current?.executeJavaScript(collectJobDetailScript) as Partial<CapturedJobDetail> | undefined
        const detail = {
          address: captured?.address?.trim() || '',
          description: captured?.description?.trim() || '',
          detailVersion: 2
        }
        if (detail.address.length > best.address.length) best.address = detail.address
        if (detail.description.length > best.description.length) best.description = detail.description
        if (best.address && hasDetailedJobDescription(best)) return best
      } catch {
        // BOSS renders parts of the detail page asynchronously; retry while navigation settles.
      }
      await new Promise(resolve => window.setTimeout(resolve, 400))
    }
    return best
  }

  function saveJobDetail(jobId: string, detail: CapturedJobDetail) {
    updateState(next => {
      const target = next.jobs.find(item => item.id === jobId)
      if (!target) return
      if (detail.address) target.workAddress = detail.address
      if (hasDetailedJobDescription(detail) && detail.description !== target.description) {
        target.description = detail.description
        if (target.status === 'pending_review' && target.greetingDraft) {
          target.greetingDraft = undefined
          target.greetingVersion = undefined
          target.status = 'new'
        }
      }
      if (detail.detailVersion === 2) target.detailVersion = 2
      if (['new', 'scored', 'pending_review'].includes(target.status)) target.score = localScore(target, next)
    })
  }

  async function viewJob(job: JobRecord) {
    const current = stateRef.current
    if (!current) return
    setSelectedJobId(job.id)
    if (!job.href) {
      showToast('error', '该岗位缺少详情链接')
      return
    }
    if (current.config.browser.mode !== 'embedded') {
      await window.jobpilot.openSystemChrome(job.href)
      return
    }
    setBusy(`view-${job.id}`)
    setBrowserUrl(job.href)
    try {
      await waitForBrowserLoad(job.href)
      const detail = await waitForJobDetail()
      if (!detail.address && !hasDetailedJobDescription(detail)) {
        showToast('info', '岗位已打开，暂未识别到工作地址和职位描述')
        return
      }
      saveJobDetail(job.id, detail)
      const fit = jobLocationFit({ ...job, workAddress: detail.address || job.workAddress }, current)
      showToast(
        fit === 'outside' || fit === 'excluded' ? 'info' : 'success',
        fit === 'outside' || fit === 'excluded'
          ? `已读取岗位详情：${detail.address || '地址待确认'}，该岗位不在通勤范围`
          : `已读取岗位详情${detail.address ? `：${detail.address}` : ''}`
      )
    } catch (error) {
      showToast('error', `打开岗位失败：${String(error)}`)
    } finally {
      setBusy('')
    }
  }

  async function enrichCandidateAddresses(
    jobs: JobRecord[],
    options: { quiet?: boolean; restoreUrl?: string; includeAllMissing?: boolean } = {}
  ): Promise<AddressEnrichmentResult> {
    const current = stateRef.current
    if (!current) return { completed: 0, descriptions: 0, failed: 0, blocked: false }
    if (current.config.browser.mode !== 'embedded') {
      if (!options.quiet) showToast('error', '批量补全地址需要使用内置浏览器模式')
      return { completed: 0, descriptions: 0, failed: 0, blocked: false }
    }
    const targets = jobs.filter(job => job.href && (
      options.includeAllMissing
        ? !job.workAddress?.trim() || !hasDetailedJobDescription(job)
        : jobLocationFit(job, current) === 'unknown' || !hasDetailedJobDescription(job)
    ))
    if (!targets.length) {
      if (!options.quiet) showToast('info', '当前候选岗位的地址和职位描述已经补全')
      return { completed: 0, descriptions: 0, failed: 0, blocked: false }
    }

    setBusy('address-enrich')
    let completed = 0
    let descriptions = 0
    let failed = 0
    let blocked = false
    try {
      for (const job of targets) {
        setSelectedJobId(job.id)
        setBrowserUrl(job.href)
        try {
          await waitForBrowserLoad(job.href)
          const captcha = await browserRef.current?.executeJavaScript(captchaDetectionScript)
          if (captcha) {
            blocked = true
            updateState(next => {
              next.automationPaused = true
              next.pauseReason = '批量补全地址时检测到安全验证，请人工完成后恢复任务。'
              addActivity(next, 'captcha', '批量补全地址检测到 BOSS 安全验证，任务已暂停。')
            })
            showToast('error', '检测到 BOSS 安全验证，已停止补全地址')
            break
          }
          const detail = await waitForJobDetail()
          if (!detail.address && !hasDetailedJobDescription(detail)) {
            failed += 1
            continue
          }
          saveJobDetail(job.id, detail)
          if (detail.address) completed += 1
          if (hasDetailedJobDescription(detail)) descriptions += 1
        } catch {
          failed += 1
        }
        await new Promise(resolve => window.setTimeout(resolve, 600))
      }
      updateState(next => addActivity(next, 'system', `批量补全岗位信息：地址 ${completed} 个，职位描述 ${descriptions} 个，未识别 ${failed} 个。`))
      if (!options.quiet && !blocked) {
        showToast(failed ? 'info' : 'success', `岗位信息补全：地址 ${completed} 个，职位描述 ${descriptions} 个${failed ? `，未识别 ${failed} 个` : ''}`)
      }
      return { completed, descriptions, failed, blocked }
    } finally {
      if (options.restoreUrl && !blocked) {
        setBrowserUrl(options.restoreUrl)
        browserRef.current?.loadURL(options.restoreUrl)
      }
      setBusy('')
    }
  }

  async function sendGreetingAcrossBossNavigation(message: string) {
    const deadline = Date.now() + 15_000
    let lastReason = '正在等待 BOSS 沟通窗口加载'
    let communicateOpenedAt = 0
    let chatFallbackStarted = false
    while (Date.now() < deadline) {
      try {
        const result = await browserRef.current.executeJavaScript(sendGreetingScript(message, true)) as {
          ok: boolean
          opening?: boolean
          sent?: boolean
          retryable?: boolean
          reason?: string
        }
        if (result.ok && result.sent) return
        if (result.opening && !communicateOpenedAt) communicateOpenedAt = Date.now()
        lastReason = result.reason || lastReason
        if (!result.opening && !result.retryable) throw new Error(lastReason)
      } catch (error) {
        const reason = String(error)
        const navigationInProgress = /execution context|frame was disposed|navigation|destroyed/i.test(reason)
        if (!navigationInProgress) lastReason = reason
      }
      if (communicateOpenedAt && !chatFallbackStarted && Date.now() - communicateOpenedAt > 4_000) {
        const currentUrl = browserRef.current?.getURL?.() || ''
        if (!/\/web\/geek\/chat/.test(currentUrl)) {
          chatFallbackStarted = true
          browserRef.current.loadURL('https://www.zhipin.com/web/geek/chat')
          lastReason = '沟通弹窗未提供可用输入框，正在切换到聊天页面'
        }
      }
      await new Promise(resolve => window.setTimeout(resolve, 600))
    }
    throw new Error(`${lastReason}。请确认 BOSS 聊天区域已正常加载后重试`)
  }

  async function sendGreeting(job: JobRecord, automated = false) {
    const current = stateRef.current
    if (!current) return false
    const persistedJob = current.jobs.find(item => item.id === job.id)
    if (!persistedJob) return false
    if (greetingAlreadySent(current, persistedJob)) {
      if (!automated) showToast('info', '该岗位已打过招呼，已阻止重复发送')
      return false
    }
    if (automated && !['new', 'scored', 'pending_review'].includes(persistedJob.status)) return false
    if (!hasDetailedJobDescription(job)) {
      if (!automated) showToast('info', '该岗位尚未读取完整职位描述，暂不发送招呼语')
      return false
    }
    if (current.automationPaused) {
      if (!automated) showToast('error', current.pauseReason || '自动化已暂停')
      return false
    }
    if (!automated && automationSendCount(current) >= current.config.automation.dailyLimit) {
      showToast('error', `已达到每日发送上限 ${current.config.automation.dailyLimit}`)
      return false
    }
    if (automated) {
      const blocked = automationBlockReason(current, true)
      if (blocked) return false
      if (!jobLocationAllowsAutoSend(job, current)) return false
    }
    if (!job.greetingDraft) {
      await draftGreeting(job)
      if (!automated) showToast('info', '已生成草稿，请检查后再次点击发送')
      return false
    }
    if (current.config.browser.mode !== 'embedded') {
      await window.jobpilot.openSystemChrome(job.href || current.config.browser.homeUrl)
      if (!automated) showToast('info', '已在系统 Chrome 打开岗位，请手动发送草稿。')
      return false
    }
    const recipientLockKey = jobGreetingRecipientKey(persistedJob)
    if (jobSendInFlightRef.current.has(recipientLockKey)) return false
    jobSendInFlightRef.current.add(recipientLockKey)
    if (!automated) setBusy(`send-${job.id}`)
    try {
      await waitForBrowserLoad(job.href)
      if (automated) {
        const latest = stateRef.current
        const latestJob = latest?.jobs.find(item => item.id === job.id)
        if (
          !latest ||
          !latestJob ||
          automationBlockReason(latest, true) ||
          latest.config.automation.sendMode !== 'auto_above_score' ||
          !['new', 'scored', 'pending_review'].includes(latestJob.status) ||
          greetingAlreadySent(latest, latestJob)
        ) return false
      }
      const captcha = await browserRef.current.executeJavaScript(captchaDetectionScript)
      if (captcha) {
        updateState(next => {
          next.automationPaused = true
          next.pauseReason = '检测到 BOSS 安全验证，请人工完成后恢复任务。'
          addActivity(next, 'captcha', '首次招呼发送前检测到 BOSS 安全验证，自动化已暂停。')
        })
        showToast('error', '检测到安全验证，自动化已暂停')
        return false
      }
      await sendGreetingAcrossBossNavigation(job.greetingDraft)
      const afterCaptcha = await browserRef.current.executeJavaScript(captchaDetectionScript)
      if (afterCaptcha) {
        updateState(next => {
          next.automationPaused = true
          next.pauseReason = '发送后检测到 BOSS 安全验证，请人工完成后恢复任务。'
          addActivity(next, 'captcha', '首次招呼发送后检测到 BOSS 安全验证，自动化已暂停。')
        })
        showToast('error', '检测到安全验证，自动化已暂停')
        return false
      }
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (!target) return
        target.status = 'sent'
        target.sentAt = new Date().toISOString()
        target.lastContactAt = target.sentAt
        target.nextFollowupAt = daysFromNow(next.config.automation.followupDays[0] || 3)
        recordAutomationSend(next, 'greeting', target.id, automated, target.greetingDraft)
        addActivity(next, 'send', `已向 ${target.company} · ${target.title} 发送招呼语。`)
      })
      if (!automated) showToast('success', '消息已发送，正在同步对话')
      await syncGreetingConversation(job)
      return true
    } catch (error) {
      if (!automated) showToast('error', String(error))
      return false
    } finally {
      jobSendInFlightRef.current.delete(recipientLockKey)
      if (!automated) setBusy('')
    }
  }

  async function runAutomationRound(quiet = false, maxItems = Number.POSITIVE_INFINITY) {
    const current = stateRef.current
    if (!current) return
    if (current.automationPaused) {
      if (!quiet) showToast('error', current.pauseReason || '自动化已暂停')
      return
    }
    const nowTime = new Date().toTimeString().slice(0, 5)
    if (nowTime < current.config.automation.workdayStart || nowTime > current.config.automation.workdayEnd) {
      if (!quiet) showToast('error', `当前不在执行时段 ${current.config.automation.workdayStart}-${current.config.automation.workdayEnd}`)
      return
    }
    if (current.config.automation.sendMode === 'auto_above_score' && !current.config.automation.enabled) {
      if (!quiet) showToast('error', '请先在设置中启用自动任务')
      return
    }
    const candidates = current.jobs.filter(job =>
      ['new', 'scored'].includes(job.status) &&
      hasDetailedJobDescription(job) &&
      current.config.target.keywords.some(keyword => job.title.toLowerCase().includes(keyword.toLowerCase())) &&
      (!job.city || job.city.includes(current.config.target.city)) &&
      targetSalaryMatches(job.salary, current) &&
      jobMatchesLocationConstraint(job, current, true) &&
      !greetingAlreadySent(current, job) &&
      (current.config.automation.sendMode !== 'auto_above_score' || jobLocationAllowsAutoSend(job, current))
    )
    if (!candidates.length) {
      if (!quiet) showToast('info', '当前没有符合条件的新岗位')
      return
    }
    setBusy(quiet ? 'round-auto' : 'round')
    try {
      let autoSent = 0
      const batch = candidates.slice(0, maxItems)
      for (const [index, original] of batch.entries()) {
        const snapshot = stateRef.current || current
        const score = original.score ?? localScore(original, snapshot)
        let greeting = original.greetingDraft
        if (!greeting) {
          greeting = sanitizeGreetingDraft(snapshot.config.model.apiKeyConfigured
            ? await window.jobpilot.callModel({ task: 'draft_greeting', payload: { job: { ...original, score } } })
            : fallbackGreeting(original, snapshot))
        }
        const prepared = { ...original, score, greetingDraft: greeting, status: 'pending_review' as const }
        updateState(next => {
          const target = next.jobs.find(item => item.id === original.id)
          if (!target) return
          target.score = score
          target.greetingDraft = greeting
          target.greetingVersion = CURRENT_GREETING_VERSION
          target.status = 'pending_review'
        })
        if (snapshot.config.automation.sendMode === 'auto_above_score' && score >= snapshot.config.automation.autoScoreThreshold) {
          if (await sendGreeting(prepared, true)) autoSent += 1
          const latest = stateRef.current || snapshot
          if (index < batch.length - 1) {
            const min = latest.config.automation.intervalMinSeconds
            const max = Math.max(min, latest.config.automation.intervalMaxSeconds)
            const delay = Math.round((min + Math.random() * (max - min)) * 1000)
            await new Promise(resolve => window.setTimeout(resolve, delay))
          }
        }
      }
      updateState(next => addActivity(
        next,
        'system',
        current.config.automation.sendMode === 'auto_above_score'
          ? `自动轮次完成：处理 ${batch.length} 个岗位，尝试发送 ${autoSent} 个。`
          : `本轮已为 ${batch.length} 个岗位生成草稿，等待确认。`
      ))
      if (!quiet) showToast('success', current.config.automation.sendMode === 'auto_above_score' ? '自动轮次已完成' : '本轮草稿已准备好')
    } catch (error) {
      if (!quiet) showToast('error', String(error))
    } finally {
      setBusy('')
    }
  }

  async function draftFollowup(job: JobRecord, quiet = false) {
    const current = stateRef.current
    if (!current) return
    if (!jobEligibleForFollowup(current, job)) {
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (!target) return
        target.nextFollowupAt = undefined
        target.followupDraft = undefined
        if (target.status === 'followup_due') target.status = target.lastContactAt ? 'sent' : 'new'
      })
      if (!quiet) showToast('info', '只有通过 JobPilot 打招呼或回复过的岗位才会跟进。')
      return
    }
    if (!quiet) setBusy(`followup-${job.id}`)
    try {
      const draft = current.config.model.apiKeyConfigured
        ? await window.jobpilot.callModel({ task: 'draft_followup', payload: { job, priorGreeting: job.greetingDraft } })
        : jobFollowupFallback(job)
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (!target) return
        target.followupDraft = sanitizeFollowupDraft(draft, jobFollowupFallback(target))
        target.status = 'followup_due'
        addActivity(next, 'followup', `${target.company} · ${target.title} 已生成第 ${target.followupCount + 1} 次跟进草稿。`)
      })
      if (!quiet) showToast('success', '跟进草稿已生成')
    } catch (error) {
      if (!quiet) showToast('error', String(error))
    } finally {
      if (!quiet) setBusy('')
    }
  }

  async function generateInterviewGuide(job: JobRecord, quiet = false) {
    const current = stateRef.current
    if (!current) return
    if (!current.config.model.apiKeyConfigured) {
      if (!quiet) showToast('error', '生成面试指南需要先配置模型')
      return
    }
    if (interviewGuideInFlightRef.current.has(job.id)) return
    interviewGuideInFlightRef.current.add(job.id)
    if (!quiet) setBusy(`interview-${job.id}`)
    try {
      const currentJob = current.jobs.find(item => item.id === job.id) || job
      const conversation = current.bossConversations.find(item =>
        item.id === currentJob.interviewInvitation?.sourceConversationId || item.jobId === currentJob.id)
      const guideJob = {
        title: currentJob.title,
        company: currentJob.company,
        salary: currentJob.salary,
        city: currentJob.city,
        workAddress: currentJob.workAddress,
        experience: currentJob.experience,
        education: currentJob.education,
        description: currentJob.description.slice(0, 5000),
        recruiter: currentJob.recruiter,
        score: currentJob.score,
        matchReason: currentJob.matchReason,
        gaps: currentJob.gaps,
        greetingDraft: currentJob.greetingDraft
      }
      const guideConversation = conversation?.messages
        .filter(message => !['system', 'resume_viewed'].includes(message.kind || 'text'))
        .slice(-14)
        .map(message => ({
          direction: message.direction,
          content: message.content,
          timeLabel: message.timeLabel
        })) || []
      const requestGuide = (compactGuide: boolean) => window.jobpilot.callModel({
        task: 'interview_guide',
        payload: {
          job: guideJob,
          greeting: currentJob.greetingDraft,
          conversationSummary: currentJob.matchReason,
          interviewInvitation: currentJob.interviewInvitation,
          conversation: guideConversation,
          compactGuide
        }
      })
      let compactGuideUsed = quiet
      let guide: string
      try {
        guide = await requestGuide(compactGuideUsed)
      } catch (error) {
        if (compactGuideUsed || !shouldRetryInterviewGuide(error)) throw error
        compactGuideUsed = true
        guide = await requestGuide(true)
      }
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (!target) return
        target.interviewGuide = guide
        target.interviewGuideGeneratedAt = new Date().toISOString()
        target.interviewGuideSourceMessageId = target.interviewInvitation?.sourceMessageId
        target.interviewGuideError = undefined
        target.status = 'interview'
        addActivity(next, 'interview', `${quiet ? '自动' : '已'}生成 ${target.company} · ${target.title} 的${compactGuideUsed ? '精简' : ''}面试指南。`)
      })
      if (!quiet) {
        setSelectedJobId(job.id)
        setPage('interviews')
        showToast('success', '面试指南已生成')
      }
    } catch (error) {
      const message = readableModelError(error)
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (target) target.interviewGuideError = message
        if (quiet && target) addActivity(next, 'interview', `${target.company} · ${target.title} 的面试指南自动生成失败，可在面试作战室重试。`)
      })
      if (!quiet) showToast('error', message)
    } finally {
      interviewGuideInFlightRef.current.delete(job.id)
      if (!quiet) setBusy('')
    }
  }

  async function askInterviewAssistant(jobId: string, question: string) {
    const current = stateRef.current
    const job = current?.jobs.find(item => item.id === jobId)
    const trimmedQuestion = question.trim()
    if (!current || !job || !trimmedQuestion) return
    if (!current.config.model.apiKeyConfigured) {
      showToast('error', '使用 AI 面试助手需要先配置模型')
      return
    }
    const busyKey = `interview-assistant-${job.id}`
    const history = job.interviewAssistantMessages || []
    const userMessage: ChatMessage = {
      id: `${Date.now()}-interview-user-${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      content: trimmedQuestion,
      createdAt: new Date().toISOString()
    }
    const assistantMessage: ChatMessage = {
      id: `${Date.now()}-interview-assistant-${Math.random().toString(36).slice(2, 7)}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    }
    updateState(next => {
      const target = next.jobs.find(item => item.id === job.id)
      if (!target) return
      target.interviewAssistantMessages = [...(target.interviewAssistantMessages || []), userMessage]
    })
    updateState(next => {
      const target = next.jobs.find(item => item.id === job.id)
      if (!target) return
      target.interviewAssistantMessages = [...(target.interviewAssistantMessages || []), assistantMessage]
    }, false)
    setBusy(busyKey)
    let streamedContent = ''
    let flushTimer: number | undefined
    const flushStream = (persist: boolean) => {
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        const message = target?.interviewAssistantMessages?.find(item => item.id === assistantMessage.id)
        if (message) message.content = persist ? visibleChatContent(streamedContent) : streamedContent
      }, persist)
    }
    try {
      const conversation = current.bossConversations.find(item =>
        item.id === job.interviewInvitation?.sourceConversationId || item.jobId === job.id)
      const request = {
        task: 'interview_assistant',
        payload: {
          job: {
            title: job.title,
            company: job.company,
            salary: job.salary,
            city: job.city,
            workAddress: job.workAddress,
            experience: job.experience,
            education: job.education,
            description: job.description.slice(0, 5000),
            recruiter: job.recruiter,
            score: job.score,
            matchReason: job.matchReason,
            gaps: job.gaps
          },
          interviewInvitation: job.interviewInvitation,
          interviewGuide: job.interviewGuide,
          recruiterConversation: conversation?.messages
            .filter(message => !['system', 'resume_viewed'].includes(message.kind || 'text'))
            .slice(-20)
            .map(message => ({ direction: message.direction, content: message.content, timeLabel: message.timeLabel })) || [],
          question: trimmedQuestion,
          history: history.slice(-12).map(message => ({ role: message.role, content: visibleChatContent(message.content) }))
        }
      } as const
      const answer = await window.jobpilot.streamModel(request, delta => {
        streamedContent += delta
        if (flushTimer !== undefined) return
        flushTimer = window.setTimeout(() => {
          flushTimer = undefined
          flushStream(false)
        }, 120)
      })
      if (flushTimer !== undefined) window.clearTimeout(flushTimer)
      flushTimer = undefined
      streamedContent = answer
      flushStream(true)
    } catch (error) {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer)
      updateState(next => {
        const target = next.jobs.find(item => item.id === job.id)
        if (!target?.interviewAssistantMessages) return
        if (streamedContent.trim()) {
          const message = target.interviewAssistantMessages.find(item => item.id === assistantMessage.id)
          if (message) message.content = visibleChatContent(streamedContent)
        } else {
          target.interviewAssistantMessages = target.interviewAssistantMessages.filter(item => item.id !== assistantMessage.id)
        }
      })
      showToast('error', `面试助手回答失败：${readableModelError(error)}`)
    } finally {
      setBusy('')
    }
  }

  function clearInterviewAssistant(jobId: string) {
    const current = stateRef.current?.jobs.find(job => job.id === jobId)
    if (!current?.interviewAssistantMessages?.length || !window.confirm(`确定清空“${current.company} · ${current.title}”的 AI 面试助手对话吗？`)) return
    updateState(next => {
      const target = next.jobs.find(job => job.id === jobId)
      if (target) target.interviewAssistantMessages = []
    })
    showToast('success', '当前面试助手对话已清空')
  }

  async function generatePendingInterviewGuides(current: AppState, limit = 3) {
    if (
      !current.config.automation.enabled ||
      !current.config.automation.interviewAutoGuideEnabled ||
      !current.config.model.apiKeyConfigured
    ) return
    const pending = current.jobs.filter(job =>
      job.status === 'interview' &&
      Boolean(job.interviewInvitation?.sourceMessageId) &&
      job.interviewGuideSourceMessageId !== job.interviewInvitation?.sourceMessageId &&
      !job.interviewGuideError &&
      !interviewGuideInFlightRef.current.has(job.id)
    ).slice(0, limit)
    for (const job of pending) await generateInterviewGuide(job, true)
  }

  async function selectResumeFile(purpose: 'profile' | 'diagnosis' = 'diagnosis') {
    try {
      const file = await window.jobpilot.selectResume()
      if (!file) return null
      if (purpose === 'profile') {
        setProfileResumeFile(file)
        updateState(next => {
          next.profile.resumePath = file.path
          addActivity(next, 'system', `已选择画像来源：${file.name}。`)
        })
      } else {
        setResumeFile(file)
        updateState(next => { addActivity(next, 'system', `已选择诊断简历：${file.name}。`) })
      }
      showToast('success', `已读取 ${file.name}`)
      return file
    } catch (error) {
      showToast('error', `读取简历失败：${String(error)}`)
      return null
    }
  }

  async function resolveResumeSource(current: AppState, sourceId: ResumeSourceId | undefined, purpose: 'profile' | 'diagnosis') {
    if (sourceId && sourceId !== 'upload') {
      const document = current.knowledgeDocuments.find(item => item.id === sourceId)
      if (!document) throw new Error('所选知识库文件已不存在')
      try {
        return await window.jobpilot.readResume(document.path)
      } catch {
        const text = current.knowledgeChunks
          .filter(chunk => chunk.documentId === document.id)
          .sort((a, b) => a.index - b.index)
          .map(chunk => chunk.text)
          .join('\n\n')
        if (!text.trim()) throw new Error('所选知识库文件没有可用文本，请重新导入')
        return { path: document.path, name: document.name, type: document.type, text } satisfies ResumeFile
      }
    }
    let file = purpose === 'profile' ? profileResumeFile : resumeFile
    const fallbackPath = purpose === 'diagnosis'
      ? current.resumeDiagnosis?.path || current.profile.resumePath
      : current.profile.resumePath
    if (!file && fallbackPath) file = await window.jobpilot.readResume(fallbackPath)
    if (!file) file = await selectResumeFile(purpose)
    return file
  }

  async function generateCandidateProfile(sourceId?: ResumeSourceId) {
    const current = stateRef.current
    if (!current) return
    if (!current.config.model.apiKeyConfigured) {
      showToast('error', '生成候选人画像需要先配置对话模型 API Key')
      setPage('settings')
      return
    }
    setBusy('profile-generation')
    try {
      const file = await resolveResumeSource(current, sourceId, 'profile')
      if (!file) return
      if (!file.text.trim()) throw new Error('简历没有解析出可用文本')
      setProfileResumeFile(file)
      const raw = await window.jobpilot.callModel({
        task: 'candidate_profile',
        payload: {
          fileName: file.name,
          resumeText: file.text.slice(0, 50000),
          target: current.config.target
        }
      })
      const profile = normalizeCandidateProfile(raw, current.profile, current.config.target, file)
      updateState(next => {
        next.profile = profile
        addActivity(next, 'system', `已根据 ${file.name} 重新生成候选人画像，可继续手动微调。`)
      })
      showToast('success', '候选人画像已生成，可直接编辑')
    } catch (error) {
      showToast('error', `画像生成失败：${String(error).replace(/^Error:\s*/, '')}`)
    } finally {
      setBusy('')
    }
  }

  function updateCandidateProfile(mutator: (profile: CandidateProfile) => void) {
    updateState(next => { mutator(next.profile) })
  }

  async function diagnoseResume(sourceId?: ResumeSourceId) {
    const current = stateRef.current
    if (!current) return
    if (!current.config.model.apiKeyConfigured) {
      showToast('error', '简历诊断需要先在设置中配置对话模型 API Key')
      setPage('settings')
      return
    }
    setBusy('resume-diagnosis')
    try {
      const file = await resolveResumeSource(current, sourceId, 'diagnosis')
      if (!file) return
      if (!file.text.trim()) throw new Error('简历没有解析出可用文本，请换一个 PDF 或 DOCX 文件')
      setResumeFile(file)
      const raw = await window.jobpilot.callModel({
        task: 'resume_diagnosis',
        payload: {
          fileName: file.name,
          resumeText: file.text.slice(0, 50000),
          targetRole: current.profile.targetRole,
          targetKeywords: current.config.target.keywords.join('、'),
          targetCity: current.config.target.city,
          salaryRange: `${current.config.target.salaryMinK}-${current.config.target.salaryMaxK}K`,
          preferredKeywords: current.config.target.preferredKeywords
        }
      })
      const diagnosis = normalizeResumeDiagnosis(raw, file)
      updateState(next => {
        next.resumeDiagnosis = diagnosis
        addActivity(next, 'system', `已完成简历诊断：${file.name}，匹配评分 ${diagnosis.score}。`)
      })
      showToast('success', '简历诊断完成')
    } catch (error) {
      showToast('error', `简历诊断失败：${String(error).replace(/^Error:\s*/, '')}`)
    } finally {
      setBusy('')
    }
  }

  function deleteInterview(jobId: string) {
    const current = stateRef.current?.jobs.find(job => job.id === jobId)
    if (!current || !window.confirm(`确定删除“${current.company} · ${current.title}”的面试准备记录吗？岗位和聊天记录不会删除。`)) return
    updateState(next => {
      const target = next.jobs.find(job => job.id === jobId)
      if (!target) return
      target.interviewInvitation = undefined
      target.interviewGuide = undefined
      target.interviewGuideGeneratedAt = undefined
      target.interviewGuideSourceMessageId = undefined
      target.interviewGuideError = undefined
      target.interviewAssistantMessages = undefined
      target.status = target.lastContactAt ? 'replied' : target.sentAt ? 'sent' : 'new'
      addActivity(next, 'system', `已删除 ${target.company} · ${target.title} 的面试准备记录。`)
    })
    setSelectedJobId(null)
    showToast('success', '面试准备已删除')
  }

  function resumeAutomation() {
    updateState(next => {
      next.automationPaused = false
      next.pauseReason = undefined
      addActivity(next, 'system', '用户确认验证已完成，自动化已恢复。')
    })
  }

  function toggleAutomationEnabled() {
    const enabled = !stateRef.current?.config.automation.enabled
    updateState(next => {
      next.config.automation.enabled = enabled
      addActivity(next, 'system', enabled
        ? '自动化总开关已启用，将按现有策略继续执行自动任务。'
        : '自动化总开关已关闭，自动采集、招呼、回复、发简历和跟进均已停止。')
    })
    showToast(enabled ? 'success' : 'info', enabled ? '自动化已启用' : '自动化已关闭，手动操作仍可用')
  }

  if (!state) {
    return <div className="loading-screen"><div className="loader" /><span>正在启动 JobPilot...</span></div>
  }

  const selectedJob = state.jobs.find(job => job.id === selectedJobId) || state.jobs[0]
  const stats = {
    captured: state.jobs.length,
    radar: state.jobs.filter(job => jobMatchesRadarFilters(job, state)).length,
    sent: state.jobs.filter(job => job.status === 'sent').length,
    interviews: state.jobs.filter(job => job.status === 'interview').length,
    chats: state.bossConversations.filter(conversation => conversation.unreadCount > 0 || conversation.status === 'draft_ready').length
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPage} stats={stats} />
      <main className="app-main">
        <Topbar state={state} onResume={resumeAutomation} onToggleAutomation={toggleAutomationEnabled} />
        <div className={`page-host ${page === 'radar' ? '' : 'hidden'}`}>
          <RadarView
            state={state}
            browserRef={browserRef}
            browserReady={browserReady}
            setBrowserReady={setBrowserReady}
            browserUrl={browserUrl}
            setBrowserUrl={setBrowserUrl}
            browserFocus={browserFocus}
            setBrowserFocus={setBrowserFocus}
            browserZoom={browserZoom}
            setBrowserZoom={setBrowserZoom}
            busy={busy}
            collectJobs={collectJobs}
            syncBossChats={() => syncBossChats(false, undefined, 'normal', true)}
            runAutomationRound={runAutomationRound}
            scoreJob={scoreJob}
            draftGreeting={draftGreeting}
            sendGreeting={sendGreeting}
            viewJob={viewJob}
            enrichCandidateAddresses={enrichCandidateAddresses}
            generateInterviewGuide={generateInterviewGuide}
            selectedJobId={selectedJobId}
            setSelectedJobId={setSelectedJobId}
          />
        </div>
        {page === 'followups' && (
          <FollowupsView
            state={state}
            busy={busy}
            syncBossChats={conversation => syncBossChats(false, conversation, 'normal', !conversation)}
            draftConversationReply={draftConversationReply}
            draftConversationGreeting={draftConversationGreeting}
            editConversationDraft={editConversationDraft}
            sendConversationReply={sendConversationReply}
            sendConversationResume={sendConversationResume}
            toggleConversationAi={toggleConversationAi}
            toggleConversationEnded={toggleConversationEnded}
            openBossConversation={openBossConversation}
            viewJob={viewJob}
          />
        )}
        {page === 'interviews' && (
          <InterviewsView
            state={state}
            selectedJob={selectedJob}
            setSelectedJobId={setSelectedJobId}
            busy={busy}
            generateInterviewGuide={generateInterviewGuide}
            deleteInterview={deleteInterview}
            askInterviewAssistant={askInterviewAssistant}
            clearInterviewAssistant={clearInterviewAssistant}
            fetchInterviewInvitations={fetchInterviewInvitations}
          />
        )}
        {page === 'knowledge' && (
          <KnowledgeView state={state} updateState={updateState} replaceState={replaceState} showToast={showToast} busy={busy} setBusy={setBusy} />
        )}
        {page === 'resume' && (
          <ResumeDiagnosisView
            state={state}
            busy={busy}
            selectedResumeFile={resumeFile}
            selectResume={() => selectResumeFile('diagnosis')}
            diagnoseResume={diagnoseResume}
          />
        )}
        {page === 'profile' && (
          <ProfileView
            state={state}
            busy={busy}
            selectResume={() => selectResumeFile('profile')}
            generateProfile={generateCandidateProfile}
            updateProfile={updateCandidateProfile}
          />
        )}
        {page === 'settings' && (
          <SettingsView state={state} updateState={updateState} showToast={showToast} />
        )}
      </main>
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.type === 'success' ? <Check size={17} /> : toast.type === 'error' ? <CircleAlert size={17} /> : <Activity size={17} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)}><X size={15} /></button>
        </div>
      )}
    </div>
  )
}

function Sidebar({ page, setPage, stats }: { page: Page; setPage: (page: Page) => void; stats: Record<string, number> }) {
  const items: Array<{ id: Page; label: string; icon: typeof Gauge; badge?: number }> = [
    { id: 'radar', label: '岗位雷达', icon: Gauge, badge: stats.radar },
    { id: 'followups', label: '对话跟进', icon: MessageCircleMore, badge: stats.chats },
    { id: 'interviews', label: '面试准备', icon: BriefcaseBusiness, badge: stats.interviews },
    { id: 'knowledge', label: '知识库问答', icon: LibraryBig },
    { id: 'resume', label: '简历诊断', icon: FileText },
    { id: 'profile', label: '候选人画像', icon: UserRound },
    { id: 'settings', label: '设置', icon: Settings }
  ]
  return (
    <aside className="sidebar">
      <div className="window-drag" />
      <div className="brand">
        <div className="brand-mark"><img src={jobpilotLogo} alt="" /></div>
        <div><strong>JobPilot</strong><span>求职副驾</span></div>
      </div>
      <nav>
        {items.map(item => {
          const Icon = item.icon
          return (
            <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}>
              <Icon size={18} />
              <span>{item.label}</span>
              {Boolean(item.badge) && <em>{item.badge}</em>}
            </button>
          )
        })}
      </nav>
      <div className="sidebar-summary">
        <span>本地运行</span>
        <strong>{stats.captured}</strong>
        <p>个岗位已进入本地求职台账</p>
      </div>
      <div className="privacy-note"><ShieldCheck size={15} /><span>简历与登录态保存在本机</span></div>
    </aside>
  )
}

function Topbar({
  state,
  onResume,
  onToggleAutomation
}: {
  state: AppState
  onResume: () => void
  onToggleAutomation: () => void
}) {
  const automationEnabled = state.config.automation.enabled
  return (
    <header className="topbar">
      <div className="window-drag" />
      <div className="topbar-target">
        <Target size={16} />
        <strong>{state.config.target.keywords[0]}</strong>
        <span>{state.config.target.city}</span>
        <span>{state.config.target.salaryMinK}-{state.config.target.salaryMaxK}K</span>
      </div>
      <div className="topbar-status">
        <button
          type="button"
          className={`status-pill ${automationEnabled ? 'running' : 'disabled'}`}
          role="switch"
          aria-checked={automationEnabled}
          title={automationEnabled ? '点击关闭全部自动任务，手动操作不受影响' : '点击启用自动任务，并沿用当前策略配置'}
          onClick={onToggleAutomation}
        >
          <Power size={14} />
          <span>{automationEnabled ? '自动化已启用' : '自动化已关闭'}</span>
          <i aria-hidden="true" />
        </button>
        {state.automationPaused && (
          <button className="paused-pill" onClick={onResume}><Pause size={14} />已暂停 · 点击恢复</button>
        )}
        <span className={`mode-pill ${automationEnabled ? '' : 'muted'}`}>{sendModeLabels[state.config.automation.sendMode]}</span>
      </div>
    </header>
  )
}

interface RadarProps {
  state: AppState
  browserRef: React.MutableRefObject<any>
  browserReady: boolean
  setBrowserReady: (ready: boolean) => void
  browserUrl: string
  setBrowserUrl: (url: string) => void
  browserFocus: boolean
  setBrowserFocus(focus: boolean): void
  browserZoom: number
  setBrowserZoom(zoom: number): void
  busy: string
  collectJobs(quiet?: boolean): Promise<void>
  syncBossChats(): Promise<void>
  runAutomationRound(): Promise<void>
  scoreJob(job: JobRecord): Promise<void>
  draftGreeting(job: JobRecord): Promise<void>
  sendGreeting(job: JobRecord): Promise<boolean>
  viewJob(job: JobRecord): Promise<void>
  enrichCandidateAddresses(jobs: JobRecord[]): Promise<AddressEnrichmentResult>
  generateInterviewGuide(job: JobRecord): Promise<void>
  selectedJobId: string | null
  setSelectedJobId(id: string): void
}

function RadarView(props: RadarProps) {
  const { state, browserRef, browserReady, setBrowserReady, browserUrl, setBrowserUrl, busy } = props
  const [locationView, setLocationView] = useState<'eligible' | 'all'>('all')
  const collecting = busy === 'collect' || busy === 'collect-auto' || busy === 'address-enrich'
  const matchingJobs = useMemo(() => state.jobs.filter(job => jobMatchesRadarFilters(job, state)), [state])
  const eligibleJobs = useMemo(() => matchingJobs.filter(job => jobMatchesLocationConstraint(job, state, false)), [matchingJobs, state])
  const visibleJobs = locationView === 'eligible' ? eligibleJobs : matchingJobs
  const unknownLocationCount = matchingJobs.filter(job => jobLocationFit(job, state) === 'unknown').length
  const restrictedLocationCount = matchingJobs.filter(job => {
    const fit = jobLocationFit(job, state)
    return fit === 'outside' || fit === 'excluded'
  }).length

  function navigate(value: string) {
    let url = value.trim()
    if (!/^https?:\/\//.test(url)) url = `https://${url}`
    setBrowserUrl(url)
    browserRef.current?.loadURL(url)
  }

  function changeZoom(delta: number) {
    const next = Math.max(0.6, Math.min(1.2, Math.round((props.browserZoom + delta) * 10) / 10))
    props.setBrowserZoom(next)
    browserRef.current?.setZoomFactor(next)
  }

  function browserLoaded() {
    setBrowserReady(true)
    browserRef.current?.setZoomFactor(props.browserZoom)
  }

  useEffect(() => {
    if (state.config.browser.mode !== 'embedded') return
    const webview = browserRef.current
    if (!webview) return
    const handleReady = () => { browserLoaded() }
    webview.addEventListener('dom-ready', handleReady)
    webview.addEventListener('did-finish-load', handleReady)
    try {
      const currentUrl = webview.getURL?.()
      if (currentUrl && currentUrl !== 'about:blank') {
        setBrowserReady(true)
        webview.setZoomFactor(props.browserZoom)
      }
    } catch { /* webview is still attaching */ }
    return () => {
      webview.removeEventListener('dom-ready', handleReady)
      webview.removeEventListener('did-finish-load', handleReady)
    }
  }, [state.config.browser.mode])

  return (
    <section className={`radar-layout ${props.browserFocus ? 'browser-focus' : ''}`}>
      <div className="browser-pane">
        <div className="browser-toolbar">
          <div className="browser-actions">
            <button onClick={() => browserRef.current?.goBack()}><ArrowLeft size={16} /></button>
            <button onClick={() => browserRef.current?.goForward()}><ArrowRight size={16} /></button>
            <button onClick={() => browserRef.current?.reload()}><RefreshCw size={15} /></button>
          </div>
          <form onSubmit={event => { event.preventDefault(); navigate(browserUrl) }}>
            <ShieldCheck size={14} />
            <input value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} />
          </form>
          <div className="browser-data-actions">
            <button className="collect-button" disabled={collecting} onClick={() => void props.collectJobs()}>
              {collecting ? <RefreshCw size={15} className="spin" /> : <Inbox size={15} />}
              {busy === 'address-enrich' ? '采集地址' : collecting ? '采集中' : '采集岗位'}
            </button>
            <button className="sync-chat-button" disabled={busy === 'chat-sync'} onClick={props.syncBossChats}>
              {busy === 'chat-sync' ? <RefreshCw size={15} className="spin" /> : <MessageCircleMore size={15} />}
              同步对话
            </button>
          </div>
          <div className="browser-fit-actions">
            <button title="缩小网页" onClick={() => changeZoom(-0.1)}><ZoomOut size={14} /></button>
            <span>{Math.round(props.browserZoom * 100)}%</span>
            <button title="放大网页" onClick={() => changeZoom(0.1)}><ZoomIn size={14} /></button>
            <button title={props.browserFocus ? '显示候选队列' : '浏览器专注模式'} onClick={() => props.setBrowserFocus(!props.browserFocus)}>
              {props.browserFocus ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button className="login-window-button" onClick={() => window.jobpilot.openLoginWindow(state.config.browser.homeUrl)}>
              <ExternalLink size={14} />全屏登录
            </button>
            <button className="round-button" disabled={busy === 'round'} onClick={props.runAutomationRound}>
              {busy === 'round' ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
              执行本轮
            </button>
          </div>
        </div>
        {state.automationPaused && (
          <div className="captcha-banner">
            <CircleAlert size={17} />
            <div><strong>需要人工完成安全验证</strong><span>{state.pauseReason}</span></div>
          </div>
        )}
        {state.config.browser.mode === 'embedded' ? (
          <webview
            ref={browserRef}
            src={state.config.browser.homeUrl}
            partition="persist:jobpilot-boss"
            useragent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
            allowpopups={true}
            onLoad={browserLoaded}
            className="boss-webview"
          />
        ) : (
          <div className="external-browser-empty">
            <ExternalLink size={32} />
            <strong>当前使用系统 Chrome 模式</strong>
            <p>适合登录兼容性优先的场景。页面自动采集与发送需要切回内置浏览器。</p>
            <button onClick={() => window.jobpilot.openSystemChrome(state.config.browser.homeUrl)}>打开 BOSS 直聘</button>
          </div>
        )}
      </div>
      <aside className="queue-pane">
        <div className="queue-heading">
          <div className="queue-heading-title">
            <div><span>候选队列</span><strong>{visibleJobs.length}</strong></div>
            <div className="queue-heading-actions">
              <div className="location-view-switch" role="group" aria-label="岗位范围">
                <button className={locationView === 'eligible' ? 'active' : ''} onClick={() => setLocationView('eligible')}>通勤内 {eligibleJobs.length}</button>
                <button className={locationView === 'all' ? 'active' : ''} onClick={() => setLocationView('all')}>全部 {matchingJobs.length}</button>
              </div>
              <button
                disabled={!unknownLocationCount || busy === 'address-enrich'}
                title="依次打开待确认岗位并读取工作地址"
                onClick={() => void props.enrichCandidateAddresses(matchingJobs)}
              >
                {busy === 'address-enrich' ? <RefreshCw size={13} className="spin" /> : <MapPin size={13} />}
                {busy === 'address-enrich' ? '补全中' : '补全地址'}
              </button>
            </div>
          </div>
          <p>{state.config.target.locationConstraintEnabled
            ? `${locationView === 'eligible' ? '符合通勤范围' : '全部匹配岗位'}${unknownLocationCount ? ` · ${unknownLocationCount} 个${locationView === 'eligible' ? '待确认未计入' : '地址待确认'}` : ''}${restrictedLocationCount ? ` · ${restrictedLocationCount} 个超出或排除` : ''}`
            : '已按城市、岗位与薪资范围筛选'}</p>
        </div>
        <div className="queue-list">
          {visibleJobs.length === 0 ? (
            <div className="empty-state">
              <Search size={28} />
              <strong>还没有候选岗位</strong>
              <p>在左侧登录 BOSS 并打开职位列表，然后采集当前页。</p>
            </div>
          ) : visibleJobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              selected={props.selectedJobId === job.id}
              busy={busy}
              locationFit={jobLocationFit(job, state)}
              onSelect={() => props.setSelectedJobId(job.id)}
              onView={() => props.viewJob(job)}
              onScore={() => props.scoreJob(job)}
              onDraft={() => props.draftGreeting(job)}
              onSend={() => props.sendGreeting(job)}
              onInterview={() => props.generateInterviewGuide(job)}
            />
          ))}
        </div>
      </aside>
    </section>
  )
}

function JobCard({ job, selected, busy, locationFit, onSelect, onView, onScore, onDraft, onSend, onInterview }: {
  job: JobRecord
  selected: boolean
  busy: string
  locationFit: ReturnType<typeof jobLocationFit>
  onSelect(): void
  onView(): void
  onScore(): void
  onDraft(): void
  onSend(): void
  onInterview(): void
}) {
  const scoreTone = (job.score || 0) >= 80 ? 'high' : (job.score || 0) >= 65 ? 'medium' : 'low'
  const detailReady = hasDetailedJobDescription(job)
  const locationLabel = job.workAddress || job.city || '地址待确认'
  const locationSuffix = locationFit === 'preferred'
    ? ' · 推荐通勤'
    : locationFit === 'outside'
      ? ' · 超出偏好'
      : locationFit === 'excluded'
        ? ' · 已排除'
        : locationFit === 'unknown'
          ? ' · 待确认'
          : ''
  return (
    <article className={`job-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="job-card-top">
        <div><strong>{job.title}</strong><span><Building2 size={13} />{job.company}</span></div>
        <div className={`score score-${scoreTone}`}>{job.score ?? '—'}</div>
      </div>
      <div className="job-meta">
        <span className={`job-location-meta location-${locationFit}`} title={locationLabel}>
          <MapPin size={12} />{locationLabel}{locationSuffix}
        </span>
        <span>{job.salary || '薪资面议'}</span>
        {job.experience && <span>{job.experience}</span>}
        {!detailReady && <span className="job-detail-missing">职位描述待补全</span>}
      </div>
      {job.matchReason && <p className="match-reason">{job.matchReason}</p>}
      {job.greetingDraft && <div className="draft-preview"><MessageCircleMore size={13} /><span>{job.greetingDraft}</span></div>}
      <div className="job-card-actions" onClick={event => event.stopPropagation()}>
        <button disabled={!job.href || busy === `view-${job.id}`} title={job.href ? '在左侧查看岗位详情，并读取地址、职责与任职要求' : '该岗位缺少详情链接'} onClick={onView}>
          {busy === `view-${job.id}` ? <RefreshCw size={14} className="spin" /> : <ExternalLink size={14} />}
          {busy === `view-${job.id}` ? '读取中' : '查看岗位'}
        </button>
        <button disabled={busy === `score-${job.id}`} onClick={onScore}><Sparkles size={14} />评分</button>
        <button disabled={!detailReady || busy === `draft-${job.id}`} title={detailReady ? '根据完整职位描述生成招呼语' : '请先查看岗位并补全职位描述'} onClick={onDraft}><WandSparkles size={14} />招呼语</button>
        <button className="primary" disabled={!detailReady || busy === `send-${job.id}`} title={detailReady ? '发送当前招呼语' : '请先查看岗位并补全职位描述'} onClick={onSend}>
          {busy === `send-${job.id}` ? <RefreshCw size={14} className="spin" /> : <Send size={14} />}
          {busy === `send-${job.id}` ? '发送中' : '发送'}
        </button>
        <button className="icon-only" title="生成面试指南" onClick={onInterview}><BriefcaseBusiness size={14} /></button>
      </div>
      <span className={`job-status status-${job.status}`}>{statusLabel(job.status)}</span>
    </article>
  )
}

function FollowupsView({
  state, busy, syncBossChats, draftConversationReply, draftConversationGreeting, editConversationDraft, sendConversationReply, sendConversationResume, toggleConversationAi, toggleConversationEnded, openBossConversation, viewJob
}: {
  state: AppState
  busy: string
  syncBossChats(conversation?: BossConversation): Promise<void>
  draftConversationReply(conversation: BossConversation): Promise<void>
  draftConversationGreeting(conversation: BossConversation): Promise<void>
  editConversationDraft(conversationId: string, value: string): void
  sendConversationReply(conversationId: string, kind?: 'chat_reply' | 'followup', automated?: boolean): Promise<boolean>
  sendConversationResume(conversationId: string, automated?: boolean): Promise<boolean>
  toggleConversationAi(conversationId: string): void
  toggleConversationEnded(conversationId: string): void
  openBossConversation(conversation: BossConversation, fillDraft?: boolean): Promise<void>
  viewJob(job: JobRecord): Promise<void>
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [conversationTab, setConversationTab] = useState<'all' | 'active' | 'ended' | 'manual'>('active')
  const [conversationSearch, setConversationSearch] = useState('')
  const needsManualReview = (conversation: BossConversation) => conversation.status !== 'ended' && Boolean(
    conversation.aiPaused ||
    (conversation.draftReply && conversation.draftRequiresReview) ||
    ((conversation.resumeRequestPending || conversation.resumeProactiveSendPending) && state.config.automation.resumeSendMode === 'review_each')
  )
  const isTrackedConversation = (conversation: BossConversation) => conversation.status !== 'ended' && Boolean(
    conversationHasJobPilotSend(state, conversation)
    || conversation.unreadCount > 0
    || conversation.draftReply
    || conversation.replyPendingMessageId
    || conversation.resumeRequestPending
    || conversation.resumeProactiveSendPending
  )
  const normalizedSearch = conversationSearch.trim().toLowerCase()
  const tabConversations = state.bossConversations.filter(conversation => {
    const matchesSearch = !normalizedSearch || [
      conversation.recruiter,
      conversation.company,
      conversation.jobTitle,
      conversation.preview,
      ...conversation.messages.slice(-20).map(message => message.content)
    ].join(' ').toLowerCase().includes(normalizedSearch)
    if (normalizedSearch) return matchesSearch
    if (conversationTab === 'active' && !isTrackedConversation(conversation)) return false
    if (conversationTab === 'ended' && conversation.status !== 'ended') return false
    if (conversationTab === 'manual' && !needsManualReview(conversation)) return false
    return matchesSearch
  })
  const selected = tabConversations.find(conversation => conversation.id === selectedId) || tabConversations[0]
  const linkedJob = selected?.jobId ? state.jobs.find(job => job.id === selected.jobId) : undefined
  const unread = state.bossConversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0)
  const drafts = state.bossConversations.filter(conversation => Boolean(conversation.draftReply)).length
  const ended = state.bossConversations.filter(conversation => conversation.status === 'ended').length
  const manual = state.bossConversations.filter(needsManualReview).length
  const active = state.bossConversations.filter(isTrackedConversation).length
  const protectedIntents = sensitiveIntentOptions
    .filter(option => state.config.automation.sensitiveChatIntents.includes(option.value))
    .map(option => option.label)

  useEffect(() => {
    if (selected) void syncBossChats(selected)
  }, [selected?.id])

  return (
    <section className="page-content conversation-page">
      <div className="conversation-heading">
        <PageHeading eyebrow="Boss Inbox" title="对话工作台" description="同步 BOSS 消息，用知识库生成第一人称回复；发送行为严格按当前策略执行。" />
        <div className="conversation-heading-actions">
          <span><i />{chatReplyModeLabels[state.config.automation.chatReplyMode]}</span>
          <button disabled={busy === 'chat-sync'} onClick={() => void syncBossChats()}>
            <RefreshCw size={15} className={busy === 'chat-sync' ? 'spin' : ''} />同步 BOSS 对话
          </button>
        </div>
      </div>
      <div className="conversation-metrics">
        <span><strong>{state.bossConversations.length}</strong>个会话</span>
        <span><strong>{unread}</strong>条未读</span>
        <span><strong>{drafts}</strong>份草稿</span>
        <span><strong>{ended}</strong>个已结束</span>
        <span><ShieldCheck size={14} />{protectedIntents.length ? `${protectedIntents.join('、')}需人工确认` : '未设置必须人工确认的意图'}</span>
      </div>
      <div className="conversation-filters">
        <div className="conversation-tabs">
          {([
            ['all', '全部', state.bossConversations.length],
            ['active', '跟进中', active],
            ['ended', '已结束', ended],
            ['manual', '需人工确认', manual]
          ] as const).map(([id, label, count]) => (
            <button key={id} className={conversationTab === id ? 'active' : ''} onClick={() => setConversationTab(id)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
        <label className="conversation-search">
          <Search size={15} />
          <input value={conversationSearch} onChange={event => setConversationSearch(event.target.value)} placeholder="搜索招聘者、公司、岗位或消息" />
          {conversationSearch && <button title="清空搜索" onClick={() => setConversationSearch('')}><X size={14} /></button>}
        </label>
      </div>
      <div className="conversation-workspace">
        <aside className="conversation-list">
          {state.bossConversations.length === 0 ? (
            <EmptyPanel icon={MessageCircleMore} title="还没有同步会话" text="点击右上角同步，客户端会打开 BOSS 消息页并读取当前登录账号可见的对话。" />
          ) : tabConversations.length === 0 ? (
            <EmptyPanel icon={Search} title="没有匹配的会话" text="换一个筛选条件或搜索关键词。" />
          ) : tabConversations.map(conversation => (
            <button key={conversation.id} className={`${selected?.id === conversation.id ? 'active' : ''} ${conversation.status === 'ended' ? 'ended' : ''}`} onClick={() => {
              if (selected?.id === conversation.id) void syncBossChats(conversation)
              else setSelectedId(conversation.id)
            }}>
              <span className="conversation-avatar">{conversation.recruiter.slice(0, 1)}</span>
              <span className="conversation-list-body">
                <span><strong>{conversation.recruiter}</strong><time>{conversationDisplayTime(conversation)}</time></span>
                <small>{[conversation.company, conversation.jobTitle].filter(Boolean).join(' · ') || 'BOSS 招聘沟通'}</small>
                <p>{conversation.preview || '打开会话后同步完整消息'}</p>
              </span>
              {conversation.unreadCount > 0 && <em>{conversation.unreadCount}</em>}
              {conversation.status === 'draft_ready' && <i className="draft-dot" title="草稿已就绪" />}
              {conversation.status === 'ended' && <i className="ended-badge">已结束</i>}
            </button>
          ))}
        </aside>

        <main className="conversation-thread">
          {!selected ? (
            <EmptyPanel icon={Inbox} title="选择一个会话" text="同步后可在这里查看消息上下文。" />
          ) : (
            <>
              <header>
                <div><strong>{selected.recruiter}</strong><span>{[selected.company, selected.jobTitle].filter(Boolean).join(' · ') || 'BOSS 招聘沟通'}</span></div>
                <button onClick={() => void openBossConversation(selected)}><ExternalLink size={14} />在 BOSS 打开</button>
              </header>
              <div className="conversation-messages">
                {linkedJob && (
                  <div className="conversation-job-card">
                    <div>
                      <span><BriefcaseBusiness size={14} />对应岗位</span>
                      <strong>{linkedJob.title}</strong>
                      <small>{linkedJob.company} · {linkedJob.salary || '薪资面议'} · {linkedJob.workAddress || linkedJob.city || '地址待确认'}</small>
                    </div>
                    <button onClick={() => void viewJob(linkedJob)} disabled={!linkedJob.href || busy === `view-${linkedJob.id}`}>
                      <RefreshCw size={13} className={busy === `view-${linkedJob.id}` ? 'spin' : ''} />{busy === `view-${linkedJob.id}` ? '读取中' : '读取岗位信息'}
                    </button>
                  </div>
                )}
                {selected.messages.length === 0 ? (
                  <div className="thread-empty"><MessageCircleMore size={24} /><strong>这是一个尚未发送消息的会话</strong><p>{linkedJob ? '可以根据对应岗位生成招呼语，再填入 BOSS 发送。' : '请先在 BOSS 打开这位招聘者并同步；关联岗位后才能生成匹配的招呼语。'}</p></div>
                ) : selected.messages.map(message => (
                  <div key={message.id} className={`boss-message ${message.direction}`}>
                    <span>{message.direction === 'inbound' ? selected.recruiter.slice(0, 1) : '我'}</span>
                    <div><p>{message.content}</p><small>{message.timeLabel || (message.timeUnknown ? '历史消息' : formatDate(message.sentAt))}</small></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>

        <aside className="reply-copilot">
          {!selected ? (
            <EmptyPanel icon={Bot} title="AI 回复副驾" text="选择会话后生成回复草稿。" />
          ) : (
            <>
              <header>
                <div><Bot size={16} /><strong>AI 回复副驾</strong></div>
                <div className="reply-header-actions">
                  <button className={selected.status === 'ended' ? 'ended-toggle' : ''} onClick={() => toggleConversationEnded(selected.id)}>
                    {selected.status === 'ended' ? <Play size={13} /> : <Check size={13} />}
                    {selected.status === 'ended' ? '恢复会话' : '结束跟进'}
                  </button>
                  {selected.status !== 'ended' && (
                    <button className={selected.aiPaused ? 'paused' : ''} onClick={() => toggleConversationAi(selected.id)}>
                      {selected.aiPaused ? <Play size={13} /> : <Pause size={13} />}
                      {selected.aiPaused ? '恢复' : '暂停'}
                    </button>
                  )}
                </div>
              </header>
              <div className="intent-summary">
                <span>识别意图</span>
                <strong>{chatIntentLabel(selected.intent)}</strong>
                {selected.draftRequiresReview && <em><ShieldCheck size={12} />需人工确认</em>}
              </div>
              {(selected.resumeRequestPending || selected.resumeProactiveSendPending) && selected.status !== 'ended' && (
                <div className="resume-request-note">
                  <FileText size={16} />
                  <div>
                    <strong>招聘者正在索要附件简历</strong>
                    <span>{selected.resumeProactiveSendPending
                      ? (state.config.automation.resumeSendMode === 'auto' ? '已进入主动发送队列，将通过 BOSS 的“发简历”入口操作。' : state.config.automation.resumeSendMode === 'review_each' ? '确认后将通过 BOSS 的“发简历”入口操作。' : '当前策略设置为不发送。')
                      : (state.config.automation.resumeSendMode === 'auto' ? '已进入自动发送队列，只会发送 BOSS 中的附件简历。' : state.config.automation.resumeSendMode === 'review_each' ? '确认后只会发送 BOSS 中的附件简历。' : '当前策略设置为不发送。')}</span>
                  </div>
                  {state.config.automation.resumeSendMode !== 'off' && (
                    <button className="primary" disabled={busy === `resume-send-${selected.id}`} onClick={() => void sendConversationResume(selected.id, false)}>
                      <Send size={14} />{busy === `resume-send-${selected.id}` ? '发送中' : '发送附件简历'}
                    </button>
                  )}
                </div>
              )}
              {selected.resumeProactiveRequestedAt && !selected.resumeSentAt && !selected.resumeProactiveSendPending && (
                <div className="resume-request-note"><Clock3 size={16} /><div><strong>附件简历发送请求已发出</strong><span>正在等待招聘者同意；同意后 BOSS 会自动发送附件简历。</span></div></div>
              )}
              {selected.resumeSentAt && !selected.resumeRequestPending && (
                <div className="resume-sent-note"><Check size={14} />附件简历已发送</div>
              )}
              {selected.status === 'ended' ? (
                <div className="conversation-ended-note">
                  <ShieldCheck size={15} />
                  <div><strong>已结束 · 不再跟进</strong><span>{selected.endReason || '该会话已标记结束，AI 不会继续生成或跟进。'}</span></div>
                </div>
              ) : selected.aiPaused && (
                <div className="ai-paused-note">
                  <CircleAlert size={14} />
                  <span>{selected.pauseReason || '该会话的 AI 已暂停'} 仍可手动编辑草稿并填入 BOSS。</span>
                </div>
              )}
              <label className="reply-draft">
                <span>{selected.aiPaused && selected.status !== 'ended' ? '手动草稿' : '回复草稿'}</span>
                <textarea
                  value={selected.draftReply || ''}
                  disabled={selected.status === 'ended'}
                  onChange={event => editConversationDraft(selected.id, event.target.value)}
                  placeholder={selected.aiPaused
                    ? 'AI 已暂停，请在这里手动输入回复。'
                    : selected.messages.length === 0
                      ? linkedJob ? '点击“生成招呼语”，或在这里手动输入。' : '关联对应岗位后可生成匹配的招呼语，也可以手动输入。'
                      : '同步到新消息后，AI 草稿会显示在这里。'}
                />
              </label>
              <div className="reply-actions">
                <button disabled={selected.status === 'ended' || selected.aiPaused || busy === `chat-draft-${selected.id}`} onClick={() => void (selected.messages.length === 0 ? draftConversationGreeting(selected) : draftConversationReply(selected))}>
                  <WandSparkles size={14} />{selected.draftReply ? '重新生成' : selected.messages.length === 0 ? '生成招呼语' : '生成草稿'}
                </button>
                <button className="primary" disabled={selected.status === 'ended' || !selected.draftReply || busy === `chat-open-${selected.id}`} onClick={() => void openBossConversation(selected, true)}>
                  <ExternalLink size={14} />填入 BOSS
                </button>
                <button className="primary send-now" disabled={selected.status === 'ended' || !selected.draftReply || busy === `chat-send-${selected.id}`} onClick={() => void sendConversationReply(selected.id, selected.draftKind === 'followup' ? 'followup' : 'chat_reply', false)}>
                  <Send size={14} />确认发送
                </button>
              </div>
              <p className="reply-safety">“填入 BOSS”只写入输入框；“确认发送”会立即发送。自动模式只发送未命中人工确认清单的原始 AI 草稿，手动编辑后必须再次确认。</p>
            </>
          )}
        </aside>
      </div>
    </section>
  )
}

function InterviewsView({ state, selectedJob, setSelectedJobId, busy, generateInterviewGuide, deleteInterview, askInterviewAssistant, clearInterviewAssistant, fetchInterviewInvitations }: {
  state: AppState
  selectedJob?: JobRecord
  setSelectedJobId(id: string): void
  busy: string
  generateInterviewGuide(job: JobRecord): Promise<void>
  deleteInterview(jobId: string): void
  askInterviewAssistant(jobId: string, question: string): Promise<void>
  clearInterviewAssistant(jobId: string): void
  fetchInterviewInvitations(): Promise<void>
}) {
  const [assistantDrafts, setAssistantDrafts] = useState<Record<string, string>>({})
  const [assistantCollapsed, setAssistantCollapsed] = useState(false)
  const assistantMessagesRef = useRef<HTMLDivElement>(null)
  const eligible = state.jobs
    .filter(job => job.status === 'interview')
    .sort((a, b) => {
      const statusDelta = Number(b.status === 'interview') - Number(a.status === 'interview')
      if (statusDelta) return statusDelta
      return new Date(b.interviewInvitation?.receivedAt || b.lastContactAt || b.capturedAt).getTime()
        - new Date(a.interviewInvitation?.receivedAt || a.lastContactAt || a.capturedAt).getTime()
    })
  const activeJob = eligible.find(job => job.id === selectedJob?.id) || eligible[0]
  const modeLabel = { onsite: '线下面试', video: '视频面试', phone: '电话沟通', unknown: '方式待确认' }
  const assistantMessages = activeJob?.interviewAssistantMessages || []
  const assistantBusy = Boolean(activeJob && busy === `interview-assistant-${activeJob.id}`)
  const interviewScanBusy = busy === 'interview-scan'
  const assistantDraft = activeJob ? assistantDrafts[activeJob.id] || '' : ''
  const assistantSuggestions = [
    '帮我准备一段 1 分钟自我介绍',
    '这个岗位最可能追问我的哪些短板？',
    '根据 JD 帮我模拟一个追问',
    '我应该反问面试官什么？'
  ]
  useEffect(() => {
    const container = assistantMessagesRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [activeJob?.id, assistantMessages.length, assistantBusy])

  async function submitAssistantQuestion(question = assistantDraft) {
    if (!activeJob || !question.trim() || assistantBusy || busy) return
    setAssistantDrafts(current => ({ ...current, [activeJob.id]: '' }))
    await askInterviewAssistant(activeJob.id, question)
  }
  return (
    <section className="page-content interview-page">
      <PageHeading eyebrow="Interview" title="面试作战室" description="基于实际 JD、简历主张和沟通上下文生成，不编造经历。" />
      <div className="interview-scan-bar">
        <span>最近会话邀约</span>
        <button disabled={Boolean(busy)} onClick={() => void fetchInterviewInvitations()} title="逐个读取最近 BOSS 会话并识别面试邀约">
          {interviewScanBusy ? <RefreshCw size={15} className="spin" /> : <Inbox size={15} />}
          {interviewScanBusy ? '正在获取' : '获取面试邀约'}
        </button>
      </div>
      <div className="interview-grid">
        <aside className="interview-list">
          {eligible.length === 0 ? <EmptyPanel icon={BriefcaseBusiness} title="还没有面试流程" text="检测到面试邀请后会自动进入这里；普通岗位可在岗位雷达卡片上手动生成指南。" /> : eligible.map(job => (
            <button key={job.id} className={activeJob?.id === job.id ? 'active' : ''} onClick={() => setSelectedJobId(job.id)}>
              <span>{job.company}{job.interviewInvitation ? ' · 已收到邀约' : ''}</span><strong>{job.title}</strong><ChevronRight size={16} />
            </button>
          ))}
        </aside>
        <article className="guide-panel">
          {!activeJob ? (
            <EmptyPanel icon={FileText} title="选择一个岗位" text="面试指南会显示在这里。" />
          ) : (
            <div className="interview-detail">
              {activeJob.interviewInvitation && <div className="invitation-card">
                <div className="invitation-card-head"><span>招聘者邀约</span><strong>{formatDate(activeJob.interviewInvitation.receivedAt)}</strong></div>
                <p>{activeJob.interviewInvitation.message}</p>
                <div className="invitation-meta">
                  <span><Clock3 size={14} />{activeJob.interviewInvitation.scheduleText || '时间待确认'}</span>
                  <span><MessageCircleMore size={14} />{modeLabel[activeJob.interviewInvitation.mode]}</span>
                  <span><MapPin size={14} />{activeJob.interviewInvitation.location || '地点待确认'}</span>
                </div>
              </div>}
              <div className="guide-toolbar">
                <div><strong>{activeJob.company} · {activeJob.title}</strong><span>{activeJob.interviewGuideGeneratedAt ? `指南生成于 ${formatDate(activeJob.interviewGuideGeneratedAt)}` : '面试准备'}</span></div>
                <div className="guide-toolbar-actions">
                  <button title="删除面试准备" onClick={() => deleteInterview(activeJob.id)}><Trash2 size={14} />删除</button>
                  <button disabled={Boolean(busy)} onClick={() => generateInterviewGuide(activeJob)}>{activeJob.interviewGuide ? <RefreshCw size={14} /> : <Sparkles size={14} />}{activeJob.interviewGuide ? '重新生成指南' : '生成面试指南'}</button>
                </div>
              </div>
              <div className="interview-guide-layout">
                <section className="interview-guide-section">
                  {activeJob.interviewGuide ? (
                    <div className="guide-markdown"><ReactMarkdown>{activeJob.interviewGuide}</ReactMarkdown></div>
                  ) : (
                    <div className="guide-empty">
                      <div className="guide-badge"><FileText size={22} /></div>
                      <span>{activeJob.company}</span>
                      <h2>{activeJob.title}</h2>
                      <p>{activeJob.interviewGuideError || '生成后会在这里展示结合岗位、邀约、聊天与个人资料的完整面试指南。'}</p>
                      <button disabled={Boolean(busy)} onClick={() => generateInterviewGuide(activeJob)}>
                        <Sparkles size={16} />{activeJob.interviewGuideError ? '重新生成' : '生成面试指南'}
                      </button>
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}
        </article>
      </div>
      {activeJob && (assistantCollapsed ? (
        <button className="interview-assistant-launcher" onClick={() => setAssistantCollapsed(false)} title="打开 AI 面试助手" aria-label="打开 AI 面试助手">
          <Bot size={23} />
        </button>
      ) : (
        <aside className="interview-assistant-float">
          <header>
            <div><span className="interview-assistant-icon"><Bot size={17} /></span><div><strong>AI 面试助手</strong><small>{activeJob.company} · {activeJob.title}</small></div></div>
            <div className="interview-assistant-header-actions">
              <button disabled={!assistantMessages.length || assistantBusy} onClick={() => clearInterviewAssistant(activeJob.id)} title="清空当前岗位对话"><Trash2 size={14} />清空</button>
              <button className="assistant-collapse-button" onClick={() => setAssistantCollapsed(true)} title="收起 AI 面试助手" aria-label="收起 AI 面试助手"><Minimize2 size={15} /></button>
            </div>
          </header>
          <div className="interview-assistant-messages" ref={assistantMessagesRef}>
            {assistantMessages.length === 0 && (
              <div className="interview-assistant-empty">
                <MessageCircleMore size={25} />
                <strong>针对这场面试继续追问</strong>
                <p>我会结合当前 JD、面试指南、招聘沟通和你的知识库回答。切换岗位后不会串话。</p>
              </div>
            )}
            {assistantMessages.map(message => (
              <div key={message.id} className={`interview-assistant-message ${message.role}`}>
                <span>{message.role === 'user' ? '你' : 'AI'}</span>
                <div>{message.role === 'assistant'
                  ? message.content
                    ? <div className="chat-markdown"><ReactMarkdown>{visibleChatContent(message.content)}</ReactMarkdown></div>
                    : <p className="interview-assistant-streaming">正在组织回答<span>...</span></p>
                  : <p>{message.content}</p>}</div>
              </div>
            ))}
            {assistantBusy && !assistantMessages.some(message => message.role === 'assistant' && !message.content) && <div className="chat-thinking"><span /><span /><span /></div>}
          </div>
          <div className="interview-assistant-suggestions">
            {assistantSuggestions.map(suggestion => <button key={suggestion} disabled={Boolean(busy)} onClick={() => void submitAssistantQuestion(suggestion)}>{suggestion}</button>)}
          </div>
          <form className="interview-assistant-composer" onSubmit={event => { event.preventDefault(); void submitAssistantQuestion() }}>
            <textarea
              value={assistantDraft}
              onChange={event => setAssistantDrafts(current => ({ ...current, [activeJob.id]: event.target.value }))}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submitAssistantQuestion()
                }
              }}
              placeholder={state.config.model.apiKeyConfigured ? '问这场面试中的具体问题…' : '请先在设置中配置模型'}
              disabled={!state.config.model.apiKeyConfigured || assistantBusy}
            />
            <button disabled={!assistantDraft.trim() || Boolean(busy)} title="发送给 AI 面试助手"><Send size={16} /></button>
          </form>
          <p className="interview-assistant-note">仅用于面试准备，不会发送给招聘者。</p>
        </aside>
      ))}
    </section>
  )
}

function ResumeDiagnosisView({ state, busy, selectedResumeFile, selectResume, diagnoseResume }: {
  state: AppState
  busy: string
  selectedResumeFile: ResumeFile | null
  selectResume(): Promise<ResumeFile | null>
  diagnoseResume(sourceId?: ResumeSourceId): Promise<void>
}) {
  const [sourceId, setSourceId] = useState<ResumeSourceId>('upload')
  const diagnosis = state.resumeDiagnosis
  const analyzing = busy === 'resume-diagnosis'
  const sources = resumeSourceOptions(state)
  const selectedSource = sources.find(source => source.id === sourceId)
  const resumeName = selectedSource?.label || selectedResumeFile?.name || diagnosis?.name || state.profile.resumePath.split(/[\\/]/).pop() || '尚未选择简历'
  const priorityLabel: Record<ResumeDiagnosisPriority, string> = { high: '优先修改', medium: '建议优化', low: '可选优化' }
  async function chooseUpload() {
    const file = await selectResume()
    if (file) setSourceId('upload')
  }
  return (
    <section className="page-content resume-diagnosis-page">
      <PageHeading eyebrow="Resume Review" title="简历诊断" description="围绕当前目标岗位检查简历的匹配度、表达清晰度和投递风险。" />
      <div className="resume-diagnosis-toolbar">
        <div className="resume-file-chip">
          <FileText size={20} />
          <div><strong>{resumeName}</strong><span>{diagnosis ? `上次诊断：${formatDate(diagnosis.analyzedAt)}` : '选择 PDF、DOCX 或文本简历'}</span></div>
        </div>
        <div className="resume-diagnosis-actions">
          <select className="resume-source-select" value={sourceId} onChange={event => setSourceId(event.target.value)}>
            <option value="upload">本地上传文件</option>
            {sources.map(source => <option value={source.id} key={source.id}>知识库：{source.label}</option>)}
          </select>
          <button onClick={() => void chooseUpload()} disabled={analyzing}><Upload size={15} />选择文件</button>
          <button className="primary" onClick={() => void diagnoseResume(sourceId)} disabled={analyzing}><Sparkles size={15} />{analyzing ? '诊断中...' : '开始诊断'}</button>
        </div>
      </div>
      <div className="resume-target-strip">
        <Target size={15} />
        <span>当前目标</span>
        <strong>{state.config.target.keywords.join(' / ')}</strong>
        <em>{state.config.target.city}</em>
        <em>{state.config.target.salaryMinK}-{state.config.target.salaryMaxK}K</em>
        <span className="resume-target-hint">诊断结果会随目标设置变化</span>
      </div>
      <div className="resume-privacy-note"><ShieldCheck size={14} /><span>点击诊断后，简历文本会发送到“模型与 RAG”中配置的模型接口；不会发送到 BOSS，也不会自动修改原文件。</span></div>
      {!diagnosis ? (
        <div className="resume-diagnosis-empty">
          <div className="resume-empty-icon"><FileText size={28} /></div>
          <h2>还没有诊断结果</h2>
          <p>先选择你准备投递的版本，系统会按当前求职目标给出优先级明确的修改意见。</p>
          <button className="primary" onClick={() => void diagnoseResume(sourceId)} disabled={analyzing}><Sparkles size={16} />开始诊断</button>
        </div>
      ) : (
        <div className="resume-diagnosis-report">
          <div className="resume-diagnosis-overview">
            <div className="resume-score-ring"><strong>{diagnosis.score}</strong><span>/ 100</span></div>
            <div className="resume-overview-copy"><span className="report-eyebrow">诊断结论</span><h2>{diagnosis.verdict}</h2><p>{diagnosis.summary || '这份简历已经完成结构化诊断。'}</p></div>
            <div className="resume-overview-meta"><span>覆盖关键词<strong>{diagnosis.matchedKeywords.length}</strong></span><span>待补关键词<strong>{diagnosis.missingKeywords.length}</strong></span></div>
          </div>
          <div className="resume-diagnosis-grid">
            <section className="diagnosis-section diagnosis-priority">
              <div className="diagnosis-section-heading"><div><span className="report-eyebrow">Action Plan</span><h3>优先修改项</h3></div><span>{diagnosis.recommendations.length} 项</span></div>
              <div className="diagnosis-recommendations">
                {diagnosis.recommendations.length ? diagnosis.recommendations.map((item, index) => (
                  <article className="diagnosis-recommendation" key={`${item.title}-${index}`}>
                    <div className={`priority-mark priority-${item.priority}`}>{index + 1}</div>
                    <div>
                      <div className="recommendation-title"><strong>{item.title}</strong><span className={`priority-label priority-label-${item.priority}`}>{priorityLabel[item.priority]}</span></div>
                      {item.location && <small className="recommendation-location">定位：{item.location}</small>}
                      <p>{item.detail}</p>
                      {item.currentText && <div className="recommendation-current"><span>当前简历</span><blockquote>{item.currentText}</blockquote></div>}
                      {item.example && <div className="recommendation-example"><span>改写参考</span>{item.example}</div>}
                    </div>
                  </article>
                )) : <p className="diagnosis-muted">模型没有返回具体修改项，可重新诊断一次。</p>}
              </div>
            </section>
            <section className="diagnosis-section">
              <div className="diagnosis-section-heading"><div><span className="report-eyebrow">Evidence</span><h3>诊断依据</h3></div></div>
              <div className="diagnosis-columns">
                <div><h4><Check size={15} />可保留的亮点</h4>{diagnosis.strengths.length ? <ul>{diagnosis.strengths.map(item => <li key={item}>{item}</li>)}</ul> : <p className="diagnosis-muted">暂无明确亮点</p>}</div>
                <div><h4><CircleAlert size={15} />需要留意的风险</h4>{diagnosis.risks.length ? <ul>{diagnosis.risks.map(item => <li key={item}>{item}</li>)}</ul> : <p className="diagnosis-muted">暂未识别明显风险</p>}</div>
              </div>
            </section>
            <section className="diagnosis-section diagnosis-keywords">
              <div className="diagnosis-section-heading"><div><span className="report-eyebrow">Keywords</span><h3>岗位关键词覆盖</h3></div></div>
              <div className="keyword-groups"><div><span>已覆盖</span><div className="keyword-list">{diagnosis.matchedKeywords.length ? diagnosis.matchedKeywords.map(item => <em className="keyword-hit" key={item}>{item}</em>) : <small>暂无</small>}</div></div><div><span>建议补充</span><div className="keyword-list">{diagnosis.missingKeywords.length ? diagnosis.missingKeywords.map(item => <em className="keyword-miss" key={item}>{item}</em>) : <small>暂无</small>}</div></div></div>
            </section>
          </div>
        </div>
      )}
    </section>
  )
}

function ProfileView({ state, busy, selectResume, generateProfile, updateProfile }: {
  state: AppState
  busy: string
  selectResume(): Promise<ResumeFile | null>
  generateProfile(sourceId?: ResumeSourceId): Promise<void>
  updateProfile(mutator: (profile: CandidateProfile) => void): void
}) {
  const [sourceId, setSourceId] = useState<ResumeSourceId>('upload')
  const profile = state.profile
  const sources = resumeSourceOptions(state)
  const generating = busy === 'profile-generation'
  async function chooseUpload() {
    const file = await selectResume()
    if (file) setSourceId('upload')
  }
  return (
    <section className="page-content profile-page">
      <PageHeading eyebrow="Candidate" title="候选人画像" description="从知识库简历或本地文件生成；生成结果可以继续编辑，后续招呼、回复和面试准备都会使用这里的内容。" />
      <div className="profile-source-toolbar">
        <div>
          <FileText size={18} />
          <select value={sourceId} onChange={event => setSourceId(event.target.value)}>
            <option value="upload">本地上传文件</option>
            {sources.map(source => <option value={source.id} key={source.id}>知识库：{source.label}</option>)}
          </select>
          <button onClick={() => void chooseUpload()} disabled={generating}><Upload size={15} />选择文件</button>
        </div>
        <button className="primary" onClick={() => void generateProfile(sourceId)} disabled={generating}><Sparkles size={15} />{generating ? '生成中...' : '生成画像'}</button>
      </div>
      <div className="profile-hero">
        <div className="profile-monogram">{profile.name.trim().slice(0, 1) || '我'}</div>
        <div><span>{profile.headline}</span><h2>{profile.name}</h2><p>{profile.summary}</p></div>
        <div className="profile-facts"><span><strong>{profile.yearsExperience}</strong>年经验</span><span><strong>{profile.targetRole || '未设置'}</strong>目标岗位</span><span><strong>{profile.targetCity || '未设置'}</strong>目标城市</span></div>
      </div>
      <div className="profile-editor">
        <label><span>姓名</span><input value={profile.name} onChange={event => updateProfile(next => { next.name = event.target.value })} /></label>
        <label className="profile-editor-wide"><span>职业定位</span><input value={profile.headline} onChange={event => updateProfile(next => { next.headline = event.target.value })} /></label>
        <label><span>工作年限</span><input type="number" min="0" value={profile.yearsExperience} onChange={event => updateProfile(next => { next.yearsExperience = Number(event.target.value) })} /></label>
        <label><span>目标岗位</span><input value={profile.targetRole} onChange={event => updateProfile(next => { next.targetRole = event.target.value })} /></label>
        <label><span>目标城市</span><input value={profile.targetCity} onChange={event => updateProfile(next => { next.targetCity = event.target.value })} /></label>
        <label className="profile-editor-full"><span>职业概述</span><textarea value={profile.summary} onChange={event => updateProfile(next => { next.summary = event.target.value })} /></label>
        <ProfileListEditor label="核心能力" items={profile.strengths} onCommit={items => updateProfile(next => { next.strengths = items })} />
        <ProfileListEditor label="技能关键词" items={profile.skills} onCommit={items => updateProfile(next => { next.skills = items })} />
        <ProfileListEditor label="代表业绩" items={profile.achievements} onCommit={items => updateProfile(next => { next.achievements = items })} />
        <ProfileListEditor label="经历摘要" items={profile.experienceHighlights} onCommit={items => updateProfile(next => { next.experienceHighlights = items })} />
      </div>
      <div className="resume-source"><FileText size={16} /><span>简历来源</span><code>{profile.resumePath}</code></div>
    </section>
  )
}

function ProfileListEditor({ label, items, onCommit }: { label: string; items: string[]; onCommit(items: string[]): void }) {
  const serialized = items.join('\n')
  const [draft, setDraft] = useState(serialized)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(serialized)
  }, [serialized])
  function commit() {
    focused.current = false
    const values = draft.split(/\n+/).map(item => item.trim()).filter(Boolean)
    setDraft(values.join('\n'))
    onCommit(values)
  }
  return (
    <label className="profile-list-editor">
      <span>{label}<small>每行一项</small></span>
      <textarea value={draft} onFocus={() => { focused.current = true }} onChange={event => setDraft(event.target.value)} onBlur={commit} />
    </label>
  )
}

function KnowledgeView({ state, updateState, replaceState, showToast, busy, setBusy }: {
  state: AppState
  updateState(mutator: (state: AppState) => void): void
  replaceState(state: AppState): void
  showToast(type: Toast['type'], message: string): void
  busy: string
  setBusy(value: string): void
}) {
  const [question, setQuestion] = useState('')
  const [qaEditor, setQaEditor] = useState<{ id?: string; category: string; question: string; answer: string } | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [state.knowledgeChat])
  useEffect(() => {
    if (!qaEditor) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy !== 'knowledge-qa-save') setQaEditor(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [qaEditor, busy])

  async function importFiles() {
    setBusy('knowledge-import')
    try {
      const next = await window.jobpilot.importKnowledge()
      replaceState(next)
      showToast('success', '知识库文档已导入并切片')
    } catch (error) {
      showToast('error', String(error))
    } finally { setBusy('') }
  }

  async function deleteDocument(documentId: string) {
    try {
      const next = await window.jobpilot.deleteKnowledge(documentId)
      replaceState(next)
      showToast('success', '文档已从知识库移除')
    } catch (error) { showToast('error', String(error)) }
  }

  async function rebuild() {
    setBusy('knowledge-rebuild')
    try {
      const next = await window.jobpilot.rebuildEmbeddings()
      replaceState(next)
      showToast('success', '向量索引已重建')
    } catch (error) { showToast('error', String(error)) }
    finally { setBusy('') }
  }

  async function retryDocument(documentId: string) {
    setBusy(`knowledge-retry-${documentId}`)
    try {
      const next = await window.jobpilot.retryKnowledge(documentId)
      replaceState(next)
      const document = next.knowledgeDocuments.find(item => item.id === documentId)
      showToast(document?.status === 'ready' ? 'success' : 'error', document?.status === 'ready' ? '文档已恢复，可用于检索' : document?.error || '重试失败')
    } catch (error) { showToast('error', String(error)) }
    finally { setBusy('') }
  }

  function openQaEditor(documentId?: string) {
    const existing = documentId ? state.knowledgeQas.find(item => item.documentId === documentId) : undefined
    setQaEditor(existing
      ? { id: existing.id, category: existing.category, question: existing.question, answer: existing.answer }
      : { category: '求职状态', question: '', answer: '' })
  }

  async function saveQa() {
    if (!qaEditor?.question.trim() || !qaEditor.answer.trim()) return
    setBusy('knowledge-qa-save')
    try {
      const next = await window.jobpilot.upsertKnowledgeQa(qaEditor)
      replaceState(next)
      setQaEditor(null)
      showToast('success', qaEditor.id ? '问答口径已更新' : '问答口径已加入知识库')
    } catch (error) { showToast('error', String(error)) }
    finally { setBusy('') }
  }

  async function ask() {
    const content = question.trim()
    if (!content) return
    if (!state.config.model.apiKeyConfigured) {
      showToast('error', '知识库问答需要先配置模型 API Key')
      return
    }
    const userMessage = { id: `${Date.now()}-u`, role: 'user' as const, content, createdAt: new Date().toISOString() }
    updateState(next => { next.knowledgeChat.push(userMessage) })
    setQuestion('')
    setBusy('knowledge-chat')
    try {
      const history = [...state.knowledgeChat, userMessage].map(item => ({ role: item.role, content: item.content }))
      const response = await window.jobpilot.ragChat(content, history)
      updateState(next => {
        next.knowledgeChat.push({
          id: `${Date.now()}-a`, role: 'assistant', content: response.content,
          sources: response.sources, createdAt: new Date().toISOString()
        })
      })
    } catch (error) { showToast('error', String(error)) }
    finally { setBusy('') }
  }

  const fileCount = state.knowledgeDocuments.filter(document => document.type !== 'qa').length

  return (
    <>
    <section className="page-content knowledge-page">
      <PageHeading eyebrow="Local RAG" title="求职知识库" description="简历、项目补充和问答口径在本地切片落库；模型只读取检索命中的小段资料。" />
      <div className="knowledge-grid">
        <aside className="knowledge-sources">
          <div className="source-actions">
            <button className="primary" onClick={() => openQaEditor()}><Plus size={15} />添加问答</button>
            <button disabled={busy === 'knowledge-import'} onClick={importFiles}><Upload size={15} />导入资料</button>
            <button title="重建全部向量" aria-label="重建全部向量" disabled={busy === 'knowledge-rebuild'} onClick={rebuild}><RotateCcw size={15} /></button>
          </div>
          <div className="rag-metrics">
            <span><strong>{fileCount}</strong>份文件</span>
            <span><strong>{state.knowledgeQas.length}</strong>组问答</span>
            <span><strong>{state.knowledgeChunks.length}</strong>个切片</span>
          </div>
          <div className="source-list">
            {state.knowledgeDocuments.map(document => (
              <div className="source-item" key={document.id}>
                {document.type === 'qa' ? <CircleHelp size={16} /> : <FileText size={16} />}
                <div><strong>{document.name}</strong><span>{document.type === 'qa' ? '手动问答' : `${document.chunkCount} 个切片`} · {document.status === 'ready' ? (document.warning ? '关键词检索' : '可检索') : document.status === 'embedding' ? '处理中' : '失败'}</span>{document.warning && <small className="source-warning">{document.warning}</small>}{document.error && <small>{document.error}</small>}</div>
                <div className="source-item-actions">
                  {document.status === 'error' && <button title="重新解析" disabled={busy === `knowledge-retry-${document.id}`} onClick={() => retryDocument(document.id)}><RotateCcw size={14} /></button>}
                  {document.type === 'qa' && <button title="编辑问答" onClick={() => openQaEditor(document.id)}><Pencil size={14} /></button>}
                  {document.id !== 'structured-resume' && <button title={document.type === 'qa' ? '移除问答' : '移除文档'} onClick={() => deleteDocument(document.id)}><Trash2 size={14} /></button>}
                </div>
              </div>
            ))}
          </div>
          <div className="rag-policy"><ShieldCheck size={15} /><span>文件原文、切片与向量均保存在客户端本地数据目录。</span></div>
        </aside>
        <div className="knowledge-chat">
          <div className="chat-header"><div><Bot size={17} /><span>我的求职知识问答</span></div><small>Top {state.config.rag.topK} 混合检索</small></div>
          <div className="chat-messages">
            {state.knowledgeChat.length === 0 && (
              <div className="chat-empty"><LibraryBig size={28} /><strong>用知识库校准求职表达</strong><p>可以问：我的 AI 产品优势是什么？如何回答离职原因？针对某个 JD 应该强调哪些项目？</p></div>
            )}
            {state.knowledgeChat.map(message => (
              <div key={message.id} className={`chat-message ${message.role}`}>
                <span>{message.role === 'user' ? '你' : 'AI'}</span>
                <div>{message.role === 'assistant'
                  ? <div className="chat-markdown"><ReactMarkdown>{visibleChatContent(message.content)}</ReactMarkdown></div>
                  : <p>{message.content}</p>}
                </div>
              </div>
            ))}
            {busy === 'knowledge-chat' && <div className="chat-thinking"><span /><span /><span /></div>}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-composer" onSubmit={event => { event.preventDefault(); void ask() }}>
            <textarea
              value={question}
              onChange={event => setQuestion(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void ask()
                }
              }}
              placeholder="询问经历、项目、面试口径或岗位匹配..."
            />
            <button disabled={!question.trim() || busy === 'knowledge-chat'}><Send size={16} /></button>
          </form>
        </div>
      </div>
    </section>
    {qaEditor && (
      <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && busy !== 'knowledge-qa-save') setQaEditor(null) }}>
        <div className="qa-editor" role="dialog" aria-modal="true" aria-labelledby="qa-editor-title">
          <div className="qa-editor-header">
            <div><CircleHelp size={18} /><div><h2 id="qa-editor-title">{qaEditor.id ? '编辑问答口径' : '添加问答口径'}</h2><p>该回答会参与 HR 回复与面试准备的知识检索。</p></div></div>
            <button title="关闭" aria-label="关闭" disabled={busy === 'knowledge-qa-save'} onClick={() => setQaEditor(null)}><X size={17} /></button>
          </div>
          {!qaEditor.id && (
            <div className="qa-suggestions">
              {qaSuggestions.map(item => <button key={item.category} onClick={() => setQaEditor(current => current ? { ...current, ...item } : current)}>{item.category}</button>)}
            </div>
          )}
          <div className="qa-editor-fields">
            <label><span>分类</span><select value={qaEditor.category} onChange={event => setQaEditor({ ...qaEditor, category: event.target.value })}><option>求职状态</option><option>薪资期望</option><option>到岗时间</option><option>工作地点</option><option>离职原因</option><option>项目经历</option><option>其他</option></select></label>
            <label><span>HR 可能提出的问题</span><textarea className="qa-question" autoFocus value={qaEditor.question} onChange={event => setQaEditor({ ...qaEditor, question: event.target.value })} placeholder="例如：你目前是否已经离职？" /></label>
            <label><span>你的标准回答</span><textarea className="qa-answer" value={qaEditor.answer} onChange={event => setQaEditor({ ...qaEditor, answer: event.target.value })} placeholder="填写准确、可直接用于沟通的事实口径" /></label>
          </div>
          <div className="qa-editor-footer">
            <span>{qaEditor.answer.length} 字</span>
            <button disabled={busy === 'knowledge-qa-save'} onClick={() => setQaEditor(null)}>取消</button>
            <button className="primary" disabled={!qaEditor.question.trim() || !qaEditor.answer.trim() || busy === 'knowledge-qa-save'} onClick={() => void saveQa()}><Check size={15} />{busy === 'knowledge-qa-save' ? '保存中' : '保存到知识库'}</button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

function SettingsView({ state, updateState, showToast }: {
  state: AppState
  updateState(mutator: (state: AppState) => void): void
  showToast(type: Toast['type'], message: string): void
}) {
  const [apiKey, setApiKey] = useState('')
  const [embeddingApiKey, setEmbeddingApiKey] = useState('')
  const [embeddingTest, setEmbeddingTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [settingsTab, setSettingsTab] = useState<'target' | 'automation' | 'ai' | 'browser' | 'notifications' | 'data'>('target')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [notificationTest, setNotificationTest] = useState('')
  const [migrationBusy, setMigrationBusy] = useState<'export' | 'import' | ''>('')
  const [migrationStatus, setMigrationStatus] = useState('')
  function refreshDraftReviewFlags(next: AppState) {
    next.bossConversations.forEach(conversation => {
      if (!conversation.draftReply || conversation.draftEditedManually) return
      const autoMode = conversation.draftKind === 'followup'
        ? next.config.automation.followupSendMode === 'auto_above_score'
        : next.config.automation.chatReplyMode === 'auto_safe'
      conversation.draftRequiresReview = !autoMode || next.config.automation.sensitiveChatIntents.includes(conversation.intent)
    })
  }
  async function saveApiKey() {
    if (!apiKey.trim()) return
    try {
      await window.jobpilot.saveModelApiKey(apiKey)
      updateState(next => { next.config.model.apiKeyConfigured = true })
      setApiKey('')
      showToast('success', 'API Key 已使用系统安全存储加密保存')
    } catch (error) {
      showToast('error', String(error))
    }
  }
  function applyEmbeddingProvider(provider: string) {
    updateState(next => {
      next.config.rag.embeddingProvider = provider
      if (provider === 'siliconflow') {
        next.config.rag.embeddingBaseUrl = 'https://api.siliconflow.cn/v1'
        next.config.rag.embeddingModel = 'BAAI/bge-m3'
        next.config.rag.embeddingDimensions = 1024
      } else if (provider === 'openai') {
        next.config.rag.embeddingBaseUrl = 'https://api.openai.com/v1'
        next.config.rag.embeddingModel = 'text-embedding-3-small'
        next.config.rag.embeddingDimensions = 1536
      }
    })
    setEmbeddingTest(null)
  }
  async function saveEmbeddingKey() {
    if (!embeddingApiKey.trim()) return
    try {
      await window.jobpilot.saveEmbeddingApiKey(embeddingApiKey)
      updateState(next => { next.config.rag.embeddingApiKeyConfigured = true })
      setEmbeddingApiKey('')
      setEmbeddingTest(null)
      showToast('success', '向量 API Key 已加密保存')
    } catch (error) { showToast('error', String(error)) }
  }
  async function testEmbedding() {
    setEmbeddingTest({ ok: true, message: '正在连接...' })
    try {
      const result = await window.jobpilot.testEmbedding()
      setEmbeddingTest({ ok: true, message: `连接成功 · ${result.model} · ${result.dimensions} 维 · ${result.latencyMs}ms` })
      showToast('success', '向量接口连接成功')
    } catch (error) {
      setEmbeddingTest({ ok: false, message: String(error).replace(/^Error:\s*/, '') })
      showToast('error', '向量接口连接失败')
    }
  }
  async function saveWebhook() {
    if (!webhookUrl.trim()) return
    try {
      await window.jobpilot.saveNotificationWebhook(webhookUrl)
      updateState(next => { next.config.notifications.webhookConfigured = true })
      setWebhookUrl('')
      showToast('success', 'Webhook 地址已加密保存')
    } catch (error) { showToast('error', String(error)) }
  }
  async function testWebhook() {
    setNotificationTest('发送中...')
    try {
      await window.jobpilot.testNotificationWebhook()
      setNotificationTest('测试消息已发送')
      showToast('success', 'Webhook 测试成功')
    } catch (error) {
      setNotificationTest(String(error).replace(/^Error:\s*/, ''))
      showToast('error', 'Webhook 测试失败')
    }
  }
  async function exportData() {
    setMigrationBusy('export')
    setMigrationStatus('')
    try {
      const result = await window.jobpilot.exportData()
      if (result.canceled) return
      const name = result.path?.split(/[\\/]/).at(-1) || 'JobPilot 数据备份'
      setMigrationStatus(`已导出：${name}`)
      showToast('success', '数据已导出，密钥和 BOSS 登录态未包含在文件中')
    } catch (error) {
      showToast('error', String(error).replace(/^Error:\s*/, ''))
    } finally {
      setMigrationBusy('')
    }
  }
  async function importData() {
    setMigrationBusy('import')
    setMigrationStatus('')
    try {
      const result = await window.jobpilot.importData()
      if (result.canceled || !result.state) return
      updateState(next => { Object.assign(next, structuredClone(result.state)) })
      const suffix = result.crossPlatform ? '；检测到跨系统迁移，请重新登录并配置密钥' : ''
      setMigrationStatus(`导入完成，原数据已自动备份${suffix}`)
      showToast('success', `数据导入完成${result.crossPlatform ? '，请重新登录 BOSS 并检查本机文件路径' : ''}`)
    } catch (error) {
      showToast('error', String(error).replace(/^Error:\s*/, ''))
    } finally {
      setMigrationBusy('')
    }
  }
  return (
    <section className="page-content settings-page">
      <PageHeading eyebrow="Preferences" title="自动化与模型设置" description="所有策略都可调整；高风险动作保留清晰的暂停与人工接管入口。" />
      <div className="settings-tabs">
        <button className={settingsTab === 'target' ? 'active' : ''} onClick={() => setSettingsTab('target')}><Target size={15} />求职目标</button>
        <button className={settingsTab === 'automation' ? 'active' : ''} onClick={() => setSettingsTab('automation')}><Send size={15} />发送与跟进</button>
        <button className={settingsTab === 'ai' ? 'active' : ''} onClick={() => setSettingsTab('ai')}><Bot size={15} />模型与 RAG</button>
        <button className={settingsTab === 'browser' ? 'active' : ''} onClick={() => setSettingsTab('browser')}><ExternalLink size={15} />浏览器</button>
        <button className={settingsTab === 'notifications' ? 'active' : ''} onClick={() => setSettingsTab('notifications')}><Bell size={15} />通知</button>
        <button className={settingsTab === 'data' ? 'active' : ''} onClick={() => setSettingsTab('data')}><Download size={15} />数据迁移</button>
      </div>
      {settingsTab === 'target' && <SettingsSection icon={Target} title="目标岗位" description="先做硬条件过滤，再进入 AI 匹配评分。">
        <Field label="岗位关键词"><DelimitedInput values={state.config.target.keywords} onCommit={values => updateState(next => { next.config.target.keywords = values })} /></Field>
        <Field label="目标城市"><input value={state.config.target.city} onChange={event => updateState(next => { next.config.target.city = event.target.value })} /></Field>
        <Field label="薪资范围"><div className="range-input"><input type="number" value={state.config.target.salaryMinK} onChange={event => updateState(next => { next.config.target.salaryMinK = Number(event.target.value) })} /><span>至</span><input type="number" value={state.config.target.salaryMaxK} onChange={event => updateState(next => { next.config.target.salaryMaxK = Number(event.target.value) })} /><span>K</span></div></Field>
        <Field label="启用通勤约束"><Toggle checked={state.config.target.locationConstraintEnabled} onChange={checked => updateState(next => { next.config.target.locationConstraintEnabled = checked })} /></Field>
        {state.config.target.locationConstraintEnabled && <>
          <Field label="优先通勤区域"><div><DelimitedInput values={state.config.target.preferredLocations} onCommit={values => updateState(next => { next.config.target.preferredLocations = values })} /><small>填写离家较近的区、商圈、道路或地铁站，例如：高新区，金融城，孵化园。</small></div></Field>
          <Field label="排除通勤区域"><div><DelimitedInput values={state.config.target.excludedLocations} onCommit={values => updateState(next => { next.config.target.excludedLocations = values })} /><small>匹配到这些区域的岗位不会自动发送，但会保留在“全部”候选视图并标注“已排除”。</small></div></Field>
          <Field label="地址未知禁止自动发送"><Toggle checked={state.config.target.requireKnownLocationForAutoSend} onChange={checked => updateState(next => { next.config.target.requireKnownLocationForAutoSend = checked })} /></Field>
        </>}
        <Field label="偏好关键词"><DelimitedInput values={state.config.target.preferredKeywords} onCommit={values => updateState(next => { next.config.target.preferredKeywords = values })} /></Field>
        <Field label="排除关键词"><DelimitedInput values={state.config.target.excludedKeywords} onCommit={values => updateState(next => { next.config.target.excludedKeywords = values })} /></Field>
      </SettingsSection>}

      {settingsTab === 'automation' && <><SettingsSection icon={Send} title="发送策略" description="自动发送只处理达到阈值且通过硬条件过滤的岗位。">
        <Field label="启用自动任务"><Toggle checked={state.config.automation.enabled} onChange={checked => updateState(next => { next.config.automation.enabled = checked })} /></Field>
        <Field label="启用定时采集"><Toggle checked={state.config.automation.collectionEnabled} onChange={checked => updateState(next => { next.config.automation.collectionEnabled = checked })} /></Field>
        <Field label="采集间隔"><div><NumberInput value={state.config.automation.collectionIntervalMinutes} suffix="分钟" onChange={value => updateState(next => { next.config.automation.collectionIntervalMinutes = Math.max(5, value) })} /><small>最短 5 分钟；最近执行：{state.lastCollectionAt ? formatDate(state.lastCollectionAt) : '尚未执行'}</small></div></Field>
        <Field label="首次招呼策略"><select value={state.config.automation.sendMode} onChange={event => updateState(next => { next.config.automation.sendMode = event.target.value as SendMode })}>{modeOptions()}</select></Field>
        <Field label="自动发送分数"><NumberInput value={state.config.automation.autoScoreThreshold} suffix="分" onChange={value => updateState(next => { next.config.automation.autoScoreThreshold = value })} /></Field>
        <Field label="每日发送上限"><NumberInput value={state.config.automation.dailyLimit} suffix="条" onChange={value => updateState(next => { next.config.automation.dailyLimit = value })} /></Field>
        <Field label="发送随机间隔"><div className="range-input"><NumberInput value={state.config.automation.intervalMinSeconds} onChange={value => updateState(next => { next.config.automation.intervalMinSeconds = value })} /><span>至</span><NumberInput value={state.config.automation.intervalMaxSeconds} suffix="秒" onChange={value => updateState(next => { next.config.automation.intervalMaxSeconds = value })} /></div></Field>
        <Field label="去重周期"><NumberInput value={state.config.automation.dedupeDays} suffix="天" onChange={value => updateState(next => { next.config.automation.dedupeDays = value })} /></Field>
        <Field label="执行时段"><div className="range-input"><input type="time" value={state.config.automation.workdayStart} onChange={event => updateState(next => { next.config.automation.workdayStart = event.target.value })} /><span>至</span><input type="time" value={state.config.automation.workdayEnd} onChange={event => updateState(next => { next.config.automation.workdayEnd = event.target.value })} /></div></Field>
      </SettingsSection>

      <SettingsSection icon={Clock3} title="跟进节奏" description="到期后生成草稿或进入自动发送队列，最多执行设定次数。">
        <Field label="启用自动跟进"><Toggle checked={state.config.automation.followupEnabled} onChange={checked => updateState(next => { next.config.automation.followupEnabled = checked })} /></Field>
        <Field label="跟进日期"><DelimitedInput values={state.config.automation.followupDays.map(String)} onCommit={values => updateState(next => { next.config.automation.followupDays = values.map(Number).filter(day => Number.isFinite(day) && day > 0) })} /><small>例如 3，7 表示首次发送后的第 3、7 天</small></Field>
        <Field label="最多跟进"><NumberInput value={state.config.automation.maxFollowups} suffix="次" onChange={value => updateState(next => { next.config.automation.maxFollowups = value })} /></Field>
        <Field label="跟进发送策略"><select value={state.config.automation.followupSendMode} onChange={event => updateState(next => { next.config.automation.followupSendMode = event.target.value as SendMode; refreshDraftReviewFlags(next) })}>{followupModeOptions()}</select></Field>
      </SettingsSection>

      <SettingsSection icon={MessageCircleMore} title="HR 对话策略" description="同步消息并生成第一人称回复。自动模式只处理非敏感、未被人工编辑的草稿。">
        <Field label="启用消息同步"><Toggle checked={state.config.automation.chatSyncEnabled} onChange={checked => updateState(next => { next.config.automation.chatSyncEnabled = checked })} /></Field>
        <Field label="回复策略"><select value={state.config.automation.chatReplyMode} onChange={event => updateState(next => { next.config.automation.chatReplyMode = event.target.value as ChatReplyMode; refreshDraftReviewFlags(next) })}><option value="draft_only">仅生成草稿</option><option value="review_each">逐条确认</option><option value="auto_safe">非敏感意图自动发送</option></select></Field>
        <Field label="附件简历策略"><div><select value={state.config.automation.resumeSendMode} onChange={event => updateState(next => { next.config.automation.resumeSendMode = event.target.value as ResumeSendMode })}><option value="off">不发送</option><option value="review_each">每次确认</option><option value="auto">检测到请求后自动发送</option></select><small>同时处理 BOSS 原生请求卡片和聊天文字索要；只选择未标记为作品集的附件简历。</small></div></Field>
        <Field label="轮询间隔"><NumberInput value={state.config.automation.chatPollingSeconds} suffix="秒" onChange={value => updateState(next => { next.config.automation.chatPollingSeconds = Math.max(15, value) })} /></Field>
        <Field label="手动回复后暂停"><Toggle checked={state.config.automation.manualTakeoverPause} onChange={checked => updateState(next => { next.config.automation.manualTakeoverPause = checked })} /></Field>
        <Field label="自动生成面试指南"><div><Toggle checked={state.config.automation.interviewAutoGuideEnabled} onChange={checked => updateState(next => { next.config.automation.interviewAutoGuideEnabled = checked })} /><small>检测到明确面试邀约后自动关联岗位并生成指南；面试时间回复仍遵循下方人工确认策略。</small></div></Field>
        <Field label="自动发送前必须确认"><div><div className="intent-checks">{sensitiveIntentOptions.map(option => <label key={option.value}><input type="checkbox" checked={state.config.automation.sensitiveChatIntents.includes(option.value)} onChange={event => updateState(next => { next.config.automation.sensitiveChatIntents = event.target.checked ? [...new Set([...next.config.automation.sensitiveChatIntents, option.value])] : next.config.automation.sensitiveChatIntents.filter(intent => intent !== option.value); refreshDraftReviewFlags(next) })} />{option.label}</label>)}</div><small>取消勾选后，该意图在“非敏感意图自动发送”模式下也可能直接发送。</small></div></Field>
        <div className="safety-callout"><ShieldCheck size={17} /><p><strong>自动发送边界</strong><span>验证码、风控页面、发送结果无法确认时立即暂停；客户端不会绕过验证。自动发送前会检查每日上限、随机间隔和执行时段。</span></p></div>
      </SettingsSection></>}

      {settingsTab === 'ai' && <><SettingsSection icon={Bot} title="对话模型" description="用于岗位评分、文案、问答和面试指南，走 OpenAI 兼容 chat/completions 接口。">
        <Field label="Base URL"><input value={state.config.model.baseUrl} onChange={event => updateState(next => { next.config.model.baseUrl = event.target.value })} /></Field>
        <Field label="模型名称"><input value={state.config.model.model} onChange={event => updateState(next => { next.config.model.model = event.target.value })} /></Field>
        <Field label="Temperature"><input type="number" min="0" max="2" step="0.1" value={state.config.model.temperature} onChange={event => updateState(next => { next.config.model.temperature = Number(event.target.value) })} /></Field>
        <Field label="请求超时（秒）"><input type="number" min="30" max="600" step="10" value={state.config.model.requestTimeoutSeconds} onChange={event => updateState(next => { next.config.model.requestTimeoutSeconds = Math.min(600, Math.max(30, Number(event.target.value) || 300)) })} /><small className="field-help">模型无响应时的最长等待时间，默认 300 秒。</small></Field>
        <Field label="API Key"><div className="secret-input"><input type="password" placeholder={state.config.model.apiKeyConfigured ? '已配置，输入新值可替换' : 'sk-...'} value={apiKey} onChange={event => setApiKey(event.target.value)} /><button onClick={saveApiKey}><KeyRound size={14} />保存</button></div></Field>
      </SettingsSection>

      <SettingsSection icon={Zap} title="向量嵌入" description="与对话模型独立配置；硅基流动预设使用 BAAI/bge-m3。">
        <Field label="启用向量检索"><Toggle checked={state.config.rag.embeddingEnabled} onChange={checked => updateState(next => { next.config.rag.embeddingEnabled = checked })} /></Field>
        <Field label="Provider"><select value={state.config.rag.embeddingProvider} onChange={event => applyEmbeddingProvider(event.target.value)}><option value="siliconflow">硅基流动 SiliconFlow</option><option value="openai">OpenAI</option><option value="custom">自定义兼容接口</option></select></Field>
        <Field label="API Base"><input value={state.config.rag.embeddingBaseUrl} onChange={event => updateState(next => { next.config.rag.embeddingBaseUrl = event.target.value })} /></Field>
        <Field label="Embedding 模型"><input value={state.config.rag.embeddingModel} onChange={event => updateState(next => { next.config.rag.embeddingModel = event.target.value })} /></Field>
        <Field label="向量维度"><NumberInput value={state.config.rag.embeddingDimensions} onChange={value => updateState(next => { next.config.rag.embeddingDimensions = value })} /></Field>
        <Field label="API Key"><div className="secret-input"><input type="password" placeholder={state.config.rag.embeddingApiKeyConfigured ? '已配置，输入新值可替换' : '填写 SiliconFlow API Key'} value={embeddingApiKey} onChange={event => setEmbeddingApiKey(event.target.value)} /><button onClick={saveEmbeddingKey}><KeyRound size={14} />保存</button></div></Field>
        <Field label="连接状态"><div className="connection-row"><button className="test-connection" onClick={testEmbedding}><Activity size={14} />测试向量接口</button>{embeddingTest && <span className={embeddingTest.ok ? 'ok' : 'failed'}>{embeddingTest.message}</span>}</div></Field>
      </SettingsSection>
      <SettingsSection icon={LibraryBig} title="检索与切片" description="文档保存在本地，向量不可用时自动回退关键词检索。">
        <Field label="启用知识检索"><Toggle checked={state.config.rag.enabled} onChange={checked => updateState(next => { next.config.rag.enabled = checked })} /></Field>
        <Field label="切片字符数"><NumberInput value={state.config.rag.chunkSize} suffix="字" onChange={value => updateState(next => { next.config.rag.chunkSize = value })} /></Field>
        <Field label="切片重叠"><NumberInput value={state.config.rag.chunkOverlap} suffix="字" onChange={value => updateState(next => { next.config.rag.chunkOverlap = value })} /></Field>
        <Field label="召回数量"><NumberInput value={state.config.rag.topK} suffix="段" onChange={value => updateState(next => { next.config.rag.topK = value })} /></Field>
      </SettingsSection></>}

      {settingsTab === 'browser' && <SettingsSection icon={ExternalLink} title="浏览器与验证" description="内置浏览器便于一体化操作；系统 Chrome 作为兼容性回退。">
        <Field label="浏览器模式"><select value={state.config.browser.mode} onChange={event => updateState(next => { next.config.browser.mode = event.target.value as AppState['config']['browser']['mode'] })}><option value="embedded">内置 Chromium</option><option value="system_chrome">系统 Chrome（回退）</option></select></Field>
        <Field label="BOSS 首页"><input value={state.config.browser.homeUrl} onChange={event => updateState(next => { next.config.browser.homeUrl = event.target.value })} /></Field>
        <Field label="检测验证后暂停"><Toggle checked={state.config.automation.pauseOnCaptcha} onChange={checked => updateState(next => { next.config.automation.pauseOnCaptcha = checked })} /></Field>
        <div className="safety-callout"><ShieldCheck size={17} /><p><strong>人工验证接管</strong><span>检测到验证码或安全验证时立即暂停并保留当前页面。客户端不绕过验证码，也不规避站点访问控制。</span></p></div>
      </SettingsSection>}
      {settingsTab === 'notifications' && <SettingsSection icon={Bell} title="人工处理通知" description="将安全验证、地点确认和需要你确认的消息推送到飞书或企业微信机器人。">
        <Field label="启用通知"><Toggle checked={state.config.notifications.enabled} onChange={checked => updateState(next => { next.config.notifications.enabled = checked })} /></Field>
        <Field label="通知渠道"><select value={state.config.notifications.provider} onChange={event => updateState(next => { next.config.notifications.provider = event.target.value as AppState['config']['notifications']['provider'] })}><option value="feishu">飞书群机器人</option><option value="wechat">企业微信机器人</option><option value="generic">通用 JSON Webhook</option></select></Field>
        <Field label="Webhook 地址"><div className="secret-input"><input type="password" placeholder={state.config.notifications.webhookConfigured ? '已配置，输入新地址可替换' : 'https://...'} value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} /><button onClick={() => void saveWebhook()}><KeyRound size={14} />保存</button></div></Field>
        <Field label="推送人机验证"><Toggle checked={state.config.notifications.notifyCaptcha} onChange={checked => updateState(next => { next.config.notifications.notifyCaptcha = checked })} /></Field>
        <Field label="推送人工确认"><Toggle checked={state.config.notifications.notifyManualReview} onChange={checked => updateState(next => { next.config.notifications.notifyManualReview = checked })} /></Field>
        <Field label="连接测试"><div className="connection-row"><button className="test-connection" disabled={!state.config.notifications.webhookConfigured} onClick={() => void testWebhook()}><Bell size={14} />发送测试</button>{notificationTest && <span className="ok">{notificationTest}</span>}</div></Field>
        <div className="safety-callout"><ShieldCheck size={17} /><p><strong>通知不改变执行策略</strong><span>Webhook 只负责提醒，不会自动点击验证码，也不会代替你的人工确认。通知失败不会阻塞本地任务。</span></p></div>
      </SettingsSection>}
      {settingsTab === 'data' && <SettingsSection icon={Download} title="数据迁移与备份" description="在源码测试版、安装版或另一台电脑之间迁移本地业务数据。">
        <Field label="导出数据"><div><button disabled={Boolean(migrationBusy)} onClick={() => void exportData()}><Download size={14} />{migrationBusy === 'export' ? '导出中' : '导出迁移文件'}</button><small>包含岗位、对话、发送历史、知识库、画像、诊断和面试准备；不包含任何密钥或 BOSS Cookie。</small></div></Field>
        <Field label="导入数据"><div><button disabled={Boolean(migrationBusy)} onClick={() => void importData()}><Upload size={14} />{migrationBusy === 'import' ? '导入中' : '选择迁移文件'}</button><small>导入前会在当前设备的 userData 目录自动备份现有 state.json。</small></div></Field>
        {migrationStatus && <Field label="最近结果"><span className="ok">{migrationStatus}</span></Field>}
        <div className="safety-callout"><ShieldCheck size={17} /><p><strong>跨平台迁移边界</strong><span>macOS 与 Windows 可以迁移业务数据和知识库向量，但 API Key、Webhook、BOSS 登录态及本机文件路径必须在新设备重新配置。</span></p></div>
      </SettingsSection>}
    </section>
  )
}

function SettingsSection({ icon: Icon, title, description, children }: { icon: typeof Target; title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-section"><div className="settings-section-head"><Icon size={18} /><div><h3>{title}</h3><p>{description}</p></div></div><div className="settings-fields">{children}</div></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span><div>{children}</div></label>
}

function Toggle({ checked, onChange }: { checked: boolean; onChange(checked: boolean): void }) {
  return <button className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button>
}

function NumberInput({ value, suffix, onChange }: { value: number; suffix?: string; onChange(value: number): void }) {
  return <div className="number-input"><input type="number" value={value} onChange={event => onChange(Number(event.target.value))} />{suffix && <span>{suffix}</span>}</div>
}

function DelimitedInput({ values, onCommit }: { values: string[]; onCommit(values: string[]): void }) {
  const serialized = values.join('，')
  const [draft, setDraft] = useState(serialized)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(serialized)
  }, [serialized])

  function commit() {
    focused.current = false
    const parsed = splitList(draft)
    setDraft(parsed.join('，'))
    onCommit(parsed)
  }

  return <input
    value={draft}
    onFocus={() => { focused.current = true }}
    onChange={event => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur()
    }}
  />
}

function modeOptions() {
  return Object.entries(sendModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)
}

function followupModeOptions() {
  return <>
    <option value="draft_only">仅生成草稿</option>
    <option value="review_each">逐条确认发送</option>
    <option value="auto_above_score">到期自动发送</option>
  </>
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-heading"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
}

function EmptyPanel({ icon: Icon, title, text }: { icon: typeof Inbox; title: string; text: string }) {
  return <div className="empty-panel"><Icon size={26} /><strong>{title}</strong><p>{text}</p></div>
}

function splitList(value: string) {
  return value.split(/[，,、]/).map(item => item.trim()).filter(Boolean)
}

function statusLabel(status: JobRecord['status']) {
  const labels: Record<JobRecord['status'], string> = {
    new: '新岗位', scored: '已评分', pending_review: '待确认', approved: '已批准', sent: '已发送',
    replied: '已回复', followup_due: '待跟进', interview: '面试中', rejected: '不合适', paused: '已暂停'
  }
  return labels[status]
}

export default App
