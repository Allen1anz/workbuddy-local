# Third-party boundaries

- Tencent WorkBuddy is a third-party product. No affiliation or endorsement is implied. Original renderer bundles, artwork, fonts, built-in catalogs, skills, native binaries and extracted application code are excluded from this repository.
- The MCP client is installed through npm under its upstream license. Dependency metadata is recorded in package-lock.json; node_modules is not distributed here.
- Electron and Node.js are separate runtimes. Electron is installed separately. desktop/Node-LICENSE preserves the upstream Node.js notice for optional local packaging.
- DSH is an external, separately obtained and built dependency. This repository contains only the product integration adapter; the DSH core is not copied or relicensed here.
- Optional MLX vision and Whisper speech dependencies and model weights are not distributed. Users must obtain them separately under their respective licenses.
- Tests that inspect an installed third-party renderer or catalog require resources absent from this source release. Their presence in the test source does not grant redistribution rights.

## Research screenshots

Images under docs/screenshots are documentation captures of the local compatibility prototype using WorkBuddy interface resources. They illustrate reverse-engineering research and product behavior; they are not original UI source assets. Third-party UI elements and trademarks shown remain with their respective owners and are not relicensed under the project MIT license. The public source defaults to an independently authored UI.
