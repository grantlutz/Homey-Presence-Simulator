# Presence Simulator — Homey Pro App (v1)

Simulates a lived-in home while you're away by cycling selected lights/switches in a plausible random pattern.

## Install (development)

```
npm install
homey app run
```

Requires the [Homey CLI](https://apps.developer.homey.app/the-basics/getting-started/the-athom-cli).

## Known limitations for v1

- **Confirmation push**: implemented as a plain notification + Flow action cards
  (`Answer presence prompt: Yes` / `No`). Yes/No buttons inside the push itself are
  firmware-dependent and not used in v1 — wire a Flow in Homey to provide your own
  response UX if you want native yes/no buttons.
- **Icons and images**: placeholders in `assets/` and `drivers/simulator/assets/`.
  Add real 75/500/1000 px PNGs and SVGs before publishing.
- **Reconciliation on restart**: app reads persisted state on boot, then tick loop
  re-plans based on observed device state. No snapshot of pre-sim state (by design).