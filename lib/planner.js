'use strict';

const { random, randInt, pickWeighted } = require('./random');
const { parseHHMM } = require('./scheduler');

// A participating device is eligible to turn ON now if:
// - it's not in the user-overridden set for today
// - current minute-of-day is within [earliestOn, latestOff]
//   (handles cross-midnight ranges too)
function isEligibleNow(cfg, now) {
  const earliest = parseHHMM(cfg.earliestOn || '17:00') ?? 17 * 60;
  const latest = parseHHMM(cfg.latestOff || '23:30') ?? 23 * 60 + 30;
  const m = now.getHours() * 60 + now.getMinutes();
  if (earliest <= latest) return m >= earliest && m <= latest;
  return m >= earliest || m <= latest;
}

// How deep are we in the window? 0.0 at start → 1.0 at end.
function windowPhase(window, now) {
  const total = window.endMs - window.startMs;
  if (total <= 0) return 0.5;
  const p = (now.getTime() - window.startMs) / total;
  return Math.max(0, Math.min(1, p));
}

// Decide next action: "on" | "off" | "noop".
// Early window biases towards "on", late window biases towards "off".
function decideAction({ currentlyOnCount, eligibleOnCount, maxConcurrentOn, phase }) {
  if (currentlyOnCount >= maxConcurrentOn && eligibleOnCount === 0) return 'off';
  if (currentlyOnCount === 0 && eligibleOnCount === 0) return 'noop';
  if (currentlyOnCount >= maxConcurrentOn) return 'off';
  if (currentlyOnCount === 0) return eligibleOnCount > 0 ? 'on' : 'noop';

  // pOn decreases as phase → 1. Early: ~0.75, late: ~0.2.
  const pOn = 0.8 - 0.6 * phase;
  const r = random();
  if (eligibleOnCount === 0) return 'off';
  return r < pOn ? 'on' : 'off';
}

function pickDeviceToTurnOn(participatingCfgs, { userOverridden, currentlyOnIds, now }) {
  const candidates = participatingCfgs.filter((d) => {
    if (userOverridden.includes(d.deviceId)) return false;
    if (currentlyOnIds.includes(d.deviceId)) return false;
    return isEligibleNow(d, now);
  });
  if (candidates.length === 0) return null;
  return pickWeighted(candidates, (d) => (typeof d.weight === 'number' ? d.weight : 1));
}

function pickDeviceToTurnOff(currentlyOn, now) {
  if (!currentlyOn || currentlyOn.length === 0) return null;
  // Prefer the one closest to (or past) its scheduled off-time.
  const sorted = [...currentlyOn].sort((a, b) => {
    const ta = new Date(a.scheduledOffAt).getTime();
    const tb = new Date(b.scheduledOffAt).getTime();
    return ta - tb;
  });
  return sorted[0];
}

function scheduleOffTime(cfg, now) {
  const mn = Math.max(1, cfg.minDurationMinutes ?? 10);
  const mx = Math.max(mn, cfg.maxDurationMinutes ?? 90);
  const durMin = randInt(mn, mx);
  return new Date(now.getTime() + durMin * 60000);
}

module.exports = {
  isEligibleNow,
  windowPhase,
  decideAction,
  pickDeviceToTurnOn,
  pickDeviceToTurnOff,
  scheduleOffTime,
};
