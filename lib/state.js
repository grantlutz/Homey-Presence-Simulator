'use strict';

const CONFIG_KEY = 'config';
const STATE_KEY = 'state';

const DEFAULT_CONFIG = {
  armed: false,
  autoArmWithHomeyAway: false,
  schedule: {
    startMode: 'sunset-offset',
    sunsetOffsetMinutes: -30,
    fixedStartTime: null,
    endTime: '23:30',
    jitterMinutes: 15,
  },
  simulation: {
    minActionIntervalMinutes: 1,
    maxActionIntervalMinutes: 30,
    maxConcurrentOn: 3,
  },
  devices: [],
  presence: {
    sources: {
      motionDeviceIds: [],
      doorDeviceIds: [],
      whosHomeEnabled: true,
      manualTriggerEnabled: true,
    },
    triggerThreshold: 1,
    triggerWindowMinutes: 5,
  },
  prompt: {
    timeoutSeconds: 120,
    cooldownMinutes: 30,
    recipientUserIds: [], // empty = all users
  },
};

const DEFAULT_STATE = {
  paused: false,
  pausedUntil: null,
  currentWindowOpen: false,
  currentlyOn: [],
  userOverriddenToday: [],
  lastActionAt: null,
  lastPromptAt: null,
  suppressPromptUntil: null,
  recentActivity: [],
  presenceEventLog: [],
  activePromptId: null,
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (typeof base !== 'object' || base === null) return override === undefined ? base : override;
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    if (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

class Store {
  constructor(settings, logger) {
    this.settings = settings;
    this.log = logger || (() => {});
    this.config = deepMerge(DEFAULT_CONFIG, settings.get(CONFIG_KEY) || {});
    this.state = deepMerge(DEFAULT_STATE, settings.get(STATE_KEY) || {});
  }

  getConfig() { return this.config; }
  getState() { return this.state; }

  async setConfig(patch) {
    this.config = deepMerge(this.config, patch);
    await this.settings.set(CONFIG_KEY, this.config);
  }

  async replaceConfig(next) {
    this.config = deepMerge(DEFAULT_CONFIG, next || {});
    await this.settings.set(CONFIG_KEY, this.config);
  }

  async setState(patch) {
    this.state = deepMerge(this.state, patch);
    await this.settings.set(STATE_KEY, this.state);
  }

  async pushActivity(entry, cap = 50) {
    const list = [entry, ...(this.state.recentActivity || [])].slice(0, cap);
    await this.setState({ recentActivity: list });
  }
}

module.exports = { Store, DEFAULT_CONFIG, DEFAULT_STATE };
