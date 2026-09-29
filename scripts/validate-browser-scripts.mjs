import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const sourcePath = path.resolve('src/boss.ts')
const source = fs.readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sourcePath
}).outputText

const moduleRecord = { exports: {} }
new Function('module', 'exports', compiled)(moduleRecord, moduleRecord.exports)
const boss = moduleRecord.exports

const scripts = [
  ['collectJobsScript', boss.collectJobsScript],
  ['captchaDetectionScript', boss.captchaDetectionScript],
  ['collectJobDetailScript', boss.collectJobDetailScript],
  ['collectBossChatsScript', boss.collectBossChatsScript],
  ['prepareBossResumeSendScript', boss.prepareBossResumeSendScript],
  ['prepareBossProactiveResumeSendScript', boss.prepareBossProactiveResumeSendScript],
  ['confirmBossResumeSendScript', boss.confirmBossResumeSendScript],
  ['prepareBossResumeSelectionScript', boss.prepareBossResumeSelectionScript],
  ['prepareBossResumeDialogSendScript', boss.prepareBossResumeDialogSendScript],
  ['selectBossExpectationScript', boss.selectBossExpectationScript('产品经理', '成都')],
  ['bossExpectationStateScript', boss.bossExpectationStateScript('产品经理', '成都')],
  ['inspectBossActiveConversationScript', boss.inspectBossActiveConversationScript('招聘者', '示例公司')],
  ['openBossConversationScript', boss.openBossConversationScript('example-id', '招聘者', '示例公司')],
  ['fillBossReplyScript', boss.fillBossReplyScript('测试回复')],
  ['sendBossReplyScript', boss.sendBossReplyScript('测试回复')],
  ['confirmBossReplyScript', boss.confirmBossReplyScript('测试回复')],
  ['sendGreetingScript', boss.sendGreetingScript('测试招呼语', false)]
]

for (const [name, script] of scripts) {
  if (typeof script !== 'string' || !script.trim()) throw new Error(`${name} 没有生成脚本文本`)
  try {
    new Function(`return (${script})`)
  } catch (error) {
    throw new Error(`${name} 语法无效：${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`Validated ${scripts.length} browser injection scripts.`)
