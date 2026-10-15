# 安全入库、独立备份与 Windows/macOS 迁移

目标是一个公开代码仓库、一套独立加密备份的作品数据和单独保管的密钥。GitHub 仅保存经过审查的代码、文档和脱敏测试样例，不保存小说、数据库、API Key 或加密备份，也不负责让本地网页服务常驻。当前是跨平台准备，不是 Mac 实机验收结论。

## 1. 什么入库，什么不入库

| 内容 | 保存位置 | 换机方式 |
| --- | --- | --- |
| `server.mjs`、`public/`、`lib/`、脚本、脱敏测试、文档 | GitHub 公开代码仓库 | 克隆相同提交或发布标签 |
| `package-lock.json`、`.node-version`、脱敏 `.env.example` | 同一代码仓库 | 固定 Node 24.20.0，用 npm 重装 |
| 小说、SQLite、人物记忆、版本、任务、费用台账 | 数据目录及仓库外加密备份 | 完整恢复、核验后配置数据目录 |
| API Key、认证令牌、备份解密密钥 | 独立凭据管理或受保护文件 | 在新机器单独配置，不通过 Git |
| `node_modules/`、`.venv-memory/`、`models/`、`dist/` | 本机生成或下载 | 不照搬 Windows 二进制，按目标系统重建 |

`.gitignore` 排除**整个 `output/`**，以及 `archive/`、`.openai/`、数据库、日志、密钥与备份文件。`.env.example` 是唯一允许的环境变量示例；不要在其中填入真实值。原电脑的 pnpm 锁文件和工作区配置保留但不入库，npm 是受支持的复现路径。

公开仓库的文件与提交历史可能被任何人复制，不是私密数据存储。提交前核对 `git status --short`、`git diff --cached --stat`、实际暂存内容及将要上传的全部提交；忽略规则不会清除已进入 Git 历史的文件。若密钥曾进入历史，需要撤销并轮换该密钥，不能只删除当前文件。小说若误入历史也不能仅靠后续删除视为已经保密。

提交前执行 `npm run repo:check`。它扫描实际 Git 暂存区的文件白名单、文件大小、密钥模式和脱敏配置；这是一道防误传门禁，不是完整秘密审计的替代品。

不使用 Git LFS 或同步盘实时同步活动 SQLite 数据库。运行中的数据库不能被两台电脑通过共享文件夹同时写入。

## 2. 两个系统使用同一套代码

先安装 `.node-version` 指定的 Node 24.20.0，克隆代码仓库，在项目根目录执行。不要新建单独的 Mac 代码分支来维持两份实现。

Windows PowerShell：

```powershell
node --version
npm ci --ignore-scripts
node scripts/verify.mjs
$env:OPENAI_MODEL="gpt-6-astra"
npm start
```

macOS Terminal（zsh）：

```zsh
node --version
npm ci --ignore-scripts
node scripts/verify.mjs
export OPENAI_MODEL="gpt-6-astra"
npm start
```

打开 `http://127.0.0.1:3000`。不配置 API Key 也能编辑和验证页面；真实生成会提示缺少密钥。`npm start` 不会自动加载 `.env` 或 `.env.example`，因此仅复制该文件不会生效。生产密钥应另行注入终端环境；Windows 注册表变量不会自动迁移到 Mac。

默认数据目录是代码根目录下的 `output/`。可以用 `NOVEL_OUTPUT_DIR` 指向仓库外的完整数据目录；默认数据库随之位于 `<数据目录>/platform.sqlite`。如果另外配置了 `NOVEL_DB_PATH`，它会覆盖默认数据库路径，迁移时必须明确核对或取消旧路径，不能误连旧数据库。

`npm start` 的监督进程可在子服务崩溃后重启；注销、重启电脑或监督进程退出后仍须人工启动。`.cmd`/`.vbs` 只服务于 Windows，不用于 Mac。这里没有新增系统级后台启动器或云部署。

## 3. 创建独立加密备份

备份脚本为 `scripts/backup.mjs`，不使用第三方云服务，不上传文件。它使用 SQLite 备份 API 创建一致性快照；每个文件先压缩再用 AES-256-GCM 加密，清单本身也加密，备份目录不会展示小说文件名。

