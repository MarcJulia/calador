import * as THREE from 'three';
import { createScene, adjustCamera } from './scene.js';
import { createTerrain, destroyTerrain, applyOverlay, removeOverlay, prefetchTerrain } from './terrain.js';
import { createMarkerSystem } from './markers.js';
import { createPanel } from './panel.js';
import { saveToStorage, loadFromStorage } from './data.js';
import { createMap, createGridSizeSelector, getTileBoundsAt, ORIGIN, RANGE_KM } from './map2d.js';
import { createBoat } from './boat.js';
import { addContext } from './context.js';
import { OVERLAY_GROUPS, getOverlayById } from './layers.js';
import { createGPSSimulator } from './gps.js';
import { initWeather } from './weather.js';

// ===== State =====
let allMarkers = loadFromStorage();
let leafletMap = null;
let current3D = null;
let activeOverlays = new Set();

// ===== Live GPS =====
const gps = createGPSSimulator();
let gpsMapMarker = null;    // Leaflet marker on 2D map
let gpsMapTrail = null;     // Leaflet polyline trail
let gpsTrailPoints = [];    // lat/lon history
let gps3DMarker = null;     // THREE mesh in 3D scene
let gps3DTrail = null;      // THREE line in 3D scene
let minimap = null;         // Leaflet map in bottom-right inset
let minimapBoat = null;     // Leaflet marker for GPS on minimap
let followMode = false;     // auto-follow boat between tiles
let followCurrentTileKey = null; // track which tile we're in during follow
let focusMode = false;      // chase camera behind the boat
let focusCamPos = null;     // smoothed camera position
let focusCamTarget = null;  // smoothed look-at target
let focusCamDist = 50;      // zoom distance behind boat
let focusCamOffset = null;  // {pos, target} offsets from vessel for tile transitions
let depthLineOn = false;    // show vertical line to sea floor
let depthLine3D = null;     // THREE.Line object
let depthDot3D = null;      // dot at sea floor

// ===== Tile preloading =====
let preloadingKey = null;     // key of tile currently being prefetched

// ===== Navigation / Itinerary =====
let itinerary = [];             // ordered array of marker data objects
let navLine2D = null;           // Leaflet polyline on 2D map
let navLine3D = null;           // THREE.Line in 3D scene
let navLabels3D = [];           // THREE sprites for distance labels
let navMinimapLine = null;      // Leaflet polyline on minimap

// ===== DOM refs =====
const viewMap = document.getElementById('view-map');
const view3D = document.getElementById('view-3d');
const canvas = document.getElementById('canvas');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const hoverCoords = document.getElementById('hover-coords');
const tileLabel = document.getElementById('tile-label');
const btnBack = document.getElementById('btn-back');
const btnLayers = document.getElementById('btn-layers');
const btnAddMode = document.getElementById('btn-add-mode');
const layerPanel = document.getElementById('layer-panel');
const layerPanelBody = document.getElementById('layer-panel-body');
const layerPanelClose = document.getElementById('layer-panel-close');

// ===== Marker search =====
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

function searchMarkers(query) {
  if (!query) { searchResults.classList.add('hidden'); return; }
  const q = query.toLowerCase();

  const matches = allMarkers.filter(m => {
    const fields = [
      m.name, m.notes, m.substrate, m.species?.join(' '),
      m.color, m.date,
      m.tags ? Object.entries(m.tags).map(([k, v]) => `${k} ${v}`).join(' ') : '',
    ].filter(Boolean).join(' ').toLowerCase();
    return fields.includes(q);
  });

  searchResults.innerHTML = '';

  if (matches.length === 0) {
    searchResults.innerHTML = '<div class="search-no-results">No markers found</div>';
    searchResults.classList.remove('hidden');
    return;
  }

  matches.slice(0, 20).forEach(m => {
    const item = document.createElement('div');
    item.className = 'search-result';

    const title = m.name || `${m.lat.toFixed(4)}°N ${m.lon.toFixed(4)}°E`;
    const detail = [m.substrate, m.species?.join(', '), m.notes].filter(Boolean).join(' · ');
    item.innerHTML = `
      <span class="search-result-color" style="background:${m.color || '#40c0ff'}"></span>
      <div class="search-result-info">
        <div class="search-result-title">${title} · ${m.depth}m</div>
        <div class="search-result-detail">${detail || 'No details'}</div>
      </div>`;

    item.addEventListener('click', () => {
      const tile = getTileBoundsAt(m.lat, m.lon);
      searchResults.classList.add('hidden');
      searchInput.value = '';
      onTileClick(tile);
    });

    const navBtn = document.createElement('button');
    navBtn.className = 'btn-nav';
    navBtn.textContent = '+ Route';
    navBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addToItinerary(m);
      navBtn.textContent = 'Added';
      navBtn.disabled = true;
    });
    item.appendChild(navBtn);

    searchResults.appendChild(item);
  });

  searchResults.classList.remove('hidden');
}

searchInput.addEventListener('input', () => searchMarkers(searchInput.value.trim()));
searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) searchMarkers(searchInput.value.trim()); });
document.addEventListener('click', (e) => {
  if (!e.target.closest('#marker-search')) searchResults.classList.add('hidden');
});

// ===== Haversine distance =====
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(km) {
  return km < 1 ? `${(km * 1000).toFixed(0)}m` : `${km.toFixed(1)}km`;
}

