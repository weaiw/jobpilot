export interface CapturedJob {
  title: string
  company: string
  salary: string
  city: string
  experience: string
  education: string
  description: string
  recruiter: string
  href: string
}

export interface CapturedBossMessage {
  id: string
  direction: 'inbound' | 'outbound'
  content: string
  sender: string
  timeLabel: string
  kind: 'text' | 'resume_request' | 'resume_sent' | 'resume_viewed' | 'system'
  actionAvailable: boolean
}

export interface CapturedBossConversation {
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
  messages: CapturedBossMessage[]
}

export const collectJobsScript = `(() => {
  const decodeBossDigits = value => (value || '').replace(/[\uE031-\uE03A]/g, char => String(char.codePointAt(0) - 0xE031))
  const text = (root, selectors) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector)
      const value = decodeBossDigits(node?.textContent).replace(/\\s+/g, ' ').trim()
      if (value) return value
    }
    return ''
  }
  const cards = [...document.querySelectorAll('.job-card-box, .job-card-wrapper, li.job-card-wrapper, [class*="job-card"]')]
  const jobs = cards.map(card => {
    const link = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[href*="/web/geek/job"]')
    const href = link?.href || ''
    const tags = [...card.querySelectorAll('.tag-list li, .job-card-footer li, [class*="tag"]')]
      .map(node => decodeBossDigits(node.textContent).trim())
      .filter(Boolean)
    return {
      title: text(card, ['.job-name', '.job-title', '[class*="job-name"]']),
      company: text(card, ['.company-name', '.boss-name', '[class*="company-name"]']),
      salary: text(card, ['.salary', '[class*="salary"]']),
      city: text(card, ['.job-area', '.job-area-wrapper', '.company-location', '[class*="job-area"]', '[class*="company-location"]']),
      experience: tags.find(tag => /年|经验|不限/.test(tag)) || '',
      education: tags.find(tag => /本科|大专|硕士|博士|学历|不限/.test(tag)) || '',
      description: text(card, ['.job-card-footer', '.job-info', '[class*="job-info"]']),
      recruiter: text(card, ['.boss-name', '.info-public', '[class*="boss-name"]']),
      href
    }
  }).filter(job => job.title && job.company)
  const seen = new Set()
  return jobs.filter(job => {
    const key = job.href || job.company + '|' + job.title
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})()`

export function selectBossExpectationScript(role: string, city: string) {
  return `(() => {
    const clean = value => (value || '').replace(/\\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').trim()
    const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
    const expectedRole = clean(${JSON.stringify(role)})
    const expectedCity = clean(${JSON.stringify(city)})
    const expectedLabel = expectedRole + '(' + expectedCity + ')'
    const candidates = [...document.querySelectorAll('a, button, [role="tab"], li')].filter(node => {
      if (!visible(node)) return false
      const rect = node.getBoundingClientRect()
      const label = clean(node.innerText || node.textContent)
      return rect.top < Math.max(320, window.innerHeight * .4) && label.length > 0 && label.length <= 40
    })
    const target = candidates.find(node => clean(node.innerText || node.textContent) === expectedLabel)
      || candidates.find(node => {
        const label = clean(node.innerText || node.textContent)
        return label.includes(expectedRole) && label.includes(expectedCity) && label.length <= expectedLabel.length + 8
      })
    const signature = [...document.querySelectorAll('a[href*="/job_detail/"]')]
      .slice(0, 8)
      .map(node => clean(node.textContent) + '|' + node.getAttribute('href'))
      .join('||')
    if (!target) return { ok: false, label: expectedLabel, signature }
    const activeNode = target.closest('li') || target
    const active = /active|selected|current/.test(String(activeNode.className || ''))
      || activeNode.getAttribute('aria-selected') === 'true'
      || Boolean(activeNode.querySelector('.active, .selected, .current'))
    const clickTarget = target.matches('a, button, [role="tab"]')
      ? target
      : target.querySelector('a, button, [role="tab"]') || target
    if (!active) clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return { ok: true, label: clean(target.innerText || target.textContent), active, changed: !active, signature }
  })()`
}

export function bossExpectationStateScript(role: string, city: string) {
  return `(() => {
    const clean = value => (value || '').replace(/\\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').trim()
    const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
    const expectedRole = clean(${JSON.stringify(role)})
    const expectedCity = clean(${JSON.stringify(city)})
    const expectedLabel = expectedRole + '(' + expectedCity + ')'
    const candidates = [...document.querySelectorAll('a, button, [role="tab"], li')].filter(node => {
      if (!visible(node)) return false
      const rect = node.getBoundingClientRect()
      const label = clean(node.innerText || node.textContent)
      return rect.top < Math.max(320, window.innerHeight * .4) && label.length > 0 && label.length <= 40
    })
    const target = candidates.find(node => clean(node.innerText || node.textContent) === expectedLabel)
      || candidates.find(node => {
        const label = clean(node.innerText || node.textContent)
        return label.includes(expectedRole) && label.includes(expectedCity) && label.length <= expectedLabel.length + 8
      })
    const activeNode = target?.closest('li') || target
    const active = Boolean(activeNode) && (
      /active|selected|current/.test(String(activeNode.className || ''))
      || activeNode.getAttribute('aria-selected') === 'true'
      || Boolean(activeNode.querySelector('.active, .selected, .current'))
    )
    const signature = [...document.querySelectorAll('a[href*="/job_detail/"]')]
      .slice(0, 8)
      .map(node => clean(node.textContent) + '|' + node.getAttribute('href'))
      .join('||')
    return { found: Boolean(target), active, signature, jobCount: document.querySelectorAll('a[href*="/job_detail/"]').length }
  })()`
}

