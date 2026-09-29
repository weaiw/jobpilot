import { dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import pdfParse from 'pdf-parse'
import type { AppState, KnowledgeChunk, KnowledgeDocument, KnowledgeQaInput } from '../shared/types'
import { getEmbeddingApiKey, hasEmbeddingApiKey } from './store'
import { redactSensitive } from '../shared/security'

function embeddingsEndpoint(baseUrl: string) {
  const trimmed = baseUrl.replace(/\/$/, '').replace(/\/chat\/completions$/, '')
  return `${trimmed}/embeddings`
}

async function extractText(filename: string) {
  const extension = path.extname(filename).toLowerCase()
  const buffer = await fs.readFile(filename)
  if (extension === '.pdf') return (await pdfParse(buffer)).text
  if (extension === '.docx') return (await mammoth.extractRawText({ buffer })).value
  if (['.txt', '.md', '.markdown', '.json', '.csv'].includes(extension)) return buffer.toString('utf8')
  throw new Error(`暂不支持 ${extension || '未知'} 文件`)
}

export async function readDocumentText(filename: string) {
  return extractText(filename)
}

export function chunkText(text: string, size: number, overlap: number) {
  const normalized = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!normalized) return []
  const paragraphs = normalized.split(/\n\n+/).map(item => item.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length <= size) {
      current = current ? `${current}\n\n${paragraph}` : paragraph
      continue
    }
    if (current) chunks.push(current)
    if (paragraph.length <= size) {
      current = paragraph
      continue
    }
    const step = Math.max(1, size - overlap)
    for (let start = 0; start < paragraph.length; start += step) {
      chunks.push(paragraph.slice(start, start + size))
    }
    current = ''
  }
  if (current) chunks.push(current)
  return chunks
}

async function embedTexts(state: AppState, texts: string[]) {
  const apiKey = getEmbeddingApiKey()
  if (!apiKey) throw new Error('请先保存向量嵌入 API Key')
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += 64) {
    const batch = texts.slice(start, start + 64)
    const requestBody: Record<string, unknown> = {
      model: state.config.rag.embeddingModel,
      input: batch,
      encoding_format: 'float'
    }
    if (state.config.rag.embeddingProvider === 'openai' && state.config.rag.embeddingDimensions > 0) {
      requestBody.dimensions = state.config.rag.embeddingDimensions
    }
    const response = await fetch(embeddingsEndpoint(state.config.rag.embeddingBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      const detail = redactSensitive((await response.text()).slice(0, 240))
      if (response.status === 401 || response.status === 403) {
        throw new Error('向量接口鉴权失败。请检查模型 Base URL 与 API Key 是否属于同一服务，或暂时关闭向量检索。')
      }
      if (response.status === 404) {
        throw new Error('当前模型服务没有提供 /embeddings 接口，可关闭向量检索并继续使用关键词检索。')
      }
      throw new Error(redactSensitive(`向量请求失败 (${response.status}): ${detail}`))
    }
    const data = (await response.json()) as { data?: Array<{ embedding: number[]; index: number }> }
    const ordered = (data.data || []).sort((a, b) => a.index - b.index)
    if (!ordered.length) throw new Error('向量接口返回为空')
    const actualDimensions = ordered[0].embedding.length
    if (state.config.rag.embeddingDimensions > 0 && actualDimensions !== state.config.rag.embeddingDimensions) {
      throw new Error(`向量维度不匹配：配置为 ${state.config.rag.embeddingDimensions}，接口返回 ${actualDimensions}`)
    }
    vectors.push(...ordered.map(item => item.embedding))
  }
  return vectors
}

