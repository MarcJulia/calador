/**
 * Weather panel + precipitation radar overlay for the 2D map.
 * Uses Open-Meteo (free, no API key) for conditions and
 * RainViewer (free, no API key) for radar tiles.
 */

import { ORIGIN } from './map2d.js';

const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${ORIGIN.lat}&longitude=${ORIGIN.lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,pressure_msl,weather_code&wind_speed_unit=kn`;
const MARINE_URL = `https://marine-api.open-meteo.com/v1/marine?latitude=${ORIGIN.lat}&longitude=${ORIGIN.lon}&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,swell_wave_direction`;
const RAINVIEWER_URL = 'https://api.rainviewer.com/public/weather-maps.json';

const REFRESH_MS = 10 * 60 * 1000; // 10 minutes

const WIND_DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function degToCompass(deg) {
  return WIND_DIRS[Math.round(deg / 22.5) % 16];
}

function windArrow(deg) {
  // Arrow points in the direction wind is coming FROM (meteorological convention)
  return `rotate(${deg}deg)`;
}

// WMO weather codes → short description
const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Light showers',
  81: 'Showers', 82: 'Heavy showers', 95: 'Thunderstorm',
  96: 'T-storm + hail', 99: 'T-storm + heavy hail',
};

let radarLayer = null;
let radarTimestamp = null;

async function fetchWeather() {
  const [wxRes, marineRes] = await Promise.all([
    fetch(WEATHER_URL).then(r => r.json()).catch(() => null),
    fetch(MARINE_URL).then(r => r.json()).catch(() => null),
  ]);
  return { wx: wxRes?.current, marine: marineRes?.current };
}

async function fetchRadarTimestamp() {
  try {
    const data = await fetch(RAINVIEWER_URL).then(r => r.json());
    const frames = data?.radar?.past;
    if (frames && frames.length > 0) {
      return frames[frames.length - 1].path; // most recent frame path
    }
  } catch { /* ignore */ }
  return null;
}

function renderPanel(container, wx, marine) {
  if (!wx && !marine) {
    container.innerHTML = '<div class="weather-error">Weather unavailable</div>';
    return;
  }

  let html = '';

  if (wx) {
    const desc = WMO[wx.weather_code] || `Code ${wx.weather_code}`;
    html += `
      <div class="weather-condition">${desc}</div>
      <div class="weather-grid">
        <div class="weather-item">
          <span class="weather-arrow" style="transform:${windArrow(wx.wind_direction_10m)}">&#8595;</span>
          <span class="weather-value">${wx.wind_speed_10m}<small>kn</small></span>
          <span class="weather-label">Wind ${degToCompass(wx.wind_direction_10m)}</span>
        </div>
        <div class="weather-item">
          <span class="weather-value">${wx.wind_gusts_10m}<small>kn</small></span>
          <span class="weather-label">Gusts</span>
        </div>
        <div class="weather-item">
          <span class="weather-value">${wx.temperature_2m}<small>&deg;C</small></span>
          <span class="weather-label">Temp</span>
        </div>
        <div class="weather-item">
          <span class="weather-value">${wx.pressure_msl}<small>hPa</small></span>
          <span class="weather-label">Pressure</span>
        </div>
      </div>`;
  }

  if (marine) {
    html += `
      <div class="weather-divider"></div>
      <div class="weather-grid">
        <div class="weather-item">
          <span class="weather-value">${marine.wave_height}<small>m</small></span>
          <span class="weather-label">Waves</span>
        </div>
        <div class="weather-item">
          <span class="weather-value">${marine.wave_period}<small>s</small></span>
          <span class="weather-label">Period</span>
        </div>
        <div class="weather-item">
          <span class="weather-value">${marine.swell_wave_height}<small>m</small></span>
          <span class="weather-label">Swell</span>
        </div>
        <div class="weather-item">
          <span class="weather-arrow" style="transform:${windArrow(marine.swell_wave_direction)}">&#8595;</span>
          <span class="weather-value">${degToCompass(marine.swell_wave_direction)}</span>
          <span class="weather-label">Swell dir</span>
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

/**
 * Initialize weather panel and radar overlay toggle.
 * @param {L.Map} map - Leaflet map instance
 */
export function initWeather(map, getBoatLatLng) {
  const panel = document.getElementById('weather-panel');
  const body = document.getElementById('weather-body');
  const toggle = document.getElementById('weather-toggle');
  const radarBtn = document.getElementById('btn-radar');

  if (!panel || !body) return;

  // Zoom slider
  const zoomLabel = document.getElementById('map-zoom-label');
  const zoomSlider = document.getElementById('map-zoom');
  let updatingFromMap = false;

  function updateZoomDisplay() {
    const z = Math.round(map.getZoom());
    zoomLabel.textContent = `z${z}`;
    updatingFromMap = true;
    zoomSlider.value = z;
    updatingFromMap = false;
  }
  updateZoomDisplay();
  map.on('zoomend', updateZoomDisplay);

  zoomSlider.addEventListener('input', () => {
    if (!updatingFromMap) {
      const boatLL = getBoatLatLng && getBoatLatLng();
      if (boatLL) {
        map.setView(boatLL, Number(zoomSlider.value));
      } else {
        map.setZoom(Number(zoomSlider.value));
      }
    }
  });

  // Collapse / expand
  let collapsed = false;
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    body.classList.toggle('hidden', collapsed);
    toggle.textContent = collapsed ? '+' : '-';
  });

  // Radar overlay toggle
  radarBtn.addEventListener('click', async () => {
    if (radarLayer) {
      map.removeLayer(radarLayer);
      radarLayer = null;
      radarBtn.classList.remove('active');
      return;
    }

    const path = radarTimestamp || await fetchRadarTimestamp();
    if (!path) return;
    radarTimestamp = path;

    radarLayer = L.tileLayer(`https://tilecache.rainviewer.com${path}/512/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.5,
      zIndex: 500,
      maxNativeZoom: 7,
      maxZoom: 18,
      tileSize: 512,
      zoomOffset: -1,
    });
    radarLayer.addTo(map);
    radarBtn.classList.add('active');
  });

  // Initial fetch
  async function refresh() {
    body.innerHTML = '<div class="weather-loading">Loading...</div>';
    const { wx, marine } = await fetchWeather();
    renderPanel(body, wx, marine);
    // Also refresh radar timestamp
    radarTimestamp = await fetchRadarTimestamp();
    // If radar is active, swap to latest frame
    if (radarLayer && radarTimestamp) {
      map.removeLayer(radarLayer);
      radarLayer = L.tileLayer(`https://tilecache.rainviewer.com${radarTimestamp}/512/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0.5,
        zIndex: 500,
        maxNativeZoom: 7,
        maxZoom: 18,
        tileSize: 512,
        zoomOffset: -1,
      });
      radarLayer.addTo(map);
    }
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
}
