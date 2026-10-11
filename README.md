# DSH-Seedream

# 本插件已弃用，停止更新维护，您可以根据自己的需求自行修改更新自用

把 **Seedream（火山方舟 Ark）** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的图片与图像素材生成插件。

Agent 会自己调用它出图；你也可以在 DSH 界面左下角看到一个**实时计费徽标**，点开就能管理 API Key 与单价。

```
🎨 今天 12 张 · ¥3.73   共 19 张        ← 界面常驻徽标（实时）
```

- **五个 Agent 工具**：`seedream_generate`（文生图）、`seedream_edit`（按指令改造已有图）、`seedream_status`（接入自检）、`seedream_usage`（用量与费用）、`seedream_balance`（可用余额）
- **对话窗口的模型选择器**：就嵌在输入框那一行，和**权限、模型选择**控件排在一起 —— 直接选 `5.0-pro` / `5.0-flash`（带单价），选中即成为后续出图的**默认档位**；对话里明确要求某档位时以要求为准
- **实时计费**：每次生成回显计费张数与金额；按今天 / 近 7 天 / 本月 / 全部 汇总，可按档位分解
- **可用余额**：配了费用中心 AK/SK 就显示**官方可用余额**（10 分钟缓存，可手动刷新）；没配就用**本地预算**（已充值 − 台账累计 + 日均消耗估算）
- **图形化管理**：界面内改/删 API Key（写入 DPAPI 金库）、编辑单价、按新价重算历史、管理 AK/SK 与预算
- **密钥不落明文**：API Key 与 AK/SK 都只存 Windows DPAPI 密文；界面任何响应都不含明文（细节见 [SECURITY.md](SECURITY.md)）
- **零运行时依赖**：`@deepseek-ai/schemastery` 可选（装了就多一份配置面板 schema，不装照常用）

> 计费口径提示：方舟图像模型**按返回张数计费**，但**单价只在控制台可见、API 不返回**。
> 所以本插件把「张数 / tokens」当**事实**自动记账，把「金额」当**按本地价表的估算**，
> 未配置单价时如实显示「单价未配置」，绝不编造数字。

---

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| DSH | 0.2.x 及以上（需要 `tools` 与 `webServer` 服务） |
| Node | `^22.19` 或 `>=24` |
| 系统 | **Windows**（DPAPI 金库与界面完整支持）。其它平台可用：Key 走环境变量/DSH 凭据服务，金库与界面指纹不可用 |
| 其它 | 需要 PowerShell 7（`pwsh`）做 DPAPI 加解密。DSH 桌面版自带 pwsh，通常无需另装 |
| 账号 | 火山方舟已开通 Seedream 模型（见第 3 节） |

## 2. 安装

### 方式一：从本仓库安装（推荐）

```bash
git clone https://github.com/BlankTasftu/DSH-Seedream.git
```

然后按你的 DSH 形态二选一：

```bash
# A) 有 dsh CLI（link: 后面换成你克隆下来的绝对路径）
dsh plugin --profile desktop add link:/absolute/path/to/DSH-Seedream

# B) 桌面版：在 DSH 的插件管理里「安装本地目录」，目标填：
#    link:/absolute/path/to/DSH-Seedream
```

安装动作会：把 `dsh-seedream` 加进 profile 依赖、写进 `dsh.profile.bundles`、并立即启用。

### 方式二：手动挂载

把仓库放到任意位置，让 Node 能解析到它（例如放进 profile 的 `node_modules/`，或用 `link:` 安装），
然后在该 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-seedream
      name: dsh-seedream
      config:
        defaultModel: 5.0-pro
        editModel: 5.0-pro
        outputDir: images/seedream
