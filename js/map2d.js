// Colonia de Sant Jordi: 39.3167°N, 2.9889°E
// A fishing boat at ~8 knots for ~5h out + 5h back = ~40 nautical miles radius ≈ 74 km
// We'll use ~50km effective fishing radius (accounting for working time at spots)

export const ORIGIN = { lat: 39.3167, lon: 2.9889 };
export const RANGE_KM = 50;

// Grid size options in meters
const GRID_SIZES = [
  { label: '500m', meters: 500 },
  { label: '1km', meters: 1000 },
  { label: '2km', meters: 2000 },
  { label: '5km', meters: 5000 },
];

const LS_KEY = 'seafloor-grid-size';

function getStoredGridSize() {
  const stored = localStorage.getItem(LS_KEY);
  if (stored) {
    const val = parseInt(stored, 10);
    if (GRID_SIZES.some(g => g.meters === val)) return val;
  }
  return 2000;
}

function setStoredGridSize(meters) {
  localStorage.setItem(LS_KEY, String(meters));
}

export function getGridSizeMeters() {
  return getStoredGridSize();
}

/** Return the tile bounds for a given lat/lon position. */
export function getTileBoundsAt(lat, lon) {
  const tileSizeM = getStoredGridSize();
  const latDeg = tileSizeM / 111320;
  const lonDeg = tileSizeM / (111320 * Math.cos(ORIGIN.lat * Math.PI / 180));
  const minLat = Math.floor(lat / latDeg) * latDeg;
  const minLon = Math.floor(lon / lonDeg) * lonDeg;
  const center = [minLat + latDeg / 2, minLon + lonDeg / 2];
  return {
    minLat: parseFloat(minLat.toFixed(6)),
    maxLat: parseFloat((minLat + latDeg).toFixed(6)),
    minLon: parseFloat(minLon.toFixed(6)),
    maxLon: parseFloat((minLon + lonDeg).toFixed(6)),
    label: `${center[0].toFixed(3)}°N, ${center[1].toFixed(3)}°E`,
  };
}

