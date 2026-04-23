'use strict';

const Homey = require('homey');

class SimulatorDevice extends Homey.Device {
  async onInit() {
    this.log('SimulatorDevice initialized');

    const app = this.homey.app;

    // Reflect current app state.
    const st = app.store.getState();
    await this.setCapabilityValue('onoff', !!app.store.getConfig().armed).catch(() => {});
    await this.setCapabilityValue('alarm_presence_simulator_active', !!st.currentWindowOpen).catch(() => {});
    await this.setCapabilityValue('alarm_presence_simulator_paused', !!st.paused).catch(() => {});
    await this.setCapabilityValue('measure_devices_on', (st.currentlyOn || []).length).catch(() => {});

    this.registerCapabilityListener('onoff', async (value) => {
      if (value) await app.arm();
      else await app.disarm();
    });
  }
}

module.exports = SimulatorDevice;