// ===== Itinerary management =====
const btnItinerary = document.getElementById('btn-itinerary');
const itineraryPanel = document.getElementById('itinerary-panel');
const itineraryList = document.getElementById('itinerary-list');
const btnClearRoute = document.getElementById('btn-clear-route');
const btnStartNav = document.getElementById('btn-start-nav');
const itineraryClose = document.getElementById('itinerary-close');
const navStatus = document.getElementById('nav-status');

function addToItinerary(marker, { enterFocus = false } = {}) {
  // Don't add duplicates
  if (itinerary.find(m => m.id === marker.id)) return;
  itinerary.push({ ...marker });
  updateItineraryUI();
  drawRoute2D();
  if (current3D) drawRoute3D();
  if (gps.hasRoute()) {
    // Already navigating — append to the live route
    gps.setRoute(itinerary, routeAdvanceCallback);
  } else {
    // Not navigating yet — start immediately
    startNavigation({ enterFocus });
  }
}

function removeFromItinerary(index) {
  itinerary.splice(index, 1);
  updateItineraryUI();
  drawRoute2D();
  if (current3D) drawRoute3D();
  if (itinerary.length === 0) {
    navStatus.classList.add('hidden');
  }
}

function updateItineraryUI() {
  btnItinerary.textContent = `Route (${itinerary.length})`;
  btnItinerary.classList.toggle('active', itinerary.length > 0);
  renderItineraryList();
}

function renderItineraryList() {
  itineraryList.innerHTML = '';
  const pos = gps.getPosition();
  let prevLat = pos.lat, prevLon = pos.lon;

  itinerary.forEach((m, i) => {
    const dist = haversineKm(prevLat, prevLon, m.lat, m.lon);
    const item = document.createElement('div');
    item.className = 'itinerary-item';
    item.draggable = true;
    item.dataset.index = i;

    item.innerHTML = `
      <span class="drag-handle">&#8801;</span>
      <span class="itinerary-color" style="background:${m.color || '#40c0ff'}"></span>
      <div class="itinerary-info">
        <div class="itinerary-name">${m.name || `${m.lat.toFixed(3)}°N ${m.lon.toFixed(3)}°E`}</div>
        <div class="itinerary-dist">${fmtDist(dist)} · ${m.depth}m deep</div>
      </div>
      <button class="itinerary-remove" data-index="${i}">&times;</button>`;

    // Drag reorder
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', i);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      const to = i;
      if (from === to) return;
      const [moved] = itinerary.splice(from, 1);
      itinerary.splice(to, 0, moved);
      updateItineraryUI();
      drawRoute2D();
      if (current3D) drawRoute3D();
    });

    item.querySelector('.itinerary-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromItinerary(i);
    });

    itineraryList.appendChild(item);
    prevLat = m.lat;
    prevLon = m.lon;
  });
}

btnItinerary.addEventListener('click', () => {
  itineraryPanel.classList.toggle('hidden');
});

itineraryClose.addEventListener('click', () => {
  itineraryPanel.classList.add('hidden');
});

btnClearRoute.addEventListener('click', () => {
  itinerary = [];
  gps.clearRoute();
  updateItineraryUI();
  drawRoute2D();
  if (current3D) drawRoute3D();
  navStatus.classList.add('hidden');
});

function routeAdvanceCallback(reachedIdx) {
  if (reachedIdx === -1) {
    // Route complete
    itinerary = [];
    updateItineraryUI();
    drawRoute2D();
    if (current3D) drawRoute3D();
    navStatus.textContent = 'Route complete';
    setTimeout(() => navStatus.classList.add('hidden'), 3000);
    return;
  }
  // Remove reached waypoint from itinerary
  itinerary.shift();
  updateItineraryUI();
  drawRoute2D();
  if (current3D) drawRoute3D();
}

function startNavigation({ enterFocus = true } = {}) {
  if (itinerary.length === 0) return;
  itineraryPanel.classList.add('hidden');

  if (enterFocus) {
    // Activate focus + follow (only click if not already focused)
    if (!focusMode) {
      btnFocus.click();
    } else if (!current3D) {
      // Already focused but not in 3D — enter 3D at vessel tile
      const pos = gps.getPosition();
      const tile = getTileBoundsAt(pos.lat, pos.lon);
      onTileClick(tile);
    }
  }
  navStatus.classList.remove('hidden');

  // Bump speed so navigation is visible
  if (gps.getTimeScale() < 30) {
    speedIdx = SPEED_STEPS.indexOf(30);
    gps.setTimeScale(30);
    btnSpeed.textContent = '30x';
    btnSpeed.classList.add('active');
  }

  // Send route to GPS simulator
  gps.setRoute(itinerary, routeAdvanceCallback);
}

btnStartNav.addEventListener('click', () => startNavigation());

// ===== Route drawing — 2D map =====
function drawRoute2D() {
  if (navLine2D && leafletMap) { leafletMap.removeLayer(navLine2D); navLine2D = null; }
  if (!leafletMap || itinerary.length === 0) return;

  const pos = gps.getPosition();
  const pts = [[pos.lat, pos.lon], ...itinerary.map(m => [m.lat, m.lon])];
  navLine2D = L.polyline(pts, { color: '#ffcc00', weight: 2, dashArray: '8,6', opacity: 0.8 }).addTo(leafletMap);
}

function updateRoute2D(pos) {
  if (!navLine2D || itinerary.length === 0) return;
  const pts = [[pos.lat, pos.lon], ...itinerary.map(m => [m.lat, m.lon])];
  navLine2D.setLatLngs(pts);
}

// ===== Route drawing — 3D scene =====
function makeDistSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,22,40,0.8)';
  ctx.roundRect(0, 0, 256, 64, 8);
  ctx.fill();
  ctx.fillStyle = '#ffcc00';
  ctx.font = 'bold 32px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(12, 3, 1);
  return sprite;
}