export const captchaDetectionScript = `(() => {
  const bodyText = document.body?.innerText || ''
  const keywordHit = /安全验证|请完成验证|拖动滑块|点击进行验证|访问过于频繁|环境异常/.test(bodyText)
  const frameHit = [...document.querySelectorAll('iframe')].some(frame => /captcha|geetest|verify|challenge/i.test(frame.src || ''))
  const nodeHit = Boolean(document.querySelector('[class*="captcha"], [id*="captcha"], [class*="geetest"], [class*="verify"]'))
  return keywordHit || frameHit || nodeHit
})()`

export const collectJobDetailScript = `(() => {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const blockText = node => (node?.innerText || node?.textContent || '')
    .split(/\\n+/)
    .map(clean)
    .filter(Boolean)
    .join('\\n')
  const selectors = [
    '.location-address', '.job-address', '.job-location .address',
    '[class*="location-address"]', '[class*="job-address"]'
  ]
  let address = ''
  for (const selector of selectors) {
    const value = clean(document.querySelector(selector)?.textContent)
    if (value && value !== '工作地址') {
      address = value.replace(/^工作地址\\s*/, '')
      break
    }
  }
  const lines = (document.body?.innerText || '').split(/\\n+/).map(clean).filter(Boolean)
  const labelIndex = address ? -1 : lines.findIndex(line => line === '工作地址' || line.startsWith('工作地址 '))
  if (!address && labelIndex >= 0) {
    const inline = lines[labelIndex].replace(/^工作地址\\s*/, '')
    if (inline) address = inline
    else address = lines.slice(labelIndex + 1).find(line => !/点击查看地图|查看更多信息/.test(line)) || ''
  }

  let description = ''
  const start = lines.findIndex(line => /^(职位描述|岗位职责|工作职责)$/.test(line))
  if (start >= 0) {
    const stop = lines.findIndex((line, index) => index > start && /^(公司介绍|工商信息|工作地址|职位福利|公司基本信息|相关推荐)$/.test(line))
    description = lines.slice(start + 1, stop > start ? stop : start + 80).join('\\n').slice(0, 12000)
  }
  if (!description) {
    const sections = [...document.querySelectorAll('.job-detail-section, [class*="job-detail-section"], section')]
    const jobSection = sections.find(section => /职位描述|岗位职责|工作职责/.test(blockText(section).slice(0, 80)))
    description = blockText(jobSection?.querySelector('.job-sec-text, [class*="sec-text"]') || jobSection).slice(0, 12000)
  }
  if (!description) {
    const firstJobText = document.querySelector('.job-detail-section .job-sec-text, .job-sec-text')
    description = blockText(firstJobText).slice(0, 12000)
  }
  return { address, description }
})()`