```

### 装完必须做一次

**重启 DSH。** 原因：宿主插件按模块 URL 缓存，且桌面壳的界面注入表只在启动时收集一次。
重启后左下角出现计费徽标，四个工具对 Agent 可见。

自检（把端口换成你实际的 DSH Web 端口）：

```powershell
Invoke-WebRequest http://127.0.0.1:19387/dsh-seedream/state -UseBasicParsing | Select-Object -Expand Content
# 期望：{"ok":true,"key":{...},"usage":{...},...}
```

## 3. 先确认模型已开通

插件默认使用下面两个档位（Model ID 可在配置里覆盖）：

| 档位 | Model ID | 画幅 | 参考图 | 一次多张 |
| --- | --- | --- | --- | --- |
| `5.0-pro` | `doubao-seedream-5-0-pro-260628` | `1K` `2K`；显式 1280x720–2048x2048（边长 16 的倍数） | ≤10 | 不支持（串行多次调用） |
| `5.0-flash` | `doubao-seedream-5-0-flash-260915` | `2K` `3K` `4K`；显式 2560x1440–4096x4096 | ≤14 | 不支持（串行多次调用） |

```bash
node bin/seedream.mjs probe                       # 不计费：探测模型是否可达
node bin/seedream.mjs probe --live --tier 5.0-pro # 计费：真实出一张验证
```

`probe` 区分两类失败：**模型不存在/无访问权**（`InvalidEndpointOrModel.NotFound`）与
**模型存在但账号未开通**（`ModelNotOpen`，需去方舟控制台开通）。
lite 档位在部分账号已不可用，本插件不提供。

## 4. 配置 API Key

### 推荐：界面里填

重启 DSH 后，点左下角徽标 → **API Key 管理** → 粘贴 Key → 「保存到金库」。
服务端用 Windows DPAPI 加密后落盘；页面只提交，永不回显。

### 或者：命令行

```bash
# Key 只从 stdin / 环境变量读，不接受命令行明文参数
echo ark-你的Key | node bin/seedream.mjs key set
node bin/seedream.mjs key status      # 查看各来源状态（不显示 Key）
node bin/seedream.mjs key clear       # 删除金库
```

写入位置：`<DSH_HOME>/seedream/ark-key.vault.json`（默认 `%USERPROFILE%\.dsh\seedream\`），内容只有 DPAPI 密文。

**解析顺序**：DPAPI 金库 → DSH 凭据服务（`apiKeyEnv`，默认 `ARK_API_KEY`）→ 进程环境变量。
金库优先是刻意的——它是唯一非明文来源，避免残留明文值造成「换了 Key 却仍失败」的假象。
`seedream_status` 会如实报告当前生效来源。

## 5. 使用

### Agent 侧（推荐）

直接说要什么图：

```
帮我生成一张扁平风格的设置页图标，青色齿轮 + 橙色扳手，纯白背景
把 images/seedream/xxx.png 改成深色主题配色，形状不要变
这个月 Seedream 花了多少钱？
```

### 工具参数（`seedream_generate`）

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填。中文 ≤300 字 / 英文 ≤600 词；写清主体、动作、环境、风格、光线、构图、用途 |
| `model` | `5.0-pro` / `5.0-flash`，默认 `5.0-pro`（`5.0` 为历史别名，仍可用） |
| `size` | 档位（`1K/2K/3K/4K`）或显式 `宽x高`；越界会按档位能力等比钳制并提示 |
| `count` | 1–4，串行多次调用（两个档位都不支持一次请求出多张） |
| `references` | 参考图：工作目录内路径或公网 URL |
| `output_format` | `png`（默认）/ `jpeg` |
| `watermark` | 默认 `false`（素材保持干净） |
| `output_dir` | 默认 `images/seedream`（相对会话工作目录；默认禁止逃逸出工作目录） |
| `name` | 文件名提示词 → `seedream-<时间戳>-<name>.png` |

`seedream_edit` 用 `images`（1 张起，按顺序即「图一/图二」）代替 `references`。
方舟**没有 mask 局部重绘**，编辑是整图按指令重绘，请在 prompt 里写明「要改什么」和「必须保留什么」。

### CLI

```bash
node bin/seedream.mjs models                      # 档位与能力
node bin/seedream.mjs probe [--live] [--model-id <id>]
node bin/seedream.mjs generate --prompt "一只猫" --model 5.0-flash --size 2K --count 2
node bin/seedream.mjs model [--tier 5.0-flash | --clear]  # 查看/设置默认出图档位
node bin/seedream.mjs usage [--period today|week|month|all] [--detail]
node bin/seedream.mjs usage recost [--dry-run]    # 按当前价表重算历史（自动留 .bak）
node bin/seedream.mjs price show
node bin/seedream.mjs price set --tier 5.0-pro --price 0.32 --high 0.95 --note "方舟控制台 2026-10"
node bin/seedream.mjs price clear
```

## 6. 计费与用量

| 类别 | 来源 | 性质 |
| --- | --- | --- |
| 张数 / output tokens / 像素 / 落盘字节 | 方舟响应 + 本地文件实测 | **权威事实**，每次生成自动记账 |
| 金额 | 本地价表（可配置） | **估算**，报告里带 `<price-source>` 与免责声明 |

- 记账文件：`<DSH_HOME>/seedream/usage.jsonl`（一行一次调用：时间、档位、画幅、像素、张数、tokens、当时单价与金额）
- 价表文件：`<DSH_HOME>/seedream/prices.json`；单价 = 基准档 + 「超过阈值像素」的高价档（默认阈值 261 万像素）
- **改价不改历史**：台账金额是当时的估算；填价后用 `usage recost` 按当前价表补齐历史（自动备份 `.bak`）
- 也可在 profile 配置里写死单价：`price5Pro` / `price5ProHigh` / `price5Flash` / `price5FlashHigh` / `priceHighPixelThreshold` / `priceCurrency`（旧键 `price5` / `price5High` 仍可读）
  （优先级：插件配置 > prices.json > 内置默认=未配置）

## 7. 可用余额

两种模式，**官方优先、本地兜底**（都不需要动 profile 配置）：

| 模式 | 数据来源 | 前提 |
| --- | --- | --- |
| **官方余额**（推荐） | 火山引擎费用中心 OpenAPI `QueryBalanceAcct` | 需要子账号 **AK/SK**，建议只授予「费用中心只读」 |
| **本地预算** | 「已充值总额 − 台账累计花费」+ 近 7 天日均 | 零凭据，纯本地账 |

### 为什么不能直接用方舟 API Key

实测方舟数据面（`ark.cn-beijing.volces.com/api/v3`）的 10 个候选余额/用量路径**全部 404**——
余额属于费用中心 OpenAPI，必须用 AK/SK 做 Volcengine Signature V4（HMAC-SHA256）签名。
插件的签名实现已与官方 Python SDK 的 `signv4.py` 做**固定向量交叉验证**（见 `test/signv4_reference.py`）。

### 配置官方余额（最小权限）

1. 火山引擎控制台 → **访问控制 IAM** → 新建**子用户**（不要用主账号 AK/SK）；
2. 给它授予内置策略 **`BillingCenterReadOnlyAccess`**（费用中心只读，不含任何资源操作权限）；
3. 为该子用户创建 **Access Key**，拿到 AK / SK；
4. 回到 DSH：点左下角徽标 → **可用余额** → 填 AK / SK → 「保存并验证」。
   插件会立刻查一次：成功就显示余额，失败会把原因（如权限不足）如实回显。

AK/SK 与方舟 Key 一样：**DPAPI 密文落盘**（`<DSH_HOME>/seedream/billing.vault.json`）、
界面只回显 AK 的首尾 4 位与 SK 的长度、**SK 任何字符都不显示**、不打印、不进日志。
也支持环境变量 `VOLC_ACCESSKEY` / `VOLC_SECRETKEY`（明文，自行权衡）。

### 本地预算

界面里填「已充值」与可选起始日期即可（存 `<DSH_HOME>/seedream/budget.json`），
插件会算：已花 / 剩余 / 近 7 天日均 / 预计可用天数。也可写进 profile 配置：
`budgetTotal`（元）与 `budgetSince`（ISO 日期）——**注意配置优先级高于那个文件**，界面会提示。

### 查看方式

```bash
node bin/seedream.mjs balance [--refresh]   # 命令行
```

Agent 侧直接问「我还有多少余额」即可（会调 `seedream_balance`）；
`seedream_status` 也会带一行余额摘要。官方余额有 **10 分钟缓存**（`billingCacheSeconds`），
手动刷新有 **30 秒节流**，所以界面 5 秒轮询不会把费用中心打爆。

## 8. 客户端界面

**对话窗口的模型选择器**：**嵌在输入框的控制行里**，与 DSH 自带的**权限、模型选择**控件同一排 —— `🎨 [5.0-pro ¥0.32/张 ▾]`。

- 选项来自插件的档位表（`5.0-pro` / `5.0-flash`），价表已配置时直接显示单价；第一项「默认 5.0-pro」用于恢复默认。
- 选中后写入 `<DSH_HOME>/seedream/model.json`，**不需要重启**；`已选定` 提示当前是否由界面选择生效。
- 生效优先级：**工具显式传参 > 界面选择 > 插件配置默认** —— 所以对话里说「用 5.0-flash 出这张」仍然能覆盖选择器。
- 嵌入点是**运行时按 `data-composer-card` + 类名后缀**找到的控制行（优先「模型选择」那一组，其次「权限」那一行），插在**该行最前面 —— 也就是模型选择左侧**；DSH 换版也不会失联，React 重渲染把节点挤掉后会自动重新插入；实在找不到控制行时回退为「浮在输入框上方」。
- **不改动 DSH 输入框原有布局**：不覆盖行间距（`gap`）等任何布局规则；只把自己的 `select` 宽度收敛到「当前档位名 + 原生箭头」——原生 `select` 默认按**最长选项**撑宽、会把箭头推到很右边，收敛后箭头紧贴文字。
- 可用参数 `uiModelPicker: false` 关闭；CLI 也可查看/设置：`node bin/seedream.mjs model [--tier 5.0-flash | --clear]`。

**左下角徽标**：实时显示今日张数与金额，5 秒轮询 + 窗口回焦立即刷新；未配置 Key 时变成 `⚠️`。
有官方余额时徽标右侧直接显示「余额 ¥x」。

**点击徽标展开管理面板**：

| 区块 | 能力 |
| --- | --- |
| 可用余额 | 官方余额（大字 + 明细 + 刷新）或本地预算剩余；AK/SK 的保存/验证/删除；预算设置 |
| API Key 管理 | 当前 Key 卡片（来源 / 指纹 / 写入时间 / 金库路径）；**修改**＝粘贴新 Key 点「替换」；**删除**＝按来源单独删（DPAPI 金库 / DSH 凭据服务），带二次确认 |
| 用量与费用 | 今天 / 近 7 天 / 本月 / 全部 的次数、张数、tokens、估算金额 |
| 单价与重新计价 | 逐档位改价、记录价格来源、按当前价重算历史、清除价表 |
| 最近生成明细 | 最近 10 次的时间、模式、档位、画幅、金额 |

**不打扰页面**：数据没变时**零 DOM 变更**；面板内有输入框获得焦点时跳过重绘；面板重建时保留滚动位置。

**不挡界面**：徽标默认放在**侧栏右侧**（运行时探测侧栏边缘），账户按钮与其上拉菜单不会被遮挡；
新出现的浮层与徽标相交时徽标临时隐藏；**可以直接拖动**徽标换位置（自动记忆），**双击**复位。

位置也可在配置里改：`uiBadgePosition: bottom-left | bottom-right | top-left | top-right`。

## 9. 配置项

写在 profile 的 `cordis.patch.yml` 中 `dsh-seedream` 条目的 `config:` 下（完整默认值见 `lib/schema.js`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `ARK_API_KEY` | 凭据引用名（环境变量名） |
| `vaultPath` | `''` | 金库路径，留空用 `<DSH_HOME>/seedream/ark-key.vault.json` |
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | 网关（国际站 `https://ark.ap-southeast.bytepluses.com/api/v3`） |
| `defaultModel` / `editModel` | `5.0-pro` | 默认生成 / 编辑档位 |
| `model5Pro` / `model5Flash` | 见第 3 节 | Model ID 覆盖（也支持 `ep-xxxx` 接入点）；**旧键 `model5` 仍可读** |
| `outputDir` | `images/seedream` | 产出目录（相对会话工作目录） |
| `allowOutsideCwd` | `false` | 是否允许产出目录/参考图逃出工作目录 |
| `requestTimeoutMs` | `300000` | 同步长请求超时（方舟无轮询） |
| `rateLimitRetries` / `rateLimitBackoffMs` | `2` / `15000` | 429 限流退避 |
| `watermark` | `false` | 默认是否加水印 |
| `maxImagesPerCall` | `4` | 单次调用最多张数 |
| `powershellPath` | `''` | DPAPI 用的 PowerShell 路径，留空自动探测 |
| `promptSection` | `true` | 是否注册能力提示段 |
| `ledgerPath` / `priceFilePath` | `''` | 台账 / 价表路径，留空用 DSH_HOME 下默认位置 |
| `price5Pro` / `price5ProHigh` / `price5Flash` / `price5FlashHigh` | `''` | 单价（元/张），留空 = 未配置；**旧键 `price5` / `price5High` 仍可读** |
| `priceHighPixelThreshold` | `2610000` | 高清档像素阈值 |
| `priceCurrency` | `CNY` | 计价币种（仅展示） |
| `uiBadgePosition` | `bottom-left` | 徽标初始角落 |
| `uiKeyHint` | `true` | 是否显示 Key 指纹（不可逆）；`false` 只显示已配置/未配置 |
| `billingVaultPath` | `''` | 费用中心 AK/SK 金库路径，留空用 `<DSH_HOME>/seedream/billing.vault.json` |
| `billingRegion` / `billingHost` | `cn-north-1` / `billing.volcengineapi.com` | 费用中心 OpenAPI 地址（一般不用改） |
| `billingTimeoutMs` / `billingCacheSeconds` | `15000` / `600` | 余额查询超时 / 缓存秒数 |
| `budgetTotal` / `budgetSince` | `0` / `''` | 本地预算：已充值（元）与起始日期（**优先级高于界面的 budget.json**） |
| `budgetFilePath` | `''` | 预算文件路径，留空用 `<DSH_HOME>/seedream/budget.json` |
| `uiModelPicker` | `true` | 是否在对话窗口（输入框上方）显示档位选择器 |
| `modelChoicePath` | `''` | 档位选择文件路径，留空用 `<DSH_HOME>/seedream/model.json` |