### 备份前置条件

1. 在网页暂停生成，等待当前章/模型调用结束，确认没有未知状态的收费请求。
2. 正常停止本项目服务和监督进程，确保没有其他标签页或进程写入数据。`--quiesced` 是对这项事实的明确确认，脚本不会替你关闭服务。
3. 准备仓库外的密钥目录、备份目录和足够磁盘空间。目标父目录必须已存在，备份目标只能是新目录或空目录；不覆盖已有备份。创建过程中还需要快照和事务工作空间。
4. 若数据库通过 `NOVEL_DB_PATH` 位于数据根目录之外，先制定包含该数据库的完整迁移目录方案；脚本不会猜测、搜索或自动收集外置数据库。

以下 `<...>` 都是需替换的路径占位符。命令可在 PowerShell 或 zsh 中执行；路径含空格时保留引号。不要把密钥路径或备份目标改到代码仓库内。

仅第一次创建独立的 32 字节随机密钥（不会覆盖已有文件）：

```text
node scripts/backup.mjs keygen --key-file "<独立密钥目录>/novel-studio.key"
```

备份暂停并停止写入后的数据目录：

```text
node scripts/backup.mjs create --source "<完整数据目录>" --destination "<独立备份父目录>/<本次备份名称>" --key-file "<独立密钥目录>/novel-studio.key" --quiesced --code-version "<git提交哈希或发布标签>"
```

使用 `git rev-parse HEAD` 获取已提交代码版本，保留命令输出的备份结果。`--code-version` 是用于追踪的标签，不会自动将未提交改动转成该版本；重要备份前应先确认代码状态。

备份内容包括 `platform.sqlite` 快照、项目 JSON、导出文件、项目目录索引、训练包和其他未排除的数据文件。数据库内的人物、章节、历史修订、候选、任务及调用账本随数据库一起保存。

明确排除：已有 `backups/`、日志、WAL/SHM（已合入快照）和大部分 `verification/` 验证产物。验证目录中文件名包含 `ledger`、`receipt`、`usage`、`cost` 或 `budget` 的费用凭证仍保留。排除清单写入加密 manifest。这不是整个工作目录的逐字节归档；若需完整保存原始实验响应、截图、向量或历史报告，必须另外做加密归档，不能假定本备份已包含它们。

脚本会核对 SQLite 完整性、表计数及作品数量，记录文件 SHA-256 和长度；如果备份期间源文件清单或数据库状态发生变化，会拒绝发布本次备份。该防护不能替代停止写入的前置要求。路径大小写、Unicode 冲突、跨平台不安全名称和符号链接会被拒绝，不会擅自改名。

密钥丢失就无法恢复。Mac/Linux 创建的密钥权限为 `0600`；Windows 还需要使用文件权限/ACL 限制读取。密钥应与备份分开保管，至少留一份独立安全副本。加密备份若仍只在同一块硬盘，不具备硬盘损坏后的恢复能力。

## 4. 恢复与换机验收

先克隆对应代码版本，在新系统重装 Node/npm 依赖。通过独立安全渠道带来加密备份和密钥；不要把它们上传到 GitHub。恢复到仓库外的新目录或空目录：

```text
node scripts/backup.mjs restore --backup "<加密备份目录>" --destination "<仓库外恢复父目录>/<本次恢复名称>" --key-file "<独立密钥目录>/novel-studio.key"
```

恢复会验证 GCM 完整性、SHA-256、长度、SQLite `integrity_check`、表计数和作品数量，全部通过后才发布恢复目录。原数据和已有目标内容不会被覆盖。失败会清理本次创建的事务目录，不会删除原备份。恢复只还原数据，不启动服务、不提交生成、不上传训练集，结果中的 `tasksStarted` 应为 `0`。

恢复后先以**未配置真实模型密钥**的环境验收。指定新目录启动服务前，应正常停止其他同端口服务，不通过全局杀进程处理冲突。

Windows PowerShell（替换为恢复后的绝对路径）：

```powershell
$env:NOVEL_OUTPUT_DIR="<仓库外完整恢复目录>"
Remove-Item Env:NOVEL_DB_PATH -ErrorAction SilentlyContinue
Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
npm start
```

