const { createAutomationWatch } = require("./automation-watch.cjs");
function createMcpAppWatch({ getApps, publish, ...options }) {
  return createAutomationWatch({
    ...options,
    getSnapshot: getApps,
    getSignature: (apps) => JSON.stringify(apps),
    publish,
  });
}
module.exports = { createMcpAppWatch };
