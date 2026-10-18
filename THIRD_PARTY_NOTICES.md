# Third-party boundaries

- Tencent WorkBuddy is a third-party product. No affiliation or endorsement is implied. Original renderer bundles, artwork, fonts, catalogs, native binaries and extracted application code are excluded. Two specifically licensed skill packages are included under their own terms below.
- The MCP client is installed through npm under its upstream license. Dependency metadata is recorded in package-lock.json; node_modules is not distributed here.
- Desktop installers bundle Electron and Node.js with upstream runtime notices. Source developers install Electron separately. desktop/Node-LICENSE preserves the upstream Node.js notice.
- DSH is an external, separately obtained and built dependency. This repository contains only the product integration adapter; the DSH core is not copied or relicensed here.
- `open-skills/skill-creator` and `open-skills/expert-manager` were obtained from the WorkBuddy 5.3.14 published package. Each directory carried an Apache License 2.0 file. Their content is retained without changes, including package metadata, references and scripts. They remain Apache-2.0, not MIT. The product installs them as text instructions; their scripts do not execute on installation. Model-accessible execution still uses product approvals and declared tools.
- Desktop binaries additionally bundle unmodified Ollama 0.40.6 under MIT and its upstream dependency notices, and CPython 3.12.15 from Astral python-build-standalone with Python and dependency notices. Runtime download URLs and checksums are in `desktop/runtime-manifest.json`. Binary notices are retained beside their runtimes in `Contents/Resources/runtime`.
- Qwen3 1.7B is downloaded only after the user explicitly requests it. The model's Apache 2.0 license is exposed by its upstream registry: https://ollama.com/library/qwen3:1.7b . Its weights are not stored in Git or the base installer. Optional MLX vision and Whisper speech dependencies and weights remain separate, not included in this desktop installer.
- Tests that inspect an installed third-party renderer or catalog require resources absent from this source release. Their presence in the test source does not grant redistribution rights.

## Research screenshots

Images under docs/screenshots are documentation captures of the local compatibility prototype using WorkBuddy interface resources. They illustrate reverse-engineering research and product behavior; they are not original UI source assets. Third-party UI elements and trademarks shown remain with their respective owners and are not relicensed under the project MIT license. The public source defaults to an independently authored UI.