## 10. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `MISSING_CREDENTIAL` | 三个来源都没有 Key。用界面徽标或 `key set` 写入金库 |
| `AUTH_FAILED` (401/403) | Key 无效/过期/被停用 → 重新写入 |
| `MODEL_UNAVAILABLE` + `ModelNotOpen` | 模型存在但账号未开通 → 去方舟控制台开通 |
| `MODEL_UNAVAILABLE` + `NotFound` | Model ID 不对或该档位已下线 → `probe` 验证，或改 `model5Pro` / `model5Flash` |
| `RATE_LIMITED` (429) | 图像模型按 IPM 限流；默认退避重试 2 次，可调 `rateLimitRetries` / `rateLimitBackoffMs` |
| `SENSITIVE_CONTENT` | 输入或输出被审核拦截 → 改写提示词（不重试） |
| `TIMEOUT` | 同步接口耗时长 → 调大 `requestTimeoutMs`，或减少张数/参考图 |
| `POWERSHELL_MISSING` | 找不到 pwsh → 安装 PowerShell 7，或配置 `powershellPath` |
| 余额显示「未配置」 | 没填 AK/SK 也没设本地预算 → 见第 7 节 |
| 余额要「费用中心只读」 | 余额用 AK/SK 单独鉴权；Key 本身不带权限，需给子用户授予 `BillingCenterReadOnlyAccess` |
| 官方余额查询失败 `AUTH_FAILED` | AK/SK 无效，或该子用户没有费用中心只读权限 |
| 界面没出现徽标 | 装完没重启 DSH；或用第 2 节的 `Invoke-WebRequest` 自检路由 |
| 徽标挡到东西 | 直接拖动它（自动记忆）或双击复位，或改 `uiBadgePosition` |
| 改了 `lib/client.js` 不生效 | 硬刷新页面（Ctrl+F5）；改宿主代码（工具/路由/注入行）需重启 DSH |

