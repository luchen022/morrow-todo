import test from "node:test";
import assert from "node:assert/strict";
import { calendarDays, calendarKey, calendarToday, dueDayKey, shiftCalendar } from "../src/calendar.ts";

test("month calendar includes leap day and complete Monday-to-Sunday weeks", () => {
  const days = calendarDays(new Date("2024-02-12T12:00:00Z"), "month");
  assert.equal(days.length, 42);
  assert.equal(calendarKey(days[0]), "2024-01-29");
  assert.ok(days.some((day) => calendarKey(day) === "2024-02-29"));
  assert.equal(days.at(-1).getUTCDay(), 0);
});

test("week spans year boundaries and starts Monday even when anchor is Sunday", () => {
  const days = calendarDays(new Date("2027-01-03T12:00:00Z"), "week");
  assert.equal(calendarKey(days[0]), "2026-12-28");
  assert.equal(calendarKey(days.at(-1)), "2027-01-03");
});

test("month navigation does not skip February when starting January 31", () => {
  assert.equal(calendarKey(shiftCalendar(new Date("2026-01-31T12:00:00Z"), "month", 1)), "2026-02-01");
  assert.equal(calendarKey(shiftCalendar(new Date("2026-12-31T12:00:00Z"), "month", 1)), "2027-01-01");
});

test("deadline grouping follows configured timezone, including DST", () => {
  assert.equal(dueDayKey("2026-10-02T18:00:00Z", "Asia/Shanghai"), "2026-10-03");
  assert.equal(dueDayKey("2026-10-02T03:00:00Z", "America/Los_Angeles"), "2026-10-01");
  assert.equal(dueDayKey("2026-03-08T07:30:00Z", "America/New_York"), "2026-03-08");
  assert.equal(calendarKey(calendarToday("Asia/Shanghai", new Date("2026-12-31T18:00:00Z"))), "2027-01-01");
  assert.equal(dueDayKey("invalid", "Asia/Shanghai"), null);
});

test("week navigation remains seven civil days across DST", () => {
  assert.equal(calendarKey(shiftCalendar(new Date("2026-03-04T12:00:00Z"), "week", 1)), "2026-03-11");
});
