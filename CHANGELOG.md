# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循语义化版本。

## [0.5.0] — 2026-10-10

### 变更：档位名与真实 Model ID 对齐

- `5.0` → **`5.0-flash`**（`doubao-seedream-5-0-flash-260915`），与 `5.0-pro` 并列，消除「5.0 到底是哪个」的歧义；
  枚举顺序调整为 `5.0-pro, 5.0-flash`
- **历史名继续兼容**：`5.0`（以及 `5.0-lite` / `flash` / `pro`）仍可作为别名解析；
  台账里旧的 `tier: "5.0"` 在汇总时**自动归一到 `5.0-flash`**（统计不会裂成两个桶）；
  档位选择文件里的旧名读取时同样归一
- 配置键 `model5` / `price5` / `price5High` 更名为 `model5Flash` / `price5Flash` / `price5FlashHigh`，**旧键仍可读**

### 新增：对话窗口的模型选择器（嵌进输入框控制行）

- 选择器**内联在输入框那一排**，插在**控制行最前面 —— 模型选择左侧**，与 DSH 自带的**权限、模型选择**控件排在一起
  （`🎨 [5.0-pro ¥0.32/张 ▾]`），不是浮在上方的独立胶囊
- **不动 DSH 输入框原有布局**：不覆盖行间距（`gap`）等布局规则；只把自己的 `select` 宽度按**当前档位名的实测宽度**收敛
  （原生 `select` 默认按最长选项撑宽，会把下拉箭头推到很右边）
- 嵌入点运行时探测：优先 `[class*="standardControls"]`（模型选择那一组，位于 `[data-composer-card]` 内），
  其次 `[class*="modes"]`（权限 / 计划那一行），再退 `[class*="dock"]`；类名按**后缀**匹配以适配 CSS Module 哈希变化；
  React 重渲染挤掉节点后会自动重新插入；全找不到时回退为浮层
- 选项来自档位表并带单价；第一项「默认 5.0-pro」用于恢复配置默认
- **生效优先级**：工具显式传参 > **界面选择** > 插件配置默认；生成结果里会带一条 note 说明档位来自界面
- 选择落盘 `<DSH_HOME>/seedream/model.json`，改档位**无需重启**；`uiModelPicker: false` 可关闭
- CLI：`node bin/seedream.mjs model [--tier 5.0-flash | --clear]`
- 工具描述与系统提示同步：**省略 `model` 参数时使用界面选定的档位**，只有用户明确要求时才传该参数

### 修复

- **金库指纹形状**：AK/SK 金库的指纹原本是对整段 JSON 取哈希，界面会显示成 `{"ac…=="}` ——
  既没有展示价值、也暴露内部结构。现改为「AK 掩码 + SK 长度」，已存在的旧指纹会**自动修正一次**
  （解密 → 重写指纹 → 密文原样保留，AK/SK 不受影响）
- `vault.js#setSecret` 支持调用方传入自定义指纹（`hint` 选项）

### 测试

- 界面路由 8 → **9 条**（新增 `POST /model`，同样过三层信任栅栏、写操作限本机）
- 离线自检 162 → **185 项**（新增档位优先级、选择文件读写与清除、`/model` 路由、旧指纹修正、
  历史档位名归一、配置旧键兼容）
- 新增 **`test/client-dom.mjs`（16 项）**：用最小 DOM 桩跑真实 `lib/client.js`，验证选择器确实嵌进
  `[class*="standardControls"]`、模型行隐藏时退到权限行、无输入框时回退浮层、切换档位会 `POST /model {tier}`、
  选「默认」会 `POST {clear:true}`、`uiModelPicker:false` 时隐藏

## [0.4.0] — 2026-10-10

### 新增：可用余额

- **官方余额**（火山引擎费用中心 OpenAPI）
  - 实现 Volcengine Signature V4（HMAC-SHA256）签名 + `POST billing.volcengineapi.com/?Action=QueryBalanceAcct&Version=2022-01-01`
  - 签名与官方 Python SDK `signv4.py` 做**固定向量交叉验证**（`test/signv4_reference.py`），签名值逐字节一致
  - 方舟数据面查不到余额（实测 10 个候选路径全部 404），因此余额走费用中心、用独立的子账号 AK/SK
  - AK/SK 与 API Key 同级保密：**独立 DPAPI 金库**（`billing.vault.json`）、只回显 AK 首尾 4 位与 SK 长度、
    **SK 任何字符都不显示**、按值精确擦除（上游异常夹带也会被抹掉）
  - 缓存 10 分钟 + 手动刷新 30 秒节流：界面 5 秒轮询不会反复打费用中心
  - 失败不伪造数据：查询失败时保留上一次成功值并标注 stale，同时给出错误原因（如权限不足）