function geoTo3DRoute(terrain, lat, lon) {
  const v = terrain.geoToPosition(lat, lon);
  return new THREE.Vector3(v.x, Math.max(v.y, 0) + 3, v.z);
}

function drawRoute3D() {
  if (!current3D) return;
  const { scene, terrain, terrainBounds } = current3D;

  // Cleanup previous
  if (navLine3D) { scene.remove(navLine3D); navLine3D = null; }
  navLabels3D.forEach(s => scene.remove(s));
  navLabels3D = [];

  if (itinerary.length === 0) return;

  const pos = gps.getPosition();
  const allPts = [{ lat: pos.lat, lon: pos.lon }, ...itinerary];
  const points3d = allPts.map(p => geoTo3DRoute(terrain, p.lat, p.lon));

  // Pre-allocate buffer with extra room so updateRoute3D can modify vertex 0
  const maxPts = points3d.length;
  const posArr = new Float32Array(maxPts * 3);
  points3d.forEach((v, i) => { posArr[i * 3] = v.x; posArr[i * 3 + 1] = v.y; posArr[i * 3 + 2] = v.z; });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.9 });
  navLine3D = new THREE.Line(geo, mat);
  scene.add(navLine3D);

  // Distance labels at midpoint of each segment
  for (let i = 0; i < points3d.length - 1; i++) {
    const a = allPts[i], b = allPts[i + 1];
    const dist = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const mid = new THREE.Vector3().lerpVectors(points3d[i], points3d[i + 1], 0.5);
    mid.y += 5;
    const sprite = makeDistSprite(fmtDist(dist));
    sprite.position.copy(mid);
    scene.add(sprite);
    navLabels3D.push(sprite);
  }
}

function updateRoute3D(pos) {
  if (!current3D || !navLine3D || itinerary.length === 0) return;
  const { terrain } = current3D;

  // Update first point (vessel position)
  const v = geoTo3DRoute(terrain, pos.lat, pos.lon);
  const positions = navLine3D.geometry.attributes.position.array;
  positions[0] = v.x;
  positions[1] = v.y;
  positions[2] = v.z;
  navLine3D.geometry.attributes.position.needsUpdate = true;

  // Update first distance label
  if (navLabels3D.length > 0) {
    const wp = itinerary[0];
    const dist = haversineKm(pos.lat, pos.lon, wp.lat, wp.lon);
    const wpV = geoTo3DRoute(terrain, wp.lat, wp.lon);
    navLabels3D[0].position.set(
      (v.x + wpV.x) / 2,
      (v.y + wpV.y) / 2 + 5,
      (v.z + wpV.z) / 2
    );
    // Redraw label text
    const c = navLabels3D[0].material.map.image;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = 'rgba(10,22,40,0.8)';
    ctx.roundRect(0, 0, 256, 64, 8);
    ctx.fill();
    ctx.fillStyle = '#ffcc00';
    ctx.font = 'bold 32px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtDist(dist), 128, 32);
    navLabels3D[0].material.map.needsUpdate = true;
  }
}

function updateNavStatus(pos) {
  if (itinerary.length === 0) { navStatus.classList.add('hidden'); return; }
  const dist = haversineKm(pos.lat, pos.lon, itinerary[0].lat, itinerary[0].lon);
  const name = itinerary[0].name || 'WP1';
  navStatus.textContent = `Next: ${name} · ${fmtDist(dist)}`;
}

// ===== Init 2D Map =====
function initMap() {
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  leafletMap = createMap('map', onTileClick, allMarkers, (m) => addToItinerary(m));
  createGridSizeSelector(() => initMap());
  setupGPS2D();
  drawRoute2D();
  initWeather(leafletMap);
}

