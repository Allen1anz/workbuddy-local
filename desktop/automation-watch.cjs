"use strict";
function createAutomationWatch({
  getSnapshot,
  publish,
  onError = () => {},
  intervalMs = 1000,
  getSignature = (snapshot) =>
    JSON.stringify({
      automations: snapshot.automations,
      inbox: snapshot.inbox,
      runtimeState: snapshot.runtimeState,
    }),
  schedule = setInterval,
  unschedule = clearInterval,
}) {
  let active = false,
    busy = false,
    timer,
    revision = 0,
    previous;
  async function tick() {
    if (!active || busy) return;
    busy = true;
    const current = revision;
    try {
      const snapshot = await getSnapshot();
      if (!active || current !== revision) return;
      const signature = getSignature(snapshot);
      if (signature !== previous) {
        await publish(snapshot);
        previous = signature;
      }
    } catch (error) {
      if (active && current === revision) onError(error);
    } finally {
      busy = false;
    }
  }
  return {
    start() {
      if (active) return;
      active = true;
      revision++;
      previous = undefined;
      timer = schedule(tick, intervalMs);
      timer?.unref?.();
      void tick();
    },
    stop() {
      active = false;
      revision++;
      if (timer) unschedule(timer);
      timer = undefined;
    },
    tick,
  };
}
module.exports = { createAutomationWatch };
