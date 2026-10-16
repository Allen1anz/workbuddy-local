import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { nextCalendarRun, validateCalendarSchedule } from "./calendar-schedule.mjs";

const rule = (rrule, extra = {}) => ({
  scheduleType: "recurring",
  status: "ACTIVE",
  rrule,
  ...extra,
});
const local = (year, month, day, hour = 0, minute = 0) =>
  new Date(year, month - 1, day, hour, minute);

test("once, pause, valid range and strict after semantics", () => {
  const at = local(2026, 10, 14, 9).toISOString();
  const once = { scheduleType: "once", scheduledAt: at, status: "ACTIVE" };
  assert.equal(nextCalendarRun(once, local(2026, 10, 14, 8)), at);
  assert.equal(nextCalendarRun(once, at), null);
  assert.equal(nextCalendarRun({ ...once, status: "PAUSED" }, local(2026, 10, 14, 8)), null);
  assert.equal(
    nextCalendarRun({ ...once, validUntil: local(2026, 10, 14, 8) }, local(2026, 10, 13)),
    null,
  );
  assert.equal(nextCalendarRun({ ...once, validFrom: at }, local(2026, 10, 13)), at);
});
test("daily wall clock and valid start boundary", () => {
  const daily = rule("FREQ=DAILY;BYHOUR=9;BYMINUTE=15");
  assert.equal(
    nextCalendarRun(daily, local(2026, 10, 13, 9, 15)),
    local(2026, 10, 14, 9, 15).toISOString(),
  );
  assert.equal(
    nextCalendarRun({ ...daily, validFrom: local(2026, 10, 20, 10) }, local(2026, 10, 13)),
    local(2026, 10, 21, 9, 15).toISOString(),
  );
});
test("weekly days and two week persistent anchor survive restart", () => {
  const weekly = rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;BYHOUR=10;BYMINUTE=0", {
    scheduleAnchor: local(2026, 10, 5).toISOString(),
  });
  const next = nextCalendarRun(weekly, local(2026, 10, 7, 10));
  assert.equal(next, local(2026, 10, 19, 10).toISOString());
  assert.equal(nextCalendarRun(JSON.parse(JSON.stringify(weekly)), local(2026, 10, 12)), next);
});
test("monthly dates skip absent days and yearly leap day advances correctly", () => {
  assert.equal(
    nextCalendarRun(rule("FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=8;BYMINUTE=0"), local(2026, 4, 1)),
    local(2026, 5, 31, 8).toISOString(),
  );
  assert.equal(
    nextCalendarRun(rule("FREQ=MONTHLY;BYMONTHDAY=1,15;BYHOUR=8;BYMINUTE=0"), local(2026, 4, 1, 8)),
    local(2026, 4, 15, 8).toISOString(),
  );
  assert.equal(
    nextCalendarRun(
      rule("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYHOUR=8;BYMINUTE=0"),
      local(2026, 1, 1),
    ),
    local(2028, 2, 29, 8).toISOString(),
  );
});
test("hourly cadence preserves anchor and filters weekdays", () => {
  const hourly = rule("FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR", {
    scheduleAnchor: local(2026, 10, 9, 9, 30).toISOString(),
  });
  assert.equal(
    nextCalendarRun(hourly, local(2026, 10, 9, 23, 30)),
    local(2026, 10, 12, 1, 30).toISOString(),
  );
});
test("invalid and unsupported RRULE fields fail before saving", () => {
  for (const rrule of [
    "FREQ=DAILY;BYHOUR=24;BYMINUTE=0",
    "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=3",
    "FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0",
    "FREQ=WEEKLY;BYDAY=XX;BYHOUR=9;BYMINUTE=0",
    "FREQ=DAILY;FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYHOUR=9;BYMINUTE=0",
  ])
    assert.throws(() => validateCalendarSchedule(rule(rrule)));
  assert.throws(() => validateCalendarSchedule({ scheduleType: "once", scheduledAt: "garbage" }));
});
test("DST missing local times skip rather than silently shift", () => {
  const source = `import { nextCalendarRun } from ${JSON.stringify(new URL("./calendar-schedule.mjs", import.meta.url).href)};
    const next = nextCalendarRun({scheduleType:'recurring',rrule:'FREQ=DAILY;BYHOUR=2;BYMINUTE=30'},new Date(2026,2,7,3));
    const date = new Date(next); console.log(JSON.stringify([date.getMonth(),date.getDate(),date.getHours(),date.getMinutes()]));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [2, 9, 2, 30]);
});
