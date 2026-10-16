const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MINUTE = 60000;

function dateValue(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw Error(`${label} 必须为有效日期`);
  return time;
}
function numbers(value, low, high, label) {
  const values = String(value)
    .split(",")
    .map((item) => {
      if (!/^\d+$/.test(item)) throw Error(`${label} 无效`);
      const number = Number(item);
      if (number < low || number > high) throw Error(`${label} 超出范围`);
      return number;
    });
  return [...new Set(values)];
}

/** Validate the RRULE subset emitted by the desktop editor, in host local time. */
export function validateCalendarSchedule(automation) {
  const from = dateValue(automation.validFrom, "validFrom");
  const until = dateValue(automation.validUntil, "validUntil");
  if (from !== null && until !== null && until < from) throw Error("有效结束日期早于开始日期");
  if (automation.status && !["ACTIVE", "PAUSED"].includes(automation.status))
    throw Error("调度状态必须为 ACTIVE / PAUSED");
  const anchor =
    dateValue(
      automation.scheduleAnchor || automation.createdAt || automation.created_at,
      "scheduleAnchor",
    ) ?? Date.UTC(1970, 0, 5);
  if (automation.scheduleType === "once") {
    const at = dateValue(automation.scheduledAt, "scheduledAt");
    if (at === null) throw Error("一次任务必须设置 scheduledAt");
    return { type: "once", at, from, until, anchor };
  }
  if (automation.scheduleType !== "recurring") throw Error("scheduleType 必须为 once / recurring");
  const fields = {};
  for (const part of String(automation.rrule || "").split(";")) {
    const match = /^([A-Z]+)=([^=]+)$/.exec(part);
    if (!match || Object.hasOwn(fields, match[1])) throw Error("RRULE 格式无效或字段重复");
    fields[match[1]] = match[2];
  }
  const freq = fields.FREQ;
  const allowed = {
    HOURLY: ["FREQ", "INTERVAL", "BYDAY"],
    DAILY: ["FREQ", "BYHOUR", "BYMINUTE"],
    WEEKLY: ["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"],
    MONTHLY: ["FREQ", "BYMONTHDAY", "BYHOUR", "BYMINUTE"],
    YEARLY: ["FREQ", "BYMONTH", "BYMONTHDAY", "BYHOUR", "BYMINUTE"],
  }[freq];
  if (!allowed || Object.keys(fields).some((key) => !allowed.includes(key)))
    throw Error("RRULE 含原编辑器不支持的调度字段");
  const interval = fields.INTERVAL
    ? numbers(fields.INTERVAL, 1, freq === "WEEKLY" ? 2 : 8760, "INTERVAL")[0]
    : 1;
  if (fields.INTERVAL?.includes(",")) throw Error("INTERVAL 必须为单个整数");
  const days = fields.BYDAY ? [...new Set(fields.BYDAY.split(","))] : DAYS;
  if (days.some((day) => !DAYS.includes(day))) throw Error("BYDAY 无效");
  if (freq === "WEEKLY" && !fields.BYDAY) throw Error("每周任务必须设置 BYDAY");
  const hour = freq === "HOURLY" ? null : numbers(fields.BYHOUR, 0, 23, "BYHOUR");
  const minute = freq === "HOURLY" ? null : numbers(fields.BYMINUTE, 0, 59, "BYMINUTE");
  if (hour?.length > 1 || minute?.length > 1) throw Error("原编辑器只支持单个时分");
  const monthDays = ["MONTHLY", "YEARLY"].includes(freq)
    ? numbers(fields.BYMONTHDAY, 1, 31, "BYMONTHDAY")
    : [];
  const months = freq === "YEARLY" ? numbers(fields.BYMONTH, 1, 12, "BYMONTH") : [];
  if (
    freq === "YEARLY" &&
    !months.some((month) => monthDays.some((day) => day <= new Date(2000, month, 0).getDate()))
  )
    throw Error("年度任务没有存在的日历日期");
  return {
    type: "recurring",
    freq,
    interval,
    days,
    hour: hour?.[0],
    minute: minute?.[0],
    monthDays,
    months,
    from,
    until,
    anchor,
  };
}

function dayNumber(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}
function mondayNumber(date) {
  return dayNumber(date) - ((date.getDay() + 6) % 7);
}

/** Return the first scheduled instant strictly after `after`, or null if exhausted/paused.
 * Nonexistent DST wall times and absent month days are skipped. Ambiguous DST times
 * use JavaScript's earlier occurrence. Hourly cadence is elapsed time from anchor.
 */
export function nextCalendarRun(automation, after = Date.now()) {
  const schedule = validateCalendarSchedule(automation);
  const afterTime = dateValue(after, "after");
  if (afterTime === null) throw Error("after 必须为有效日期");
  if (automation.status === "PAUSED" || automation.enabled === false) return null;
  const lower = Math.max(afterTime + 1, schedule.from ?? -Infinity);
  const accept = (time) => time >= lower && (schedule.until === null || time <= schedule.until);
  if (schedule.type === "once")
    return accept(schedule.at) ? new Date(schedule.at).toISOString() : null;
  if (schedule.until !== null && lower > schedule.until) return null;
  if (schedule.freq === "HOURLY") {
    const step = schedule.interval * 60 * MINUTE;
    let time = schedule.anchor + Math.max(0, Math.ceil((lower - schedule.anchor) / step)) * step;
    for (let attempts = 0; attempts < 24 * 366 * 10; attempts++, time += step) {
      if (schedule.until !== null && time > schedule.until) return null;
      if (schedule.days.includes(DAYS[new Date(time).getDay()]))
        return new Date(time).toISOString();
    }
    return null;
  }
  const day = new Date(lower);
  day.setHours(12, 0, 0, 0);
  const anchorWeek = mondayNumber(new Date(schedule.anchor));
  for (let attempts = 0; attempts < 366 * 10; attempts++, day.setDate(day.getDate() + 1)) {
    const time = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      schedule.hour,
      schedule.minute,
    );
    if (schedule.until !== null && time.getTime() > schedule.until) return null;
    if (
      time.getDate() !== day.getDate() ||
      time.getHours() !== schedule.hour ||
      time.getMinutes() !== schedule.minute
    )
      continue;
    if (!accept(time.getTime())) continue;
    if (
      schedule.freq === "WEEKLY" &&
      (!schedule.days.includes(DAYS[day.getDay()]) ||
        ((mondayNumber(day) - anchorWeek) / 7) % schedule.interval !== 0)
    )
      continue;
    if (
      ["MONTHLY", "YEARLY"].includes(schedule.freq) &&
      !schedule.monthDays.includes(day.getDate())
    )
      continue;
    if (schedule.freq === "YEARLY" && !schedule.months.includes(day.getMonth() + 1)) continue;
    return time.toISOString();
  }
  return null;
}
