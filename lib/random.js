'use strict';

// Thin wrapper around Math.random so tests can mock it.
// No seeded PRNG in v1 (decision #10).

function random() {
  return Math.random();
}

function randInt(minInclusive, maxInclusive) {
  const lo = Math.ceil(minInclusive);
  const hi = Math.floor(maxInclusive);
  return Math.floor(random() * (hi - lo + 1)) + lo;
}

function randBetween(min, max) {
  return random() * (max - min) + min;
}

function pickWeighted(items, weightFn) {
  const total = items.reduce((s, it) => s + Math.max(0, weightFn(it)), 0);
  if (total <= 0) return null;
  let r = random() * total;
  for (const it of items) {
    r -= Math.max(0, weightFn(it));
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

module.exports = { random, randInt, randBetween, pickWeighted };