export const collectBossChatsScript = `(() => {
  try {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
  const hash = value => {
    let result = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index)
      result = Math.imul(result, 16777619)
    }
    return (result >>> 0).toString(36)
  }
  const textFrom = (root, selectors) => {
    for (const selector of selectors) {
      const value = clean(root?.querySelector?.(selector)?.textContent)
      if (value) return value
    }
    return ''
  }
  const blockTextFrom = root => (root?.innerText || root?.textContent || '')
    .split(/\\n+/)
    .map(clean)
    .filter(Boolean)
    .join('\\n')
  const messageContentFrom = node => {
    const textContent = textFrom(node, ['.text-content', '.message-text'])
    if (textContent) return textContent
    const cardTitle = textFrom(node, ['.message-card-top-title', '.msg-dialog-title'])
    if (cardTitle) {
      const cardText = blockTextFrom(node)
      if (/(?:现场|线下|视频|电话)?面试邀请/.test(cardTitle + cardText)) return cardText || cardTitle
      return cardTitle
    }
    if (/item-system/.test(String(node.className || ''))) {
      const systemText = clean(node.innerText || node.textContent)
      if (systemText) return systemText
    }
    const media = node.querySelector('.text-content img, .message-text img, .emotion-content img, .emoji-content img')
    if (!media) return ''
    const label = clean(
      media.getAttribute('alt')
      || media.getAttribute('title')
      || media.getAttribute('aria-label')
      || media.getAttribute('data-name')
      || media.getAttribute('data-emoji')
      || ''
    )
    if (!label) return '[表情]'
    return /^\[.*\]$/.test(label) ? label : '[' + label + ']'
  }
  const roots = [...document.querySelectorAll('.user-list, .chat-list, .conversation-list, .friend-list, [class*="chat-list"], [class*="conversation-list"], [class*="user-list"]')].filter(visible)
  const conversations = new Map()
  for (const node of roots.flatMap(root => [...root.querySelectorAll('li, [class*="item"]')])) {
    if (!visible(node)) continue
    const raw = clean(node.innerText || node.textContent)
    if (raw.length < 2 || raw.length > 500) continue
    const lines = (node.innerText || '').split(/\\n+/).map(clean).filter(Boolean)
    const link = node.closest('a[href]') || node.querySelector('a[href]')
    const jobLink = node.querySelector('a[href*="/job_detail/"]') || node.querySelector('a[href*="/job/"]')
    const href = link?.href || ''
    const jobHref = jobLink?.href || ''
    const nameParts = [...node.querySelectorAll('.name-box > span')].map(part => clean(part.textContent)).filter(Boolean)
    const recruiter = textFrom(node, ['.name-text', '.user-name', '.boss-name']) || nameParts[0] || lines[0] || ''
    const company = textFrom(node, ['.company', '.company-name']) || nameParts[1] || ''
    const jobTitle = textFrom(node, ['.job-name', '.job-title', '.position']) || nameParts.slice(2).join(' ') || ''
    const preview = textFrom(node, ['.last-msg-text', '.last-msg', '.last-message', '.preview']) || lines.at(-1)?.slice(0, 180) || ''
    const timeLabel = textFrom(node, ['.last-time', '.message-time', '.time', '[class*="time"]'])
    const badgeNode = [...node.querySelectorAll('.badge, .unread, [class*="unread"], [class*="badge"]')].find(visible)
    const badge = clean(badgeNode?.textContent || badgeNode?.getAttribute('aria-label') || badgeNode?.getAttribute('title') || '')
    const unreadVisual = Boolean(badgeNode) || /(?:^|\\s)(?:unread|has-new|is-new)(?:\\s|$)/i.test(String(node.className || ''))
    const unreadCount = Number((badge.match(/\\d+/) || [])[0] || (/未读/.test(raw + ' ' + badge) || unreadVisual ? 1 : 0))
    const dataId = node.getAttribute('data-id') || node.getAttribute('data-uid') || node.getAttribute('data-geek') || ''
    const externalId = dataId || (href.match(/[?&](?:id|uid|geekId|lid)=([^&]+)/)?.[1]) || hash(recruiter + '|' + company + '|' + jobTitle + '|' + href)
    if (!recruiter || (/消息|全部沟通|沟通过/.test(recruiter) && lines.length < 2)) continue
    const active = /active|selected|current/.test(String(node.className || '')) || Boolean(node.querySelector('.active, .selected, .current'))
    const item = { externalId, recruiter, company, jobTitle, jobHref, href, unreadCount, preview, timeLabel, active, messages: [] }
    const previous = conversations.get(externalId)
    if (!previous || raw.length > (previous.preview || '').length) conversations.set(externalId, item)
  }
  const messageSelector = '.message-item, .chat-message, .message-row, .chat-record-item, [class*="message-item"], [class*="message-row"]'
  const messageNodes = [...document.querySelectorAll(messageSelector)]
    .filter(node => visible(node) && !node.querySelector(messageSelector))
  const messageSeen = new Set()
  const messages = []
  for (const node of messageNodes) {
    const content = messageContentFrom(node)
    if (!content || content.length > 6000) continue
    if (/^你与该职位竞争者PK情况$/.test(content.replace(/\\s+/g, ''))) continue
    const classText = [node.className, node.parentElement?.className].join(' ').toLowerCase()
    const rect = node.getBoundingClientRect()
    const direction = /item-friend|from-friend|message-friend/.test(classText)
      ? 'inbound'
      : /item-myself|message-self|mine|my-|right|send/.test(classText) || rect.left + rect.width / 2 > window.innerWidth * .68
        ? 'outbound'
        : 'inbound'
    const timeLabel = textFrom(node, ['time', '.time', '[class*="time"]'])
    const sender = textFrom(node, ['.name', '.sender', '[class*="name"]'])
    const hasResumeCard = Boolean(node.querySelector('.message-dialog-both .dialog-icon.resume, .dialog-icon.resume')) && /附件简历/.test(content)
    const resumeSent = /(?:您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方)/.test(content)
    const resumeViewed = /对方已查看了您的附件简历/.test(content)
    const kind = hasResumeCard ? 'resume_request' : resumeSent ? 'resume_sent' : resumeViewed ? 'resume_viewed' : /item-system/.test(classText) ? 'system' : 'text'
    const actionAvailable = hasResumeCard && [...node.querySelectorAll('.message-card-buttons .card-btn, .card-btn')]
      .some(button => clean(button.textContent) === '同意' && !/(^|\\s)disabled(\\s|$)/.test(String(button.className || '')) && button.getAttribute('aria-disabled') !== 'true')
    const id = node.getAttribute('data-mid') || node.getAttribute('data-id') || hash(direction + '|' + content + '|' + timeLabel)
    if (messageSeen.has(id)) continue
    messageSeen.add(id)
    messages.push({ id, direction, content, sender, timeLabel, kind, actionAvailable })
  }
  const header = [...document.querySelectorAll('.chat-conversation .user-info, .chat-conversation .name-text, .chat-header, .conversation-header, [class*="chat-header"], [class*="conversation-header"]')].filter(visible).at(-1)
  const headerText = clean(header?.innerText || '')
  const compactIdentity = value => clean(value).replace(/\\s+/g, '').toLowerCase()
  const compactHeader = compactIdentity(headerText)
  const headerNameMatches = [...conversations.values()].filter(item => item.recruiter && compactHeader.includes(compactIdentity(item.recruiter)))
  const headerIdentityMatches = headerNameMatches.filter(item => item.company && compactHeader.includes(compactIdentity(item.company)))
  let active = headerIdentityMatches.find(item => item.active)
    || headerIdentityMatches[0]
    || [...conversations.values()].find(item => item.active)
    || (headerNameMatches.length === 1 ? headerNameMatches[0] : undefined)
  if (messages.length || headerText) {
    if (!active) {
      const recruiter = textFrom(header, ['.name', '.boss-name', '[class*="name"]']) || headerText.split(' ')[0] || '当前会话'
      active = { externalId: hash(recruiter + '|' + location.href), recruiter, company: '', jobTitle: '', href: location.href, unreadCount: 0, preview: messages.at(-1)?.content || '', timeLabel: '', active: true, messages: [] }
      conversations.set(active.externalId, active)
    }
    active.active = true
    const headerJobLink = header?.querySelector('a[href*="/job_detail/"], a[href*="/job/"]')
    const headerCompany = textFrom(header, ['.company-name', '.company', '.job-company', '[class*="company"]'])
    const headerJobTitle = textFrom(header, ['.job-name', '.job-title', '.position-name', '[class*="job-name"]', '[class*="job-title"]'])
    if (headerJobLink?.href) active.jobHref = headerJobLink.href
    if (headerCompany) active.company ||= headerCompany
    if (headerJobTitle) active.jobTitle ||= headerJobTitle
    active.messages = messages
    if (!active.preview) active.preview = messages.at(-1)?.content || ''
  }
  return { ok: /zhipin\\.com/.test(location.hostname), url: location.href, title: document.title, conversations: [...conversations.values()].slice(0, 200) }
  } catch (error) {
    return {
      ok: false,
      url: location.href,
      title: document.title,
      conversations: [],
      error: 'BOSS 页面采集失败：' + String(error?.stack || error?.message || error)
    }
  }
})()`

