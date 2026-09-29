import type { AppState, BossChatMessage, ChatIntent, InterviewInvitation, JobRecord } from '../shared/types'

export type JobLocationFit = 'unrestricted' | 'preferred' | 'outside' | 'excluded' | 'unknown'

function normalizedLocation(value: string) {
  return value.replace(/\s+/g, '').toLowerCase()
}

export function jobLocationFit(job: Pick<JobRecord, 'city' | 'workAddress'>, state: AppState): JobLocationFit {
  const target = state.config.target
  if (!target.locationConstraintEnabled) return 'unrestricted'
  const location = normalizedLocation(`${job.city || ''} ${job.workAddress || ''}`)
  const matches = (values: string[]) => values.some(value => value.trim() && location.includes(normalizedLocation(value)))
  if (matches(target.excludedLocations)) return 'excluded'
  if (target.preferredLocations.length > 0 && matches(target.preferredLocations)) return 'preferred'
  const city = normalizedLocation(job.city || '')
  if (city && target.city.trim() && !city.includes(normalizedLocation(target.city))) return 'outside'
  const detailedLocation = Boolean(job.workAddress?.trim()) || /区|县|街道|镇|路|巷|大道|商圈|地铁|·/.test((job.city || '').replace(target.city, ''))
  if (target.preferredLocations.length > 0) {
    return detailedLocation ? 'outside' : 'unknown'
  }
  return detailedLocation ? 'unrestricted' : 'unknown'
}

export function jobMatchesLocationConstraint(job: Pick<JobRecord, 'city' | 'workAddress'>, state: AppState, allowUnknown = true) {
  const fit = jobLocationFit(job, state)
  return fit === 'unrestricted' || fit === 'preferred' || (allowUnknown && fit === 'unknown')
}

export function jobLocationAllowsAutoSend(job: Pick<JobRecord, 'city' | 'workAddress'>, state: AppState) {
  const fit = jobLocationFit(job, state)
  if (fit === 'unrestricted' || fit === 'preferred') return true
  return fit === 'unknown' && !state.config.target.requireKnownLocationForAutoSend
}

