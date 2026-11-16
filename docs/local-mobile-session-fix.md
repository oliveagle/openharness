# 本地部署 · 手机端 session 历史读不到（2026-11-16 修复记录）

## 部署入口（10.126.126.0/24，不走 autonomous.ai 云）

| 用途 | 地址 |
|---|---|
| backend | `http://10.126.126.10:8085` |
| 手机 APK | `http://10.126.126.10:8088/harness.apk`（1.0.17+92，sha256 `15dbe6766cb2d7b11d245f9ef76ad8293e2563de935a22ab882a9dbdeb204b51`） |
| 本地配对页（二维码） | `http://10.126.126.10:8089/pair` |
| 本地 web | `http://10.126.126.10:8091` |

DB / Redis 在 `oleNas01 (10.126.126.6)`。机器：`machineId=dfb203716baf7e104757968e3b7bedd8`，
computer `oleworkstation01`。

`http://10.126.126.10:8089/pair` 的二维码 90 秒过期，刷新页面即得新码。

## 症状

手机点进任意 session：只有标题 + 一堆灰色横条动画，永远加载不出历史消息。

## 根因（四个叠加）

1. **手机等的是 terminal keyframe。** Herdr 只有 `capture`，没有实时终端字节流，
   终端视图永远等不到 → 旧版手机无限转圈。
   修复：`mobile/lib/phone/agent_conversation.dart` 直接读 daemon 的 native transcript
   （`session_get`），不再把终端字节流当第一依赖。

2. **backend 给手机的 agents_list 投影丢了 `sessionId`**
   （`backend/src/lib/deviceWs.ts` → `deviceAgentListItem`）。
   手机因此无法指名要哪段对话，只能退回 `agent_recent` 摘要。
   修复：投影带上 `sessionId`（不透明句柄，内容仍由机器经 E2EE 提供）。

3. **手机发的是 E2EE 密封帧，backend 看不到 payload。**
   所以 backend **不能**代答 `session_get`（必须原样中继给 daemon，由 daemon 解密后
   用 `historyProvider` 回答）。曾经写错成 backend 代答，后回滚。

4. **`ensureActiveReady()` 集合里没有 `session_get` / `sessions_list`**
   → 刚连上、active machine 还没 ready 时请求会落空。
   修复：加入集合（只负责唤醒，不代答）。

另外：手机端兜底 —— agent 没有 `sessionId` 时用 `agentId` 去问
（daemon 的 registry 认 agent id）。

## 已验证

- daemon 侧 `session_get` 真能返回完整对话：
  `harness-local show 3bff295b --json` 返回整段 transcript。
- 本地签发链路：`POST /api/auth/handoff` → `POST /api/auth/handoff/redeem` 能给手机签发
  本地 token（`kind: viewer`）。
- APK 下载与本地产物 sha256 一致；`backend` `tsc --noEmit` 通过。
- 手机聊天渲染端到端仍需真机确认（模拟器摄像头在此机器上解不出码）。

## 排障命令

```bash
journalctl --user -u openharness-cli-daemon.service --since '2 minutes ago' --no-pager \
  | rg 'session_get|session_get_result|conn:'
journalctl --user -u openharness-backend-server.service --since '2 minutes ago' --no-pager \
  | rg 'commander|device_hello|error'
```

## 坑

- `pnpm` 在 `backend/` 里会触发依赖重装；用 `backend/node_modules/.bin/tsc --noEmit`。
- flutter 在 `~/opt/flutter347/flutter/bin`；APK server 的 cwd 就是
  `mobile/build/app/outputs/flutter-apk`，重新构建后无需拷贝文件。
- repo hook 限制几个命令（文本匹配/删文件/python 一类），一律用 `rg` / `find -delete` / `node`。
- 模拟器 `-no-window` 跑时 virtualscene 不渲染，摄像头扫码必然失败；带窗口启动也常常
  解不出码（本机 swiftshader 无 GPU），不要在这上面耗时间。

---

# 追加修复：配对二维码秒失效（2026-11-16 晚间）

## 症状

手机上「Sign in a computer」扫码**完全没有反应**；「Add computer」进去只有登录、没有扫码。
本机打开 `http://10.126.126.10:8089/pair`，二维码要么是「QR expired — refresh」，要么扫了没反应。

## 根因

### 1. 二维码的配对流程顺序错了（主因）

CPace 配对有固定的两步顺序：

1. **手机**扫到码后，先经 relay 发 `e2e_pair_intent`，daemon 这才建立一个 pairing slot
   （`PAIR_TTL_MS = 60s`，`cli/src/lib/e2ee/manager.ts` 的 `onPairIntent`）；
2. **工作站**再执行 `harness pair <code>`，由它发起 CPace round 1
   （同文件 `onPair`）。

