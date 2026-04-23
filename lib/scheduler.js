'use strict';

const { randInt, randBetween } = require('./random');

// Parse "HH:MM" → minutes-of-day (0..1439). Returns null on bad input.
function parseHHMM(str) {
  if (!str || typeof str !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Compute today's window [start, end] as epoch-ms.
// Window crossing midnight: if end <= start, end is tomorrow.
// `now` is used as the "today" anchor.
function computeWindow({ config, now, sunsetDate }) {
  const { startMode, sunsetOffsetMinutes, fixedStartTime, endTime, jitterMinutes } = config.schedule;

  // Base start: minutes-of-day relative to `now`'s local date.
  let startMinutes;
  if (startMode === 'fixed' && fixedStartTime) {
    startMinutes = parseHHMM(fixedStartTime);
    if (startMinutes == null) startMinutes = 18 * 60;
  } else if (sunsetDate instanceof Date && !isNaN(sunsetDate.getTime())) {
    startMinutes = minutesOfDay(sunsetDate) + (sunsetOffsetMinutes || 0);
  } else {
    startMinutes = 18 * 60; // fallback if geolocation unavailable
  }

  let endMinutes = parseHHMM(endTime);
  if (endMinutes == null) endMinutes = 23 * 60 + 30;

  // Apply jitter (±jitterMinutes).
  const j = Math.max(0, jitterMinutes || 0);
  if (j > 0) {
    startMinutes += Math.round(randBetween(-j, j));
    endMinutes += Math.round(randBetween(-j, j));
  }

  const anchor = new Date(now);
  anchor.setHours(0, 0, 0, 0);
  const startMs = anchor.getTime() + startMinutes * 60000;
  let endMs = anchor.getTime() + endMinutes * 60000;
  if (endMs <= startMs) endMs += 24 * 3600 * 1000; // crosses midnight

  return { startMs, endMs };
}

function isInWindow(window, now) {
  const t = now.getTime();
  return t >= window.startMs && t < window.endMs;
}

function nextActionDelayMs(config) {
  const { minActionIntervalMinutes: mn, maxActionIntervalMinutes: mx } = config.simulation;
  const lo = Math.max(1, mn | 0);
  const hi = Math.max(lo, mx | 0);
  return randInt(lo, hi) * 60000;
}

module.exports = { parseHHMM, minutesOfDay, computeWindow, isInWindow, nextActionDelayMs };
