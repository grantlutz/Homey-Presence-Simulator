'use strict';

// Rolling threshold counter: N events within M minutes fires.
class PresenceDetector {
  constructor({ threshold, windowMinutes, onTrigger, log }) {
    this.threshold = Math.max(1, threshold | 0);
    this.windowMs = Math.max(1, windowMinutes | 0) * 60000;
    this.onTrigger = onTrigger;
    this.log = log || (() => {});
    this.events = []; // [{ at: ms, source, detail }]
  }

  updateThreshold(threshold, windowMinutes) {
    this.threshold = Math.max(1, threshold | 0);
    this.windowMs = Math.max(1, windowMinutes | 0) * 60000;
  }

  record(source, detail) {
    const now = Date.now();
    this.events = this.events.filter((e) => now - e.at <= this.windowMs);
    this.events.push({ at: now, source, detail });
    this.log(`presence event ${source} (${this.events.length}/${this.threshold})`);
    if (this.events.length >= this.threshold) {
      this.events = []; // reset after firing so we don't spam
      try {
        this.onTrigger({ source, detail, at: now });
      } catch (err) {
        this.log(`onTrigger error: ${err.message}`);
      }
    }
  }
}

module.exports = { PresenceDetector };
