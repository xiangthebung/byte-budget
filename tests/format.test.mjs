/**
 * Tests for `src/core/format.ts`.
 *
 * Two things here are worth pinning. Byte formatting is the last step in front of
 * a number people will compare against a data plan, so the unit system has to be
 * honoured exactly rather than approximately. And `parseByteSize` reads the field
 * that will later decide when to cut off someone's connection — it has to return
 * `null` when it cannot tell, never a guess.
 *
 * The third thing is the join between them: the app has to be able to read back
 * what it printed. Formatting localises, so every assertion below would otherwise
 * depend on the locale of whichever machine ran the suite. The default is pinned to
 * en-US and `withLocale` moves it, which is also the only way to put a comma-decimal
 * reader in front of these functions from a test process that is not one.
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

const NativeNumberFormat = Intl.NumberFormat;
let locale = "en-US";
Intl.NumberFormat = function NumberFormat(_requested, options) {
  return new NativeNumberFormat(locale, options);
};
// A stand-in for the constructor, so anything else in this process that reaches for
// it — an `instanceof`, a reporter — still finds what it expects.
Intl.NumberFormat.prototype = NativeNumberFormat.prototype;
Intl.NumberFormat.supportedLocalesOf = NativeNumberFormat.supportedLocalesOf;

function withLocale(next, run) {
  const previous = locale;
  locale = next;
  try {
    run();
  } finally {
    locale = previous;
  }
}

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
  // The last two are the carry cases: 999,999,999 B is 999.999… MB, which rounds to
  // a five-character "1000M", and 1023 MiB is four digits before the unit letter is
  // even added. Both have to come out as the next unit up.
  const values = [
    0, 940, 9_400, 94_000, 940_000, 9_400_000, 94_000_000, 940_000_000, 999_999_999,
    1023 * 1024 * 1024, 9.4e12,
  ];
  for (const name of ["en-US", "de-DE"]) {
    withLocale(name, () => {
      for (const value of values) {
        for (const units of ["si", "iec"]) {
          const text = formatBytesBadge(value, units);
          const where = `${value} ${units} in ${name}`;
          assert.ok(text.length <= 4, `"${text}" is ${text.length} characters for ${where}`);
          assert.doesNotMatch(text, /NaN|undefined/);
        }
      }
    });
  }
  assert.equal(formatBytesBadge(1_500_000, "si"), "1.5M");
  assert.equal(formatBytesBadge(345_000_000, "si"), "345M");
  assert.equal(formatBytesBadge(999_999_999, "si"), "1.0G");
  assert.equal(formatBytesBadge(1023 * 1024 * 1024, "iec"), "1.0G");
  // The bytes row has no unit letter, so four digits there are still four characters.
  assert.equal(formatBytesBadge(1023, "iec"), "1023");

  // A locale's decimal separator is one character like any other. Dropping the
  // decimal by re-parsing the formatted string put "NaNM" in the toolbar here.
  withLocale("de-DE", () => {
    assert.equal(formatBytesBadge(1_500_000, "si"), "1,5M");
    assert.equal(formatBytesBadge(94_000_000, "si"), "94M");
  });
});

test("byte figures use the same separator as the counts beside them", () => {
  withLocale("de-DE", () => {
    assert.equal(formatBytes(1_500_000, "si"), "1,5 MB");
    assert.equal(formatBytes(45_600_000, "si"), "45,6 MB");
    assert.equal(formatOfBudget(4_200_000, 50_000_000, "si"), "4,2 MB of 50,0 MB");
    assert.equal(splitBytes(9_400_000, "si").value, "9,4");

    // Never grouped, whatever the locale: "1.023 B" is a string `parseByteSize`
    // cannot tell from 1.023 B, and the app has to be able to read its own output.
    assert.equal(formatBytes(1023, "iec"), "1023 B");
    assert.equal(formatBytes(345_000_000, "si"), "345 MB");
  });
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

test("a comma is read the way it was typed, or not at all", () => {
  // The whole point: most of the world writes 1.5 GB as "1,5 GB". Deleting the
  // comma stored 15 GB — a cap ten times too large, so it never fired, and nothing
  // on the way in echoed the parsed size back for anyone to notice.
  assert.equal(parseByteSize("1,5 GB"), 1_500_000_000);
  assert.equal(parseByteSize("0,5 gb"), 500_000_000);
  assert.equal(parseByteSize("1,25 MB"), 1_250_000);
  assert.equal(parseByteSize("1234,5 MB"), 1_234_500_000);

  // Strict three-digit groups are a thousands separator. The dot is the asymmetry:
  // a lone one stays a decimal point, so only "1.234.567" can be grouping.
  assert.equal(parseByteSize("1,500 kb"), 1_500_000);
  assert.equal(parseByteSize("1,234,567 b"), 1_234_567);
  assert.equal(parseByteSize("1.234.567 b"), 1_234_567);
  assert.equal(parseByteSize("1.234 GB"), 1_234_000_000);

  // Both separators present: the last one is the decimal point.
  assert.equal(parseByteSize("1,234.5 MB"), 1_234_500_000);
  assert.equal(parseByteSize("1.234,5 MB"), 1_234_500_000);

  // Ambiguous or simply not a number. `null` sends the caller to an error message
  // rather than to a cap that is out by a factor of a thousand.
  for (const bad of ["1,5000 GB", "1,23,456 MB", "1,234,5 MB", "1.2,3 MB", "1, MB", "1 500 MB"]) {
    assert.equal(parseByteSize(bad), null, `"${bad}" should not parse`);
  }
});

test("the app can read back what it printed, in any locale", () => {
  // Values chosen to be exact at the precision the formatter prints; anything
  // rounded away is lost by design and is not what this is guarding.
  const cases = [
    ["si", [0, 999, 1000, 1_500_000, 45_600_000, 345_000_000, 2_000_000_000]],
    ["iec", [0, 1023, 1024, 1_572_864, 250 * 1024 * 1024, 3 * 1024 ** 3]],
  ];
  for (const name of ["en-US", "de-DE", "fr-FR"]) {
    withLocale(name, () => {
      for (const [units, values] of cases) {
        for (const value of values) {
          const text = formatBytes(value, units);
          assert.equal(parseByteSize(text), value, `"${text}" did not read back in ${name}`);
        }
      }
    });
  }
});
