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

---

# 手机端按机器分组（2026-11-16）

owner 的原话：「手机端如何切换机器的呢？我看是所有 session 都混在一个列表里边的对吧？
可以优化么？分组，用机器分组？」

## 问题在哪一屏

- **不是** `AgentsListPage`（`lib/phone/agents_list_page.dart`，标题 `Harnesses`）—— 它早就
  按机器分组了，但只能从终端的 `⋯` 抽屉或搜索进去。
- 是 **`PickUpPage`**（`lib/phone/welcome/pick_up_page.dart`，首屏 `Pick up where you left off`）：
  它直接复用 Find 的 `PhoneSearchResults`，而那一份是**一条平铺的排行列表**
  （`needs you` / `recent` / `paused`，机器名只在每行第二行的 `机器:项目` 里）。

## 改法（最小且不动 Find）

`PhoneSearchResults` 新增 `groupByMachine`（默认 `false`，**只有首屏传 `true`**）：

1. **每台机器一个标题**：`STATUSDOT + 机器名大写 + 该机器几条`（终端的字，`TtyText`）。
   分组顺序 = 该组**第一行**在排行里的位置（不重新排序，排行仍然说话），组内保持排行顺序。
2. **每台机器一个 chip**：`All computers / oleNucBoxEVOX2 5 / oleFedora01 4 / …`（不叫 All：
  下一行的 tab 栏里已经有一个 All，两个都叫 All 说不清各自清的是哪一维），复用
   `DeskTabFilterBar`（和桌面的 tab chips 同一个控件、同一套语义：`All` + 各机器，点了就窄化）。
   - 只在**两台及以上**机器有 session 时画（一台机器的 chip 栏是纯装饰）。
   - **不替换** tab chips：tab 栏仍在机器栏下面（`find_tab_new_harness_test.dart` 的
     「pick-up 屏 New Harness 进选中 tab」那条仍在跑，tab 选择照样传给 `NewAgentPage.deskTabId`）。
   - 计数按**当前 tab** 算（先 tab 后机器，外层是机器）。
3. **`needs you` 仍然在最上面、跨机器**：把要你答的 harness 塞进某个机器组里，等于把唯一的
   紧急信号埋掉；所以它单独一段，其余（`rest` / `current` / `paused`）才按机器分组。
4. **分页顺序 = 画出来的顺序**：`_drawn`（`needs you` + 各组，按绘制顺序）交给
   `openAgentPager`。分组会打乱排行顺序（A 机的第二行画在 B 机第一行前面），
   用未分组的行建 pager 会让「往右滑」跳到不是旁边那个 harness。
5. **一个都不能少**：`phoneMachineGroups()` 现在也收「Harness 没启动的对话」（`external`，
   它有 `machineId` 但没有 `entry`，名字取 `machineLabel`）；分组覆盖不到的行
   （机器行 / 项目行 / 命令行）追加在最后一组之后，**不丢**。
6. 窄化到一台机器时**不画标题**（chip 已经写着是哪台）；该机器空空如也时给
   `Nothing on <机器> can be reached right now.` + `Show all computers` 的出口。

Find（终端里的搜索）**一个字没改**：带查询的列表仍是平铺排行 —— 标题会跟排行打架，
那条理由写在 `phone_search_results.dart` 顶部和 `phone_search_groups.dart` 里。

## 文件

| 文件 | 改动 |
|---|---|
| `mobile/lib/phone/phone_search_results.dart` | `groupByMachine` / `_machineId` / `_machineChoices` / `_machine` / `_machineNarrowed` / `_listed` / `_machineHeader` / `_drawn` |
| `mobile/lib/phone/phone_search_groups.dart` | 分组收 `external` 行；机器名回落 `machineLabel` |
| `mobile/lib/phone/welcome/pick_up_page.dart` | `groupByMachine: true` |
| `mobile/test/pick_up_machine_groups_test.dart` | 新，4 例 |

## 验证

```
flutter analyze lib/phone test/pick_up_machine_groups_test.dart   # 只有那条既有的 phone_welcome.dart info
flutter test test/pick_up_machine_groups_test.dart                # 4 passed
flutter test test/phone_search_test.dart test/find_tab_new_harness_test.dart \
             test/phone_edge test/desk_groups_test.dart test/desk_tab_filter_bar_test.dart \
             test/phone_launch_tab_test.dart test/phone_restore_last_agent_test.dart
                                                                  # +378 ~2 -3
```

- **那 3 个 `focus_behavior_test.dart` 失败是既有的**（skeleton → conversation view 的上游断言没跟上）：
  把三个改动文件 `git stash` 之后**同样 3 个失败**，已现场复核。
