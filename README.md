# 折光故事工坊

一个本地中文小说创作与训练数据准备工作台。网页按“需求解析 → 故事圣经 → 全书大纲 → 场景规划 → 正文写作 → 一致性审校 → 分支与修订”工作；生成请求由本地 Node 服务转发到 OpenAI Responses API。项目还提供持久化长期记忆、显式授权的数据集、微调/续训数据包、调用指标和基础漂移告警。运行时使用 `diff@9.0.0`，固定离线评测使用 Node 原生断言，浏览器验收使用 `@playwright/test@1.64.1`；版本及间接依赖由锁文件固定。

唯一活动入口是 `server.mjs + public/`。旧 Next/Vite/Sites 原型仅保留在原电脑的 `archive/legacy-next-sites/`，不入库、不参与运行、测试或构建。

代码按 GitHub **公开源码仓库**边界准备；实际远端状态请核对 `git remote -v` 和仓库可见性。公开范围仅限经过审查的程序、文档和脱敏测试样例；小说、数据库、作品历史版本、API 密钥和加密备份仍由用户独立保管，不上传。全部 `output/`、本地模型权重、虚拟环境、构建目录与机器专用配置均被忽略。公开提交可能被复制，不能依靠事后删除恢复保密。GitHub 不负责运行网页，也不能替代作品备份。完整操作和换机验收见 [安全入库、独立备份与 Windows/macOS 迁移](docs/migration.md)。

## 环境要求

- 固定使用 `.node-version` 中的 **Node.js 24.20.0**；使用内置 `node:sqlite`。其他版本尚未纳入本次复现基线
- 使用 npm 和 `package-lock.json` 安装；本地旧 pnpm 文件保留但不入库，不作为受支持安装路径
- 安装 Git 并确保 `git` 在 PATH 中；新克隆执行 `node scripts/install-git-hooks.mjs`，钩子不会随克隆自动启用
- 只有真实模型生成需要可用的 `OPENAI_API_KEY`；页面编辑与模拟回归不需要密钥
- 默认模型为 GPT-6 Astra（`gpt-6-astra`），可通过 `OPENAI_MODEL` 修改；现有环境变量优先于默认值

## 启动

先进入项目目录并安装指定版本的 Node。密钥通过当前终端环境或独立的系统凭据管理配置，不要写入仓库或命令示例。以下命令没有密钥也可以启动页面；生成时会明确提示未配置。

Windows PowerShell：

```powershell
npm ci --ignore-scripts
$env:OPENAI_MODEL="gpt-6-astra"
npm start
```

macOS Terminal（zsh）：

```zsh
npm ci --ignore-scripts
export OPENAI_MODEL="gpt-6-astra"
npm start
```

`.env.example` 是脱敏字段说明，`npm start` **不会自动读取 `.env` 或 `.env.example`**；复制文件不等于配置已生效。不要把生产密钥放进 GitHub Actions。Windows 注册表中的环境变量不会随代码迁移到 Mac，需要在新设备单独配置。

打开 `http://127.0.0.1:3000`。服务默认只监听本机地址；可用 `PORT` 修改端口。不要直接双击 `public/index.html`，否则无法调用模型或保存文件。

Windows 用户也可以双击 `start-novel-studio.cmd`。该脚本会读取通过 `setx` 保存的用户级 `OPENAI_API_KEY`，并在系统代理已启用时自动将代理交给 Node。不要把 PowerShell 命令粘贴到 `Win + R` 的“运行”窗口。

`npm start` 和 Windows 启动脚本通过 `service-runner.mjs` 启动服务；服务进程意外退出后会按退避策略自动拉起。计算机重启、用户注销或守护进程本身退出后仍需重新启动；它不是 Windows 系统服务。

首次安装在项目目录执行 `npm ci --ignore-scripts`；仅运行不评测可用 `npm ci --omit=dev --ignore-scripts`。不要混用包管理器，不要把 Windows 的 `node_modules` 或 Python 虚拟环境复制到 Mac。本轮没有启用依赖安装脚本。升级代码后必须重启 Node 服务；`GET /api/status` 的 `workflowVersion` 为 `3` 才是本轮服务端任务协议，旧服务会被新网页明确拦截。备份前暂停生成、等待当前请求结束并正常停止服务；使用一致性 SQLite 快照及独立加密备份，不要只复制正在使用的 `.sqlite` 或仅备份 JSON，详见迁移文档。

