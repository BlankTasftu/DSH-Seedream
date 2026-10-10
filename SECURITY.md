# 安全说明 / Security

本文件说明 `dsh-seedream` 如何保管与使用火山方舟（Ark）API Key，以及 2026-10-10 的**全量代码安全审查**结论。

## 一、密钥处理模型

| 环节 | 做法 |
| --- | --- |
| **存储** | 只有一处：`<DSH_HOME>/seedream/ark-key.vault.json`，内容是 Windows DPAPI（当前用户范围）**密文**。文件里没有明文 Key |
| **写入** | 只从 **stdin 或环境变量** 读取（CLI），或从本机界面表单提交（HTTP POST，仅回环）。**不接受命令行明文参数**，不进 shell 历史、不进进程列表 |
| **加解密** | 通过 PowerShell 的 `ConvertFrom-SecureString` / `ConvertTo-SecureString`（即 DPAPI，用户级）。明文只在内存与子进程 stdin/stdout 之间流转，不落盘、不进日志 |
| **使用** | Key 仅用于 `Authorization: Bearer <key>` 请求头，不写入请求体、不落任何中间文件 |
| **解析顺序** | DPAPI 金库 → DSH 凭据服务（`apiKeyEnv`，默认 `ARK_API_KEY`）→ 进程环境变量。**每次调用重新解析**，改 Key 无需重启 |
| **日志** | 全部 15 处日志/错误出口已逐条审查：只输出错误描述、路径、模型名与计数，不含凭据 |
| **兜底擦除** | `lib/errors.js#redactSecrets()` 会把任何「形如 `ark-…`」的文本替换为 `ark-***REDACTED***`，用于上游异常消息等意外夹带场景（`lib/ark.js`、`lib/vault.js`、`lib/ui.js` 出口均已接入） |

## 二、界面与 HTTP 面

客户端界面（实时计费徽标 + 管理面板）由插件自己在 DSH 的 Web 服务上注册 5 条路由：

| 方法 | 路径 | 是否含密钥 |
| --- | --- | --- |
| GET | `/dsh-seedream/client.js` | 否（纯前端脚本） |
| GET | `/dsh-seedream/state` | 否（只有「是否已配置 / 来源 / 指纹 / 用量 / 价表」） |
| POST | `/dsh-seedream/key` | 请求体含 Key（仅回环），**响应不含** |
| POST | `/dsh-seedream/price` | 否 |
| POST | `/dsh-seedream/recost` | 否 |

三层信任栅栏（`lib/ui.js`）：

1. **插件自校验**：拒绝 `Sec-Fetch-Site: cross-site`；带 `Origin` 时必须与 `Host` 同源；缺 `Host` 或畸形直接 403；
2. **写操作仅限本机**：`POST` 的来源主机必须是回环地址（`localhost` / `*.localhost` / `127.0.0.0/8` / `::1`），否则 403。确需远端管理须显式声明 `DSH_SEEDREAM_ADMIN_HOSTS`；
3. **委托宿主栅栏**：可用时调用 `connection.requestRejection(req)` 并沿用其状态码；**它抛异常时按拒绝处理**（fail-closed）。

## 三、Key 指纹（可选，默认开启）

界面为了回答「当前配的是哪一把」，会显示一个**不可逆指纹**：

```
ark-…1378　·　46 字符　·　指纹 005e579f
         ↑ 末 4 位            ↑ sha256 前 8 位（不可反推）
```

- 指纹在**写入时**由明文算出，只把 `prefix/suffix/length/hash` 存进金库文件（旧金库首次读取时补写一次，**不改动密文**）；
- 不含 Key 主体，无法据此重建 Key；等效于 AWS 控制台「显示末 4 位」的常见做法；
- **可以整体关闭**：配置 `uiKeyHint: false` → `/state` 不返回指纹，也不会为它解密，界面只显示「已配置 / 未配置」。

## 四、2026-10-10 审查发现与整改

| # | 发现 | 处理 |
| --- | --- | --- |
| 1 | `test/offline.mjs` 的断言语里含**真实 Key 的 9 位前缀** | 改为通用形态断言 `!/ark-[0-9a-f]{8}/i.test(body)`，不含任何真实片段 |
| 2 | 新增的擦除测试又引入了一处真实前缀 | 换成占位串 `ark-PLACEHOLDER-NOT-A-REAL-KEY` |
| 3 | 上游非预期异常可能把凭据夹带进错误消息 | 新增 `redactSecrets()` 并在 `ark.js` / `vault.js` / `ui.js` 出口接入 |
| 4 | CLI `decrypt-check` 会打印 Key 的前 4 字符 | 改为只打印长度与不可逆指纹，**不打印任何 Key 字符** |
| 5 | 指纹无法关闭 | 新增 `uiKeyHint` 配置（默认开启，可关闭） |

整改后复检：

```
插件目录内「完整令牌形态 ark-<8位hex>」命中数：0
插件目录内「真实 Key 特征串（UUID 段）」命中数：0
金库文件内「完整令牌形态」：未命中；'ark-' 仅来自指纹 prefix
usage.jsonl / prices.json / *.bak：均不含任何 'ark-' 文本
运行中 DSH 的 /state 与 /client.js 响应：均不含完整令牌形态
```

## 五、已知边界（如实声明）

1. **DPAPI 仅 Windows 可用**。其它平台金库不可用，请改用进程环境变量或 DSH 凭据服务（注意：DSH 凭据库是 0600 权限的**明文** YAML）。
2. **DSH 凭据服务/环境变量是明文**。本插件优先使用 DPAPI 金库，但如果你另外把 `ARK_API_KEY` 写进凭据库或环境变量，那份副本是明文，需自行管理。
3. **指纹为有意的部分披露**（首尾各 4 字符 + 长度 + 哈希）。介意就用 `uiKeyHint: false`。
4. **聊天/会话日志不归本插件管**：如果你在对话里粘贴过 Key，那份明文存在于 DSH 的会话记录中（会话导出、截图均会带出）。介意请到方舟控制台轮换 Key，然后用 CLI 或界面重新写入。
5. **同用户进程可解密**：DPAPI 绑定当前 Windows 用户；以同一用户身份运行的恶意程序仍可解密金库。它防的是「文件被拷走 / 被其它用户或机器读取」，不是本机同用户提权。
6. **界面写操作依赖回环判断**：若你把 DSH 反向代理到公网且未声明 `DSH_SEEDREAM_ADMIN_HOSTS`，写操作会被 403 拒绝（读操作也会因宿主栅栏而拒绝）。

## 六、报告漏洞

请通过 GitHub Issues 反馈：https://github.com/BlankTasftu/DSH-Seedream/issues
**不要在 Issue 里粘贴任何真实 API Key。**