// ===== GPS on 2D map =====
function setupGPS2D() {
  if (!leafletMap) return;

  const boatSvg = `<svg class="gps-boat-svg" viewBox="0 0 24 32" width="24" height="32">
    <path d="M12 2 L18 22 L12 28 L6 22 Z" fill="#ff2200" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
  const boatIcon = L.divIcon({
    className: 'gps-boat-icon',
    html: boatSvg,
    iconSize: [24, 32],
    iconAnchor: [12, 16],
  });

  gpsMapMarker = L.marker([0, 0], { icon: boatIcon, zIndexOffset: 1000 }).addTo(leafletMap);
  gpsMapMarker.bindTooltip('', { permanent: true, direction: 'top', className: 'gps-tooltip', offset: [0, -18] });

  gpsTrailPoints = [];
  gpsMapTrail = L.polyline([], {
    color: '#ff8844', weight: 2, opacity: 0.6, dashArray: '4,4',
  }).addTo(leafletMap);
}

function updateGPS2D(pos) {
  if (!gpsMapMarker || !leafletMap) return;
  gpsMapMarker.setLatLng([pos.lat, pos.lon]);
  const svg = gpsMapMarker.getElement()?.querySelector('.gps-boat-svg');
  if (svg) svg.style.transform = `rotate(${pos.heading}deg)`;
  gpsMapMarker.setTooltipContent(
    `<b>${pos.speed.toFixed(1)} kts</b> · ${pos.phase}<br>${pos.lat.toFixed(4)}°N ${pos.lon.toFixed(4)}°E`
  );


  gpsTrailPoints.push([pos.lat, pos.lon]);
  if (gpsTrailPoints.length > 500) gpsTrailPoints.shift();
  gpsMapTrail.setLatLngs(gpsTrailPoints);
}

// ===== GPS on 3D view =====
function setupGPS3D() {
  if (!current3D) return;
  const { scene, terrain } = current3D;

  // Red sphere marker
  const geo = new THREE.SphereGeometry(1.5, 12, 8);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.5, roughness: 0.3,
  });
  gps3DMarker = new THREE.Mesh(geo, mat);
  gps3DMarker.visible = false;
  scene.add(gps3DMarker);

  // Depth line (surface → sea floor) — use a thin cylinder so it's visible
  depthLine3D = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, 1, 6),
    new THREE.MeshBasicMaterial({ color: 0xff2200 })
  );
  depthLine3D.visible = false;
  scene.add(depthLine3D);

  // Dot at the sea floor end
  depthDot3D = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xff2200, emissive: 0xff2200, emissiveIntensity: 0.5 })
  );
  depthDot3D.visible = false;
  scene.add(depthDot3D);

  // Trail line
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(1500), 3)); // 500 points
  trailGeo.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({ color: 0xff8844, transparent: true, opacity: 0.6 });
  gps3DTrail = new THREE.Line(trailGeo, trailMat);
  scene.add(gps3DTrail);
}

let gps3DTrailPoints = [];

function updateGPS3D(pos) {
  if (!current3D || !gps3DMarker) return;
  const { terrain, terrainBounds } = current3D;

  // Check if boat is within rendered terrain area
  const inTile = pos.lat >= terrainBounds.minLat && pos.lat <= terrainBounds.maxLat &&
                 pos.lon >= terrainBounds.minLon && pos.lon <= terrainBounds.maxLon;

  if (inTile) {
    const pos3d = terrain.geoToPosition(pos.lat, pos.lon);
    const surfaceY = Math.max(pos3d.y, 0) + 2;
    const floorY = pos3d.y;
    gps3DMarker.position.set(pos3d.x, surfaceY, pos3d.z);
    gps3DMarker.visible = true;

    // Update boat coords display — depth below surface shown as negative
    const geo = terrain.positionToGeo(pos3d);
    hoverCoords.textContent = `${pos.lat.toFixed(4)}°N  ${pos.lon.toFixed(4)}°E  ${geo.depth.toFixed(1)}m  ${pos.speed.toFixed(1)}kts  ${pos.phase}`;

    // Focus mode — chase camera behind the boat, looking forward
    if (focusMode && current3D) {
      const { camera, controls } = current3D;
      const headingRad = pos.heading * Math.PI / 180;
      const fwdX = Math.sin(headingRad);
      const fwdZ = -Math.cos(headingRad);
      const camHeight = focusCamDist * 0.5;
      const lookAhead = focusCamDist * 0.6;

      const desiredPos = {
        x: pos3d.x - fwdX * focusCamDist,
        y: surfaceY + camHeight,
        z: pos3d.z - fwdZ * focusCamDist,
      };
      const desiredTarget = {
        x: pos3d.x + fwdX * lookAhead,
        y: surfaceY,
        z: pos3d.z + fwdZ * lookAhead,
      };

      const smooth = 0.015; // lower = smoother
      if (!focusCamPos) {
        focusCamPos = { ...desiredPos };
        focusCamTarget = { ...desiredTarget };
      } else {
        focusCamPos.x += (desiredPos.x - focusCamPos.x) * smooth;
        focusCamPos.y += (desiredPos.y - focusCamPos.y) * smooth;
        focusCamPos.z += (desiredPos.z - focusCamPos.z) * smooth;
        focusCamTarget.x += (desiredTarget.x - focusCamTarget.x) * smooth;
        focusCamTarget.y += (desiredTarget.y - focusCamTarget.y) * smooth;
        focusCamTarget.z += (desiredTarget.z - focusCamTarget.z) * smooth;
      }

      camera.position.set(focusCamPos.x, focusCamPos.y, focusCamPos.z);
      controls.target.set(focusCamTarget.x, focusCamTarget.y, focusCamTarget.z);
      controls.update();

      // Save offset from vessel for seamless tile transitions
      focusCamOffset = {
        posX: focusCamPos.x - pos3d.x,
        posY: focusCamPos.y - surfaceY,
        posZ: focusCamPos.z - pos3d.z,
        tgtX: focusCamTarget.x - pos3d.x,
        tgtY: focusCamTarget.y - surfaceY,
        tgtZ: focusCamTarget.z - pos3d.z,
      };
    }

    // Depth line — stretch cylinder between surface and floor
    if (depthLineOn && depthLine3D && depthDot3D) {
      const lineLen = surfaceY - floorY;
      const midY = (surfaceY + floorY) / 2;
      depthLine3D.position.set(pos3d.x, midY, pos3d.z);
      depthLine3D.scale.set(1, Math.max(lineLen, 0.1), 1);
      depthLine3D.visible = true;
      depthDot3D.position.set(pos3d.x, floorY, pos3d.z);
      depthDot3D.visible = true;
    }

    gps3DTrailPoints.push(pos3d.x, Math.max(pos3d.y, 0) + 1, pos3d.z);
    if (gps3DTrailPoints.length > 1500) gps3DTrailPoints.splice(0, 3);

    const arr = gps3DTrail.geometry.attributes.position.array;
    for (let i = 0; i < gps3DTrailPoints.length; i++) arr[i] = gps3DTrailPoints[i];
    gps3DTrail.geometry.attributes.position.needsUpdate = true;
    gps3DTrail.geometry.setDrawRange(0, gps3DTrailPoints.length / 3);
  } else {
    gps3DMarker.visible = false;
    if (depthLine3D) depthLine3D.visible = false;
    if (depthDot3D) depthDot3D.visible = false;
  }

  // Hide depth line if toggled off
  if (!depthLineOn && depthLine3D) { depthLine3D.visible = false; depthDot3D.visible = false; }
}

// ===== Satellite minimap in 3D view =====
function setupMinimap(tileBounds) {
  destroyMinimap();

  const container = document.getElementById('minimap');
  minimap = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    boxZoom: false,
    keyboard: false,
    touchZoom: true,
  });

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
  }).addTo(minimap);

  // Fit to tile bounds with padding
  const bounds = L.latLngBounds(
    [tileBounds.minLat, tileBounds.minLon],
    [tileBounds.maxLat, tileBounds.maxLon]
  );
  minimap.fitBounds(bounds.pad(0.15));

  // Show colored marker dots on minimap
  const terrainMarkers = allMarkers.filter(m =>
    m.lat >= tileBounds.minLat && m.lat <= tileBounds.maxLat &&
    m.lon >= tileBounds.minLon && m.lon <= tileBounds.maxLon
  );
  terrainMarkers.forEach(m => {
    L.circleMarker([m.lat, m.lon], {
      radius: 4, color: '#fff', fillColor: m.color || '#40c0ff',
      fillOpacity: 0.9, weight: 1,
    }).addTo(minimap);
  });

  // Draw tile outline
  L.rectangle(bounds, {
    weight: 2, color: '#4a9ede', fill: false, dashArray: '6,4',
  }).addTo(minimap);

  // Trail line
  minimapTrail = L.polyline([], {
    color: '#ff8844', weight: 2, opacity: 0.6, dashArray: '4,4',
  }).addTo(minimap);

  // GPS boat marker
  const miniBoatSvg = `<svg class="gps-boat-svg" viewBox="0 0 24 32" width="16" height="20">
    <path d="M12 2 L18 22 L12 28 L6 22 Z" fill="#ff2200" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
  const miniBoatIcon = L.divIcon({
    className: 'gps-boat-icon',
    html: miniBoatSvg,
    iconSize: [16, 20],
    iconAnchor: [8, 10],
  });
  minimapBoat = L.marker([0, 0], { icon: miniBoatIcon }).addTo(minimap);

  // Draw navigation route on minimap
  if (itinerary.length > 0) {
    const pos = gps.getPosition();
    const pts = [[pos.lat, pos.lon], ...itinerary.map(m => [m.lat, m.lon])];
    navMinimapLine = L.polyline(pts, { color: '#ffcc00', weight: 2, dashArray: '6,4', opacity: 0.8 }).addTo(minimap);
  }
}

