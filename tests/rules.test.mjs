import { test } from "node:test";
import assert from "node:assert/strict";
import { splitRent, parseSleep, checksHalfway, roleList, SETTING_GROUPS, TABLE_RULES } from "../scripts/rules.mjs";

test("splitRent equal: floor share, remainder 1eb each to the first members", () => {
  assert.deepEqual(splitRent(1000, 3, "equal"), [334, 333, 333]);
  assert.deepEqual(splitRent(1001, 3, "equal"), [334, 334, 333]);
  assert.deepEqual(splitRent(900, 3, "equal"), [300, 300, 300]);
  assert.deepEqual(splitRent(2, 3, "equal"), [1, 1, 0]);
  assert.deepEqual(splitRent(1000, 3), [334, 333, 333]);
});

test("splitRent first and none", () => {
  assert.deepEqual(splitRent(1000, 3, "first"), [1000, 0, 0]);
  assert.deepEqual(splitRent(1000, 3, "none"), [0, 0, 0]);
  assert.deepEqual(splitRent(1000, 1, "equal"), [1000]);
});

test("splitRent: no members, no charges", () => {
  for ( const mode of ["equal", "first", "none"] ) assert.deepEqual(splitRent(1000, 0, mode), []);
});

test("splitRent: zero rent", () => {
  assert.deepEqual(splitRent(0, 2, "equal"), [0, 0]);
  assert.deepEqual(splitRent(0, 2, "first"), [0, 0]);
});

test("parseSleep reads the start hour and length", () => {
  assert.deepEqual(parseSleep("22:00-06:00"), { from: 22, hours: 8 });
  assert.deepEqual(parseSleep("01:00-07:00"), { from: 1, hours: 6 });
  assert.deepEqual(parseSleep(" 23:30 - 7:00 "), { from: 23, hours: 8 });
});

test("parseSleep wraps past midnight", () => {
  assert.deepEqual(parseSleep("20:00-04:00"), { from: 20, hours: 8 });
  assert.deepEqual(parseSleep("00:00-23:00"), { from: 0, hours: 23 });
  assert.deepEqual(parseSleep("23:00-00:00"), { from: 23, hours: 1 });
});

test("parseSleep: invalid, empty or zero-length gives the default", () => {
  const fallback = { from: 22, hours: 8 };
  for ( const text of ["", null, undefined, "nonsense", "22-06", "25:00-06:00", "22:60-06:00", "22:00-24:00", "06:00-06:00"] ) {
    assert.deepEqual(parseSleep(text), fallback, String(text));
  }
});

test("checksHalfway by mode", () => {
  assert.equal(checksHalfway("invent", "invent"), true);
  assert.equal(checksHalfway("fabricate", "invent"), false);
  assert.equal(checksHalfway("fabricate", "all"), true);
  assert.equal(checksHalfway("invent", "none"), false);
  assert.equal(checksHalfway("invent", undefined), true);
});

test("roleList: trimmed, lowercased, empty names dropped", () => {
  assert.deepEqual(roleList("Tech, Medtech"), ["tech", "medtech"]);
  assert.deepEqual(roleList("  TECH ,, fixer ,"), ["tech", "fixer"]);
  assert.deepEqual(roleList("netrunner"), ["netrunner"]);
});

test("roleList: empty means Tech", () => {
  for ( const text of ["", "  ", ",, ,", null, undefined] ) assert.deepEqual(roleList(text), ["tech"]);
});

test("setting groups: setup order, menus and keys", () => {
  assert.deepEqual(SETTING_GROUPS.map(g => [g.id, g.menu, g.keys]), [
    ["activities", "editActivities", ["downtimeActivities"]],
    ["lifestyle", "editPresets", ["lifestylePresets"]],
    ["upkeep", "tableRules", ["upkeep", "upkeepMalfunctions", "upkeepNeglect"]],
    ["billing", "tableRules", ["billAgentPlans", "rentSplit"]],
    ["crewBenefits", "tableRules", ["crewEffects"]],
    ["downtime", "tableRules", ["downtimeSystem", "requireFullDay", "sleepMinimum", "defaultSleep", "fatigueOnSettle"]],
    ["workshop", "tableRules", ["workDay", "halfwayCheck", "workshopRoles"]],
    ["content", undefined, ["contentFolder"]]
  ]);
});

test("every table rule is in a Table rules group, with a valid default", () => {
  const inForm = SETTING_GROUPS.filter(g => g.menu === "tableRules").flatMap(g => g.keys);
  for ( const [key, rule] of Object.entries(TABLE_RULES) ) {
    assert.ok(inForm.includes(key), key);
    if ( rule.choices ) assert.ok(rule.choices.includes(rule.default), key);
  }
  assert.equal(TABLE_RULES.sleepMinimum.default, 6);
  assert.deepEqual(roleList(TABLE_RULES.workshopRoles.default), ["tech"]);
  assert.deepEqual(parseSleep(TABLE_RULES.defaultSleep.default), { from: 22, hours: 8 });
});
