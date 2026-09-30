/**
 * How long a test waits for something asynchronous (a file watched, a delivery, the agent's reply):
 * an upper bound, reached only when it goes wrong. The CI machines are about twice as slow as a
 * laptop. A deadline that the product promises is checked on its own (e.g. a reply shown within a
 * second).
 */
export const WAIT_MS = 10_000;
