'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

const { Store } = require('./lib/state');
const { computeWindow, isInWindow, nextActionDelayMs } = require('./lib/scheduler');
const {
  windowPhase,
  decideAction,
  pickDeviceToTurnOn,
  pickDeviceToTurnOff,
  scheduleOffTime,
  isEligibleNow,
} = require('./lib/planner');
const { PresenceDetector } = require('./lib/presence');
const { PromptManager } = require('./lib/prompt');

class PresenceSimulatorApp extends Homey.App {
  async onInit() {
    this.log('Presence Simulator starting');

    this.store = new Store(this.homey.settings, (m) => this.log(m));

    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });

    this._deviceListenerHandles = new Map(); // deviceId → unsubscribe fn
    this._lastCommandedState = new Map(); // deviceId → { capability, value, at }
    this._currentWindow = null;
    this._windowTimer = null;
    this._tickTimer = null;

    this.presence = new PresenceDetector({
      threshold: this.store.getConfig().presence.triggerThreshold,
      windowMinutes: this.store.getConfig().presence.triggerWindowMinutes,
      onTrigger: (evt) => this._onPresenceTrigger(evt),
      log: (m) => this.log(`[presence] ${m}`),
    });

    this.prompt = new PromptManager({
      homey: this.homey,
      store: this.store,
      log: (m) => this.log(`[prompt] ${m}`),
      onAnswer: ({ answer }) => this._onPromptAnswer(answer),
    });

    this._registerFlow();
    this._watchSettings();

    if (this.store.getConfig().autoArmWithHomeyAway) {
      this._watchHomeyAway();
    }

    await this._hookupParticipatingDevices();
    await this._hookupPresenceSources();

    if (this.store.getConfig().armed) {
      await this._reconcileAndScheduleWindow();
    }

    this.log('Presence Simulator ready');
  }

  // ───────────────── Flow wiring ─────────────────

  _registerFlow() {
    const f = this.homey.flow;

    this.trigger = {
      simulationStarted: f.getTriggerCard('simulation_started'),
      simulationStopped: f.getTriggerCard('simulation_stopped'),
      windowOpened: f.getTriggerCard('window_opened'),
      windowClosed: f.getTriggerCard('window_closed'),
      simulationPaused: f.getTriggerCard('simulation_paused'),
      simulationResumed: f.getTriggerCard('simulation_resumed'),
      deviceOn: f.getTriggerCard('device_turned_on'),
      deviceOff: f.getTriggerCard('device_turned_off'),
      promptSent: f.getTriggerCard('prompt_sent'),
      promptAnswered: f.getTriggerCard('prompt_answered'),
    };

    f.getConditionCard('is_armed').registerRunListener(() => !!this.store.getConfig().armed);
    f.getConditionCard('is_in_window').registerRunListener(() => !!this.store.getState().currentWindowOpen);
    f.getConditionCard('is_paused').registerRunListener(() => !!this.store.getState().paused);

    f.getActionCard('arm').registerRunListener(() => this.arm());
    f.getActionCard('disarm').registerRunListener(() => this.disarm());
    f.getActionCard('pause_until_next_window').registerRunListener(() => this.pauseUntilNextWindow('manual'));
    f.getActionCard('pause_for_minutes').registerRunListener(async (args) => {
      const until = new Date(Date.now() + Math.max(1, args.minutes | 0) * 60000);
      await this.pauseUntil(until, 'manual');
    });
    f.getActionCard('resume').registerRunListener(() => this.resume('manual'));
    f.getActionCard('mark_home').registerRunListener(() => {
      this.presence.record('manual-flow', 'mark_home action');
    });
    f.getActionCard('send_prompt_now').registerRunListener(() => this.prompt.send({ reason: 'debug' }));
    f.getActionCard('answer_prompt_yes').registerRunListener(() => this.prompt.answer('yes'));
    f.getActionCard('answer_prompt_no').registerRunListener(() => this.prompt.answer('no'));
  }

  _watchSettings() {
    this.homey.settings.on('set', async (key) => {
      if (key !== 'config') return;
      // Reload config from settings. User-edited via settings page.
      const raw = this.homey.settings.get('config') || {};
      await this.store.replaceConfig(raw);
      const cfg = this.store.getConfig();
      this.presence.updateThreshold(cfg.presence.triggerThreshold, cfg.presence.triggerWindowMinutes);
      await this._hookupParticipatingDevices();
      await this._hookupPresenceSources();
      if (cfg.armed) await this._reconcileAndScheduleWindow();
      else await this._closeWindow(/* cleanup */ true);
    });
  }

  _watchHomeyAway() {
    try {
      this.homey.presence.on('presence', async () => {
        // Managed via Homey.Presence in SDK v3; the 'presence' event fires on any change.
        // We can read individual users via this.api.users if needed.
        const anyHome = await this._anyUserHome();
        if (!anyHome && this.store.getConfig().autoArmWithHomeyAway && !this.store.getConfig().armed) {
          await this.arm();
        } else if (anyHome && this.store.getConfig().armed) {
          // Treat as a presence event; goes through normal prompt flow.
          this.presence.record('whos-home', 'home transition');
        }
      });
    } catch (err) {
      this.log(`could not hook Homey Away: ${err.message}`);
    }
  }

  async _anyUserHome() {
    try {
      const users = await this.api.users.getUsers();
      return Object.values(users).some((u) => u.present);
    } catch {
      return false;
    }
  }

  // ───────────────── Arming lifecycle ─────────────────

  async arm() {
    if (this.store.getConfig().armed) return;
    await this.store.setConfig({ armed: true });
    await this.trigger.simulationStarted.trigger({}).catch(() => {});
    await this._reconcileAndScheduleWindow();
    this.log('armed');
  }

  async disarm() {
    if (!this.store.getConfig().armed) return;
    await this.store.setConfig({ armed: false });
    await this._closeWindow(/* cleanup */ true);
    await this.trigger.simulationStopped.trigger({}).catch(() => {});
    this.log('disarmed');
  }

  async pauseUntil(until, reason) {
    await this.store.setState({
      paused: true,
      pausedUntil: until instanceof Date ? until.toISOString() : until,
    });
    this._clearTickTimer();
    await this.trigger.simulationPaused.trigger({}, { reason }).catch(() => {});
  }

  async pauseUntilNextWindow(reason) {
    // "Until next active window start" — compute tomorrow's window start.
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
    const sunset = await this._sunsetFor(tomorrow);
    const nextWin = computeWindow({ config: this.store.getConfig(), now: tomorrow, sunsetDate: sunset });
    await this.pauseUntil(new Date(nextWin.startMs), reason);
  }

  async resume(reason = 'manual') {
    if (!this.store.getState().paused) return;
    await this.store.setState({ paused: false, pausedUntil: null });
    await this.trigger.simulationResumed.trigger({}).catch(() => {});
    if (this.store.getConfig().armed) await this._reconcileAndScheduleWindow();
  }

  // ───────────────── Window + tick ─────────────────

  async _reconcileAndScheduleWindow() {
    if (this._windowTimer) { this.homey.clearTimeout(this._windowTimer); this._windowTimer = null; }

    const cfg = this.store.getConfig();
    if (!cfg.armed) return;

    const now = new Date();
    const sunset = await this._sunsetFor(now);
    let win = computeWindow({ config: cfg, now, sunsetDate: sunset });

    // If we're past today's window, schedule tomorrow.
    if (now.getTime() >= win.endMs) {
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
      const s2 = await this._sunsetFor(tomorrow);
      win = computeWindow({ config: cfg, now: tomorrow, sunsetDate: s2 });
    }

    this._currentWindow = win;

    // If in window right now and not paused, open it.
    if (isInWindow(win, now) && !this._pausedNow()) {
      await this._openWindow();
    } else {
      await this.store.setState({ currentWindowOpen: false });
      const delay = Math.max(1000, win.startMs - now.getTime());
      this._windowTimer = this.homey.setTimeout(() => this._openWindow(), delay);
    }
  }

  _pausedNow() {
    const st = this.store.getState();
    if (!st.paused) return false;
    if (!st.pausedUntil) return true;
    return new Date(st.pausedUntil).getTime() > Date.now();
  }

  async _openWindow() {
    // Auto-resume if pause has expired.
    if (this._pausedNow()) {
      const st = this.store.getState();
      if (st.pausedUntil && new Date(st.pausedUntil).getTime() <= Date.now()) {
        await this.resume('auto');
      }
    }

    await this.store.setState({ currentWindowOpen: true, userOverriddenToday: [] });
    await this.trigger.windowOpened.trigger({}).catch(() => {});

    this._scheduleEndOfWindow();
    this._scheduleTick();
  }

  _scheduleEndOfWindow() {
    if (!this._currentWindow) return;
    const ms = Math.max(1000, this._currentWindow.endMs - Date.now());
    this._windowTimer = this.homey.setTimeout(() => this._closeWindow(true), ms);
  }

  async _closeWindow(cleanup) {
    this._clearTickTimer();
    if (this._windowTimer) { this.homey.clearTimeout(this._windowTimer); this._windowTimer = null; }
    const wasOpen = this.store.getState().currentWindowOpen;

    if (cleanup) {
      await this._turnOffAllSimOn('window-close');
    }

    await this.store.setState({
      currentWindowOpen: false,
      currentlyOn: [],
      userOverriddenToday: [],
    });

    if (wasOpen) await this.trigger.windowClosed.trigger({}).catch(() => {});

    if (this.store.getConfig().armed) {
      // Schedule tomorrow's window.
      await this._reconcileAndScheduleWindow();
    }
  }

  _scheduleTick() {
    this._clearTickTimer();
    const delay = nextActionDelayMs(this.store.getConfig());
    this._tickTimer = this.homey.setTimeout(() => this._tick().catch((e) => this.log(`tick error: ${e.message}`)), delay);
  }

  _clearTickTimer() {
    if (this._tickTimer) { this.homey.clearTimeout(this._tickTimer); this._tickTimer = null; }
  }

  async _tick() {
    const cfg = this.store.getConfig();
    const st = this.store.getState();

    if (!cfg.armed || !st.currentWindowOpen) return;
    if (this._pausedNow()) { this._scheduleTick(); return; }

    // Auto-expire completed off-times.
    await this._reapScheduledOffs();

    const now = new Date();
    const participating = cfg.devices;
    const currentlyOnIds = (this.store.getState().currentlyOn || []).map((x) => x.deviceId);
    const eligibleToTurnOn = participating.filter((d) =>
      !this.store.getState().userOverriddenToday.includes(d.deviceId)
      && !currentlyOnIds.includes(d.deviceId)
      && isEligibleNow(d, now)
    );

    const action = decideAction({
      currentlyOnCount: currentlyOnIds.length,
      eligibleOnCount: eligibleToTurnOn.length,
      maxConcurrentOn: Math.max(1, cfg.simulation.maxConcurrentOn | 0),
      phase: windowPhase(this._currentWindow, now),
    });

    if (action === 'on') {
      const pick = pickDeviceToTurnOn(participating, {
        userOverridden: this.store.getState().userOverriddenToday,
        currentlyOnIds,
        now,
      });
      if (pick) await this._turnDeviceOn(pick, now);
    } else if (action === 'off') {
      const pick = pickDeviceToTurnOff(this.store.getState().currentlyOn, now);
      if (pick) await this._turnDeviceOff(pick.deviceId, 'plan');
    }

    await this.store.setState({ lastActionAt: new Date().toISOString() });
    await this._refreshDeviceCount();
    this._scheduleTick();
  }

  async _reapScheduledOffs() {
    const now = Date.now();
    const on = this.store.getState().currentlyOn || [];
    const expired = on.filter((x) => new Date(x.scheduledOffAt).getTime() <= now);
    for (const e of expired) await this._turnDeviceOff(e.deviceId, 'scheduled-off');
  }

  // ───────────────── Device actions ─────────────────

  async _turnDeviceOn(cfg, now) {
    const id = cfg.deviceId;
    try {
      const dev = await this.api.devices.getDevice({ id });
      if (!dev) throw new Error('device not found');
      if (dev.capabilitiesObj && dev.capabilitiesObj.dim && typeof cfg.dimLevel === 'number') {
        await this._setCap(id, 'dim', Math.max(0, Math.min(1, cfg.dimLevel)));
      }
      await this._setCap(id, 'onoff', true);

      const scheduledOffAt = scheduleOffTime(cfg, now).toISOString();
      const currentlyOn = [...(this.store.getState().currentlyOn || []), { deviceId: id, scheduledOffAt }];
      await this.store.setState({ currentlyOn });

      const name = dev.name || id;
      await this.store.pushActivity({ deviceId: id, deviceName: name, action: 'on', at: new Date().toISOString() });
      await this.trigger.deviceOn.trigger({}, { device_name: name }).catch(() => {});
      this.log(`on: ${name}`);
    } catch (err) {
      this.log(`turn on failed (${id}): ${err.message}`);
    }
  }

  async _turnDeviceOff(id, reason) {
    try {
      await this._setCap(id, 'onoff', false);
      const currentlyOn = (this.store.getState().currentlyOn || []).filter((x) => x.deviceId !== id);
      await this.store.setState({ currentlyOn });

      let name = id;
      try {
        const dev = await this.api.devices.getDevice({ id });
        if (dev && dev.name) name = dev.name;
      } catch {}
      await this.store.pushActivity({ deviceId: id, deviceName: name, action: 'off', at: new Date().toISOString(), reason });
      await this.trigger.deviceOff.trigger({}, { device_name: name }).catch(() => {});
      this.log(`off: ${name} (${reason})`);
    } catch (err) {
      this.log(`turn off failed (${id}): ${err.message}`);
    }
  }

  async _turnOffAllSimOn(reason) {
    const on = [...(this.store.getState().currentlyOn || [])];
    for (const x of on) await this._turnDeviceOff(x.deviceId, reason);
  }

  async _setCap(deviceId, capability, value) {
    this._lastCommandedState.set(deviceId, { capability, value, at: Date.now() });
    await this.api.devices.setCapabilityValue({ deviceId, capabilityId: capability, value });
  }

  async _refreshDeviceCount() {
    const count = (this.store.getState().currentlyOn || []).length;
    const drv = this.homey.drivers.getDriver('simulator');
    if (!drv) return;
    for (const d of drv.getDevices()) {
      try { await d.setCapabilityValue('measure_devices_on', count); } catch {}
      try {
        await d.setCapabilityValue('alarm_presence_simulator_active', !!this.store.getState().currentWindowOpen);
      } catch {}
      try {
        await d.setCapabilityValue('alarm_presence_simulator_paused', !!this.store.getState().paused);
      } catch {}
    }
  }

  // ───────────────── Device listeners ─────────────────

  async _hookupParticipatingDevices() {
    // Unsubscribe existing.
    for (const unsub of this._deviceListenerHandles.values()) {
      try { unsub(); } catch {}
    }
    this._deviceListenerHandles.clear();

    const ids = (this.store.getConfig().devices || []).map((d) => d.deviceId);
    for (const id of ids) {
      try {
        const dev = await this.api.devices.getDevice({ id });
        if (!dev) continue;
        const handler = (cap, value) => this._onParticipatingCapabilityChange(id, cap, value);
        dev.on('capability', handler);
        this._deviceListenerHandles.set(id, () => {
          try { dev.removeListener('capability', handler); } catch {}
        });
      } catch (err) {
        this.log(`listener hookup failed (${id}): ${err.message}`);
      }
    }
  }

  _onParticipatingCapabilityChange(deviceId, capability, value) {
    if (capability !== 'onoff') return;
    const last = this._lastCommandedState.get(deviceId);
    const recent = last && last.capability === 'onoff' && last.value === value && (Date.now() - last.at) < 5000;
    if (recent) return; // our own command
    const st = this.store.getState();
    if (!st.currentWindowOpen) return;
    if (!st.userOverriddenToday.includes(deviceId)) {
      this.store.setState({
        userOverriddenToday: [...st.userOverriddenToday, deviceId],
        currentlyOn: (st.currentlyOn || []).filter((x) => x.deviceId !== deviceId),
      }).catch(() => {});
      this.log(`user override detected: ${deviceId}`);
    }
  }

  // ───────────────── Presence sources ─────────────────

  async _hookupPresenceSources() {
    // For v1 we rely on the user wiring presence signals via Flow actions
    // ("Mark someone as home") and/or the Who's Home listener. Direct
    // subscription to arbitrary motion/door sensors is also supported here.
    if (this._presenceUnsubs) this._presenceUnsubs.forEach((u) => { try { u(); } catch {} });
    this._presenceUnsubs = [];

    const { motionDeviceIds = [], doorDeviceIds = [] } = this.store.getConfig().presence.sources || {};
    const subscribe = async (id, cap, source) => {
      try {
        const dev = await this.api.devices.getDevice({ id });
        if (!dev) return;
        const handler = (c, v) => {
          if (c === cap && v === true) this.presence.record(source, dev.name || id);
        };
        dev.on('capability', handler);
        this._presenceUnsubs.push(() => { try { dev.removeListener('capability', handler); } catch {} });
      } catch (err) {
        this.log(`presence hookup failed (${id}): ${err.message}`);
      }
    };
    for (const id of motionDeviceIds) await subscribe(id, 'alarm_motion', 'motion');
    for (const id of doorDeviceIds) await subscribe(id, 'alarm_contact', 'door');
  }

  async _onPresenceTrigger({ source, detail }) {
    const st = this.store.getState();
    const cfg = this.store.getConfig();
    if (!cfg.armed || !st.currentWindowOpen) return;
    if (st.paused) return;
    await this.prompt.send({ reason: 'presence-detected', detail: `${source}${detail ? ': ' + detail : ''}` });
    await this.trigger.promptSent.trigger({}).catch(() => {});
  }

  async _onPromptAnswer(answer) {
    await this.trigger.promptAnswered.trigger({}, { answer }).catch(() => {});
    if (answer === 'no') return; // keep running
    // yes or timeout → pause until next window (decision #2)
    await this.pauseUntilNextWindow(answer === 'timeout' ? 'timeout' : 'presence-detected');
  }

  // ───────────────── Geolocation ─────────────────

  async _sunsetFor(date) {
    try {
      // Homey SDK: geolocation.getSunset/sunrise may accept a date.
      if (typeof this.homey.geolocation.getSunset === 'function') {
        return await this.homey.geolocation.getSunset(date);
      }
    } catch {}
    return null; // scheduler falls back to 18:00
  }
}

module.exports = PresenceSimulatorApp;
