/* global Homey */
'use strict';

function onHomeyReady(Homey) {
  let config = null;
  let zones = {};
  let devices = [];
  let users = [];

  function byId(id) { return document.getElementById(id); }

  function renderDevicePicker() {
    const root = byId('device-picker');
    root.innerHTML = '';

    // Group devices by zone.
    const byZone = {};
    for (const d of devices) {
      const capIds = d.capabilities || [];
      if (!capIds.includes('onoff')) continue;
      const zoneName = (zones[d.zone] && zones[d.zone].name) || 'Unknown';
      byZone[zoneName] = byZone[zoneName] || [];
      byZone[zoneName].push(d);
    }

    const selectedMap = new Map((config.devices || []).map((c) => [c.deviceId, c]));

    const frag = document.createDocumentFragment();
    for (const zoneName of Object.keys(byZone).sort()) {
      const zd = document.createElement('div');
      zd.className = 'zone';
      zd.innerHTML = `<div class="zone-title">${zoneName}</div>`;
      for (const d of byZone[zoneName].sort((a, b) => a.name.localeCompare(b.name))) {
        const cfg = selectedMap.get(d.id) || {};
        const isSelected = selectedMap.has(d.id);
        const el = document.createElement('div');
        el.className = 'dev';
        el.innerHTML = `
          <div class="dev-header">
            <input type="checkbox" data-role="sel" data-id="${d.id}" ${isSelected ? 'checked' : ''}/>
            <strong>${d.name}</strong>
            <button type="button" data-role="toggle" style="margin-left:auto;font-size:12px;">Edit</button>
          </div>
          <div class="dev-body">
            <div class="row">
              <div><label>earliestOn</label><input type="text" data-f="earliestOn" value="${cfg.earliestOn || '17:00'}"/></div>
              <div><label>latestOff</label><input type="text" data-f="latestOff" value="${cfg.latestOff || '23:30'}"/></div>
            </div>
            <div class="row">
              <div><label>minDurationMinutes</label><input type="number" data-f="minDurationMinutes" value="${cfg.minDurationMinutes ?? 10}"/></div>
              <div><label>maxDurationMinutes</label><input type="number" data-f="maxDurationMinutes" value="${cfg.maxDurationMinutes ?? 90}"/></div>
            </div>
            <div class="row">
              <div><label>dimLevel (0.0–1.0)</label><input type="number" step="0.05" min="0" max="1" data-f="dimLevel" value="${cfg.dimLevel ?? 0.7}"/></div>
              <div><label>weight</label><input type="number" data-f="weight" value="${cfg.weight ?? 1}"/></div>
            </div>
          </div>
        `;
        el.dataset.id = d.id;
        el.querySelector('[data-role="toggle"]').addEventListener('click', () => el.classList.toggle('open'));
        zd.appendChild(el);
      }
      frag.appendChild(zd);
    }
    root.appendChild(frag);
  }

  function readDevicePickerState() {
    const out = [];
    for (const el of document.querySelectorAll('#device-picker .dev')) {
      const id = el.dataset.id;
      const sel = el.querySelector('[data-role="sel"]').checked;
      if (!sel) continue;
      const f = (name) => el.querySelector(`[data-f="${name}"]`).value;
      out.push({
        deviceId: id,
        earliestOn: f('earliestOn'),
        latestOff: f('latestOff'),
        minDurationMinutes: Number(f('minDurationMinutes')),
        maxDurationMinutes: Number(f('maxDurationMinutes')),
        dimLevel: Number(f('dimLevel')),
        weight: Number(f('weight')),
      });
    }
    return out;
  }

  function fillForm() {
    byId('startMode').value = config.schedule.startMode || 'sunset-offset';
    byId('sunsetOffsetMinutes').value = config.schedule.sunsetOffsetMinutes ?? -30;
    byId('fixedStartTime').value = config.schedule.fixedStartTime || '';
    byId('endTime').value = config.schedule.endTime || '23:30';
    byId('jitterMinutes').value = config.schedule.jitterMinutes ?? 15;
    byId('minActionIntervalMinutes').value = config.simulation.minActionIntervalMinutes ?? 1;
    byId('maxActionIntervalMinutes').value = config.simulation.maxActionIntervalMinutes ?? 30;
    byId('maxConcurrentOn').value = config.simulation.maxConcurrentOn ?? 3;
    byId('whosHomeEnabled').checked = !!config.presence.sources.whosHomeEnabled;
    byId('manualTriggerEnabled').checked = !!config.presence.sources.manualTriggerEnabled;
    byId('motionDeviceIds').value = (config.presence.sources.motionDeviceIds || []).join(',');
    byId('doorDeviceIds').value = (config.presence.sources.doorDeviceIds || []).join(',');
    byId('triggerThreshold').value = config.presence.triggerThreshold ?? 1;
    byId('triggerWindowMinutes').value = config.presence.triggerWindowMinutes ?? 5;
    byId('timeoutSeconds').value = config.prompt.timeoutSeconds ?? 120;
    byId('cooldownMinutes').value = config.prompt.cooldownMinutes ?? 30;
    byId('autoArmWithHomeyAway').checked = !!config.autoArmWithHomeyAway;
  }

  function renderRecipients() {
    const sel = byId('recipientUserIds');
    sel.innerHTML = '';
    const selected = new Set(config.prompt.recipientUserIds || []);
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name || u.email || u.id;
      if (selected.has(u.id)) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function collect() {
    const min = Number(byId('minActionIntervalMinutes').value);
    const max = Number(byId('maxActionIntervalMinutes').value);
    if (min > max) throw new Error('minActionIntervalMinutes must be ≤ maxActionIntervalMinutes');

    const csv = (id) => byId(id).value.split(',').map((s) => s.trim()).filter(Boolean);
    const recipients = Array.from(byId('recipientUserIds').selectedOptions).map((o) => o.value);

    return {
      armed: !!config.armed,
      autoArmWithHomeyAway: byId('autoArmWithHomeyAway').checked,
      schedule: {
        startMode: byId('startMode').value,
        sunsetOffsetMinutes: Number(byId('sunsetOffsetMinutes').value),
        fixedStartTime: byId('fixedStartTime').value || null,
        endTime: byId('endTime').value,
        jitterMinutes: Number(byId('jitterMinutes').value),
      },
      simulation: {
        minActionIntervalMinutes: min,
        maxActionIntervalMinutes: max,
        maxConcurrentOn: Number(byId('maxConcurrentOn').value),
      },
      devices: readDevicePickerState(),
      presence: {
        sources: {
          motionDeviceIds: csv('motionDeviceIds'),
          doorDeviceIds: csv('doorDeviceIds'),
          whosHomeEnabled: byId('whosHomeEnabled').checked,
          manualTriggerEnabled: byId('manualTriggerEnabled').checked,
        },
        triggerThreshold: Number(byId('triggerThreshold').value),
        triggerWindowMinutes: Number(byId('triggerWindowMinutes').value),
      },
      prompt: {
        timeoutSeconds: Number(byId('timeoutSeconds').value),
        cooldownMinutes: Number(byId('cooldownMinutes').value),
        recipientUserIds: recipients,
      },
    };
  }

  byId('save').addEventListener('click', () => {
    byId('behavior-err').textContent = '';
    byId('save-status').textContent = '';
    let next;
    try { next = collect(); }
    catch (e) { byId('behavior-err').textContent = e.message; return; }

    Homey.set('config', next, (err) => {
      if (err) { byId('save-status').textContent = 'Error: ' + err.message; return; }
      config = next;
      byId('save-status').textContent = 'Saved.';
    });
  });

  function renderActivity() {
    Homey.get('state', (err, st) => {
      if (err || !st) return;
      const lines = (st.recentActivity || []).map((a) =>
        `${new Date(a.at).toLocaleTimeString()}  ${a.action.padEnd(3)}  ${a.deviceName}${a.reason ? ' ('+a.reason+')' : ''}`
      );
      byId('activity').textContent = lines.length ? lines.join('\n') : '—';
    });
  }

  async function bootstrap() {
    Homey.get('config', (err, cfg) => {
      if (err) { alert('Failed to load config: ' + err.message); return; }
      config = cfg || {
        schedule: {}, simulation: {}, devices: [], presence: { sources: {} }, prompt: {},
      };
      // Backfill missing nested objects to keep fillForm simple.
      config.schedule = config.schedule || {};
      config.simulation = config.simulation || {};
      config.presence = config.presence || { sources: {} };
      config.presence.sources = config.presence.sources || {};
      config.prompt = config.prompt || {};

      Homey.api('GET', '/devices', null, (e1, devs) => {
        devices = devs ? Object.values(devs) : [];
        Homey.api('GET', '/zones', null, (e2, zs) => {
          zones = zs || {};
          Homey.api('GET', '/users', null, (e3, us) => {
            users = us ? Object.values(us) : [];
            fillForm();
            renderDevicePicker();
            renderRecipients();
            renderActivity();
          });
        });
      });
    });
  }

  Homey.ready();
  bootstrap();
}