function updateMinimap(pos) {
  if (!minimapBoat || !minimap) return;
  minimapBoat.setLatLng([pos.lat, pos.lon]);
  const svg = minimapBoat.getElement()?.querySelector('.gps-boat-svg');
  if (svg) svg.style.transform = `rotate(${pos.heading}deg)`;
  if (minimapTrail) minimapTrail.setLatLngs(gpsTrailPoints);
  if (navMinimapLine && itinerary.length > 0) {
    navMinimapLine.setLatLngs([[pos.lat, pos.lon], ...itinerary.map(m => [m.lat, m.lon])]);
  }
}

let minimapTrail = null;

function destroyMinimap() {
  if (minimap) { minimap.remove(); minimap = null; minimapBoat = null; minimapTrail = null; navMinimapLine = null; }
}

// ===== Layer panel (overlays only) =====
function buildLayerPanel() {
  layerPanelBody.innerHTML = '';

  OVERLAY_GROUPS.forEach((group, gi) => {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'layer-group-label';
    groupLabel.textContent = group.label;
    layerPanelBody.appendChild(groupLabel);

    group.layers.forEach(layer => {
      const item = document.createElement('div');
      item.className = 'layer-item';
      item.dataset.layerId = layer.id;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = activeOverlays.has(layer.id);

      const info = document.createElement('div');
      info.className = 'layer-item-info';
      info.innerHTML = `<div class="layer-item-name">${layer.name}</div><div class="layer-item-desc">${layer.description}</div>`;

      item.appendChild(input);
      item.appendChild(info);
      item.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
      input.addEventListener('change', () => onOverlayToggle(layer.id, input.checked));
      layerPanelBody.appendChild(item);
    });

    if (gi < OVERLAY_GROUPS.length - 1) {
      const d = document.createElement('div');
      d.className = 'layer-divider';
      layerPanelBody.appendChild(d);
    }
  });
}

async function onOverlayToggle(layerId, enabled) {
  if (!current3D) return;
  const layer = getOverlayById(layerId);
  if (!layer) return;

  if (enabled) {
    activeOverlays.add(layerId);
    const url = layer.url(current3D.tileBounds, 512, 512);
    removeOverlay(current3D.terrain);
    await applyOverlay(current3D.terrain, url, (text) => {
      loadingText.textContent = text;
      if (text) { loading.classList.remove('hidden'); loading.classList.remove('fade-out'); }
    });
    loading.classList.add('fade-out');
    setTimeout(() => loading.classList.add('hidden'), 400);
  } else {
    activeOverlays.delete(layerId);
    removeOverlay(current3D.terrain);
    if (activeOverlays.size > 0) {
      const lastId = [...activeOverlays].pop();
      const lastLayer = getOverlayById(lastId);
      if (lastLayer) await applyOverlay(current3D.terrain, lastLayer.url(current3D.tileBounds, 512, 512), null);
    }
  }
}

