## macOS Apple Silicon 安装测试版

下载 DMG，打开后将 **WorkBuddy Local Open.app** 拖到 Applications。需要 macOS 14+、Apple Silicon，建议至少 8 GB 内存。

- 包含 Electron、Node、Python 和 Ollama，无需安装开发工具。
- 首次在设置中下载 Qwen3 1.7B（约 1.4 GB），完成后点击「使用此模型」；也支持自己的 OpenAI 兼容接口。
- 单实例模型、8192 上下文、回答后卸载，退出应用停止私有模型服务。
- 内置两个 Apache 2.0 管理技能，独立数据目录，不覆盖旧版。
- 本机 251 项回归通过、0 项失败、9 项外部条件跳过。实际下载/推理、桌面取消、DMG 安装后重启和 Office 生成已验收。发布流程另运行源码回归和打包后运行环境检查。

这是开发测试版，临时签名并通过签名检查，**尚未经过 Apple 公证**，首次打开可能被 macOS 拦截。公开界面是独立实现，原版 UI 一致性、专家团执行和完整 5.8.3 适配尚未完成。DSH 可选，需要另行准备其仓库；图片/音频的额外本地感知模型未打包。

模型权重不在基础安装包内，首次下载需要联网。下载文件的 SHA256 见同页 SHA256SUMS.txt。详细说明见 README 与 docs/PUBLISHING.md。
