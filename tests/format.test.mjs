/**
 * Tests for `src/core/format.ts`.
 *
 * Two things here are worth pinning. Byte formatting is the last step in front of
 * a number people will compare against a data plan, so the unit system has to be
 * honoured exactly rather than approximately. And `parseByteSize` reads the field
 * that will later decide when to cut off someone's connection — it has to return
 * `null` when it cannot tell, never a guess.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  formatBytesBadge,
  formatCount,
  formatOfBudget,
  formatPercent,
  parseByteSize,
  splitBytes,
} from "../src/core/format.ts";

test("decimal and binary units are both exact", () => {
  assert.equal(formatBytes(999, "si"), "999 B");
  assert.equal(formatBytes(1000, "si"), "1.0 kB");
  assert.equal(formatBytes(1_500_000, "si"), "1.5 MB");
  assert.equal(formatBytes(1_000_000_000, "si"), "1.0 GB");

  assert.equal(formatBytes(1023, "iec"), "1023 B");
  assert.equal(formatBytes(1024, "iec"), "1.0 KiB");
  assert.equal(formatBytes(1024 * 1024, "iec"), "1.0 MiB");

  // The same byte count in both systems, which is the whole reason the unit is
  // always printed.
  assert.equal(formatBytes(1_048_576, "si"), "1.0 MB");
  assert.equal(formatBytes(1_048_576, "iec"), "1.0 MiB");
});

test("precision drops once a figure has three digits", () => {
  assert.equal(splitBytes(9_400_000, "si").value, "9.4");
  assert.equal(splitBytes(45_600_000, "si").value, "45.6");
  assert.equal(splitBytes(345_000_000, "si").value, "345");
  assert.deepEqual(splitBytes(0, "si"), { value: "0", unit: "B" });
  assert.equal(formatBytes(0, "si"), "0 B");
  assert.equal(formatBytes(1, "si"), "1 B");
});

test("nothing formats as NaN or undefined", () => {
  for (const value of [0, 1, 999, 1000, 12_345, 9_999_999_999, 1.5, -400]) {
    for (const units of ["si", "iec"]) {
      const text = formatBytes(value, units);
      assert.doesNotMatch(text, /NaN|undefined/, `${value} ${units} formatted as ${text}`);
    }
  }
  assert.equal(formatBytes(-400, "si"), "-400 B");
});

test("a badge stays within four characters", () => {
  for (const value of [0, 940, 9_400, 94_000, 940_000, 9_400_000, 94_000_000, 940_000_000, 9.4e12]) {
    const text = formatBytesBadge(value, "si");
    assert.ok(text.length <= 4, `"${text}" is ${text.length} characters for ${value}`);
    assert.doesNotMatch(text, /NaN|undefined/);
  }
  assert.equal(formatBytesBadge(1_500_000, "si"), "1.5M");
  assert.equal(formatBytesBadge(345_000_000, "si"), "345M");
});

test("a rounded percentage never claims certainty it does not have", () => {
  assert.equal(formatPercent(1), "100%");
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(0.921), "92%");
  assert.equal(formatPercent(0.996), ">99%", "must not round up to 100%");
  assert.equal(formatPercent(0.004), "<1%", "must not round down to 0%");
  assert.equal(formatPercent(Number.NaN), "–");
});

test("counts and budget lines read cleanly", () => {
  assert.equal(formatCount(0), "0");
  assert.doesNotMatch(formatCount(1234), /NaN/);
  assert.equal(formatOfBudget(4_200_000, 50_000_000, "si"), "4.2 MB of 50.0 MB");
});

test("a typed size is read generously but never guessed", () => {
  // A bare number in a limit field means megabytes: that is what a person typing
  // "500" into a data cap means, and it is documented on the field.
  assert.equal(parseByteSize("500"), 500_000_000);
  assert.equal(parseByteSize("50MB"), 50_000_000);
  assert.equal(parseByteSize("  1.5 gb "), 1_500_000_000);
  assert.equal(parseByteSize("250 MiB"), 250 * 1024 * 1024);
  assert.equal(parseByteSize("2G"), 2_000_000_000);
  assert.equal(parseByteSize("1,500 kb"), 1_500_000);
  assert.equal(parseByteSize("900b"), 900);
  assert.equal(parseByteSize("0"), 0);

  for (const bad of ["", "   ", "abc", "50 bananas", "-5 MB", "1.2.3 MB", "MB"]) {
    assert.equal(parseByteSize(bad), null, `"${bad}" should not parse`);
  }
});