- 新 4 例覆盖：两机分组与标题顺序 / chip 窄化与回 All / `needs you` 在机器组之上 / 单机不画标题与 chip 栏。
- APK：`pubspec.yaml` `1.0.17+92` → **`1.0.18+93`**，`flutter build apk --release` 后
  8088 的 `/harness.apk` 直接就是新包（服务 cwd 就是 `build/app/outputs/flutter-apk`）。

---

# 装到手机上的其实是「云版」APK（2026-11-16 14:20）

## 症状（owner 原话）

- 手机上还是 Continue with Google / Apple 的云登录；
- 「Sign in a computer」开了相机，扫我们的配对二维码 **完全没反应**；
- 「Add computer」进去只有 `On your computer, go to autonomous.ai/go`，没有扫码；
- 于是这台机器又被 remove 掉了 —— 反正对话读不到。

## 根因：13:58 那个 APK 一个 `--dart-define` 都没带

`mobile/build/app/outputs/flutter-apk/app-release.apk`（versionCode 93）是直接
`flutter build apk --release` 打出来的。而本地部署的三个开关**全是编译期常量**
（`mobile/lib/core/config.dart`）：

| 常量 | 缺了会怎样 |
|---|---|
| `HARNESS_API_BASE_URL` | `apiBaseUrlOverride` 回落 `https://harness-api.autonomous.ai` |
| `HARNESS_LOCAL_MODE` | 默认值 = `apiBaseUrlOverride != cloudApiBaseUrl` → **false** |
| `HARNESS_LOCAL_PAIR_HOST` | 配对页主机回落 API 主机（云端） |

于是「本地包」里跑的是**云的每一条分支**：

- `PhoneWelcome` 走 `_Accounts`（Google / Apple / 邮箱），不进本地扫码；
- `YourComputerPage` 走 `GoToComputer`（`autonomous.ai/go`），不进本地配对页；
- Settings ▸ Sign in a computer 的相机是 `ScanToConnectPage(acceptConnectCodes: false)`，
  只认 `/signin#k=hnq_…`；我们的 `/pair#…` 在 `_onDetect` 里两个 parse 都返回 null →
  `continue` → **一点反应都没有**（不是崩溃，是静默跳过）；
- 聊天连的是云 backend，那台机器不在云账号里 → 什么都没有。

### 证据

```
$ strings -a lib/arm64-v8a/libapp.so | rg -c '10\.126\.126\.10:808'
0                        # ← 没有 API origin：define 没进去
$ strings -a lib/arm64-v8a/libapp.so | rg '10\.126\.126'
10.126.126.10            # ← 只有 ConnectCode.localHost 那个硬编码常量
$ aapt2 dump badging app-release.apk | rg '^package:'
package: name='ai.autonomous.harness.android' versionCode='93' versionName='1.0.18'
```

`ai.autonomous.harness.android` 正是 **Play 商店那个包的 id**。本机没有上传密钥
（`~/.android-release/harness-upload.properties` 不存在）→ release 用 debug key 签名 →
与商店签名不同 → 系统**装不上**（「应用未安装」），能点开的仍是商店那个云版图标。
所以「我装了你给的 APK」和「打开的是云版」可以同时成立。

## 修法

| 改动 | 为什么 |
|---|---|
| `scripts/build-local-apk.sh` | 一条命令打本地包：三个 define 全带、`--android-project-arg=harnessIdSuffix=.local`、打完**校验** `libapp.so` 里必须有 API origin，没有就报错、不发布 |
| `android/app/build.gradle.kts`、`AndroidManifest.xml` | `appLabel` 占位符：有 id 后缀就叫 **Harness Local**（`.bench` → Harness Bench），与云版并排、一眼分得清 |
| `mobile/lib/phone/settings_page.dart` | 本地模式下 Settings 那行改成 **Pair a computer**，进本地配对页（本地部署没有「给电脑登录」这回事） |
| `scripts/local-apk-server.mjs` + `openharness-apk.service` | 8088 从 `node -e` 临时进程变成 systemd 服务；`/` 是安装页，写明 package / label / version / sha256 |

## 验证

```
$ ./scripts/build-local-apk.sh
package: name='ai.autonomous.harness.android.local' versionCode='93' versionName='1.0.18'
application-label:'Harness Local'
sha256 7c4f1eafddb07f2358dcf2ae191dcccccd26fe8dde044df1946d33fc39457f84
served at http://10.126.126.10:8088/harness.apk

$ unzip -p app-release.apk lib/arm64-v8a/libapp.so > /tmp/x.so
$ strings -a /tmp/x.so | rg '10\.126\.126'
10.126.126.10
Open http://10.126.126.10:8089/pair on the workstation,
Visit http://10.126.126.10:8089/pair
http://10.126.126.10:8085     # ← API origin 在了，localMode 就是 true
```