export async function importKnowledgeFiles(state: AppState) {
  const result = await dialog.showOpenDialog({
    title: '导入求职知识库',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文档', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'json', 'csv'] }
    ]
  })
  if (result.canceled) return state
  const next = structuredClone(state)
  for (const filename of result.filePaths) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const document: KnowledgeDocument = {
      id,
      name: path.basename(filename),
      path: filename,
      type: path.extname(filename).slice(1).toLowerCase(),
      chunkCount: 0,
      importedAt: new Date().toISOString(),
      status: 'embedding'
    }
    next.knowledgeDocuments.push(document)
    try {
      const text = await extractText(filename)
      const parts = chunkText(text, next.config.rag.chunkSize, next.config.rag.chunkOverlap)
      const chunks: KnowledgeChunk[] = parts.map((part, index) => ({
        id: `${id}-${index}`,
        documentId: id,
        sourceName: document.name,
        text: part,
        index
      }))
      document.chunkCount = chunks.length
      document.status = 'ready'
      next.knowledgeChunks.push(...chunks)
      if (next.config.rag.enabled && next.config.rag.embeddingEnabled && hasEmbeddingApiKey()) {
        try {
          const vectors = await embedTexts(next, chunks.map(chunk => chunk.text))
          vectors.forEach((vector, index) => { if (chunks[index]) chunks[index].embedding = vector })
        } catch (error) {
          document.warning = `向量生成失败，已自动使用关键词检索：${redactSensitive(error instanceof Error ? error.message : String(error))}`
        }
      }
    } catch (error) {
      document.status = 'error'
      document.error = redactSensitive(error instanceof Error ? error.message : String(error))
    }
  }
  next.updatedAt = new Date().toISOString()
  return next
}

function normalizeQaInput(input: KnowledgeQaInput) {
  const category = String(input?.category || '其他').trim().slice(0, 60) || '其他'
  const question = String(input?.question || '').trim().slice(0, 500)
  const answer = String(input?.answer || '').trim().slice(0, 8000)
  if (!question) throw new Error('请填写问题')
  if (!answer) throw new Error('请填写标准回答')
  return { category, question, answer }
}

function qaText(category: string, question: string, answer: string) {
  return `求职问答口径\n分类：${category}\n问题：${question}\n标准回答：${answer}`
}

export async function upsertKnowledgeQa(state: AppState, input: KnowledgeQaInput) {
  const next = structuredClone(state)
  const values = normalizeQaInput(input)
  const now = new Date().toISOString()
  const existing = input.id ? next.knowledgeQas.find(item => item.id === input.id) : undefined
  const id = existing?.id || randomUUID()
  const documentId = existing?.documentId || `qa-${id}`
  const sourceName = `问答口径：${values.question.slice(0, 36)}`

  const qa = {
    id,
    documentId,
    ...values,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }
  if (existing) Object.assign(existing, qa)
  else next.knowledgeQas.unshift(qa)

  let document = next.knowledgeDocuments.find(item => item.id === documentId)
  if (!document) {
    document = {
      id: documentId,
      name: sourceName,
      path: '',
      type: 'qa',
      chunkCount: 1,
      importedAt: now,
      status: 'ready'
    }
    next.knowledgeDocuments.unshift(document)
  } else {
    document.name = sourceName
    document.chunkCount = 1
    document.status = 'ready'
    document.error = undefined
    document.warning = undefined
  }

  const chunk: KnowledgeChunk = {
    id: `${documentId}-0`,
    documentId,
    sourceName,
    text: qaText(values.category, values.question, values.answer),
    index: 0
  }
  next.knowledgeChunks = next.knowledgeChunks.filter(item => item.documentId !== documentId)
  next.knowledgeChunks.unshift(chunk)

  if (next.config.rag.enabled && next.config.rag.embeddingEnabled && hasEmbeddingApiKey()) {
    try {
      chunk.embedding = (await embedTexts(next, [chunk.text]))[0]
    } catch (error) {
      document.warning = `向量生成失败，已自动使用关键词检索：${redactSensitive(error instanceof Error ? error.message : String(error))}`
    }
  }
  next.updatedAt = now
  return next
}

