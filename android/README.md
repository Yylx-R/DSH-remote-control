# DSH Console · Android 客户端

原生 Kotlin + Jetpack Compose 写的手机端（不套 WebView）：登录你自建的中继服务器 → 选择已配对的电脑 →
浏览会话、发消息、上传附件、查看电脑屏幕、远程按键。协议与网页版（`relay/public`）完全一致。

## 环境

- JDK 17 及以上（`JAVA_HOME` 指向它）
- Android SDK：`platforms;android-35`、`build-tools;35.0.0`、`platform-tools`
- 用自带的 Gradle wrapper（`gradlew.bat` / `./gradlew`），无需单独装 Gradle

首次构建前在项目根目录建 `local.properties`：

```properties
sdk.dir=C:\\Users\\you\\AppData\\Local\\Android\\Sdk
```

## 构建

```powershell
.\gradlew.bat assembleDebug
# 产物：app\build\outputs\apk\debug\app-debug.apk
```

release 包需要签名。复制 `keystore.properties.example` 为 `keystore.properties` 并填写（该文件已被 gitignore）：

```properties
storeFile=keystore/your-release.jks
storePassword=***
keyAlias=your-alias
keyPassword=***
```

没有 `keystore.properties` 时 release 会退回 debug 签名，只适合自己安装测试。

生成新密钥：

```powershell
keytool -genkeypair -v -keystore keystore/your-release.jks -alias your-alias `
  -keyalg RSA -keysize 3072 -validity 10000 -storepass *** -keypass *** `
  -dname "CN=Your Name, O=Your Org, C=CN"
```

> **别把 `.jks` 和口令提交到仓库。** 泄漏签名密钥 = 别人可以用你的名义发「官方更新」。

## 安装

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

也可以把 APK 传到手机上点安装（需要允许「安装未知应用」）。

## 使用流程

1. 电脑端插件已配置好服务器地址与账号（DSH 的 Web 界面里打开 `/remote-control`，或跑 `scripts/setup-pc.mjs`）。
2. 电脑端生成配对码：`node scripts/pair.mjs`，记下 8 位码。
3. 手机登录同一账号 → 「输入配对码」→ 填码提交 → 电脑终端确认 `y`。
4. 回到设备页选中电脑 → 选/建会话 → 发消息。

## 功能

| 页面 | 能力 |
| --- | --- |
| 登录 | 服务器 / 账号 / 密码；服务器无默认值，首次必须手填并保存 |
| 设备 | 已配对电脑、在线状态、配对入口、连接状态、刷新 |
| 会话 | 列表（运行中标记）、新建、刷新 |
| 聊天 | 历史消息、流式逐字回复、Markdown 渲染、工具调用折叠、停止任务、发送附件（相册/拍照/文件） |
| 电脑画面 | 主屏/副屏/全部、清晰度、横竖屏、点击缩放、全屏、2 秒自动刷新、Alt+Tab 等控制键 |
| 设置 | 主题（跟随系统/浅色/深色）、检查更新、账号与服务器、本机名、撤销设备、退出 |

## 代码结构

```
app/src/main/java/com/dshremote/app/
  MainActivity.kt          # 入口、导航、主题、返回键、生命周期重连
  AppViewModel.kt          # 状态机：登录、WS 指令、流处理、配对、附件、截屏、更新
  data/Protocol.kt         # JSON 工具、数据模型、记录归一化、注入文本过滤
  data/HttpApi.kt          # REST：登录/me/配对/撤销/附件上传下载
  data/RelaySocket.kt      # 中继长连接（hello/welcome/msg/reply/stream/kick/心跳）
  data/UpdateChecker.kt    # 读服务器 app/latest.json、下载并校验 sha256
  ui/LoginScreen.kt
  ui/DevicesScreen.kt
  ui/SessionsScreen.kt
  ui/ChatScreen.kt
  ui/ScreenView.kt         # 电脑画面 + 控制键
  ui/SettingsScreen.kt
  ui/Markdown.kt           # 轻量 Markdown 渲染
  ui/Common.kt             # 顶栏、空态、徽章
  ui/theme/Theme.kt        # DSH 配色（#0F1115 / #4D6BFE）、深浅色
```

## 协议速查

- 连接：`ws(s)://<server>/ws`，open 后发 `{t:'hello',token}`，收 `{t:'welcome',pairs,serverTime,heartbeatMs}`。
- 指令：`{t:'msg',id:rid,to:<电脑设备id>,kind:'dsh',body:{op,rid,...}}`。
- 回复：`{op:'reply',rid,ok:true,data}` / `{op:'reply',rid,ok:false,error:{code,message}}`。
- 流：`{op:'stream',subId,frame}` / `{op:'stream',subId,error}` / `{op:'stream',subId,done:true}`。
- 常用 op：`sessions.list/create/prompt/cancel/snapshot/follow/unfollow`、`workspaces.list`、
  `screen.capture`、`screen.control`、`device.info`、`pair.code`。

## 已知限制

- 默认按 HTTP 演示，公网部署必须配 HTTPS（见根目录 `SECURITY.md`）。
- 无端到端加密：中继服务器能看到消息与附件。
- 无系统级推送，依赖前台长连接 + 打开时补拉。
- 屏幕是**按需截图**，不是实时视频。