export function inspectBossActiveConversationScript(recruiter: string, company = '') {
  return `(() => {
    const clean = value => (value || '').replace(/\s+/g, ' ').trim()
    const compact = value => clean(value).replace(/\s+/g, '').toLowerCase()
    const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
    const expectedRecruiter = compact(${JSON.stringify(recruiter)})
    const expectedCompany = compact(${JSON.stringify(company)})
    const candidates = [...document.querySelectorAll('.chat-conversation .user-info, .chat-conversation .name-text, .chat-header, .conversation-header, [class*="chat-header"], [class*="conversation-header"]')]
      .filter(visible)
      .map(node => ({ text: clean(node.innerText || node.textContent) }))
      .filter(item => item.text && compact(item.text).includes(expectedRecruiter))
      .sort((left, right) => left.text.length - right.text.length)
    const identity = candidates.find(item => !expectedCompany || compact(item.text).includes(expectedCompany))
    return {
      ok: Boolean(identity),
      recruiterMatches: candidates.length > 0,
      companyMatches: !expectedCompany || Boolean(identity),
      headerText: identity?.text || candidates[0]?.text || ''
    }
  })()`
}

export function openBossConversationScript(externalId: string, recruiter: string, company = '') {
  return `(async () => {
    const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
    const compact = value => clean(value).replace(/\\s+/g, '')
    const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const id = ${JSON.stringify(externalId)}
    const name = ${JSON.stringify(recruiter)}
    const company = ${JSON.stringify(company)}
    try {
      const roots = () => [...document.querySelectorAll('.user-list, .chat-list, .conversation-list, .friend-list, [class*="chat-list"], [class*="conversation-list"], [class*="user-list"]')].filter(visible)
      const findTarget = () => {
        const nodes = roots().flatMap(root => [...root.querySelectorAll('li, [class*="item"]')]).filter(visible)
        const rootedTarget = nodes.find(node => [node.getAttribute('data-id'), node.getAttribute('data-uid'), node.getAttribute('data-geek')].includes(id))
          || nodes.find(node => compact(node.querySelector('.name-text')?.textContent) === compact(name) && company && compact(node.innerText || node.textContent).includes(compact(company)))
          || nodes.find(node => compact(node.innerText || node.textContent).includes(compact(name)) && Boolean(company) && compact(node.innerText || node.textContent).includes(compact(company)))
          || (!company ? nodes.find(node => compact(node.querySelector('.name-text')?.textContent) === compact(name)) : undefined)
          || (!company ? nodes.find(node => compact(node.innerText || node.textContent).includes(compact(name))) : undefined)
        if (rootedTarget || !company) return rootedTarget
        return [...document.querySelectorAll('li, [role="button"], [class]')]
          .filter(node => {
            if (!visible(node)) return false
            const rect = node.getBoundingClientRect()
            const content = compact(node.innerText || node.textContent)
            return rect.left < window.innerWidth * .55
              && rect.top > 40
              && content.includes(compact(name))
              && content.includes(compact(company))
          })
          .sort((left, right) => compact(left.innerText || left.textContent).length - compact(right.innerText || right.textContent).length)[0]
      }
      let target = findTarget()
      let searchInput
      if (!target) {
        searchInput = [...document.querySelectorAll('input[type="text"], input:not([type])')]
          .filter(input => {
            if (!visible(input) || input.disabled || input.readOnly) return false
            const rect = input.getBoundingClientRect()
            const hint = clean([input.placeholder, input.getAttribute('aria-label'), input.className].join(' '))
            return rect.left < window.innerWidth * .48 && rect.top < window.innerHeight * .4 && /搜索|查找|联系人|沟通/.test(hint)
          })[0]
        if (searchInput) {
          searchInput.focus()
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(searchInput, name)
          searchInput.dispatchEvent(new Event('input', { bubbles: true }))
          searchInput.dispatchEvent(new Event('change', { bubbles: true }))
          for (let attempt = 0; attempt < 12 && !target; attempt += 1) {
            await sleep(250)
            target = findTarget()
          }
        }
      }
      if (!target) {
        const scrollables = [...document.querySelectorAll('div, ul')].filter(node => {
          if (!visible(node) || node.scrollHeight <= node.clientHeight + 20) return false
          const rect = node.getBoundingClientRect()
          return rect.left < window.innerWidth * .5 && rect.width > 180 && rect.height > 180
        })
        for (let attempt = 0; attempt < 12 && !target; attempt += 1) {
          for (const node of scrollables) node.scrollTop = Math.min(node.scrollHeight, node.scrollTop + Math.max(240, node.clientHeight * .8))
          await sleep(250)
          target = findTarget()
        }
      }
      if (!target) return { ok: false, reason: '未在 BOSS 会话列表中找到该联系人', stage: searchInput ? 'search-and-scroll' : 'scroll' }
      const expectedPreview = clean(target.querySelector('.last-msg-text, .last-msg, .last-message, .preview')?.textContent || '')
      const clickTarget = target.querySelector('.name-box, .user-content, [class*="user-content"], [class*="item-content"]') || target.firstElementChild || target
      clickTarget.click()
      if (searchInput) {
        await sleep(250)
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(searchInput, '')
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
        searchInput.dispatchEvent(new Event('change', { bubbles: true }))
      }
      return { ok: true, expectedPreview }
    } catch (error) {
      return { ok: false, reason: '定位 BOSS 联系人失败：' + String(error?.message || error), stage: 'exception' }
    }
  })()`
}

