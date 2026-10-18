# AIS 反代 · Windows 桌面版（Node.js 重写）

把 Google AI Studio 网页版变成本地 API：同时提供 **OpenAI 兼容接口** 和 **Gemini 原生接口**，完整支持函数调用（工具调用）、流式输出、思考内容、图片输入、JSON 结构化输出，多个 Chrome 配置文件轮询使用。

基于本仓库（aistudio-api）的协议逆向成果（Wire 数组格式、BotGuard 签名流程），用 Node.js 零依赖重写，面向 Windows 电脑日常使用。

## 相比原版的优势

### 实测验证过的

| | 原版 | 桌面版 |
|---|---|---|
| **函数调用** | 只有 Gemini 原生协议。Gemini 3 系列回传工具结果时如果缺少「思维签名」，AI Studio 直接返回 400（`Function call is missing a thought signature`），而 OpenAI 类客户端不会保留这个字段 | 按调用 id 缓存思维签名，客户端丢了也自动补上；实测 OpenAI / Gemini 两种客户端的多轮、并行工具调用、`tool_choice` 指定函数都能通过 |
| **OpenAI 接口** | 无 | `/v1/chat/completions`：流式、tools、tool_choice、`reasoning_content`、`response_format`（json_schema）、图片输入 |
| **握手** | 让模型真的生成一次 "say 1" 再按停止，消耗额度 | 在请求离开浏览器前就拦截掉，只拿模板，**不消耗额度**，约 1.5 秒；反代重启时直接复用页面上已有的握手，0 秒恢复 |
| **换模型** | 整份沿用页面捕获的请求模板 | 模板带着页面当前所选模型的专属参数（例如在 4a 下捕获的生成配置第 47 位），套到别的模型上会被拒为 `unsupported capabilities`；桌面版只沿用通用字段，换模型不出错 |
| **后台稳定性** | — | 工作标签页在后台 5 分钟后会被 Chrome 冻结或节流，导致请求卡几十秒；桌面版签名头同步计算、使用页面加载前保存的原生 fetch、并让标签页持有 Web Lock 和本地 WebRTC 连接，后台放置 6.5 分钟后复测，首字仍约 2 秒 |
| **工具定义兼容** | Schema 原样转换 | 自动处理 `$ref`/`$defs`、`anyOf` 带 null、`const`、类型数组、`additionalProperties` 等 Gemini 不认的写法，不会因为工具定义报 400 |
| **思考强度** | — | 模型不支持 minimal 时自动降为 low 重试（实测 gemini-4-argon、gemini-3.8-flash 都不支持 minimal）；面板可单独给 gemini-4-argon 固定思考强度（low 下首字约 3~4 秒，high 约 8~9 秒） |
| **可观测性** | 调用量统计 | 每条请求记录签名耗时、谷歌响应头到达时间、首字时间、TPS、思考强度，能直接看出慢在反代还是慢在谷歌 |

### 设计上的差别（没有和原版做对照测试）

- 签名头（SAPISIDHASH）在页面里直接算，原版每个请求都要通过 CDP 读一次 Cookie；桌面版反代自身开销只有几毫秒。
- 零依赖的 Node.js（不需要 Python / uv / Vue 构建），双击 `start.bat` 就能用。
- 扩展模式直接借用日常使用的 Chrome，不需要另开一个受控浏览器。

### 不如原版的地方

- **扩展模式下，对应的 Chrome 配置文件要开着**。原版用 Cookie 导入，可以完全脱离日常浏览器后台运行。
- 只做了 Windows 桌面版，没有 Docker / Linux / Termux 部署。
- 生图只是透传，没有专门处理或测试。
- 测试是 10 个离线单元测试加 9 项在线实测，远少于原版。

## 快速开始

1. 安装 Node.js 22 以上。
2. Chrome 打开 `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `desktop/extension` 文件夹。
3. 双击 `desktop/start.bat`（首次运行会自动生成 `config.json`，可参考 `config.example.json`）。
4. 扩展会在 Chrome 里自动打开一个固定的 AI Studio 标签页（地址末尾带 `#ais-worker`），几秒后就绪。不要关掉它，放在后台即可。
5. 打开 <http://127.0.0.1:8765/> 进入控制面板。

## 多账号轮询

每个装了扩展的 **Chrome 配置文件**就是一个账号：打开那个配置文件，它就自动加入轮询；窗口关掉后显示「未打开」，再次打开会自动恢复。

控制面板里可以：

- 启用 / 停用 / 移除账号、重新握手、跳到它的工作标签页；
- 选择轮询方式：「每个请求换一个账号」或「用到限额再换下一个」。

某个账号的某个模型触发 429 后会自动冷却并跳过；签名失效（403）时会自动刷新标签页重新握手。点扩展图标可以设置某个配置文件不参与轮询。

## 接入客户端

| 客户端 | 设置 |
|---|---|
| OpenAI 兼容（SillyTavern「自定义 OpenAI 兼容」、Cherry Studio、各类 Agent） | 地址 `http://127.0.0.1:8765/v1`，Key 随意（除非在 config.json 设置了 `apiKey`） |
| Gemini 原生（SillyTavern 选 Google AI Studio 并填写反向代理、google-genai SDK） | 地址 `http://127.0.0.1:8765` |

模型名使用 AI Studio 里的名字（`GET /v1/models` 可查看）。模型名后加 `-search` 会自动开启谷歌搜索。

## config.json

| 字段 | 说明 |
|---|---|
| `port` / `host` | 监听地址。要给局域网其他设备使用时把 host 改成 `0.0.0.0`，并务必设置 `apiKey` |
| `apiKey` | 访问密钥，留空则不校验 |
| `rotation` | `round-robin`（每个请求换账号）或 `sticky`（用到限额再换） |
| `thinkingOverrides` | 按模型固定思考强度，例如 `{"gemini-4-argon": "low"}`（面板里可直接设置） |
| `safetyOff` | 默认 `true`，所有安全过滤设为关闭 |
| `defaultThinkingLevel` | 请求没有指定时的思考强度：`minimal` / `low` / `medium` / `high` |
| `includeThoughts` | 是否把思考内容返回给客户端 |
| `requestTimeoutSeconds` | 谷歌连续多久没有任何数据才判定超时（生成中只要数据在流就不会断） |
| `mode` / `browserPath` / `debugPort` / `userDataDir` / `accounts` / `minimizeBrowser` | `mode: "chrome"` 时由反代自己启动一个独立 Chrome（需在弹出的窗口里登录），一般不需要 |

更新扩展文件后不需要手动重新加载：反代发现扩展版本与磁盘上的 `manifest.json` 不一致时，会自动让扩展重新加载。

## 测试

```bash
npm test               # 离线：协议编解码、Schema 转换、格式转换
node test/e2e.mjs      # 在线：需要反代正在运行，会发送几条真实请求（消耗少量 AI Studio 免费额度）
node test/ttft.mjs gemini-4-argon "你好" low medium high   # 各思考强度的首字耗时
```

## 已验证的协议细节

- 函数调用 Part 在下标 10：`[name, Struct, call_id]`；函数结果在下标 11；思维签名在下标 14；思考文本标记在下标 12（值为 1）。
- 回传的函数调用缺少思维签名 → 400；官方允许的占位签名 `skip_thought_signature_validator` 可以通过。
- 用 Cookie 直接计算的 SAPISIDHASH 会被接受；AI Studio 页面自身通过 XHR 发送 GenerateContent。
- 谷歌在模型输出第一个 token 时才返回响应头，所以长时间无响应是上游在排队。
