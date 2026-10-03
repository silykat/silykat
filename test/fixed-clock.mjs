// Setup file of every unit test project: the clock starts at a fixed date, then moves on in real time.
// A date written in a test can then never become past or future as the days go by, while waits and
// durations still work. Dates the clock does not control (files, git) stay real: a test that compares
// to them starts from them, never from a date written in the test.
const START = Date.UTC(2026, 9, 3, 12); // 2026-10-03T12:00:00Z

const fixed = Symbol.for('local-review.fixed-clock');

if (!globalThis.Date[fixed]) {
  const RealDate = globalThis.Date;
  const offset = START - RealDate.now();

  class FixedClockDate extends RealDate {
    static [fixed] = true;

    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }

    static now() {
      return RealDate.now() + offset;
    }

    // Dates made by Node itself (file stats…) are still dates.
    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }

  globalThis.Date = FixedClockDate;
}