export const prepareBossResumeSendScript = `(() => {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
  const messageNodes = [...document.querySelectorAll('.message-item, .chat-message, .message-row, .chat-record-item, [class*="message-item"], [class*="message-row"]')]
    .filter(node => visible(node) && !node.querySelector('.message-item, .chat-message, .message-row, .chat-record-item, [class*="message-item"], [class*="message-row"]'))
  const sentCount = messageNodes.filter(node => /(?:您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方)/.test(clean(node.innerText || node.textContent))).length
  if (sentCount > 0) return { ok: false, alreadySent: true, reason: '该会话的附件简历已经发送' }
  const cards = messageNodes.filter(node => {
    if (!node.querySelector('.message-dialog-both .dialog-icon.resume, .dialog-icon.resume')) return false
    const title = clean(node.querySelector('.message-card-top-title')?.textContent || node.innerText || node.textContent)
    return /附件简历/.test(title) && !/作品集/.test(title)
  })
  const actionable = cards.reverse().map(card => {
    const button = [...card.querySelectorAll('.message-card-buttons .card-btn, .card-btn')]
      .find(node => clean(node.textContent) === '同意' && visible(node) && !/(^|\\s)disabled(\\s|$)/.test(String(node.className || '')) && node.getAttribute('aria-disabled') !== 'true')
    return button ? { card, button } : null
  }).find(Boolean)
  if (!actionable) {
    return {
      ok: false,
      alreadySent: false,
      reason: '没有找到可操作的附件简历请求卡片'
    }
  }
  const rect = actionable.button.getBoundingClientRect()
  return {
    ok: true,
    prepared: true,
    requestId: actionable.card.getAttribute('data-mid') || '',
    sentCount,
    sendPoint: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
})()`

export const prepareBossProactiveResumeSendScript = `(() => {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
  const sentCount = [...document.querySelectorAll('.message-item')]
    .filter(visible)
    .filter(node => /(?:您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方)/.test(clean(node.innerText || node.textContent))).length
  if (sentCount > 0) return { ok: false, alreadySent: true, reason: '该会话的附件简历已经发送' }
  const requestCount = [...document.querySelectorAll('.message-item')]
    .filter(visible)
    .filter(node => /附件简历请求已发送/.test(clean(node.innerText || node.textContent))).length
  if (requestCount > 0) return { ok: false, alreadyRequested: true, requestCount, sentCount, reason: '该会话已经发起附件简历发送请求' }
  const toolbar = [...document.querySelectorAll('.toolbar-btn, .toolbar-btn-content')]
    .filter(visible)
    .filter(node => clean(node.innerText || node.textContent) === '发简历')
    .map(node => node.closest('.toolbar-btn') || node)
    .find(visible)
  if (!toolbar) return { ok: false, reason: '没有找到当前会话的“发简历”入口' }
  const rect = toolbar.getBoundingClientRect()
  return {
    ok: true,
    prepared: true,
    requestCount,
    sentCount,
    sendPoint: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
})()`