// ===== Update depth legend with actual values =====
function updateDepthLegend(terrain) {
  const dataSourceEl = document.getElementById('data-source');
  dataSourceEl.textContent = `Source: ${terrain.dataSource}`;

  const shallowEl = document.getElementById('depth-shallow');
  const deepEl = document.getElementById('depth-deep');

  if (terrain.minElev !== null && terrain.maxElev !== null) {
    shallowEl.textContent = `${Math.round(terrain.maxElev)}m`;
    deepEl.textContent = `${Math.round(terrain.minElev)}m`;
  } else {
    shallowEl.textContent = 'Shallow';
    deepEl.textContent = 'Deep';
  }
}

// ===== Tile preloading =====
function getTileBoundsExpanded(tileBounds) {
  if (!wideMode) return tileBounds;
  const latSpan = tileBounds.maxLat - tileBounds.minLat;
  const lonSpan = tileBounds.maxLon - tileBounds.minLon;
  return {
    minLat: tileBounds.minLat - latSpan,
    maxLat: tileBounds.maxLat + latSpan,
    minLon: tileBounds.minLon - lonSpan,
    maxLon: tileBounds.maxLon + lonSpan,
    label: tileBounds.label,
  };
}

function tileKey(tb) { return `${tb.minLat},${tb.minLon}`; }

function checkPreload(pos) {
  if (!followMode || !current3D) return;
  const tb = current3D.tileBounds;
  const latSpan = tb.maxLat - tb.minLat;
  const lonSpan = tb.maxLon - tb.minLon;

  // How close to the edge (>0.5 = past halfway to edge)
  const fracLat = Math.max(
    1 - (pos.lat - tb.minLat) / latSpan * 2,
    1 - (tb.maxLat - pos.lat) / latSpan * 2
  );
  const fracLon = Math.max(
    1 - (pos.lon - tb.minLon) / lonSpan * 2,
    1 - (tb.maxLon - pos.lon) / lonSpan * 2
  );

  if (fracLat > 0.5 || fracLon > 0.5) {
    const headingRad = pos.heading * Math.PI / 180;
    const lookLat = pos.lat + Math.cos(headingRad) * latSpan * 0.6;
    const lookLon = pos.lon + Math.sin(headingRad) / Math.cos(pos.lat * Math.PI / 180) * lonSpan * 0.6;
    const nextTile = getTileBoundsAt(lookLat, lookLon);
    const nextKey = tileKey(nextTile);
    if (nextKey !== followCurrentTileKey && nextKey !== preloadingKey) {
      preloadingKey = nextKey;
      const bounds = getTileBoundsExpanded(nextTile);
      prefetchTerrain(bounds).then(() => { preloadingKey = null; });
    }
  }
}

// ===== Tile click -> enter 3D =====
async function onTileClick(tileBounds) {
  viewMap.classList.add('hidden');
  view3D.classList.remove('hidden');

  const seamless = focusMode && current3D;

  if (!seamless) {
    loading.classList.remove('hidden');
    loading.classList.remove('fade-out');
    loadingText.textContent = 'Loading terrain data...';
  }

  tileLabel.textContent = tileBounds.label;
  followCurrentTileKey = tileKey(tileBounds);
  activeOverlays.clear();

  const terrainBounds = getTileBoundsExpanded(tileBounds);

  // In seamless mode, prefetch data while old scene keeps rendering
  if (seamless) {
    await prefetchTerrain(terrainBounds);
  }

  // Now swap — if data was prefetched, createTerrain hits cache and is near-instant
  if (current3D) { saveCurrentTileMarkers(); }
  cleanup3D();
  destroyMinimap();

  const { renderer, scene, camera, controls, animate } = createScene(canvas);

  const terrain = await createTerrain(scene, terrainBounds, (text) => {
    if (!seamless) loadingText.textContent = text;
  });

  // Adjust camera to frame the terrain (skip in focus mode — GPS tick handles it)
  if (!focusMode) adjustCamera(camera, controls, terrain);

  updateDepthLegend(terrain);
  document.getElementById('land-warning').classList.add('hidden');

  // Context and scale objects use terrain dimensions
  const contextGroup = addContext(scene, terrain);
  const boatObj = createBoat(scene, terrain);

  const markerSystem = createMarkerSystem(scene, camera, canvas, terrain, controls);

  const tileMarkers = allMarkers.filter(m =>
    m.lat >= terrainBounds.minLat && m.lat < terrainBounds.maxLat &&
    m.lon >= terrainBounds.minLon && m.lon < terrainBounds.maxLon
  );
  if (tileMarkers.length > 0) markerSystem.loadMarkers(tileMarkers);

  const panel = createPanel(markerSystem);

  markerSystem.onMarkerSelect = (data) => panel.show(data);
  markerSystem.onMarkerDeselect = () => panel.hide();
  panel.onNavigate = (data) => addToItinerary(data, { enterFocus: true });
  markerSystem.onMarkerChange = () => saveCurrentTileMarkers();
  markerSystem.onMultiSelect = (ids) => { editCount.textContent = `${ids.length} selected`; };
  markerSystem.onHoverUpdate = (geo) => {
    hoverCoords.textContent = `${geo.lat.toFixed(4)}°N  ${geo.lon.toFixed(4)}°E  depth: ${geo.depth.toFixed(1)}m`;
  };

  loading.classList.add('fade-out');
  setTimeout(() => loading.classList.add('hidden'), 600);

  const stopAnimate = animate();

  current3D = {
    scene, renderer, camera, controls, terrain, markerSystem, panel,
    tileBounds,          // original tile (for follow mode)
    terrainBounds,       // actual rendered bounds (may be 3x3)
    stopAnimate, contextGroup, boatObj,
  };

  buildLayerPanel();

  // Restore focus mode controls lock if active
  if (focusMode) {
    controls.enableRotate = false;
    controls.enablePan = false;
    // Reposition camera relative to vessel using saved offset
    const gpsPos = gps.getPosition();
    const pos3d = terrain.geoToPosition(gpsPos.lat, gpsPos.lon);
    const surfaceY = Math.max(pos3d.y, 0) + 2;
    if (focusCamOffset) {
      // Apply the same relative offset to the new tile coordinates
      focusCamPos = {
        x: pos3d.x + focusCamOffset.posX,
        y: surfaceY + focusCamOffset.posY,
        z: pos3d.z + focusCamOffset.posZ,
      };
      focusCamTarget = {
        x: pos3d.x + focusCamOffset.tgtX,
        y: surfaceY + focusCamOffset.tgtY,
        z: pos3d.z + focusCamOffset.tgtZ,
      };
    } else {
      // First time — compute from heading
      const headingRad = gpsPos.heading * Math.PI / 180;
      const fwdX = Math.sin(headingRad);
      const fwdZ = -Math.cos(headingRad);
      focusCamPos = {
        x: pos3d.x - fwdX * focusCamDist,
        y: surfaceY + focusCamDist * 0.5,
        z: pos3d.z - fwdZ * focusCamDist,
      };
      focusCamTarget = {
        x: pos3d.x + fwdX * focusCamDist * 0.6,
        y: surfaceY,
        z: pos3d.z + fwdZ * focusCamDist * 0.6,
      };
    }
    camera.position.set(focusCamPos.x, focusCamPos.y, focusCamPos.z);
    controls.target.set(focusCamTarget.x, focusCamTarget.y, focusCamTarget.z);
    controls.update();
  }

  // Setup GPS in 3D
  gps3DTrailPoints = [];
  setupGPS3D();

  // Setup satellite minimap showing the rendered area
  setupMinimap(terrainBounds);

  // Draw navigation route in 3D
  drawRoute3D();
}