export function fingerprint(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

export function localScore(job: Pick<JobRecord, 'title' | 'company' | 'salary' | 'city' | 'workAddress' | 'description'>, state: AppState) {
  const haystack = `${job.title} ${job.company} ${job.description}`.toLowerCase()
  let score = 48
  if (state.config.target.keywords.some(keyword => haystack.includes(keyword.toLowerCase()))) score += 20
  score += state.config.target.preferredKeywords.filter(keyword => haystack.includes(keyword.toLowerCase())).length * 5
  if (job.city.includes(state.config.target.city)) score += 10
  if (state.config.target.excludedKeywords.some(keyword => haystack.includes(keyword.toLowerCase()))) score -= 35
  const locationFit = jobLocationFit(job, state)
  if (locationFit === 'preferred') score += 10
  if (locationFit === 'outside' || locationFit === 'excluded') score -= 35
  if (/ai|人工智能|大模型|llm|agent/i.test(haystack)) score += 8
  return Math.max(0, Math.min(100, score))
}

export function parseSalaryRange(salary: string) {
  const match = salary.match(/(\d+)\s*[-–—]\s*(\d+)\s*[kK]/)
  return match ? { min: Number(match[1]), max: Number(match[2]) } : null
}

export function targetSalaryMatches(salary: string, state: AppState) {
  const range = parseSalaryRange(salary)
  if (!range) return true
  return range.max >= state.config.target.salaryMinK && range.min <= state.config.target.salaryMaxK
}

export function daysFromNow(days: number) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

export function formatDate(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function parseModelJson<T = { score: number; matchReason: string; gaps?: string[] }>(raw: string) {
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  return JSON.parse(cleaned) as T
}

export function detectChatIntent(content: string): ChatIntent {
  const text = content.replace(/\s+/g, '').toLowerCase()
  if (/薪资|薪酬|待遇|期望工资|期望薪资|多少k|工资/.test(text)) return 'salary'
  if (/到岗|入职|何时能来|什么时候来|最快.*来/.test(text)) return 'availability'
  if (/城市|成都|地点|通勤|搬家|异地|办公地点/.test(text)) return 'location'
  if (/离职|离开|上一份工作|换工作|跳槽原因/.test(text)) return 'resignation'
  if (/简历|附件|作品集|项目材料/.test(text)) return 'resume'
  if (/电话|微信|邮箱|联系方式|手机号/.test(text)) return 'contact'
  if (/面试|约谈|视频聊|时间方便|哪天方便|安排沟通/.test(text)) return 'interview'
  if (/项目|经历|负责|做过|经验|优势|能力|ai|产品/.test(text)) return 'experience'
  return 'general'
}

export function isLocationConfirmationPrompt(content: string) {
  const text = content.replace(/\s+/g, '')
  return /^(?:您|你)?是否接受(?:此|该|这个|这份)?工作地点[?？]?$/.test(text)
    || /(?:是否|能否|可以|可否).{0,6}接受.{0,4}(?:此|该|这个|这份)?工作地点[?？]?$/.test(text)
}

export function extractInterviewInvitation(content: string): Pick<InterviewInvitation, 'message' | 'scheduleText' | 'mode' | 'location'> | undefined {
  const message = content.trim()
  const compact = message.replace(/\s+/g, '')
  const invitation = /(?:现场|线下|线上|视频|电话)?面试邀请|(?:安排|约|参加|邀请|进入).{0,10}(?:面试|约谈|视频聊|电话聊|沟通)|(?:面试|约谈|视频聊|电话聊).{0,12}(?:方便|时间|安排|参加|可以|吗|么)|(?:今天|明天|后天|本周|下周|周[一二三四五六日天]|星期[一二三四五六日天]).{0,12}(?:方便|有空|面试|沟通|视频|电话)/.test(compact)
  if (!invitation) return undefined

  const scheduleText = message.match(
    /(?:今天|明天|后天|本周(?:一|二|三|四|五|六|日|天)?|下周(?:一|二|三|四|五|六|日|天)?|周[一二三四五六日天]|星期[一二三四五六日天]|(?:\d{4}[年/-])?\d{1,2}[月/-]\d{1,2}[日号]?)(?:[^，。！？\n]{0,20}(?:上午|下午|晚上|中午)?\s*\d{1,2}(?::\d{2}|点(?:半|\d{1,2}分?)?)?)?/
  )?.[0] || message.match(/(?:上午|下午|晚上|中午)\s*\d{1,2}(?::\d{2}|点(?:半|\d{1,2}分?)?)/)?.[0]
  const isOfficialCard = /(?:面试邀请|邀请您(?:现场|线下|线上|视频|电话)?面试)/.test(compact)
  const isConcreteMeeting = Boolean(scheduleText)
    || /(?:来公司|到公司|现场|线下).{0,16}(?:面试|聊聊|沟通)/.test(compact)
  const isConditionalFuturePlan = /(?:筛选|评估|审核|合适).{0,12}(?:通过后|之后|以后)|(?:通过后|后会联系|会联系你|会联系您|将安排|安排面试哦|深度沟通|长期价值共创)/.test(compact)
  if (!isOfficialCard && !isConcreteMeeting && isConditionalFuturePlan) return undefined
  const mode: InterviewInvitation['mode'] = /腾讯会议|飞书会议|视频|线上|远程/.test(compact)
    ? 'video'
    : /电话|手机沟通/.test(compact)
      ? 'phone'
      : /现场|线下|到公司|来公司|当面/.test(compact)
        ? 'onsite'
        : 'unknown'
  const lines = message.split(/\n+/).map(line => line.trim()).filter(Boolean)
  const location = message.match(/(?:面试地点|地点|地址|办公地址)\s*[：:]?\s*([^，。！？\n]{2,80})/)?.[1]?.trim()
    || lines.find(line =>
      /(?:省|市|区|县|镇|街|路|大道|大厦|广场|园区|国际|座|号|楼|大厅)/.test(line)
      && !/(?:面试邀请|产品经理|查看详情|已接受|待开始|\d{4}[年/-]\d{1,2}[月/-]\d{1,2})/.test(line)
    )

  return { message, scheduleText: scheduleText?.trim(), mode, location }
}

export function isResumeSendRequest(content: string) {
  const text = content.replace(/\s+/g, '').toLowerCase()
  if (/简历(?:已|己)?(?:收到|查看|看过|筛选)|看过.{0,4}简历|简历.{0,8}(?:优秀|匹配|不匹配)|(?:附件|简历)(?:已经|已)?发送|请求已发送/.test(text)) return false
  return /(?:方便|麻烦|可以|能否|可否|请|需要|想要|希望).{0,12}(?:发|发送|提供|给).{0,8}(?:附件)?简历/.test(text)
    || /(?:发|发送|提供|给).{0,8}(?:一份|一下|下)?(?:你的|您的|个人|详细的?)?(?:附件)?简历/.test(text)
    || /简历.{0,8}(?:发|发送|提供).{0,6}(?:我|一下|过来|吗|么)/.test(text)
}

export function hasUnconfirmedResumeClaim(content: string) {
  const text = content.replace(/\s+/g, '')
  return /(?:简历|附件).{0,10}(?:已发送|发给您|发给你|已上传|重新发送|现在发送|马上发送)/.test(text)
    || /(?:已经|刚刚|现在|马上|重新).{0,8}(?:发送|上传).{0,8}(?:简历|附件)/.test(text)
    || /(?:简历|附件).{0,12}请.{0,4}查收/.test(text)
}

export interface ConversationEndDetection {
  source: 'candidate' | 'recruiter'
  reason: string
  messageId: string
  evidence: string
}

export function detectConversationEnd(messages: Array<Pick<BossChatMessage, 'id' | 'direction' | 'content'>>) {
  const candidatePatterns = [
    /(?:不|暂不|不再)(?:考虑|接受|去了?|方便|感兴趣)(?:这个|该|这份)?(?:岗位|机会|工作|城市|地点)?/,
    /(?:距离|通勤|地点|城市|异地|薪资|待遇|工作地).*(?:太远|不合适|接受不了|不考虑)/,
    /(?:已经找到工作|已经入职|暂时不找工作|暂时不看机会|不想换工作|不用再联系)/,
    /(?:胜任不了|不考虑背井离乡|不去外地|不去异地)/
  ]
  const recruiterPatterns = [
    /(?:暂时|目前)?(?:与该职位|和岗位|岗位)?(?:不够|不太|并不)(?:匹配|合适)/,
    /(?:暂时|目前|现在)?(?:不是|不太|并不)(?:很|太|特别|十分)?合适/,
    /(?:暂时|目前|现在)?(?:不合适|不符合|无法推进|不能推进|不考虑了)/,
    /(?:经历|经验|背景).{0,16}(?:暂时|目前)?(?:不适合|不匹配|不符合)/,
    /(?:该职位|这个职位|该岗位|这个岗位).{0,12}(?:需要|要求).{0,12}(?:其他|别的|不同的).{0,8}(?:技能|经验|背景|经历)/,
    /(?:需要|要求).{0,12}(?:其他|别的|不同的).{0,8}(?:技能|经验|背景|经历)/,
    /(?:背景|经历|经验).{0,12}(?:印象深刻|不错|优秀).{0,24}(?:但是|但).{0,20}(?:不匹配|不合适|需要|要求)/,
    /(?:简历|履历|申请|投递|资料).{0,16}(?:没过|未通过|没有通过|不通过|未能通过|筛选.{0,4}(?:没过|未通过|不通过))/,
    /(?:用人部门|招聘部门|部门).{0,12}(?:没过|未通过|没有通过|不通过|未能通过)/,
    /岗位.*(?:关闭|暂停|取消|招满|已招到|停止招聘)/,
    /(?:感谢.*关注|有合适机会.*再沟通|祝.*求职顺利|祝.*找到(?:合适|满意|理想).{0,8}(?:工作|机会|岗位)?)/
  ]

  for (const message of [...messages].reverse()) {
    const text = message.content.replace(/\s+/g, '').toLowerCase()
    const patterns = message.direction === 'outbound' ? candidatePatterns : recruiterPatterns
    if (!patterns.some(pattern => pattern.test(text))) continue
    return {
      source: message.direction === 'outbound' ? 'candidate' : 'recruiter',
      reason: message.direction === 'outbound'
        ? '检测到我方已明确拒绝该机会，已停止后续跟进。'
        : '检测到招聘方已明确结束推进，已停止后续跟进。',
      messageId: message.id,
      evidence: message.content.trim()
    } satisfies ConversationEndDetection
  }
  return null
}

export function chatIntentLabel(intent: ChatIntent) {
  const labels: Record<ChatIntent, string> = {
    general: '一般沟通',
    salary: '薪资沟通',
    availability: '到岗时间',
    location: '工作地点',
    resignation: '离职原因',
    experience: '经历与能力',
    resume: '简历材料',
    contact: '联系方式',
    interview: '面试安排'
  }
  return labels[intent]
}