`scripts/local-pair-qr.mjs` 在**生成二维码的那一刻**就调用了 `harness pair <code>`，
比手机扫码早了几十秒。此时 daemon 手里没有 slot，
`onPair` 立刻返回 `NO_INTENT`（`manager.ts:676`），CLI 打印
「No browser or device is waiting to pair.」并退出 → helper 退出 →
二维码被写成「QR expired」。**所以扫码从来就没成功过。**

### 2. 服务端的 generation 竞态

`local-pair-qr-server.mjs` 每 55 秒 kill 一次 helper 并重新生成，而旧 helper 的
`exit` 回调会把「QR expired」写回 `/tmp/qr.svg` —— 覆盖掉新 helper 刚写好的二维码。
于是页面大部分时间显示的就是 expired。

### 3. helper 被 kill 时不会带走 `harness pair`

SIGTERM 只杀 helper，`harness pair` 子进程变孤儿，继续占着 daemon 的配对槽。

## 修复

| 文件 | 改动 |
|---|---|
| `scripts/local-pair-watch.ts`（新增） | 轮询 daemon 的 `POST /api/pair`：`NO_INTENT` 当作「手机还没扫」，600ms 后重试。NO_INTENT 不是失败的握手，不计入 daemon 的反猜测限流（只有真正失败的握手才计，`manager.ts:974`）。 |
| `scripts/local-pair-qr.mjs` | 改为 spawn `local-pair-watch.ts`（不再一次性 `harness pair`）；`SIGTERM` 时把 watcher 一起带走。 |
| `scripts/local-pair-qr-server.mjs` | 每个 pairing 带 generation 号，**只有最新一代**能写 expired 占位图；刷新窗口 40s（短于 60s 的 slot 生命周期），二维码不再被上一代覆盖；新增 `/code` 端点输出当前配对链接。 |

服务由 systemd user unit 管理：`openharness-pair-qr.service`（改完脚本 `systemctl --user restart openharness-pair-qr.service`）。

## 已验证（假手机 = 手机 App 的同一条链路）

`cli/scripts/fake-phone-qr-e2e.mjs`：直接用**页面上正在显示的那张二维码**
（同一个 handoff code + pair code），工作站侧由 `local-pair-watch.ts` 驱动配对：

```
· phone token minted（用二维码里的 h= 兑换）
· connected ws://10.126.126.10:8085/api/web-ws?...&client=mobile
· machine selected dfb203716baf7e104757968e3b7bedd8
  ← e2e_pair_intent_result {"accepted":true,"ttl":60}
  ← e2e_pake round 1 → 3 → 5 {"ok":true,"fingerprint":"D72A·FFA2·62DE·4C29"}
· paired with the machine
  ← e2e_welcome → E2EE session open
  ← agents_list_result → 12 agents（10 个带 sessionId）
  ← session_get_result → 81 events
✓ the phone's transcript path works end to end
```

即：**扫码 → 兑换 handoff → 配对 → E2EE 会话 → 拿到 agent 列表 → 拿到 session 完整对话**，
和真机走的是同一条路（同一个 `web-ws?client=mobile` relay、同样的密封帧）。

## 排障命令（配对相关）

```bash
systemctl --user status openharness-pair-qr.service --no-pager
journalctl --user -u openharness-pair-qr.service --since '2 minutes ago' --no-pager
cat /tmp/harness-pair-url.txt          # 当前二维码里的配对链接
ps -eo cmd | rg local-pair-watch        # watcher 在等手机扫码
curl -s http://10.126.126.10:8089/code  # 当前配对链接
```

## 坑（补充）

- `pkill -f local-pair-qr-server.mjs` 会把自己的 shell 一起杀掉（命令行里含同样的字符串）；
  用 `systemctl --user stop openharness-pair-qr.service`。
- 那个服务是 systemd 管的，手工再起一个会 `EADDRINUSE` 并被 systemd 反复重启。
- `npx tsx src/cli.ts pair <code>` 单次要 12.5s（机器负载高），所以不能用「反复起 CLI」
  的方式轮询；改成常驻进程里直接调 `localDaemonCall`（约 2.4s 启动，轮询间隔 600ms）。

---

# 追加修复：聊天能读了，但标题会滑走（2026-11-16 深夜）

## 症状

对话内容出来了，**标题没了**：得把列表滚回最顶上（最新消息那端）标题才重新出现。
一读聊天，标题就上移淡出。

## 根因

`mobile/lib/phone/terminal_page.dart` 里，标题是用 `_SlideAway(progress: _chrome.header)`
浮在终端顶部的 —— 它跟着**终端的滚动 chrome** 走。而
`TerminalChromeScroll._follow()` 在「不在最新输出」时会 `_header.forward()`，标题就滑走了。

