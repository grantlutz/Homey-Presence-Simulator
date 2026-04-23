'use strict';

// Manages a single in-flight presence confirmation prompt.
//
// v1 approach (pragmatic — Homey SDK confirmation-push coverage varies
// by firmware): send a plain push notification describing the situation,
// fire a "prompt_sent" Flow trigger, and expose Flow action cards
// "Answer prompt yes/no" so users can wire their own response UX if
// needed. A timeout always pauses (decision #2).

class PromptManager {
  constructor({ homey, store, log, onAnswer }) {
    this.homey = homey;
    this.store = store;
    this.log = log || (() => {});
    this.onAnswer = onAnswer; // ({ answer: 'yes'|'no'|'timeout' }) => Promise
    this.timer = null;
  }

  hasActive() {
    return !!this.store.getState().activePromptId;
  }

  isSuppressed(now = Date.now()) {
    const until = this.store.getState().suppressPromptUntil;
    return !!until && new Date(until).getTime() > now;
  }

  async send({ reason = 'presence-detected', detail = '' } = {}) {
    if (this.hasActive()) {
      this.log('prompt already active; skipping');
      return false;
    }
    if (this.isSuppressed()) {
      this.log('prompt suppressed by cooldown; skipping');
      return false;
    }

    const id = `p_${Date.now()}`;
    await this.store.setState({ activePromptId: id, lastPromptAt: new Date().toISOString() });

    const body = this._composeBody(reason, detail);
    try {
      await this.homey.notifications.createNotification({ excerpt: body });
    } catch (err) {
      this.log(`notification send failed: ${err.message}`);
    }

    const timeoutMs = Math.max(5, this.store.getConfig().prompt.timeoutSeconds | 0) * 1000;
    this.timer = this.homey.setTimeout(() => this._fireTimeout(id), timeoutMs);
    return true;
  }

  async answer(answer) {
    const st = this.store.getState();
    if (!st.activePromptId) {
      this.log(`answer "${answer}" ignored — no active prompt`);
      return false;
    }
    if (this.timer) { this.homey.clearTimeout(this.timer); this.timer = null; }

    const cooldownMs = Math.max(0, this.store.getConfig().prompt.cooldownMinutes | 0) * 60000;
    await this.store.setState({
      activePromptId: null,
      suppressPromptUntil: answer === 'no'
        ? new Date(Date.now() + cooldownMs).toISOString()
        : null,
    });

    await this.onAnswer({ answer });
    return true;
  }

  async _fireTimeout(id) {
    this.timer = null;
    const st = this.store.getState();
    if (st.activePromptId !== id) return;
    await this.store.setState({ activePromptId: null });
    await this.onAnswer({ answer: 'timeout' });
  }

  _composeBody(reason, detail) {
    const when = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const base = this.homey.__
      ? this.homey.__('prompt.body', { when, reason, detail })
      : `Presence detected at ${when} (${reason}${detail ? ': ' + detail : ''}). Pause presence simulation for the rest of tonight?`;
    return base;
  }
}

module.exports = { PromptManager };
