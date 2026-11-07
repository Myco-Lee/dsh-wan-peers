# dsh-wan-peers

跨互联网的 DSH 节点发现与点对点消息插件。

和 [`dsh-lan-peers`](../dsh-lan-peers) 是**两个独立插件**：那个靠 UDP 广播，只在同一子网里有效；这个不依赖端口映射、也不依赖公网 IP，只要两台机器都能访问同一个会合服务（默认公共 `ntfy.sh`），就能互相看见并收发加密文本。

- 传输：ntfy 兼容的 pub/sub（默认 `https://ntfy.sh`，也可以填自建 ntfy）
- 接收：默认用长连接订阅（`stream` 模式），一条连接吃所有消息，不反复请求
- 加密：AES-256-GCM，密钥由 `room + secret` 经 scrypt 派生；会合服务只能看到密文
- 节点身份：首次运行生成 uuid，存在 `~/.dsh/wan-peers/identity.json`

## 两种配对方式

### 方式 A：配对码（推荐，导入即生效）

在已经配好的一台机器上：

```
wan_pair action=show
```

把返回的配对码（一串 base64url）发给另一台机器，在那台机器上：

```
wan_pair action=import code=<配对码>
```

会立刻写入 `~/.dsh/wan-peers/pairing.json` 并**热切换到新房间**（不用重启）。再用 `wan_peers` 看对端是否出现。清掉配对用 `wan_pair action=reset`。

### 方式 B：手写配置

两台机器都在各自 profile 的 `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` 写入同一组 `room` 与 `secret`：

```yaml
- id: dsh-wan-peers
  config:
    room: my-team-room-815c8824
    secret: 至少八个字符的口令
```

改配置行会让桌面宿主热重载该插件；首次安装插件仍建议重启一次。

然后任意一端调 `wan_ping`：广播一次心跳并立刻刷新对端列表。对端出现在 `wan_peers` 后，用 `wan_send` 发消息，对端用 `wan_inbox` 取。

> 默认 `announceMs: 0`，也就是**不做定时心跳**：只在启动、`wan_ping`、以及收到陌生节点心跳时回广播。这样不会把公共 ntfy 的每日消息额度烧光。如果你想「一直在线、随时被别人发现」，把 `announceMs` 设成 `300000`（5 分钟一次，一天 288 条，接近公共额度上限）。

## 公共 ntfy.sh 的额度（免费访客）

| 限制 | 数值 |
| --- | --- |
| 单条消息 | 4096 字节（超了转附件，插件会按 `maxTextBytes: 2600` 截断） |
| 请求速率 | 60 个令牌起步，之后每 5 秒补 1 个（≈12 次/分钟） |
| 每日消息数 | 250 条 |
| 单 IP 每日流量 | 200 MB（含 poll 回放） |

打满会返回 `429 limit reached`；插件会按指数退避（15s 起，翻倍，上限 300s）自动放慢，`wan_room` 里能看到 `backoffUntil`。要长期在线，建议自建 ntfy 或换付费计划。

## 安装

```powershell
dsh plugin --profile desktop add "link:D:\99-DP-D\01-代码项目\dsh-wan-peers"

# 或者用打包文件
npm pack .
dsh plugin --profile desktop add "file:D:\99-DP-D\01-代码项目\dsh-wan-peers\dsh-wan-peers-0.2.0.tgz"
```

装完重启一次 DSH。检查：

```powershell
Get-Content ~\.dsh\wan-peers\boot.log -Tail 20
# 期望看到: hub started room=... mode=stream / stream connected / tools registered
```

无图形界面时也可以用 CLI 验证（需要 `DEEPSEEK_API_KEY`）：

```powershell
dsh --profile headless headless "调用 wan_room 看看配置"
```

## Agent 工具

| 工具 | 作用 |
| --- | --- |
| `wan_pair` | `action=show/import/reset`：生成配对码、导入并热切换、清除配对 |
| `wan_room` | 查看房间号、会合服务、本机 id/名字、对端数、上次同步、退避状态 |
| `wan_peers` | 列出房间内对端（在线/离线） |
| `wan_send` | 给某对端发加密文本（`peer` 支持 id、名字、片段） |
| `wan_inbox` | 拉收件箱（`limit`、`mark_read`） |
| `wan_ping` | 立刻广播心跳 + 拉一次消息 |

## 配置项

```yaml
- id: dsh-wan-peers
  config:
    service: https://ntfy.sh     # 会合服务（必须是 ntfy 兼容的 JSON/NDJSON 接口）
    room: dsh-wan-815c8824       # 房间号，[A-Za-z0-9_-]{4,64}，两台填同一组
    secret: ec40e0ee...          # 口令，至少 8 字符；它决定加密强度
    name: LMM                    # 显示名，默认 hostname
    mode: stream                 # stream（默认）| poll
    announceMs: 0                # 0 = 不发定时心跳
    pollMs: 5000                 # poll 模式间隔
    ttlMs: 60000                 # 对端多久没消息算离线
    maxTextChars: 2000
    maxTextBytes: 2600           # 密文 base64 后的字节上限，别超过 4096 账单
    maxInbox: 500
```

## 测试

```powershell
node test\smoke.mjs     # 本地 mock ntfy，三个节点（两同一异口令），覆盖发现/加密投递/已读
node test\limits.mjs    # 429 退避、跳过、恢复
node test\pairing.mjs   # 配对码 show -> import -> 双向发现
node test\probe.mjs     # 打真实 ntfy.sh 的单节点探测
node test\e2e-stream.mjs --name node-a --room <room> --secret <secret> --home <dir> --wait-ms 30000
```

## 安全边界

- **端到端加密只保护正文**：会合服务能看到房间名、消息时间、大小和频率（元数据）。房间号要当成「不可猜的频道名」：泄露房间号+口令 = 任何人都能进房间发消息冒充。
- 口令至少 8 字符且随机；`secret` 是唯一的信任根，派生密钥用 scrypt（N=16384 默认）。
- ntfy.sh 是公共服务：不要放高度敏感内容；需要更严的隔离就自建 ntfy。

## 兼容性

- 已在 DSH 0.2.2-rc.1（cordis 4.1.0）与 0.2.1-rc.5（cordis 4.0.5）上验证。
- 工具注册走 `@deepseek-ai/dsh-tools` 的 JSON Schema 子集（`{ type:'object', additionalProperties:true }`），旧版宿主也认。
- 不声明 `inject`，apply 里自行等 `tools` 服务，避免旧版 cordis 上「等依赖永远不 apply」。

## License

MIT