## 11. 安全

摘要：**API Key 与 AK/SK 都只以 DPAPI 密文落盘；写入只走 stdin/环境变量或回环 HTTP；不打印、不回显、不进日志；
界面 HTTP 面有三层信任栅栏（插件自校验 + 写操作限本机 + 委托宿主栅栏，异常即拒绝）；
所有错误文本出口带 `ark-…` 形态兜底擦除。**

AK/SK 比方舟 API Key 权限更大（属于账号级访问密钥）：请务必用**子用户 + 仅「费用中心只读」策略**，
插件只把它用于 `QueryBalanceAcct`，界面只回显 AK 首尾 4 位与 SK 长度。

完整威胁模型、审查记录与已知边界见 **[SECURITY.md](SECURITY.md)**。

## 12. 开发

```bash
node test/offline.mjs   # 185 项离线自检：不联网、不花钱
                        # 配置/档位/画幅钳制/路径逃逸/图片嗅探/工具 schema 与渲染/
                        # 价表分档/台账汇总/recost/界面路由与信任栅栏/指纹与擦除/DPAPI 金库往返/
                        # SigV4 签名（与官方实现交叉验证的固定向量）/余额解析/预算数学/档位优先级与选择文件/历史档位名归一
node test/client-dom.mjs # 21 项客户端 DOM 自检：用最小 DOM 桩跑真实 client.js，验证「插在模型选择左侧」「不改 DSH 行间距」「select 宽度收敛」「切换档位 POST /model」
```