export const confirmBossResumeSendScript = `(() => {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
  const messageNodes = [...document.querySelectorAll('.message-item, .chat-message, .message-row, .chat-record-item, [class*="message-item"], [class*="message-row"]')]
    .filter(node => visible(node) && !node.querySelector('.message-item, .chat-message, .message-row, .chat-record-item, [class*="message-item"], [class*="message-row"]'))
  const sentCount = messageNodes.filter(node => /(?:您的附件简历.*已发送给Boss|对方已同意，您的附件简历已发送给对方)/.test(clean(node.innerText || node.textContent))).length
  const requestCount = messageNodes.filter(node => /附件简历请求已发送/.test(clean(node.innerText || node.textContent))).length
  return { sentCount, requestCount }
})()`

export const prepareBossResumeSelectionScript = `(() => {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
  const dialogs = [...document.querySelectorAll('.dialog-wrap.active .choose-resume-dialog')].filter(visible)
  const dialog = dialogs.find(node => /请选择要发送的简历/.test(clean(node.closest('.dialog-wrap')?.innerText || node.innerText)))
  if (!dialog) return { ok: false, waiting: true, reason: '正在等待 BOSS 简历选择窗口' }
  const items = [...dialog.querySelectorAll('.resume-list .list-item')].filter(visible)
  const attachments = items.map(item => ({
    item,
    name: clean(item.querySelector('.resume-name')?.textContent),
    label: clean(item.querySelector('.resume-label')?.textContent),
    text: clean(item.innerText || item.textContent)
  }))
  const resumes = attachments.filter(entry => entry.name && !/作品集/.test(entry.label) && !/作品集/.test(entry.text))
  if (resumes.length !== 1) {
    const summary = attachments.map(entry => entry.name + (entry.label ? '（' + entry.label + '）' : '')).filter(Boolean).join('、')
    return {
      ok: false,
      waiting: false,
      reason: resumes.length === 0
        ? 'BOSS 简历选择窗口中没有找到可发送的附件简历' + (summary ? '：' + summary : '')
        : 'BOSS 中存在多个未标记为作品集的附件，无法安全确定要发送哪一份：' + summary
    }
  }
  const rect = resumes[0].item.getBoundingClientRect()
  return {
    ok: true,
    prepared: true,
    resumeName: resumes[0].name,
    selectPoint: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
})()`

export const prepareBossResumeDialogSendScript = `(() => {
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
  const visible = node => Boolean(node && node.getClientRects && node.getClientRects().length)
  const dialogs = [...document.querySelectorAll('.dialog-wrap.active .choose-resume-dialog')].filter(visible)
  const dialog = dialogs.find(node => /请选择要发送的简历/.test(clean(node.closest('.dialog-wrap')?.innerText || node.innerText)))
  if (!dialog) return { ok: false, waiting: true, reason: 'BOSS 简历选择窗口已关闭' }
  const selected = [...dialog.querySelectorAll('.resume-list .list-item.selected, .resume-list .list-item.active, .resume-list .list-item[aria-selected="true"]')].filter(visible)
  if (selected.length !== 1) return { ok: false, waiting: true, reason: '正在等待附件简历选中' }
  const selectedName = clean(selected[0].querySelector('.resume-name')?.textContent)
  const selectedLabel = clean(selected[0].querySelector('.resume-label')?.textContent)
  const selectedText = clean(selected[0].innerText || selected[0].textContent)
  if (!selectedName || /作品集/.test(selectedLabel) || /作品集/.test(selectedText)) {
    return { ok: false, waiting: false, reason: 'BOSS 当前选中的附件不是简历，已取消发送' }
  }
  const button = [...dialog.querySelectorAll('button')].find(node => clean(node.textContent) === '发送' && visible(node))
  if (!button || button.disabled || /(^|\\s)disabled(\\s|$)/.test(String(button.className || '')) || button.getAttribute('aria-disabled') === 'true') {
    return { ok: false, waiting: true, reason: '正在等待 BOSS 启用附件简历发送按钮' }
  }
  const rect = button.getBoundingClientRect()
  return {
    ok: true,
    prepared: true,
    resumeName: selectedName,
    sendPoint: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }
})()`

export function fillBossReplyScript(message: string) {
  return `(() => {
    const visible = element => element && element.getClientRects().length > 0
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')].filter(visible)
    const input = candidates.reverse().find(element => {
      const rect = element.getBoundingClientRect()
      const hint = ((element.getAttribute('placeholder') || '') + ' ' + (element.className || '')).toLowerCase()
      return rect.top > window.innerHeight * .45 || /消息|回复|输入|chat|message/.test(hint)
    })
    if (!input) return { ok: false, reason: '没有找到当前会话的消息输入框' }
    const value = ${JSON.stringify(message)}
    input.focus()
    if (input.isContentEditable) {
      document.execCommand('selectAll', false)
      document.execCommand('insertText', false, value)
    } else {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      setter?.call(input, value)
    }
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, drafted: true }
  })()`
}