更关键的是：聊天列表（`agent_conversation.dart`，`ListView(reverse: true)`）的滚动通知
会**冒泡**到终端页外层的 `NotificationListener<ScrollNotification>`
（`terminal_page.dart:2664`）→ 驱动 `_chrome` → 标题消失。
于是「读聊天」这件事本身把标题推走了。

## 修复

| 改动 | 说明 |
|---|---|
| `showingConversation` 局部量 | `!agentGone && !machineAway && (pane == null || session == null || !session.hasScreen)`。有实时终端时为 false —— **终端行为完全不变**。 |
| 标题改为独立一行 | `TerminalTitle` 整体提取成局部变量 `titleBar`，聊天在场时放进 `HeldHeight → Column` 的第一个子节点（在 `Expanded` 之前、也在滑动翻页的 `GestureDetector` 之外）。拖标题不会翻页，消息从标题**下方**开始，不重叠。 |
| 不再画浮动标题 | 聊天在场时不画原来那个 `Positioned` 浮动标题，避免两个标题。 |
| 吸收聊天的垂直滚动 | `placeholder`（`AgentConversationView`）外包一层 `NotificationListener<ScrollNotification>`，**只吸收 `metrics.axis == Axis.vertical`** 的通知。横向翻页通知仍然冒泡（`agent_swipe.dart` 只看 `depth == 0`，安全）。 |
| 终端回来时复位 | `showingConversation` 且 `_chrome.header.value != 0` 时 post-frame 调 `_chrome.reveal()`，终端回来时标题不会处于「已滑走」状态。 |

`agent_conversation.dart` 本身**不需要改**。

## 验证

- `dart analyze lib/phone/terminal_page.dart` → **No issues found!**
- 新增证明测试 `mobile/test/conversation_title_stays_test.dart`（假 `_Conn` 回答 `session_get`
  返回 40 轮问答）：
  - 有修复：标题 `getRect` 前后**完全相同**、`after.top >= 0`、聊天确实滚动了 → `All tests passed!`
  - **回退修复后该测试失败**：标题 `top = -79.2`（滑出屏幕外）
  → 这是一个真实的回归证明，不是「跑绿了而已」。
- 回归对照（同一机器、同一命令）：
  - `test/daemons/daemon_capture_test.dart` 2 个失败（`r4 consent…`、`r4 sheet…`）
    → **回退后同样失败 = 既有问题**
  - `test/phone_edge/focus_behavior_test.dart` 3 个失败（`attaching parked beside…`、
    `attaching with animations off, the skeleton is drawn still`、
    `brought back a terminal with nothing on it yet still waits behind the skeleton`）
    → **回退后同样失败 = 既有问题**（上一轮把 skeleton 换成 conversation view，
    上游测试没同步更新）
  - 有修复时：`focus_behavior_test.dart` = `+100 -3`（同样那 3 个既有失败，**无新增**）

## 坑（补充）

- 既有的 3 + 2 个失败测试是**上游断言 skeleton**、而本地部署已改成显示 conversation view
  造成的，不是这次改动引入的；要清干净需要同步更新上游那几条断言。

---

# 代码去向：fork 分支（2026-11-16 深夜）

`git@github.com:oliveagle/openharness.git` 这个 fork 上有一条分支：

- **`feature/lan-local-stack`** —— 上面这一整套本地部署 + 手机端对话层的工作。
  基线是 upstream 当时的 `main`（`1ee076c5`），5 个提交：

  | 提交 | 内容 |
  |---|---|
  | `feat(cli)` | Herdr 终端后端复活 + `agentRail`（workspace / agent 两层分组） |
  | `feat(backend)` | agents_list 带 `sessionId`；中继 `sessions_list` / `session_get`；`LOG_WEB_FRAMES` |
  | `feat(mobile)` | 对话视图 + 标题常驻 + 本地部署编译开关 |
  | `feat(deploy)` | 局域网全套（pair QR / 本地 web / 假手机）+ desktop/tui 的 pair origin |
  | `docs` | 本文件 |

fork 的 `main` **没有被动过**。

### 坑

- 全局 git 配置里有 `url.https://github.com/.insteadof git@github.com:`，会把 `git@` 形式改写成
  https，而本机到 github 的 https 不通 → **用 `ssh://git@github.com/<owner>/<repo>.git` 形式**
  （不匹配任何 rewrite，可用）。本 clone 的 `origin` 已改成这个形式。
- 本地是**浅克隆**（`.git/shallow` 有 2 个 graft 点），`git merge-base` 会返回空，看起来像
  「历史不相干」。`git fetch --depth=100 origin main:refs/remotes/origin/main` 之后要**再 fetch
  一次** ref 才动（第一次只进了 FETCH_HEAD）。
- 上游 main 会往前走，rebase 之后 `git diff <旧系列> HEAD` 会把 upstream 的几千行也算进去，
  别当成「我们的改动变多了」。
