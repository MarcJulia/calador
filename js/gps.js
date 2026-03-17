/**
 * Fake GPS feed — simulates a fishing boat leaving port, heading out,
 * drifting around a fishing spot, and returning.
 *
 * Realistic speeds for an 8m Mediterranean fishing vessel:
 * - Transit: 8 knots (~15 km/h) — typical cruising for a small trawler
 * - Trawling/trolling: 2-3 knots (~4-5 km/h)
 * - Drifting (handline/jigging): 0.5-1 knot
 *
 * Time scale: 120x (1 real second = 2 simulated minutes)
 */

import { ORIGIN } from './map2d.js';

const UPDATE_MS = 100;  // update 10x/sec for smooth movement
let TIME_SCALE = 1;     // real-time, can be changed

// 1 knot = 1 nm/hr = (1/60)°/hr = (1/60)/3600 °/sec
const KTS_TO_DEG_PER_SEC = 1 / 216000;

const PHASES = [
  { name: 'leaving port',   durationMin: 30,  speed: 8 },
  { name: 'trolling',       durationMin: 60,  speed: 2.5 },
  { name: 'drifting',       durationMin: 30,  speed: 0.7 },
  { name: 'relocating',     durationMin: 15,  speed: 7 },
  { name: 'trawling',       durationMin: 60,  speed: 3 },
  { name: 'drifting',       durationMin: 20,  speed: 0.5 },
  { name: 'returning',      durationMin: 30,  speed: 8 },
];

export function createGPSSimulator() {
  let listeners = [];
  let intervalId = null;
  let simTime = 0;
  let lat = 39.1963;
  let lon = 2.9677;
  let heading = 210 + Math.random() * 20;
  let speed = 0;
  let phase = 0;
  let phaseTime = 0;

  // Pick fishing spots ~8-15km south/southwest of start
  const angle1 = (210 + Math.random() * 30) * Math.PI / 180;
  const dist1 = 0.08 + Math.random() * 0.04; // degrees (~9-13km)
  const fishSpot1 = {
    lat: lat + dist1 * Math.cos(angle1),
    lon: lon + dist1 * Math.sin(angle1) / Math.cos(lat * Math.PI / 180),
  };
  const fishSpot2 = {
    lat: fishSpot1.lat + (Math.random() - 0.5) * 0.03,
    lon: fishSpot1.lon + (Math.random() - 0.5) * 0.03,
  };

  function getTarget() {
    const p = PHASES[phase];
    if (!p) return { lat: 39.1963, lon: 2.9677 };
    switch (p.name) {
      case 'leaving port': return fishSpot1;
      case 'trolling': return fishSpot1;
      case 'relocating': return fishSpot2;
      case 'trawling': return fishSpot2;
      case 'returning': return { lat: 39.1963, lon: 2.9677 };
      default: return fishSpot1;
    }
  }

  function tick() {
    const dt = (UPDATE_MS / 1000) * TIME_SCALE; // simulated seconds per tick
    simTime += dt;

    const p = PHASES[phase];
    if (!p) {
      phase = 0; phaseTime = 0; simTime = 0;
      lat = 39.1963; lon = 2.9677;
      heading = 210 + Math.random() * 20;
      return;
    }

    phaseTime += dt;
    if (phaseTime >= p.durationMin * 60) {
      phaseTime = 0;
      phase++;
    }

    speed = p.speed;
    const target = getTarget();
    const moveDeg = speed * KTS_TO_DEG_PER_SEC * dt;

    if (p.name === 'drifting') {
      // Random drift
      heading += (Math.random() - 0.5) * 20;
      lat += moveDeg * Math.cos(heading * Math.PI / 180);
      lon += moveDeg * Math.sin(heading * Math.PI / 180) / Math.cos(lat * Math.PI / 180);
    } else if (p.name === 'trolling' || p.name === 'trawling') {
      // Slow passes back and forth near the fishing spot — zigzag pattern
      const distToSpot = Math.sqrt(
        (lat - target.lat) ** 2 +
        ((lon - target.lon) * Math.cos(lat * Math.PI / 180)) ** 2
      );
      if (distToSpot > 0.015) {
        // Too far, head back toward spot
        const dlat = target.lat - lat;
        const dlon = (target.lon - lon) * Math.cos(lat * Math.PI / 180);
        heading = Math.atan2(dlon, dlat) * 180 / Math.PI;
      } else {
        // Gentle turns while working
        heading += (Math.random() - 0.5) * 8;
      }
      heading += (Math.random() - 0.5) * 3;
      lat += moveDeg * Math.cos(heading * Math.PI / 180);
      lon += moveDeg * Math.sin(heading * Math.PI / 180) / Math.cos(lat * Math.PI / 180);
    } else {
      // Transit: head toward target
      const dlat = target.lat - lat;
      const dlon = (target.lon - lon) * Math.cos(lat * Math.PI / 180);
      heading = Math.atan2(dlon, dlat) * 180 / Math.PI;
      heading += (Math.random() - 0.5) * 3; // slight course wobble
      lat += moveDeg * Math.cos(heading * Math.PI / 180);
      lon += moveDeg * Math.sin(heading * Math.PI / 180) / Math.cos(lat * Math.PI / 180);
    }

    const pos = {
      lat, lon, heading, speed,
      phase: p.name,
      simTimeMin: Math.floor(simTime / 60),
    };

    for (const fn of listeners) fn(pos);
  }

  function start() {
    if (intervalId) return;
    intervalId = setInterval(tick, UPDATE_MS);
    tick();
  }

  function stop() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  function onPosition(fn) { listeners.push(fn); }
  function removeListener(fn) { listeners = listeners.filter(f => f !== fn); }
  function getPosition() { return { lat, lon, heading, speed }; }
  function setTimeScale(s) { TIME_SCALE = s; }
  function getTimeScale() { return TIME_SCALE; }

  return { start, stop, onPosition, removeListener, getPosition, setTimeScale, getTimeScale };
}
