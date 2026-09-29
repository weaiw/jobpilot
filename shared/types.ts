export type SendMode = 'draft_only' | 'review_each' | 'review_batch' | 'auto_above_score'
export type ChatReplyMode = 'draft_only' | 'review_each' | 'auto_safe'
export type ResumeSendMode = 'off' | 'review_each' | 'auto'
export type ChatIntent =
  | 'general'
  | 'salary'
  | 'availability'
  | 'location'
  | 'resignation'
  | 'experience'
  | 'resume'
  | 'contact'
  | 'interview'
export type BrowserMode = 'embedded' | 'system_chrome'
export type NotificationProvider = 'feishu' | 'wechat' | 'generic'
export type JobStatus =
  | 'new'
  | 'scored'
  | 'pending_review'
  | 'approved'
  | 'sent'
  | 'replied'
  | 'followup_due'
  | 'interview'
  | 'rejected'
  | 'paused'

export interface TargetConfig {
  keywords: string[]
  city: string
  salaryMinK: number
  salaryMaxK: number
  excludedKeywords: string[]
  preferredKeywords: string[]
  locationConstraintEnabled: boolean
  preferredLocations: string[]
  excludedLocations: string[]
  requireKnownLocationForAutoSend: boolean
}

export interface AutomationConfig {
  enabled: boolean
  collectionEnabled: boolean
  collectionIntervalMinutes: number
  sendMode: SendMode
  autoScoreThreshold: number
  dailyLimit: number
  intervalMinSeconds: number
  intervalMaxSeconds: number
  dedupeDays: number
  workdayStart: string
  workdayEnd: string
  followupEnabled: boolean
  followupDays: number[]
  maxFollowups: number
  followupSendMode: SendMode
  pauseOnCaptcha: boolean
  chatSyncEnabled: boolean
  chatPollingSeconds: number
  chatReplyMode: ChatReplyMode
  resumeSendMode: ResumeSendMode
  manualTakeoverPause: boolean
  interviewAutoGuideEnabled: boolean
  sensitiveChatIntents: ChatIntent[]
}

export interface ModelConfig {
  baseUrl: string
  model: string
  temperature: number
  requestTimeoutSeconds: number
  apiKeyConfigured: boolean
}

export interface RagConfig {
  enabled: boolean
  embeddingEnabled: boolean
  embeddingProvider: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingApiKeyConfigured: boolean
  chunkSize: number
  chunkOverlap: number
  topK: number
  minimumScore: number
}

export interface BrowserConfig {
  mode: BrowserMode
  homeUrl: string
}

export interface NotificationConfig {
  enabled: boolean
  provider: NotificationProvider
  webhookConfigured: boolean
  notifyCaptcha: boolean
  notifyManualReview: boolean
}

export interface CandidateProfile {
  name: string
  headline: string
  yearsExperience: number
  targetRole: string
  targetCity: string
  summary: string
  strengths: string[]
  skills: string[]
  achievements: string[]
  experienceHighlights: string[]
  resumePath: string
}

export interface ResumeFile {
  path: string
  name: string
  type: string
  text: string
}

export type ResumeDiagnosisPriority = 'high' | 'medium' | 'low'

export interface ResumeDiagnosisRecommendation {
  priority: ResumeDiagnosisPriority
  title: string
  detail: string
  location?: string
  currentText?: string
  example?: string
}

export interface ResumeDiagnosis {
  path: string
  name: string
  analyzedAt: string
  score: number
  verdict: string
  summary: string
  strengths: string[]
  risks: string[]
  recommendations: ResumeDiagnosisRecommendation[]
  matchedKeywords: string[]
  missingKeywords: string[]
}

export interface KnowledgeDocument {
  id: string
  name: string
  path: string
  type: string
  chunkCount: number
  importedAt: string
  status: 'ready' | 'embedding' | 'error'
  error?: string
  warning?: string
}

export interface KnowledgeChunk {
  id: string
  documentId: string
  sourceName: string
  text: string
  index: number
  embedding?: number[]
}