// ===== Back to map =====
function goBackToMap() {
  if (current3D) { saveCurrentTileMarkers(); cleanup3D(); }
  destroyMinimap();

  view3D.classList.add('hidden');
  viewMap.classList.remove('hidden');
  layerPanel.classList.add('hidden');

  btnAddMode.classList.remove('active');
  btnAddMode.textContent = '+ Marker';
  btnEditMode.classList.remove('active');
  btnEditMode.textContent = 'Edit';
  editToolbar.classList.add('hidden');
  hoverCoords.textContent = 'Hover over terrain';

  document.getElementById('panel').classList.add('hidden');
  document.getElementById('land-warning').classList.add('hidden');

  initMap();
}

function saveCurrentTileMarkers() {
  if (!current3D) return;
  const { terrainBounds, markerSystem } = current3D;
  allMarkers = allMarkers.filter(m =>
    !(m.lat >= terrainBounds.minLat && m.lat < terrainBounds.maxLat &&
      m.lon >= terrainBounds.minLon && m.lon < terrainBounds.maxLon)
  );
  allMarkers.push(...markerSystem.getAllData());
  saveToStorage(allMarkers);
}

function cleanup3D() {
  if (!current3D) return;
  const { scene, renderer, terrain, markerSystem, stopAnimate, contextGroup, boatObj } = current3D;

  if (stopAnimate) stopAnimate();
  if (markerSystem && markerSystem.markers) markerSystem.markers.forEach(m => scene.remove(m.mesh));
  destroyTerrain(scene, terrain);
  if (contextGroup) scene.remove(contextGroup);
  if (boatObj) { scene.remove(boatObj.boat); scene.remove(boatObj.label); }
  if (gps3DMarker) { scene.remove(gps3DMarker); gps3DMarker = null; }
  if (gps3DTrail) { scene.remove(gps3DTrail); gps3DTrail = null; }
  if (depthLine3D) { scene.remove(depthLine3D); depthLine3D = null; }
  if (depthDot3D) { scene.remove(depthDot3D); depthDot3D = null; }
  if (navLine3D) { scene.remove(navLine3D); navLine3D = null; }
  navLabels3D.forEach(s => scene.remove(s));
  navLabels3D = [];

  renderer.dispose();
  current3D = null;
}

// ===== Wide mode (3x3 tiles) =====
const btnWide = document.getElementById('btn-wide');
let wideMode = true;
btnWide.classList.add('active');

btnWide.addEventListener('click', () => {
  wideMode = !wideMode;
  btnWide.classList.toggle('active', wideMode);
  // Reload current tile with new bounds
  if (current3D) {
    const tb = current3D.tileBounds;
    onTileClick(tb);
  }
});

// ===== Edit mode =====
const btnEditMode = document.getElementById('btn-edit-mode');
const editToolbar = document.getElementById('edit-toolbar');
const editCount = document.getElementById('edit-count');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDeselect = document.getElementById('btn-deselect');
const btnDeleteSelected = document.getElementById('btn-delete-selected');

btnEditMode.addEventListener('click', () => {
  if (!current3D) return;
  const ms = current3D.markerSystem;
  ms.editMode = !ms.editMode;
  btnEditMode.classList.toggle('active', ms.editMode);
  btnEditMode.textContent = ms.editMode ? 'Editing' : 'Edit';
  editToolbar.classList.toggle('hidden', !ms.editMode);
  // Turn off add mode when entering edit
  if (ms.editMode) { ms.addMode = false; btnAddMode.classList.remove('active'); btnAddMode.textContent = '+ Marker'; }
});