export function sendBossReplyScript(message: string) {
  return `(async () => {
    const visible = element => element && element.getClientRects().length > 0
    const cleanText = value => (value || '').replace(/\\s+/g, ' ').trim()
    const normalize = value => (value || '')
      .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
      .replace(/^(?:已读|送达|未读)\\s+/, '')
      .replace(/\\s+/g, '')
      .trim()
    const value = ${JSON.stringify(message)}
    const normalizedMessage = normalize(value)
    const pageText = normalize(document.body?.innerText || '')
    const beforePageMatches = normalizedMessage ? pageText.split(normalizedMessage).length - 1 : 0
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter(element => visible(element) && !element.disabled && !element.readOnly)
    const input = candidates.map(element => {
      const rect = element.getBoundingClientRect()
      const hint = cleanText([element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.className].join(' ')).toLowerCase()
      const context = cleanText(element.closest('[class*="chat"], [class*="message"], [class*="conversation"]')?.className).toLowerCase()
      let score = rect.bottom / Math.max(window.innerHeight, 1) * 100
      if (/消息|回复|输入|沟通|chat|message|editor/.test(hint + ' ' + context)) score += 160
      if (/搜索|search/.test(hint)) score -= 300
      if (rect.top < window.innerHeight * .35) score -= 120
      if (rect.width > 280) score += 30
      return { element, score }
    }).sort((left, right) => right.score - left.score)[0]?.element
    if (!input) return { ok: false, reason: '没有找到当前会话的消息输入框' }
    input.focus()
    if (input.isContentEditable) {
      document.execCommand('selectAll', false)
      document.execCommand('insertText', false, value)
    } else {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      setter?.call(input, value)
    }
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const written = normalize(input.isContentEditable ? input.textContent : input.value)
    if (written !== normalizedMessage) return { ok: false, reason: '消息输入框尚未完成写入' }
    const inputRect = input.getBoundingClientRect()
    let send
    for (let attempt = 0; attempt < 20; attempt += 1) {
      send = [...document.querySelectorAll('button, [role="button"]')]
        .filter(button => visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' && /^(发送|发 送)$/.test(cleanText(button.textContent || button.getAttribute('aria-label'))))
        .map(button => {
          const rect = button.getBoundingClientRect()
          const verticalDistance = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2))
          return { button, rect, score: verticalDistance + Math.abs(rect.left - inputRect.right) * .1 }
        })
        .sort((left, right) => left.score - right.score)
        .find(candidate => !/(^|\\s)disabled(\\s|$)/.test(String(candidate.button.className || '')))
      if (send) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!send) return { ok: false, reason: '消息已填入，但 BOSS 发送按钮一直处于禁用状态' }
    return {
      ok: true,
      prepared: true,
      beforePageMatches,
      sendPoint: { x: Math.round(send.rect.left + send.rect.width / 2), y: Math.round(send.rect.top + send.rect.height / 2) }
    }
  })()`
}

export function confirmBossReplyScript(message: string) {
  return `(() => {
    const visible = element => element && element.getClientRects().length > 0
    const normalize = value => (value || '')
      .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
      .replace(/^(?:已读|送达|未读)\\s+/, '')
      .replace(/\\s+/g, '')
      .trim()
    const message = normalize(${JSON.stringify(message)})
    const pageText = normalize(document.body?.innerText || '')
    const pageMatches = message ? pageText.split(message).length - 1 : 0
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')]
      .filter(visible)
      .filter(element => {
        const rect = element.getBoundingClientRect()
        const hint = ((element.getAttribute('placeholder') || '') + ' ' + (element.className || '')).toLowerCase()
        return rect.top > window.innerHeight * .45 || /消息|回复|输入|chat|message/.test(hint)
      })
    const input = inputs.reverse()[0]
    const inputValue = input
      ? normalize(input.isContentEditable ? input.textContent : input.value)
      : ''
    const bubbleSelectors = [
      '.message-item', '.chat-message', '.message-row', '.chat-record-item',
      '[class*="message-item"]', '[class*="message-row"]', '[class*="message-content"]',
      '.text-content', '.message-text'
    ]
    const bubbles = [...new Set(bubbleSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(visible)
      .filter(node => normalize(node.innerText || node.textContent) === message)
    return {
      pageMatches,
      matchingBubbles: bubbles.length,
      inputCleared: Boolean(input) && !inputValue,
      inputStillContainsMessage: inputValue === message
    }
  })()`
}