export interface KnowledgeQa {
  id: string
  documentId: string
  category: string
  question: string
  answer: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeQaInput {
  id?: string
  category: string
  question: string
  answer: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
  createdAt: string
}

export interface BossChatMessage {
  id: string
  direction: 'inbound' | 'outbound'
  content: string
  sender: string
  sentAt: string
  timeLabel?: string
  timeUnknown?: boolean
  kind?: 'text' | 'resume_request' | 'resume_sent' | 'resume_viewed' | 'system'
  actionAvailable?: boolean
}

export interface BossConversation {
  id: string
  jobId?: string
  externalId: string
  recruiter: string
  company: string
  jobTitle: string
  jobHref?: string
  href: string
  unreadCount: number
  preview: string
  messages: BossChatMessage[]
  status: 'new' | 'draft_ready' | 'replied' | 'paused' | 'ended'
  intent: ChatIntent
  draftReply?: string
  draftKind?: 'reply' | 'followup'
  draftEditedManually?: boolean
  draftCreatedAt?: string
  draftSourceMessageId?: string
  draftRequiresReview: boolean
  aiPaused: boolean
  pauseReason?: string
  endedAt?: string
  endReason?: string
  endSource?: 'candidate' | 'recruiter'
  endMessageId?: string
  endDetectionDismissedForMessageId?: string
  lastMessageAt: string
  lastInboundAt?: string
  lastOutboundAt?: string
  replyPendingMessageId?: string
  lastRepliedInboundMessageId?: string
  lastAutomatedMessage?: string
  resumeRequestMessageId?: string
  resumeRequestPending?: boolean
  resumeProactiveSendPending?: boolean
  resumeProactiveSourceMessageId?: string
  resumeProactiveRequestedAt?: string
  resumeSentAt?: string
  resumeSendError?: string
  followupCount: number
  nextFollowupAt?: string
  lastSyncedAt: string
  lastDetailedSyncAt?: string
}

export interface AutomationSendRecord {
  id: string
  kind: 'greeting' | 'chat_reply' | 'followup' | 'resume'
  entityId: string
  sentAt: string
  automated: boolean
  contentFingerprint?: string
  entityFingerprint?: string
  nextAllowedAt?: string
}

export interface InterviewInvitation {
  sourceConversationId: string
  sourceMessageId: string
  receivedAt: string
  message: string
  scheduleText?: string
  mode: 'onsite' | 'video' | 'phone' | 'unknown'
  location?: string
}

export interface JobRecord {
  id: string
  fingerprint: string
  title: string
  company: string
  salary: string
  city: string
  workAddress?: string
  experience: string
  education: string
  description: string
  detailVersion?: number
  recruiter: string
  href: string
  chatHref?: string
  source: 'boss'
  status: JobStatus
  score?: number
  matchReason?: string
  gaps?: string[]
  greetingDraft?: string
  greetingVersion?: number
  followupDraft?: string
  capturedAt: string
  sentAt?: string
  lastContactAt?: string
  nextFollowupAt?: string
  followupCount: number
  interviewInvitation?: InterviewInvitation
  interviewGuide?: string
  interviewGuideGeneratedAt?: string
  interviewGuideSourceMessageId?: string
  interviewGuideError?: string
  interviewAssistantMessages?: ChatMessage[]
}

export interface ActivityItem {
  id: string
  type: 'collect' | 'score' | 'draft' | 'send' | 'followup' | 'captcha' | 'interview' | 'system'
  message: string
  createdAt: string
}

export interface AppConfig {
  target: TargetConfig
  automation: AutomationConfig
  model: ModelConfig
  browser: BrowserConfig
  rag: RagConfig
  notifications: NotificationConfig
}

export interface AppState {
  config: AppConfig
  profile: CandidateProfile
  resumeDiagnosis?: ResumeDiagnosis
  jobs: JobRecord[]
  activities: ActivityItem[]
  knowledgeDocuments: KnowledgeDocument[]
  knowledgeChunks: KnowledgeChunk[]
  knowledgeQas: KnowledgeQa[]
  knowledgeChat: ChatMessage[]
  bossConversations: BossConversation[]
  automationSendHistory: AutomationSendRecord[]
  lastCollectionAt?: string
  automationPaused: boolean
  pauseReason?: string
  updatedAt: string
}

export interface ModelRequest {
  task: 'score_job' | 'draft_greeting' | 'draft_followup' | 'draft_reply' | 'interview_guide' | 'interview_assistant' | 'rag_chat' | 'resume_diagnosis' | 'candidate_profile'
  payload: Record<string, unknown>
}