export async function rebuildEmbeddings(state: AppState) {
  const next = structuredClone(state)
  if (!next.config.rag.embeddingEnabled) return next
  const vectors = await embedTexts(next, next.knowledgeChunks.map(chunk => chunk.text))
  vectors.forEach((vector, index) => { if (next.knowledgeChunks[index]) next.knowledgeChunks[index].embedding = vector })
  next.knowledgeDocuments.forEach(document => {
    if (document.status !== 'error') {
      document.status = 'ready'
      document.warning = undefined
    }
  })
  next.updatedAt = new Date().toISOString()
  return next
}

export async function retryKnowledgeDocument(state: AppState, documentId: string) {
  const next = structuredClone(state)
  const document = next.knowledgeDocuments.find(item => item.id === documentId)
  if (!document) throw new Error('找不到需要重试的知识库文档')
  next.knowledgeChunks = next.knowledgeChunks.filter(chunk => chunk.documentId !== documentId)
  document.status = 'embedding'
  document.error = undefined
  document.warning = undefined
  try {
    const text = await extractText(document.path)
    const parts = chunkText(text, next.config.rag.chunkSize, next.config.rag.chunkOverlap)
    const chunks: KnowledgeChunk[] = parts.map((part, index) => ({
      id: `${document.id}-${index}`,
      documentId: document.id,
      sourceName: document.name,
      text: part,
      index
    }))
    document.chunkCount = chunks.length
    document.status = 'ready'
    next.knowledgeChunks.push(...chunks)
    if (next.config.rag.enabled && next.config.rag.embeddingEnabled && hasEmbeddingApiKey()) {
      try {
        const vectors = await embedTexts(next, chunks.map(chunk => chunk.text))
        vectors.forEach((vector, index) => { if (chunks[index]) chunks[index].embedding = vector })
      } catch (error) {
        document.warning = `向量生成失败，已自动使用关键词检索：${redactSensitive(error instanceof Error ? error.message : String(error))}`
      }
    }
  } catch (error) {
    document.status = 'error'
    document.error = redactSensitive(error instanceof Error ? error.message : String(error))
  }
  next.updatedAt = new Date().toISOString()
  return next
}

function cosine(a: number[], b: number[]) {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] ** 2
    normB += b[index] ** 2
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}

function tokens(text: string) {
  const lower = text.toLowerCase()
  const words: string[] = lower.match(/[a-z0-9+#.]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []
  const chinese = (lower.match(/[\u4e00-\u9fff]/g) || []).join('')
  for (let index = 0; index < chinese.length - 1; index += 1) words.push(chinese.slice(index, index + 2))
  return new Set(words)
}

function lexicalScore(query: string, text: string) {
  const queryTokens = tokens(query)
  const textTokens = tokens(text)
  if (!queryTokens.size) return 0
  let overlap = 0
  queryTokens.forEach(token => { if (textTokens.has(token)) overlap += 1 })
  return overlap / Math.sqrt(queryTokens.size * Math.max(1, textTokens.size))
}

export async function retrieveKnowledge(state: AppState, query: string) {
  if (!state.config.rag.enabled || !state.knowledgeChunks.length) return []
  let queryVector: number[] | undefined
  if (state.knowledgeChunks.some(chunk => chunk.embedding) && hasEmbeddingApiKey()) {
    try { queryVector = (await embedTexts(state, [query]))[0] } catch { queryVector = undefined }
  }
  return state.knowledgeChunks
    .map(chunk => ({
      chunk,
      score: queryVector && chunk.embedding
        ? cosine(queryVector, chunk.embedding) * 0.82 + lexicalScore(query, chunk.text) * 0.18
        : lexicalScore(query, chunk.text)
    }))
    .filter(item => item.score >= state.config.rag.minimumScore || item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, state.config.rag.topK)
}

export async function testEmbeddingConnection(state: AppState) {
  const startedAt = Date.now()
  const vectors = await embedTexts(state, ['这是一次求职知识库向量连接测试。'])
  return {
    provider: state.config.rag.embeddingProvider,
    model: state.config.rag.embeddingModel,
    dimensions: vectors[0]?.length || 0,
    latencyMs: Date.now() - startedAt
  }
}