macOS zsh：

```zsh
export NOVEL_OUTPUT_DIR="<仓库外完整恢复目录>"
unset NOVEL_DB_PATH OPENAI_API_KEY
npm start
```

这只移除当前终端进程的旧变量，不删除系统保存的密钥。验收后要真实生成时，再单独配置密钥；未经确认不要点击“继续批次”或执行远程训练。恢复保留任务历史，服务启动时会将原 `running` 任务暂停，而不是自动重发生成请求。

验收清单：

- [ ] Node 版本与备份对应代码版本正确，`node scripts/verify.mjs` 通过。
- [ ] 恢复结果的文件哈希、SQLite 完整性、表计数与作品数量验证通过。
- [ ] 当前小说列表包含原有作品，切换作品后题材、规划与正文正确且不互相污染。
- [ ] 每本重点作品的章节数、正文抽样、历史修订、候选稿及任务状态与旧机器一致。
- [ ] 在**隔离恢复副本**验证版本比较/恢复、导出文件名称和下载内容；不要把测试修改写入唯一正式恢复目录。
- [ ] 无模型请求自动启动，无未知状态请求被擅自重试；需要继续生成的批次由用户明确选择。
- [ ] 新机器至少完成一次加密备份与隔离恢复演练，再考虑退役旧机器；旧备份保持可读。

### 训练包兼容规则

新清单 `schemaVersion: 2`、`pathBase: "manifest"` 的 `files` 使用相对文件名，整体复制包目录即可定位；新数据库中的 `dataset_path` 以数据根为基准。API 为现有本地调用方仍返回绝对文件路径。

旧清单的绝对路径不会在恢复时被批量修改。旧训练包换机后需人工选定搬迁后的 `manifest.json`，核对同目录的 `train.jsonl`、`validation.jsonl`、`test.jsonl`；`submit-finetune.mjs` 只有显式 `--relocate` 才会采用这些同名文件，且仍需 `--confirm` 才能远程提交。**不要用远程提交命令测试迁移是否成功。** 清单解析与路径安全已有本地模拟回归，恢复本身不产生训练费用。

### 可选 Python/BGE 实验

生产网页不依赖 BGE 权重或 Python。若要复现旧实验，应在 Mac 重新建立 Python 3.12 虚拟环境并安装锁定依赖；Windows 的 `.venv-memory` 不能直接复制。历史实验输出不在 Git 中，缺少已保存响应时 `--replay` 应报错，不转为付费调用。BGE CPU 实验不代表 Apple Silicon/MPS 或本地小说训练已验证。

## 5. 手动跨平台 CI 与边界

工作流 `.github/workflows/verify.yml` 只允许手动 `workflow_dispatch`，不在 push/PR 时自动运行。Windows/macOS 使用同一 Node 版本与 `node scripts/verify.mjs`，`contents: read`，checkout 不持久化凭据；没有 production Secret、没有缓存或 artifact 上传步骤。依赖安装仍访问 npm/Node 分发源，测试的模型响应使用本地模拟服务。

Action 固定来源为官方仓库的具体提交：[checkout v6.0.2](https://github.com/actions/checkout/commit/de0fac2e4500dabe0009e67214ff5f5447ce83dd)、[setup-node v6.0.0](https://github.com/actions/setup-node/commit/2028fbc5c25fe9cf00d9f06a71cc4710d4507903)。固定提交便于复核，不意味着以后无需审查安全更新。手动触发前确认 runner 类型及账户费用规则；本次添加工作流不代表已经触发远端任务。公开仓库的 Actions 日志也应按公开内容处理，不注入生产凭据或作品数据。

普通回归没有浏览器运行环境时会明确跳过真实浏览器场景。Mac CI 通过只能证明该 runner 的测试结果，还需目标 Mac 的浏览器、文件恢复和手工使用验收；Apple Silicon 硬件性能也不是矩阵测试自动证明的结论。

此方案面向“更换电脑”。若要 Windows 与 Mac 同时编辑同一本小说，应设计统一后端、认证和访问权限，而不是把活动数据库放入 Git、iCloud 或 OneDrive 同步目录。
