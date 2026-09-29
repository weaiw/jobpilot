const { app, BrowserWindow } = require('electron')

const compiledBossModule = process.argv[2]
if (!compiledBossModule) throw new Error('缺少已编译的 boss 模块路径')

app.whenReady().then(async () => {
  const { sendBossReplyScript } = require(compiledBossModule)
  const window = new BrowserWindow({ show: false, width: 900, height: 700 })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <body style="margin:0;height:700px">
        <textarea id="chat" placeholder="输入消息" style="position:absolute;left:80px;top:430px;width:600px;height:100px"></textarea>
        <button id="send" style="position:absolute;left:700px;top:470px;width:100px;height:40px">发送</button>
        <script>window.sendClicks = 0; document.querySelector('#send').addEventListener('click', () => { window.sendClicks += 1 })</script>
      </body>
    </html>
  `)}`)
  const prepared = await window.webContents.executeJavaScript(sendBossReplyScript('本地模拟消息'), true)
  const state = await window.webContents.executeJavaScript(`({ value: document.querySelector('#chat').value, sendClicks: window.sendClicks })`, true)
  if (!prepared.ok || prepared.x === undefined || prepared.y === undefined) throw new Error(`发送脚本未定位按钮：${JSON.stringify(prepared)}`)
  if (state.value !== '本地模拟消息') throw new Error(`消息未正确填入：${JSON.stringify(state)}`)
  if (state.sendClicks !== 0) throw new Error('发送脚本不应直接点击按钮')
  console.log(JSON.stringify({ ok: true, prepared, state }))
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
