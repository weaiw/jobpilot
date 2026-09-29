import type { AppState, CandidateProfile } from './types'

export const candidateProfile: CandidateProfile = {
  name: '',
  headline: '',
  yearsExperience: 0,
  targetRole: '产品经理',
  targetCity: '成都',
  summary: '',
  strengths: [],
  skills: [],
  achievements: [],
  experienceHighlights: [],
  resumePath: ''
}

export const defaultState: AppState = {
  config: {
    target: {
      keywords: ['产品经理', 'AI 产品经理'],
      city: '成都',
      salaryMinK: 10,
      salaryMaxK: 20,
      excludedKeywords: ['外包', '驻场', '销售岗'],
      preferredKeywords: ['AI', '人工智能', 'SaaS', 'CRM', 'Agent', '增长'],
      locationConstraintEnabled: false,
      preferredLocations: [],
      excludedLocations: [],
      requireKnownLocationForAutoSend: true
    },
    automation: {
      enabled: false,
      collectionEnabled: false,
      collectionIntervalMinutes: 30,
      sendMode: 'review_each',
      autoScoreThreshold: 82,
      dailyLimit: 20,
      intervalMinSeconds: 45,
      intervalMaxSeconds: 120,
      dedupeDays: 90,
      workdayStart: '09:30',
      workdayEnd: '19:00',
      followupEnabled: true,
      followupDays: [3, 7],
      maxFollowups: 2,
      followupSendMode: 'review_each',
      pauseOnCaptcha: true,
      chatSyncEnabled: true,
      chatPollingSeconds: 30,
      chatReplyMode: 'draft_only',
      resumeSendMode: 'auto',
      manualTakeoverPause: true,
      interviewAutoGuideEnabled: true,
      sensitiveChatIntents: ['salary', 'availability', 'contact', 'interview']
    },
    model: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      temperature: 0.3,
      requestTimeoutSeconds: 300,
      apiKeyConfigured: false
    },
    browser: {
      mode: 'embedded',
      homeUrl: 'https://www.zhipin.com/web/geek/job'
    },
    notifications: {
      enabled: false,
      provider: 'feishu',
      webhookConfigured: false,
      notifyCaptcha: true,
      notifyManualReview: true
    },
    rag: {
      enabled: true,
      embeddingEnabled: true,
      embeddingProvider: 'siliconflow',
      embeddingBaseUrl: 'https://api.siliconflow.cn/v1',
      embeddingModel: 'BAAI/bge-m3',
      embeddingDimensions: 1024,
      embeddingApiKeyConfigured: false,
      chunkSize: 700,
      chunkOverlap: 120,
      topK: 6,
      minimumScore: 0.18
    }
  },
  profile: candidateProfile,
  jobs: [],
  activities: [
    {
      id: 'welcome',
      type: 'system',
      message: '候选人画像已从简历初始化。请先在设置中配置模型，再登录 BOSS。',
      createdAt: new Date().toISOString()
    }
  ],
  knowledgeDocuments: [],
  knowledgeChunks: [],
  knowledgeQas: [],
  knowledgeChat: [],
  bossConversations: [],
  automationSendHistory: [],
  automationPaused: false,
  updatedAt: new Date().toISOString()
}