- **本地预算**（零凭据兜底）：`已充值 − 台账累计`，附近 7 天日均与预计可用天数；存 `budget.json`，
  也可用配置 `budgetTotal` / `budgetSince`（配置优先级更高，界面会提示）
- **新工具 `seedream_balance`**；`seedream_status` 增加一行余额摘要；CLI 新增 `balance [--refresh]`
- **界面新增「可用余额」区块**：余额大字 + 官方明细（现金/信控/冻结）+ 刷新、AK/SK 保存并验证/删除、预算设置；
  徽标在有官方余额时直接显示「余额 ¥x」

### 变更

- 界面路由从 5 条增至 8 条：新增 `POST /balance`、`POST /billing`、`POST /budget`（同样过三层信任栅栏，写操作限本机）
- 离线自检 130 → **162 项**（新增签名向量、余额解析、预算数学、AK/SK 金库往返与擦除、余额路由端到端）
- 测试改为完全封闭：所有落盘路径（台账/价表/金库/预算）都指向临时目录，不再写入用户的 `DSH_HOME`

## [0.3.0] — 2026-10-10

首个公开版本。

### 新增

- **Agent 工具**
  - `seedream_generate`：文生图，支持 `5.0`（flash）/ `5.0-pro` 两档、档位或显式画幅、1–4 张、参考图、`output_format`、水印开关、产出目录与文件名提示
  - `seedream_edit`：基准图 + 编辑指令 → 新图（方舟无 mask 局部重绘，整图重绘）
  - `seedream_status`：接入自检（Key 状态与来源、金库路径、档位能力、用量摘要）
  - `seedream_usage`：按 today / week / month / all 汇总调用次数、计费张数、output tokens 与估算金额，可按档位分解
- **用量与费用**
  - JSONL 台账（`<DSH_HOME>/seedream/usage.jsonl`）：每次生成记录时间、档位、画幅、每张像素与字节、计费张数、tokens、当时单价与金额
  - 可配置价表：基准档 + 「超过阈值像素」的高价档；来源优先级 插件配置 > `prices.json` > 内置默认（未配置）
  - `usage recost`：按当前价表重算历史金额（自动 `.bak` 备份）
  - 报告中带 `<price-source>` 与「非官方账单」免责声明
- **客户端界面**（同一插件内，未新增插件）
  - 左下角实时计费徽标：今日张数与金额，5 秒轮询 + 窗口回焦刷新
  - 管理面板：当前 Key 卡片（来源 / 指纹 / 写入时间 / 金库路径）、按来源删除、替换 Key、逐档位改价、按新价重算、最近明细
  - 三个不打扰保证：数据未变时零 DOM 变更、输入期间跳过重绘、面板重建保留滚动位置
  - 防遮挡：运行时探测侧栏边缘把徽标放到侧栏右侧；新浮层与徽标相交时临时隐藏；可拖动定位并记忆，双击复位
- **密钥安全**
  - Windows DPAPI（当前用户范围）密文金库；写入只走 stdin/环境变量或回环 HTTP
  - `redactSecrets()` 兜底擦除（`ark-…` 形态）接入所有错误/日志出口
  - 不可逆 Key 指纹（首尾各 4 字符 + 长度 + sha256 前 8 位），可用 `uiKeyHint: false` 整体关闭
  - 界面 HTTP 面三层信任栅栏：插件自校验（拒跨站、Origin 同源、Host 回环）+ 写操作限本机 + 委托宿主 `connection.requestRejection`（异常即拒绝）
- **CLI**：`key set/status/clear`、`models`、`probe`、`generate`、`usage [recost]`、`price show/set/clear`
- **测试**：130 项离线自检（不联网、不花钱）

### 说明

- 方舟图像模型按**返回张数**计费；单价只在控制台可见，插件不预置任何价格数字
- 5.0 flash 实测**不支持** `sequential_image_generation`，`count > 1` 一律串行调用
- 本账号实测可用的 Model ID：`doubao-seedream-5-0-pro-260628`、`doubao-seedream-5-0-flash-260915`；lite 档位在部分账号已停止开通，故不提供