export function sendGreetingScript(message: string, clickSend = true) {
  return `(() => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const visible = element => element && element.getClientRects().length > 0
    const clean = value => (value || '').replace(/\\s+/g, ' ').trim()
    const clickable = node => node?.closest?.('button, a, [role="button"]') || node
    const findCommunicate = () => {
      const matches = [...document.querySelectorAll('button, a, [role="button"], span')]
        .filter(node => visible(node) && ['立即沟通', '继续沟通'].some(text => clean(node.textContent).includes(text)))
      return clickable(matches.find(node => ['立即沟通', '继续沟通'].includes(clean(node.textContent))) || matches[0])
    }
    const editableValue = element => element.isContentEditable ? clean(element.textContent) : String(element.value || '').trim()
    const endedPattern = /(?:该职位|这个职位|该岗位|这个岗位).{0,18}(?:需要|要求).{0,18}(?:其他|别的|不同的).{0,10}(?:技能|经验|背景|经历)|(?:需要|要求).{0,18}(?:其他|别的|不同的).{0,10}(?:技能|经验|背景|经历)|祝.{0,12}(?:求职顺利|找到满意)/
    const hasEndedMessage = root => {
      const selectors = ['.message-item', '.chat-message', '.message-row', '.chat-record-item', '[class*="message-item"]', '[class*="message-row"]', '[class*="message-content"]', '.text-content', '.message-text']
      const messages = [...new Set(selectors.flatMap(selector => [...root.querySelectorAll(selector)]))]
        .filter(visible)
        .map(node => clean(node.innerText || node.textContent))
        .filter(Boolean)
      return messages.some(text => endedPattern.test(text))
    }
    const findInput = () => {
      const candidates = [...document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')]
        .filter(element => visible(element) && !element.disabled && !element.readOnly)
      return candidates.map(element => {
        const rect = element.getBoundingClientRect()
        const hint = clean([element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.className].join(' ')).toLowerCase()
        const context = clean(element.closest('[role="dialog"], [class*="dialog"], [class*="chat"], [class*="message"]')?.className).toLowerCase()
        let score = rect.bottom / Math.max(window.innerHeight, 1) * 100
        if (/消息|回复|输入|沟通|chat|message|editor/.test(hint + ' ' + context)) score += 120
        if (element.closest('[role="dialog"], [class*="dialog"]')) score += 100
        if (/搜索|search/.test(hint)) score -= 240
        if (rect.top < window.innerHeight * .3) score -= 80
        if (rect.width > 280) score += 20
        return { element, score }
      }).sort((left, right) => right.score - left.score).find(candidate => candidate.score > 40)?.element
    }
    const setNativeValue = (element, value) => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      setter?.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const findSend = input => {
      const inputRect = input.getBoundingClientRect()
      return [...document.querySelectorAll('button, [role="button"], a')]
        .filter(node => {
          if (!visible(node) || node.disabled || node.getAttribute('aria-disabled') === 'true') return false
          const label = clean(node.textContent || node.getAttribute('aria-label'))
          return label === '发送' || label === '发 送'
        })
        .map(node => {
          const rect = node.getBoundingClientRect()
          const verticalDistance = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2))
          return { node, score: verticalDistance + Math.abs(rect.left - inputRect.right) * .1 }
        })
        .sort((left, right) => left.score - right.score)[0]?.node
    }
    return (async () => {
      let input = findInput()
      if (!input) {
        const communicate = findCommunicate()
        if (!communicate) return { ok: false, retryable: true, reason: '正在等待沟通窗口或聊天页面加载' }
        communicate.click()
        return { ok: true, opening: true }
      }
      const message = ${JSON.stringify(message)}
      const inputScope = input.closest('[role="dialog"], [class*="dialog"], [class*="chat"], [class*="message"]') || document
      if (hasEndedMessage(inputScope)) {
        return { ok: false, retryable: false, ended: true, reason: '当前 BOSS 沟通已被招聘方明确结束，已阻止继续发送。' }
      }
      const messageSelector = '.message-item, .chat-message, .message-row, .chat-record-item, [class*="message-item"], [class*="message-row"]'
      const hasPriorOutbound = [...inputScope.querySelectorAll(messageSelector)]
        .filter(node => visible(node) && !node.querySelector(messageSelector))
        .some(node => {
          const classText = [node.className, node.parentElement?.className].join(' ').toLowerCase()
          const rect = node.getBoundingClientRect()
          if (/item-friend|from-friend|message-friend|item-system/.test(classText)) return false
          return /item-myself|message-self|mine|my-|right|send/.test(classText)
            || rect.left + rect.width / 2 > window.innerWidth * .68
        })
      if (hasPriorOutbound) {
        return { ok: false, retryable: false, alreadyContacted: true, reason: '当前 BOSS 会话已有我方消息，已阻止重复发送招呼语。' }
      }
      input.focus()
      if (input.isContentEditable) {
        document.execCommand('selectAll', false)
        document.execCommand('insertText', false, message)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }))
      } else {
        setNativeValue(input, message)
      }
      if (editableValue(input) !== clean(message)) {
        return { ok: false, retryable: true, reason: '聊天输入框尚未完成写入' }
      }
      if (!${clickSend ? 'true' : 'false'}) return { ok: true, drafted: true }
      await sleep(450)
      input = findInput() || input
      const send = findSend(input)
      if (!send) return { ok: false, retryable: true, reason: '消息已写入，正在等待发送按钮启用' }
      send.click()
      return { ok: true, sent: true }
    })()
  })()`
}
