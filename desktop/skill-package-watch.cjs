const fs = require("node:fs");
function watchSkillPackages(root, notify, onError = () => {}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let timer, closed = false;
  const watcher = fs.watch(root, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!closed) notify(); }, 150);
  });
  watcher.on("error", onError);
  return { close() { closed = true; clearTimeout(timer); watcher.close(); } };
}
module.exports = { watchSkillPackages };