btnSelectAll.addEventListener('click', () => {
  if (current3D) current3D.markerSystem.selectAll();
});

btnDeselect.addEventListener('click', () => {
  if (current3D) current3D.markerSystem.deselectAll();
});

btnDeleteSelected.addEventListener('click', () => {
  if (!current3D) return;
  const ms = current3D.markerSystem;
  const count = ms.multiSelected.size;
  if (count === 0) return;
  if (confirm(`Delete ${count} marker(s)?`)) {
    ms.removeMultiSelected();
    saveCurrentTileMarkers();
  }
});

// ===== Depth line toggle =====
const btnDepthLine = document.getElementById('btn-depthline');
btnDepthLine.addEventListener('click', () => {
  depthLineOn = !depthLineOn;
  btnDepthLine.classList.toggle('active', depthLineOn);
  if (!depthLineOn && depthLine3D) { depthLine3D.visible = false; depthDot3D.visible = false; }
});

// ===== Speed control =====
const btnSpeed = document.getElementById('btn-speed');
const SPEED_STEPS = [1, 10, 30, 60, 120];
let speedIdx = 0;

btnSpeed.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEED_STEPS.length;
  const scale = SPEED_STEPS[speedIdx];
  gps.setTimeScale(scale);
  btnSpeed.textContent = `${scale}x`;
  btnSpeed.classList.toggle('active', scale > 1);
});

// ===== Follow mode =====
const btnFollow = document.getElementById('btn-follow');
let followLoading = false;

btnFollow.addEventListener('click', () => {
  followMode = !followMode;
  btnFollow.classList.toggle('active', followMode);
  btnFollow.textContent = followMode ? 'Following' : 'Follow';

  if (followMode) {
    // Jump to the boat's current tile immediately
    const pos = gps.getPosition();
    const tile = getTileBoundsAt(pos.lat, pos.lon);
    followCurrentTileKey = `${tile.minLat},${tile.minLon}`;

    // If we're on the 2D map, enter 3D at the boat's tile
    if (!current3D) {
      onTileClick(tile);
    }
  } else {
    // Turning off follow also turns off focus
    if (focusMode) {
      focusMode = false;
      focusCamPos = null;
      focusCamTarget = null;
      focusCamOffset = null;
      btnFocus.classList.remove('active');
      btnFocus.textContent = 'Focus';
      if (current3D) {
        current3D.controls.enableRotate = true;
        current3D.controls.enablePan = true;
      }
    }
  }
});

// ===== Focus mode (chase cam) =====
const btnFocus = document.getElementById('btn-focus');

canvas.addEventListener('wheel', (e) => {
  if (!focusMode) return;
  e.preventDefault();
  focusCamDist = Math.max(15, Math.min(300, focusCamDist + e.deltaY * 0.1));
}, { passive: false });

btnFocus.addEventListener('click', () => {
  focusMode = !focusMode;
  btnFocus.classList.toggle('active', focusMode);
  btnFocus.textContent = focusMode ? 'Focused' : 'Focus';

  if (focusMode) {
    // Enable follow mode as well
    if (!followMode) {
      followMode = true;
      btnFollow.classList.add('active');
      btnFollow.textContent = 'Following';
      const pos = gps.getPosition();
      const tile = getTileBoundsAt(pos.lat, pos.lon);
      followCurrentTileKey = `${tile.minLat},${tile.minLon}`;
      if (!current3D) onTileClick(tile);
    }
    if (current3D) {
      current3D.controls.enableRotate = false;
      current3D.controls.enablePan = false;
    }
  } else {
    focusCamPos = null;
    focusCamTarget = null;
    focusCamOffset = null;
    if (current3D) {
      current3D.controls.enableRotate = true;
      current3D.controls.enablePan = true;
    }
  }
});

async function checkFollowTileChange(pos) {
  if (!followMode || followLoading) return;
  const tile = getTileBoundsAt(pos.lat, pos.lon);
  const key = `${tile.minLat},${tile.minLon}`;
  if (key === followCurrentTileKey) return;

  // Boat crossed into a new tile — reload 3D
  followCurrentTileKey = key;
  followLoading = true;

  if (current3D) saveCurrentTileMarkers();

  await onTileClick(tile);
  followLoading = false;
}

// ===== Toolbar events =====
btnBack.addEventListener('click', () => {
  followMode = false;
  btnFollow.classList.remove('active');
  btnFollow.textContent = 'Follow';
  focusMode = false;
  btnFocus.classList.remove('active');
  btnFocus.textContent = 'Focus';
  goBackToMap();
});

btnLayers.addEventListener('click', () => {
  layerPanel.classList.toggle('hidden');
  btnLayers.classList.toggle('active', !layerPanel.classList.contains('hidden'));
});

layerPanelClose.addEventListener('click', () => {
  layerPanel.classList.add('hidden');
  btnLayers.classList.remove('active');
});

btnAddMode.addEventListener('click', () => {
  if (!current3D) return;
  const ms = current3D.markerSystem;
  ms.addMode = !ms.addMode;
  btnAddMode.classList.toggle('active', ms.addMode);
  btnAddMode.textContent = ms.addMode ? 'Adding...' : '+ Marker';
});

// ===== Start =====
initMap();

// Start GPS and wire updates to both views
gps.onPosition((pos) => {
  updateGPS2D(pos);
  updateGPS3D(pos);
  updateMinimap(pos);
  updateRoute2D(pos);
  updateRoute3D(pos);
  updateNavStatus(pos);
  checkPreload(pos);
  checkFollowTileChange(pos);
});
gps.start();