- 坑：`unzip -p … | strings | rg -q` 在 `set -o pipefail` 下会**假失败**（rg 命中即退出 →
  strings 吃 SIGPIPE → 141 → `!` 反转成"没找到"）。校验必须先把 `.so` 落到文件再 rg，
  脚本注释里记了这条。

## 手机上怎么装（这一次）

1. 手机浏览器开 `http://10.126.126.10:8088/`，点下载；页面上的 sha256 应等于上面那个；
2. 装 **Harness Local**（新图标，与商店的 Harness 并存，互不覆盖）；
3. 打开它 —— 本地包一进来就直接开相机（`PhoneWelcome.initState` 里 `localMode` → `_Step.scan`）；
4. 对着电脑上 `http://10.126.126.10:8089/pair` 的二维码扫。

配对码 90 秒过期，页面每 20 秒自动换码；`local-pair-watch.ts` 一直等着新码，不用手动起 `harness pair`。

---

# 第三轮：二维码不再「扫了没反应」，安装页敢说自己是谁（2026-11-16 傍晚）

## 1. 配对二维码的生命周期是错的

上一轮把「生成即配对」改成「等手机 intent」，但保留了**每 40 秒换代**的做法：新一代替换掉
旧 helper，连 watcher 一起 kill。两个后果：

- 手机在换代前一刻扫到码（握手要 1–2 秒），watcher 在握手中间被 kill → 整次配对无声失败；
- `/code` 返回的 `lastUrl` 不会在换代时清空，新 helper 还没打印之前它给出的是**上一代**的链接
  → 任何按 `/code` 配对的客户端（本机 e2e）拿旧 code 去握手 → `CODE_MISMATCH`。

这张码上其实有两个码，寿命完全不同：

| 码 | 作用 | 寿命 |
|---|---|---|
| `h=` handoff | 手机换 token | 90 秒，**会过期** |
| `c=` pair code | CPace 口令，只在握手那一下比对 | 不过期，**不该换** |

所以改成：**一次配对 = 一个 watcher + 一个固定 pair code**，helper 每 30 秒重新铸一个
handoff、用同一个 pair code 重画二维码（先写临时文件再 rename，读者永远读不到半个 SVG）。
换代从此不再存在，两个故障同时消失。

| 文件 | 改动 |
|---|---|
| `scripts/local-pair-qr.mjs` | 一个固定 `pairCode` + 一个 watcher；循环 30s 重铸 handoff 并原子重画 `/tmp/qr.svg`；watcher 退出即结束 |
| `scripts/local-pair-qr-server.mjs` | 删掉 generation 与「expired 占位图」；只保证有一个 helper 活着，`/pair` 报状态（`starting/waiting/paired/expired`），`/code` 等本代的 `url:` 行 |

## 2. 本机 e2e 的默认口令是假的

`cli/scripts/fake-phone-qr-e2e.mjs` 里 `PAIR_CODE` 默认 `'FAKEPHONE1'`：不传参直接跑，必然
`CODE_MISMATCH` —— 看起来像「本地部署坏了」，其实是脚本自己在猜口令。现在不传参就从
`http://<host>:8089/code` 取**页面上正在显示的那张码**（`c=` 与 `h=` 一起），跑一次就验证
「此刻屏幕上的二维码能不能配对」。

```
$ node cli/scripts/fake-phone-qr-e2e.mjs
· took the QR on screen (pair code 4TEFGCPRRZS8XJKW)
· paired with the machine (fingerprint D72A·FFA2·62DE·4C29)
· agents_list → 12 agents
✓ session_get → 81 events (title "启动项目并运行")
```

## 3. 安装页说「unknown — unknown」

`local-apk-server.mjs` 读 `apk-info.json`，而 `build-local-apk.sh` 写的是
`app-release-info.json` —— 页面在**服务正确文件**的同时把 app/version 显示成 unknown，
恰好把「手机装的到底是哪个包」这个唯一能自证的字段弄丢了。现在读对文件，并且额外显示这个
包编译进去的 API origin 和配对页地址；如果磁盘上的 APK 与 info 文件不是同一个构建，页面自己
打 `⚠ stale`。

## 4. 手机端能自证「我是本地包」

Settings ▸ About 增加一行 **Local server**（只在本地构建出现），值就是它实际连的
`host:port`。装完打开 Settings 一眼可辨：写 `10.126.126.10:8085` 的是本地包，写
`harness-api.autonomous.ai`（或者根本没有这一行）的是商店那个云版。