未配置 API Key 时，页面仍可打开和编辑，但模型生成接口会明确返回 HTTP 503，不会用模板冒充模型结果。

## 验证与构建

源码推送保护：首次克隆或换机后执行 `node scripts/install-git-hooks.mjs`。之后普通 `git push` 会自动检查所有待推送分支/标签的完整可达历史，敏感文件先提交再删除也会被阻止；不会上传被检查的正文或密钥。`npm run test:push-safety` 用隔离本地仓库验证真实推送。检查失败须先修正历史，不能只删除当前文件。检测范围、误报边界及本地钩子可绕过的限制见迁移文档；GitHub 网页/API 上传不经过本机钩子。

```powershell
npm run check
npm run deps:check
npm test
npm run eval
npm run build
# 或使用不依赖 npm 命令可用性的完整验证：
node scripts/verify.mjs
```

回归不调用真实模型：API 测试使用回环地址的模拟服务，平台单元测试使用内存 SQLite。API 测试生成的数据作为正式验证记录保存在 `output/verification/api-<运行ID>/`，不写入用户小说目录，不创建临时脚本；`tests/planning-fixtures.mjs` 是永久回归样例，不参与生产生成。

依赖安全更新（2026-10-17）：经用户确认，固定离线评测改用 Node 原生执行器，保留原有样例、断言和报告，不再安装 Promptfoo 或提供其 CLI。这样从依赖树与锁文件移除 `promptfoo → jks-js → node-forge` 风险链，也移除已无使用者的 `basic-ftp` 强制版本配置；不是修补 Forge、伪造包版本或忽略开发/可选依赖。[上游 JKS 调整](https://github.com/promptfoo/promptfoo/pull/11739) 已合并但检查时尚未发布 npm 稳定版；[Forge 公告](https://github.com/advisories/GHSA-86w9-cpqp-85rv) 仍无正式修复版。新的隔离安装完整审计为 0，运行时 `diff` 和浏览器验收版本未变。

`npm run deps:check` 显式包含开发、可选与 peer 依赖，任何已知等级漏洞均返回非零退出码；手动 CI 也执行同一检查。此命令需要访问 npm 安全公告服务，网络/服务错误不是通过；`node scripts/verify.mjs` 保持离线，不能代替依赖审计。审计为 0 仅代表当时公告库中未报告风险，不保证没有未知漏洞；不要直接执行 `npm audit fix --force`，未来引入新依赖仍须完整审计与回归。

`.github/workflows/verify.yml` 提供 Windows/macOS 矩阵，固定官方 Action 提交，只能手动触发 `workflow_dispatch`，不会因提交或推送自动运行。它运行 `node scripts/verify.mjs`，不上传 `output/` 或 artifact、不配置生产密钥、不执行真实模型调用。实际触发前应确认 GitHub Actions 额度；仓库中存在此文件不代表 Mac 已通过验收。本次跨平台代码准备与 Windows 回归不能代替 Mac 实机、浏览器和迁移验收。

`npm run build` 会创建可复制运行的 `dist/`，其中包含服务端、静态网页、`diff` 运行依赖及最小 `package.json`，不包含浏览器验收开发依赖。在 `dist/` 中执行 `npm start` 即可运行。构建只更新程序文件，不删除部署目录中已有的小说。

### 固定评测与可复现实验

- `npm run eval` 使用 Node 原生断言检查同一组 10 个编辑验收案例，目标固定 2500 字，自动定稿范围 2200–2800 字；记录模型、相同前文/章节卡/原稿及旧新提示词的 SHA-256。报告保留 `summary.stats` 计数、逐案例实际值/期望值以及事实、检索结果，并明确标识原生执行器，不冒充 Promptfoo 专有报告格式。空案例、非法输入、断言不符或执行异常均不能作为通过结果。没有遥测、更新查询或缓存，禁止网络调用，`paidCalls=0`。这些是工程护栏回归，不是生成小说的文学对照结果。
- 同一命令比较旧抽取基线与新证据规则的 13 个固定案例，以及 4 个基于真实本地哈希向量的实体别名检索案例；`results.json`、`facts.json`、`memory.json`、`memory-inputs.json` 保存于 `output/verification/eval-<时间>/`。固定开发集存在选择偏差，不能把通过率当真实全文准确率。
- `node scripts/evaluate.mjs --bge-artifact <文件> --extraction-artifact <文件>` 可离线评估外部实验产物，两项均可省略。BGE 文件须有 `model: "BAAI/bge-m3"`、`dimension:1024`、按 `memory-inputs.json` 顺序排列的 `vectors:[{sourceHash,vector}]`；抽取文件为 `[{id,extraction:{sourceHash,observations}}]`。观察项必须包含 `start/end/evidence/category/subject/predicate/object/time/modality`，偏移按 UTF-16，原文必须精确匹配。实验只评分，不自动启用生产路径。
- 默认生产路径仍使用证据规则和哈希/别名检索；普通离线评测未提供外部产物时记录 `NOT_RUN`。2026-10-02 已单独完成真实 LangExtract 1.7.0 + GPT-6 Astra 抽取、BGE-M3 ONNX INT8 下载与 CPU 推理，未替换生产路径。见下方“真实记忆实验”；这不代表完整精度 BGE 或文学效果已经验证。
- 完整验证 `node scripts/verify.mjs` 保存每条命令、退出码、耗时与日志；`tests/recovery.test.mjs` 会在隔离输出目录实际启动、终止并重启子服务，验证响应恢复、断线未知状态、暂停和重复提交。仅操作自身创建的进程，不操作 3000 端口的现有服务。

## 长期记忆与一致性

- `output/platform.sqlite` 持久化正文分块向量、实体、事件、时间线、事实、调用记录、质量观测和告警。
- 本地向量保留 192 维特征哈希，增加故事圣经稳定人物 ID 与显式别名的检索排序，不把它标记成 BGE。规则和检索均无额外 API 成本，但语义能力弱于专业抽取/嵌入模型。
- 人物、物品转移、否定、推测、角色知识和倒叙统一进入 `story_observations`，每条记录保存原文哈希、段落及精确起止位置。只有确定、当前时间的观察进入正式状态；历史、转述和推测保留为证据，不覆盖现在的状态。未知表达可能漏抽，不能据此推断小说没有该事实。
- 只有章节正文原子保存成功后，才把该章写入正式记忆；模型候选稿和未采纳分支不会进入正式事实。手工修改后可用“重建全文记忆”按当前定稿重算状态，已删除的物品或事实不会沿用旧聚合结果。
- 下一章正文默认读取受字符预算约束的正式记忆：最近章节导航、当前人物状态、物品与伏笔、知识边界、时间线、结构化事实和向量检索出的相关定稿片段。它不再只依赖最近 6000 字，也不会把整本正文重新发送给模型。
- 完结度检查依次执行逐章要素与中段关键事件提取、分卷汇总、全书终审，最后把所有章节审查结果交给模型判断；章节数和字数不作为完结证据。
- 本地规则提供确定性基础证据，模型负责较软的因果、人物动机和文学判断。实体与事件抽取目前以规则为基础，不保证覆盖所有自然语言表达。
- 每章定稿保存后自动写入 `canonical_chapters` 和 `chapter_records`，保存章节正文、标题、摘要、段落列表和状态变化；人物、物品、伏笔与角色知识边界分别进入独立结构化表。
- 矛盾记录包含严重性、具体描述以及每一侧的章节号、段落号和原文证据。页面可执行章节审查、指定章节范围的卷级审查和全书审查。

## 正文质量闭环

### 结构化规划与生成意图

- “首次生成”“重新构思”“修订既有方案”“按正文进度继续规划”使用不同的数据边界。重新构思不回传目标模块的旧答案，不把旧需求解析的推断当用户明确要求；修订读取目标原稿与有效上游，审校和未采纳分支不作为规划事实。已有正文或已锁定项目不能重新构思，可修订或另建小说。
- 故事圣经、大纲和场景规划通过严格 JSON Schema 输出，并在服务端检查类型、长度、唯一 ID、连续分卷范围和引用完整性。页面 Markdown 由同一结构渲染，不再通过标题文本识别章节。
- `project.planning` 保存稳定人物/规则/伏笔 ID、全书卷章范围、章节卡、标题来源及本项目已采纳的故事核心历史；随项目修订进入 SQLite 历史快照。字段结构不包含预设故事答案。世界规则的代价与限制分开保存。
- 正文前调用 `POST /api/planning/prepare`：旧圣经和大纲按需转换结构，再按已保存正文进度准备当前卷最多 3 张近期章节卡。已有有效章节卡不重复调用模型；没有有效卡时正文接口明确拒绝，不截取旧场景规划末尾代替。单章目标仍为 2500 字。
- 场景卡引用本书人物、规则与伏笔，并携带目标、阻碍、选择、代价、关系变化、信息边界及结束状态。“查看实际章节卡与世界规则”显示下一章实际使用的数据。
- 用户输入或上游正文编辑会令相关下游显示“待同步”，但保留原文与历史。服务端保存时重新计算失效状态，不能靠浏览器提交空状态绕过。生成期间发生并发修改会拒绝覆盖；生成的规划原子保存后才返回新修订号。
- 重新构思圣经时，按冲突、世界机制、关系结构、关键转折四维检查与本项目已采纳核心的相似度。字符二元组检查能拦截部分换名重写，不是完整语义原创性审查，也不能保证无限原创或不同项目绝不雷同。
- 旧作品不会批量转换或重写。首次准备章节可能增加圣经转换、大纲转换和近期规划调用；转换结果仍需用户核对是否忠实保留旧设定。原稿可以从历史版本恢复。规划费随章节卡保留，正文失败后重试复用规划并沿用其已发生费用记录。

- 题材规则只保留抽象机制，例如公平线索、能力代价和信息边界；不再预置人名、地点、职业、关键物品或情节答案。规则检查读取当前作品内容，不把固定示例当作文学正确答案。
- 故事圣经必须把主要人物的私人欲望、底线和说话方式补成可执行设定；首次进入正文前仍有这些核心占位时，接口返回 `PLANNING_NOT_READY`，而不是把“待定”继续传入正文。
- 页面提供可选“作者风格卡”。每章先建立近期章节卡，明确视角、目标、阻碍、选择、后果、冲突变化和知识边界；正文候选完成后再执行一次严格 JSON Schema 的独立章节编辑，优先局部修订并限制为一轮。
- 页面分别显示规则一致性、单章编辑状态和完结度。规则一致性分只表示当前程序能检查的硬规则，不宣称是文学质量分。

### 中文小说编辑与候选稿验收

单章编辑采用 `zh-fiction-1` 规则，参考 Humanizer 3.0.0 的固定提交 `9862685f575c65a8247f90369951df1b3416e3d6`（https://github.com/blader/humanizer）。运行时不下载规则，不安装另一个模型，也不修改模型权重。

- 只在现有 `chapter_edit` 中检查冗余解释、空泛拔高、机械句式与重复收尾。不使用全局禁词或标点替换；保留中文引号、破折号、口头禅、有意重复、悬疑留白和作品风格。虚构作品的编辑也不允许凭空增加正式事实。
- 单章目标仍为约 2500 字。自动定稿范围为 **2200–2800 个非空白正文字符**（不含章节标题，标点计入），修订删减超过原稿正文的 15% 时交人工核对。这是可解释的工程护栏，不是文学质量指标；不能靠填充无关情节达标。
- 原稿 → 一轮编辑 → 程序验收；实际发生改写且基础验收通过时，再进行一次独立的 `chapter_edit_audit` 调用，逐段比较原稿、修订稿和章节卡中的正式记忆。核对人物/物品/规则、事件、时间、知识边界、伏笔、视角及意义，检查证据引文是否存在于对应段落。非空行从 1 编号，章节标题也计一段。
- `approved:false`、未解决的 error、超长/过短、明显删减、人物名称丢失、已有规则矛盾、语义结果缺失/拒绝/证据错误均不能自动定稿。未改变的合格稿件不增加语义复核调用；`edit:false` 不能绕过验收。
- 候选原稿、修订稿、验收结果及调用费用进入 SQLite 的 `chapter_candidates`，不进入正式故事记忆、不增加已完成章节数。网页正文区域提供原稿/修订稿对照与“人工确认采用”按钮；刷新或重新载入项目可找回该章最新候选。未通过时批次暂停，不自动反复改写。
- 章节追加必须引用本项目服务端候选 ID；服务器核对正文、章节号、生成时的项目修订及验收状态。人工采用需二次确认，会记录 `acceptedBy:human`；它不伪装成自动验收通过。人工可接受字数或语义风险，但不能越过章节结构、权限或修订冲突。若已修改项目，旧候选不能直接覆盖，应按新修订生成或人工编辑正文。
- 改写章节通常需要正文、编辑、独立复核三次逻辑调用，未改写章节通常为两次；格式/网络重试仍有限制。调用次数不等于尝试次数。三环节及失败尝试的已知 token、费用和耗时均记录；复核失败仍保存候选，避免把网络失败当作内容通过。
- 这些检查不保证完整语义正确，也没有证据证明中文小说质量已经提高。推广前用固定片段、相同前文/模型/篇幅比较旧编辑与新编辑，盲评继续阅读偏好、人物声音、事实/伏笔保留、人工改稿量和总成本。不得把模拟响应或规则分当真实读者评价。

运行新增与既有回归：`npm run check`、`npm test`、`npm run build`。浏览器隔离验收可用 PowerShell 执行 `$env:NOVEL_BROWSER_VERIFY="1"; node --test tests/api.test.mjs`；测试结束后会显示回环 URL 并保留模拟服务，按 Ctrl+C 结束，随后移除该进程的 `NOVEL_BROWSER_VERIFY` 环境变量。数据写入原有 `output/verification/api-<运行ID>/` 作为持久化验证记录，不创建临时脚本、不读取生产数据库、不调用真实模型。

Humanizer 改编部分许可（保留原许可全文）：

```text
MIT License

Copyright (c) 2025 Siqi Chen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

2026-09-13 工程验收：Windows / Node v24.20.0；基线 102 项回归通过，接入后 118 项通过，`node scripts/verify.mjs` 完成语法检查、回归和构建。隔离构建的 `/`、`/studio-v2.js`、`/novel-core.mjs`、`/api/health` 均返回 200 且包含对应内容。测试数据库重新打开后候选仍存在，被拦截项目未产生正式章节。所有生成均为模拟响应，未调用真实账户，未修改生产小说。

浏览器验收更新（2026-09-13）：应用内浏览器插件引用的 `browser/26.908.40834/scripts/browser-service.mjs` 仍缺失；改用本机已有 Playwright 和独立 Edge 153.0.4234.32 无头实例完成真实渲染、DOM 点击与截图，不读取日常浏览器配置。10 组流程通过：七模块导航、候选双稿与证据、取消不保存、刷新恢复、人工采用原稿、继续生成下一章、真实导出链接、人工采用修订稿、旧修订拦截、匿名盲评链接及表单提交。发现并修复了人工定稿后同步数据会跳回“需求解析”的问题，同项目数据同步现在保留当前工作模块。

本次浏览器证据位于 `output/verification/api-f65db5ab-09ad-4a14-b371-6b76b1722032/browser-results.json`，截图为同目录 `candidate-comparison.png`、`reader-form-qa.png` 和 `browser-final.png`。这些样本和表单答案均为明确标注的隔离测试数据，不是文学样本或真实读者反馈。真实模型格式兼容性、中文文学效果、读者盲评和实际账单费用仍待另行验证。

真实浏览器验收使用锁定的 `@playwright/test` 和其配套 Chromium，不需要旧机器的 Playwright 目录、Edge 路径、数据库或正在运行的网页。Windows PowerShell 与 macOS Terminal 使用相同命令：

```text
npm ci --ignore-scripts
node scripts/install-git-hooks.mjs
node scripts/verify.mjs
npm run browser:install
npm run browser:verify
```

`browser:install` 下载当前锁定版本对应的 Chromium，需要网络和磁盘空间，不读取日常浏览器配置。`browser:verify` 自动启动独立回环模拟服务、创建新的测试数据库，顺序执行候选定稿、工作台、边界、切换竞争及训练准备的浏览器流程，并关闭本次服务。模型凭据不会传入测试子进程，浏览器请求限制到测试服务；不访问原 3000 端口或根 `output/platform.sqlite`，不执行远程生成或训练。

普通 `npm test` 仍会明确跳过需要浏览器的那一项，因此完整验收必须另外运行 `npm run browser:verify`。缺少浏览器、服务启动失败或任一点击断言失败会返回非零退出码，不能解释为通过。日志、结果和截图保存在 `output/verification/` 的本次独立目录中。自动填写的盲评答案只是测试夹具，不是真实读者评价。

文学盲评验收口径：同一组必须共用设定、前文、章节卡、模型、原始候选和篇幅目标，比较旧编辑与中文小说新编辑，而非把未经编辑的初稿充当旧流程。隐藏版本来源并随机排列；由真实读者提交继续阅读偏好、人物声音、情节理解、伏笔保留和修改意见。两个样本组只能发现案例层面的收益或损伤，不能据此宣称总体提升比例或统计显著。没有真实回答时响应数必须为 0，不用模型评分或自动化表单提交代替。

## 批量生成、历史版本与费用

- 正文批次由服务端 worker 顺序执行，浏览器只提交带幂等请求 ID 的命令并查询状态。关闭页面或前端断网不再终止任务；服务重启把任务置为暂停，必须显式“继续批次”才恢复。暂停会完成已开始的当前章，不发起下一章；规划调用尚未结束时则先完成当前规划。达到规划章数仅结束该批次，仍需手动点击“检查完结度”，不能把字数或章数当成故事完结。
- 定稿正文、修订号、结构化状态和候选提交回执在一个 SQLite 事务中提交；项目读取以数据库 head 为准，`project.json` 为可恢复副本，写副本失败会记录告警。重复追加同一候选返回已提交结果，不增加章节/修订。备份与回滚必须包含一致的 SQLite 数据库，不能用旧 JSON 单独覆盖新数据库。
- 正文任务持久化上游创建结果和响应 ID：已知 ID 继续查询，同一输入的已完成结果复用；重启后不重写已保存候选。若创建连接中断且没有获得响应 ID，则保留“结果待确认”并停止，不盲目重发收费请求。此状态需人工核对服务商记录，本轮没有提供一键强制重发入口。恢复时模型/上游配置变化会被拦截。
- 本机单服务实例使用现有 SQLite 即可管理任务与原子提交，暂不引入 DBOS。不能据此宣称跨机器分布式 exactly-once，也不能保证服务商账单精确一次；崩溃边界的调用计费仍需账单核对。
- 每个模型尝试分别记录状态、输出上限、输入/输出 token、耗时和请求 ID；每章汇总正文作者与章节编辑的 token、预估费用、耗时和真实重试次数。截断重试会提高该次输出上限，并把失败尝试的已知用量计入统计。
- 默认使用 GPT-6 Astra 和 Standard 服务层，不主动启用 Fast。按 2026-10-02 [官方模型页](https://developers.openai.com/api/docs/models/gpt-6-astra)的价格，每百万 input/cached/cache-write/output token 为 `$10/$1/$12.5/$50`。费用计算包含 API 返回的缓存写入 token；输入超过 272K 时输入与缓存按 2 倍、输出按 1.5 倍计费。可通过 `MODEL_*_USD_PER_MILLION` 覆盖标准单价；更换模型时不要沿用旧模型的单价覆盖值。费用为估算，账户实际账单、地区附加费及特殊合约未核对。
- 每次服务器草稿修订都进入历史。新版本通过内容哈希引用去重后的模块和原样章节片段，不再重复保存整本 JSON；旧版完整快照仍可读取。网页支持全部修订、指定模块/单章的 jsdiff 逐段增删与字符差异，并可把历史快照恢复为新修订。候选稿同样显示逐段差异，文本只通过 DOM textContent 渲染；超大比较明确提示范围限制，不截断后冒充全文差异。

## 真实读者盲评

- 项目所有者可以为指定章节创建七天有效、只能提交一次的盲评链接。
- 盲评页不展示作品名、作者或模型信息，收集是否愿意继续阅读、最感兴趣人物、失去兴趣位置、困惑点、后续预测、机器感和愿意投入时间。
- 系统只统计实际提交，绝不自动生成模拟读者评分。核心指标为真实响应数和“愿意继续阅读率”。

## 训练数据与训练流程

当前程序没有本地小说生成模型或本地训练器；实验目录已有 BGE-M3 INT8 嵌入权重和离线推理脚本，但它只能生成检索向量，不能写小说。“准备微调包”不等于已经训练独立小说模型。若建设本地写作路线，需另行确定开放权重底座及许可证、授权数据、可用内存/显存、训练后端、固定评测集和部署方式；先验证小规模 LoRA/QLoRA 对照效果，再决定是否推广。不得把仅靠界面切换或更换 API 地址描述为本地训练能力。

项目不会默认把任何作品用于训练。只有勾选授权确认、选择“用户自有、明确授权或公版”并完成人工质量评分后，`POST /api/dataset/project` 才会写入去重样本。80 分以下样本不会进入训练包。数据按 `projectId` 分配 train/validation/test，避免同一项目跨集合泄漏，并分别统计规划、正文、审校和修订四类样本。

路线门槛：高质量授权样本不足 100 条或四类样本不完整时，优先优化提示词和评测集；达到 100 条后才比较 RAG；达到 500 条且每类至少 25 条后，才允许把微调纳入固定测试集对照；达到 5000 条后才评估专用模型。门槛只表示“可以开始实验”，不表示微调一定优于提示词或 RAG。

页面可准备两类本地包：

- SFT：生成 OpenAI 消息格式 JSONL，默认目标模型 `gpt-4.1-mini`。
- CPT：生成供外部开源训练后端使用的语料 JSONL；本仓库不实现或假装执行继续预训练。

“准备”不会上传数据、创建任务或产生远程训练费用。人工核验清单后，只有显式执行以下命令才会上传并创建 OpenAI 微调任务：

```powershell
node scripts/submit-finetune.mjs --manifest "output/training/<时间>/manifest.json" --confirm
```

提交前应检查授权、去重、样本量、验证/测试切分和预估费用。远程任务的账户权限、限流、最终指标与模型质量必须在实际账户中单独验收。

新训练包的磁盘 `manifest.json` 使用 v2 相对路径；整体搬迁训练包后仍按清单目录定位。新的数据库记录使用数据根相对引用；API 保持原有本地绝对路径响应。旧清单和旧数据库记录不自动改写。旧绝对路径失效时，核对新目录中同名 `train/validation/test.jsonl` 后可显式使用 `--relocate`；该选项不会取消 `--confirm` 的付费提交确认。备份和换机检查不要执行提交训练命令，详见迁移文档。

## 身份、隔离与配额

- 默认 `NOVEL_AUTH_MODE=local`，仅适用于绑定 `127.0.0.1` 的单用户本机模式。
- 设为 `required` 后，服务只接受 `NOVEL_AUTH_TOKENS_JSON` 中配置的 Bearer token；也可读取 Sites 平台提供的 `oai-authenticated-user-id` 请求头。
- 项目首次写入时绑定所有者；其他用户读取、导出或覆盖会返回 403。管理员角色可访问所有项目。
- 模型调用默认并发 2、等待队列 20、本地长篇模式每用户每日 1000 万 token；分别用 `MODEL_MAX_CONCURRENCY`、`MODEL_MAX_QUEUE` 和 `DAILY_TOKEN_BUDGET` 调整。页面显示当天已用量和剩余额度，队列满或额度达到时返回 429。
- 令牌预算基于已经完成并记录 usage 的调用，是成本护栏，不是账单替代品；正在执行的并发请求可能造成小幅超额。

## 监控与漂移

- `GET /api/health`：存活时间和队列深度。
- `GET /api/platform/status`：数据集、索引、调用、失败、令牌、延迟和告警摘要。
- `GET /api/metrics`：可抓取的 Prometheus 文本指标。
- 完结度评分会写入质量观测；同一模型/指标至少 10 条后，最近 5 条均值比最初 5 条低 15 分以上会产生 `MODEL_DRIFT` 告警。

这些是生产监控的可接入基础，不包含外部时序数据库、告警通知、值班流程或人工标注的代表性评估集。

## 输入与输出

- 题材是唯一必填项。
- 其他控制台字段可留空，由模型推断。
- 每个模块严格依赖前一个模块。
- 每本小说拥有独立 `projectId` 和递增修订号；页面左侧“当前小说”下拉框可切换并继续任一本小说，“新建小说”创建独立项目。
- 草稿同步到 `output/projects/<小说名>/project.json`；同名小说自动使用 `<小说名>--<短ID>`，防止互相覆盖。历史 UUID 目录在服务启动时无损迁移。
- 服务端使用修订号检测多标签页覆盖，旧修订保存会返回 HTTP 409。
- 编辑和自动保存只更新项目草稿，不创建成稿文件。点击“导出项目”后才创建带修订号的文本文件。
- 题材切换需要用户确认，并自动建立可恢复的项目版本。
- “保存版本”保留浏览器模块快照；服务器同时保存每次草稿修订。网页可查看、比较并恢复完整服务器历史。
- `NOVEL_OUTPUT_DIR` 可修改输出目录。

## 安全边界

- 服务默认绑定 `127.0.0.1`。
- 请求体默认上限 10,000,000 字节，可通过 `MAX_BODY_BYTES` 调整；长篇正文按章节提交，不在生成请求中重复上传全文。
- 长耗时模型请求使用 Responses API 后台模式：创建任务后按响应 ID 轮询，单次轮询断线只重试状态查询，不重复提交同一任务。后台任务总等待时间默认 300 秒，可通过 `MODEL_TIMEOUT_MS` 调整。
- 创建任务默认 60 秒超时；轮询间隔、单次查询超时和连续失败上限可分别通过 `MODEL_CONNECT_TIMEOUT_MS`、`MODEL_POLL_INTERVAL_MS`、`MODEL_POLL_REQUEST_TIMEOUT_MS`、`MODEL_POLL_MAX_FAILURES` 调整。
- 各模块设置独立输出额度，正文额度最高；这能降低长时间无反馈和代理连接中断概率。
- API Key 只从服务端环境变量读取，不进入浏览器或项目文件。
- Windows 启动脚本只在进程内读取用户级密钥，不输出或写入项目；系统代理仅用于模型服务请求，本地地址通过 `NO_PROXY` 排除。
- SQLite 使用 WAL 和项目修订号；项目 JSON 及导出文件仍采用原子替换写入。

## 当前限制

### 真实记忆实验（2026-10-02，未启用生产）

实验使用自建短片段，不上传生产小说。原电脑的证据与完整命令位于 `output/verification/memory-real-2026-10-02/REPORT.md`；固定输入、原始模型响应、用量台账、向量、逐例评分和运行时回执保存在同一目录。所有 `output/` 均不入库，所以新克隆不包含这些历史证据；下述历史验收数字不是新机器测试结果。实验源码、测试和环境锁定属于开发仓库，不随 `dist/` 分发。

- LangExtract 经官方 Responses API 实际调用 GPT-6 Astra 20 次，保守用量估算 US$0.25195，上限 US$2，服务商账单未核对。本轮 20 次调用额度已经用完，不再自动追加。20 个目标案例：现有规则 16 个通过；原始实验 18 个；修正证据偏移与同句多事实定位后，免费回放相同响应为 19 个。回放不是新的独立验证；仍有一例把叙述者知道的事实误当成角色已知，不自动写入正式记忆。
- BGE-M3 使用固定 Xenova ONNX INT8 版本、CLS + L2 归一化、1024 维、CPU 单条推理，已验证下载哈希。12 个检索案例：现有哈希/别名与候选均命中 6 个第一名，候选出现原有正确案例退步；批量 1/2 的向量也不等价。没有证明更优，不替换。完整精度、稀疏及 ColBERT 路径未测。
- 小样本结果只描述这些案例，不是全文准确率或文学质量。单章目标保持 2500 字；生产正文模型保持 GPT-6 Astra。

复核既有证据不收费，也不需要 API Key。先使用 Python 3.12 在项目目录创建 `.venv-memory`，在此隔离环境安装 `scripts/requirements-memory.lock.txt`（原实验顶层版本在 `requirements-memory.txt`）。已有环境可直接执行：

```powershell
$env:PYTHONUTF8="1"
.\.venv-memory\Scripts\python.exe -m unittest discover -s tests -p test_memory_experiment.py
.\.venv-memory\Scripts\python.exe scripts/langextract-experiment.py --replay
node scripts/memory-benchmark.mjs
```

`--replay` 仅使用匹配的已完成响应，缺少缓存就报错，不转为网络调用。`download` 和 `embed` 的完整离线/下载命令见实验报告；不要删除台账或修改固定实验来绕过付费上限。扩展数据与新一轮真实调用需要新的明确预算和独立实验设计。

### 生产能力边界

- 浏览器界面一次编辑一个活动项目，支持项目列表切换；尚不支持邀请或多人实时协作。
- 本地认证令牌由环境变量配置，不替代生产身份提供商、密码轮换、审计导出和细粒度 RBAC。
- 规则实体抽取与特征哈希向量是可运行基线，不等同于知识图谱抽取模型或生产级向量数据库。
- 章节调用仍顺序执行；关闭/刷新页面时已授权的当前批次继续，服务重启后才需要显式恢复，不会自动开启另一个批次。
- 为兼容现有网页与导出，活动项目的 `project.json` 仍保留完整正文；正式章节和版本内容已章节化。300 万字项目的页面加载性能仍需用真实超长作品单独压测。
- 继续预训练只准备语料；实际训练需要外部 GPU 后端、检查点恢复、训练指标和模型注册流程。
- 漂移告警样本量较小；正式交付仍需固定评估集、人工评分、置信区间和外部监控告警系统。
- 长篇生成依然受网络、OpenAI 账户权限/限流与实际调用费用影响；队列、重试和预算只能缓解，不能消除这些外部约束。
- 机器专用 `.openai/` 配置不入库；当前 SQLite 与本地文件实现面向本机部署，不应直接宣称为多实例云生产部署。
