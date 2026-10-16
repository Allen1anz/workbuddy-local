# WorkBuddy Local

独立实现的本地 Agent 工作台、Electron 桌面宿主与 DSH 适配器。支持 OpenAI 兼容接口，包括本机模型服务。

这是开发预览版，不是腾讯官方产品。公开仓库使用独立编写的网页界面；不分发原版 WorkBuddy 的 renderer、字体、图标、内置专家、技能、安装包或反编译产物。本机已有的原版资源与旧版本成果不受本次发布影响。

## 快速启动

需要 Node.js 24.11+ 和 Python 3。

```bash
git clone https://github.com/Allen1anz/workbuddy-local.git
cd workbuddy-local
npm ci
npm start
```

打开 http://127.0.0.1:18721，在设置中填写模型 API 根地址、模型名称和密钥，再选择工作目录。本机 OpenAI 兼容服务也可使用，模型权重需要自行准备。

## 能力与边界

- 流式对话、取消、持久化会话、Ask/Craft 模式与文件/命令逐次审批。
- 自定义专家与技能、记忆、自动化、MCP 连接、工作区浏览和 Office 基础读写。
- 图片与 WAV/MP3 输入支持；本地视觉/转写需另行安装依赖并准备模型。
- 可选 DSH 真实运行时适配：工具通过现有产品审批，会话恢复与取消已验证。
- Electron 宿主与兼容桥源码公开。公开版本默认加载独立网页 UI，不宣称与原版界面完全一致。

专家团执行、完整专家流程的 DSH 验收和 WorkBuddy 5.8.3 全量适配尚未完成。腾讯账号、微信绑定和官方云市场未接入。

## DSH 接入

单独准备并构建兼容的 DSH 仓库（本次本地验证版本为 0.2.0-rc.2），确保存在 `apps/cli/lib/bin.js` 和 `packages/sdk/client/lib/index.js`。在应用数据目录创建 `dsh-runtime.json`：

```json
{"enabled":true,"repository":"/absolute/path/to/dsh"}
```

网页数据目录默认为 `.data`；桌面默认在 `~/Library/Application Support/WorkBuddy Local/data`。新会话使用 DSH；已有旧引擎会话继续保留。适配器通过 `sdk-minimal` 命名 profile 启动，不修改 DSH 核心。

## 桌面开发

```bash
npm install --no-save --package-lock=false electron@37.10.3
npm run desktop
```

桌面默认使用公开网页界面。兼容桥和旧 renderer 专用的独立设置窗口需要另行提供有权使用的资源；仓库不提供这些资源，也不提供包含它们的二进制下载。`desktop/build.mjs` 是 macOS 本地打包工具，需要按源码中的目录安装 Electron runtime，未作为跨平台发布流程验收。

## 测试与发布

```bash
npm test
# 可选：使用本机已构建 DSH 运行真实 runtime 协议测试
DSH_REPOSITORY=/absolute/path/to/dsh npm test
```

发布版测试结果和外部资源测试范围见 [发布说明](docs/PUBLISHING.md)。测试中的脚本模型仅用于协议验证；本机此前另做过真实 Qwen 模型验收。

模型接口会收到对话和工具读取的内容。密钥存于本机数据目录，未做数据库加密。获批 shell 使用当前用户权限，工作目录不是操作系统沙箱。应用默认仅监听回环地址。

## 许可证

本仓库独立实现代码采用 [MIT](LICENSE)。第三方依赖、模型和用户自行提供的资源分别受各自许可证约束；MIT 不授予 WorkBuddy 商标、原版代码或素材的权利。见 [第三方说明](THIRD_PARTY_NOTICES.md)。