```
lib/
├─ index.js       宿主入口：注入行 + 路由 + 工具 + 能力提示
├─ tools.js       五个工具的 schema、渲染与执行管线
├─ ark.js         方舟客户端：请求、429 退避、错误分类、下载
├─ models.js      档位能力矩阵与画幅归一
├─ assets.js      素材落盘、参考图读取、格式嗅探、路径逃逸防护
├─ vault.js       DPAPI 金库（加解密、指纹、权限收紧）
├─ credentials.js 凭据解析顺序与状态
├─ billing.js     费用中心 OpenAPI：Volcengine SigV4 签名 + QueryBalanceAcct + AK/SK 金库
├─ balance.js     余额视图：官方优先 + 本地预算兜底 + 缓存/节流
├─ model-choice.js 对话窗口档位选择：文件读写 + 生效优先级解析
├─ pricing.js     价表（基准/高清档、多来源合并、金额估算）
├─ ledger.js      用量台账 JSONL：追加、读取、周期汇总、渲染
├─ usage.js       用量视图组装 + 历史重新计价
├─ ui.js          客户端界面宿主侧：注入行、路由、信任栅栏、状态组装
├─ client.js      浏览器侧界面（原生 JS，免构建）
├─ config.js / schema.js / errors.js
bin/seedream.mjs  CLI
test/offline.mjs  离线自检
test/client-dom.mjs  客户端脚本的 DOM 行为自检（最小 DOM 桩，不需要浏览器）
test/signv4_reference.py  官方签名算法参考实现（交叉验证用）
cordis.patch.yml  bundle 挂载声明
```

**改动的生效方式**：CLI → 立即；`lib/client.js` → Ctrl+F5；宿主代码 / 注入行 → 重启 DSH。

## 13. 已知边界

- 5.0-flash 的显式像素下限、参考图上限沿用方舟 Seedream 5.0 系列文档口径，未逐一边界实测；被网关拒绝时会原样上报并按提示调整。
- 方舟出图 URL 24 小时失效：插件收到响应即下载落盘，不等后续步骤。
- 图片同时写入 DSH 附件库以便对话内回显；附件库会对超限图片做归一化，落盘原图保持全分辨率。
- 费用是估算：官方单价以控制台为准；`usage recost` 可随时按新价表重算历史。
- 台账为无锁追加写：DSH 工具默认串行调度，正常使用不会冲突。
- DPAPI 金库仅 Windows；其它平台请用环境变量或凭据服务（后者是明文存储）。

## 14. License

[MIT](LICENSE) © 2026 BlankTasftu

火山方舟、Seedream、豆包是北京火山引擎科技有限公司的商标；本项目为第三方集成，与火山引擎无隶属关系。
