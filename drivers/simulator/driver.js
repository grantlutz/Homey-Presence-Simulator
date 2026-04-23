'use strict';

const Homey = require('homey');

class SimulatorDriver extends Homey.Driver {
  async onInit() {
    this.log('SimulatorDriver initialized');
  }

  async onPairListDevices() {
    // Single virtual device. If one already exists we still return it — Homey
    // will not re-pair duplicates with the same id.
    return [
      {
        name: 'Presence Simulator',
        data: { id: 'presence-simulator-singleton' },
      },
    ];
  }
}

module.exports = SimulatorDriver;