export function createMap(container, onTileClick, markerData, onMarkerNavigate) {
  const tileSizeM = getStoredGridSize();

  // Grid cell size in degrees
  const latDeg = tileSizeM / 111320;
  const lonDeg = tileSizeM / (111320 * Math.cos(ORIGIN.lat * Math.PI / 180));

  const map = L.map(container, {
    center: [ORIGIN.lat, ORIGIN.lon],
    zoom: 10,
    zoomControl: true,
    attributionControl: true,
  });

  // Base layers
  const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd', maxZoom: 18,
  });
  const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics', maxZoom: 19,
  });
  const nauticalDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>', subdomains: 'abcd', maxZoom: 18,
  });
  darkLayer.addTo(map);
  L.control.layers({ 'Dark': darkLayer, 'Satellite': satelliteLayer, 'Dark (no labels)': nauticalDark }, null, { position: 'topright', collapsed: true }).addTo(map);

  // Range circle
  L.circle([ORIGIN.lat, ORIGIN.lon], {
    radius: RANGE_KM * 1000,
    color: 'rgba(80, 180, 255, 0.4)', weight: 2, dashArray: '8, 6',
    fillColor: 'rgba(40, 120, 200, 0.05)', fillOpacity: 1, interactive: false,
  }).addTo(map);

  // Origin marker
  L.circleMarker([ORIGIN.lat, ORIGIN.lon], {
    radius: 7, color: '#ff8844', fillColor: '#ffaa44', fillOpacity: 0.9, weight: 2,
  }).addTo(map).bindTooltip('Colonia de Sant Jordi', {
    permanent: true, direction: 'top', className: 'origin-tooltip', offset: [0, -10],
  });

  // Show individual colored marker dots
  const markerDotsLayer = L.layerGroup().addTo(map);
  markerData.forEach(m => {
    const color = m.color || '#40c0ff';
    const cm = L.circleMarker([m.lat, m.lon], {
      radius: 5, color: '#fff', fillColor: color,
      fillOpacity: 0.9, weight: 1.5,
    }).addTo(markerDotsLayer);
    cm.bindTooltip(
      `${m.substrate || 'Marker'}<br>${m.depth?.toFixed(1) || '?'}m`,
      { className: 'tile-tooltip' }
    );
    const popupContent = document.createElement('div');
    popupContent.className = 'marker-popup';
    popupContent.innerHTML = `
      <strong>${m.name || m.substrate || 'Marker'}</strong><br>
      ${m.depth?.toFixed(1) || '?'}m deep<br>
      <button class="marker-nav-btn">Navigate</button>`;
    popupContent.querySelector('.marker-nav-btn').addEventListener('click', () => {
      if (onMarkerNavigate) onMarkerNavigate(m);
      map.closePopup();
    });
    cm.bindPopup(popupContent, { className: 'marker-popup-container' });
  });

  // --- Single hover rectangle that follows the mouse ---
  const hoverRect = L.rectangle([[0, 0], [0, 0]], {
    weight: 2,
    color: 'rgba(100, 200, 255, 0.7)',
    fillColor: 'rgba(40, 160, 240, 0.2)',
    fillOpacity: 1,
    interactive: false,
  });

  const hoverTooltip = L.tooltip({
    className: 'tile-tooltip',
    sticky: false,
    direction: 'top',
    offset: [0, -10],
  });

  let hoverVisible = false;
  let currentTileKey = null;

  function snapToGrid(latlng) {
    const lat = latlng.lat;
    const lon = latlng.lng;
    // Compute which grid cell this falls in (aligned to a global grid)
    const minLat = Math.floor(lat / latDeg) * latDeg;
    const minLon = Math.floor(lon / lonDeg) * lonDeg;
    return {
      minLat: parseFloat(minLat.toFixed(6)),
      maxLat: parseFloat((minLat + latDeg).toFixed(6)),
      minLon: parseFloat(minLon.toFixed(6)),
      maxLon: parseFloat((minLon + lonDeg).toFixed(6)),
    };
  }

  map.on('mousemove', (e) => {
    const tile = snapToGrid(e.latlng);
    const center = [(tile.minLat + tile.maxLat) / 2, (tile.minLon + tile.maxLon) / 2];
    const distKm = haversineKm(ORIGIN.lat, ORIGIN.lon, center[0], center[1]);

    // Only within range
    if (distKm > RANGE_KM) {
      if (hoverVisible) {
        map.removeLayer(hoverRect);
        map.closeTooltip(hoverTooltip);
        hoverVisible = false;
        currentTileKey = null;
      }
      return;
    }

    const key = `${tile.minLat},${tile.minLon}`;
    if (key === currentTileKey) return; // same cell, skip
    currentTileKey = key;

    const bounds = [[tile.minLat, tile.minLon], [tile.maxLat, tile.maxLon]];
    hoverRect.setBounds(bounds);

    if (!hoverVisible) {
      hoverRect.addTo(map);
      hoverVisible = true;
    }

    const tileKey = `${tile.minLat.toFixed(6)},${tile.minLon.toFixed(6)}`;
    const markerCount = markerTiles.get(tileKey) || 0;
    const tooltipHtml =
      `<b>${center[0].toFixed(3)}°N, ${center[1].toFixed(3)}°E</b><br>` +
      `${distKm.toFixed(1)} km from port` +
      (markerCount ? `<br>${markerCount} marker(s)` : '');

    hoverTooltip.setLatLng([tile.maxLat, (tile.minLon + tile.maxLon) / 2]);
    hoverTooltip.setContent(tooltipHtml);
    if (!map.hasLayer(hoverTooltip)) hoverTooltip.addTo(map);
  });

  map.on('mouseout', () => {
    if (hoverVisible) {
      map.removeLayer(hoverRect);
      map.closeTooltip(hoverTooltip);
      hoverVisible = false;
      currentTileKey = null;
    }
  });

  map.on('click', (e) => {
    const tile = snapToGrid(e.latlng);
    const center = [(tile.minLat + tile.maxLat) / 2, (tile.minLon + tile.maxLon) / 2];
    const distKm = haversineKm(ORIGIN.lat, ORIGIN.lon, center[0], center[1]);
    if (distKm > RANGE_KM) return;

    onTileClick({
      minLat: tile.minLat,
      maxLat: tile.maxLat,
      minLon: tile.minLon,
      maxLon: tile.maxLon,
      label: `${center[0].toFixed(3)}°N, ${center[1].toFixed(3)}°E — ${distKm.toFixed(1)}km from port`,
    });
  });

  return map;
}

/**
 * Create the grid size selector control and attach it to the map toolbar.
 */
export function createGridSizeSelector(onChangeCallback) {
  const container = document.getElementById('grid-size-selector');
  if (!container) return;

  const current = getStoredGridSize();
  container.innerHTML = '';

  const label = document.createElement('span');
  label.className = 'grid-size-label';
  label.textContent = 'Grid:';
  container.appendChild(label);

  const select = document.createElement('select');
  select.id = 'grid-size-select';
  GRID_SIZES.forEach(gs => {
    const opt = document.createElement('option');
    opt.value = gs.meters;
    opt.textContent = gs.label;
    if (gs.meters === current) opt.selected = true;
    select.appendChild(opt);
  });

  select.addEventListener('change', () => {
    setStoredGridSize(parseInt(select.value, 10));
    if (onChangeCallback) onChangeCallback();
  });

  container.appendChild(select);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
