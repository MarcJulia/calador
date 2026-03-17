import * as THREE from 'three';

// ===== Config =====
const TERRAIN_BASE = 200;  // 3D units for the largest horizontal dimension
const SEGMENTS = 256;

// ===== EMODnet WCS via local proxy — real depth values at ~115m =====
// Proxied through /proxy/emodnet-wcs to bypass CORS.
// Returns ASCII grid with actual depth in meters.

async function fetchEmodnetHeightmap(bounds, segments, setLoadingText) {
  const size = segments + 1;
  setLoadingText('Fetching EMODnet bathymetry...');

  // Oversample: request 5x the tile area for more data points near edges
  const latSpan = bounds.maxLat - bounds.minLat;
  const lonSpan = bounds.maxLon - bounds.minLon;
  const pad = 2; // 2x padding each side = 5x total
  const wb = {
    minLat: bounds.minLat - latSpan * pad,
    maxLat: bounds.maxLat + latSpan * pad,
    minLon: bounds.minLon - lonSpan * pad,
    maxLon: bounds.maxLon + lonSpan * pad,
  };

  // Use native resolution (no SCALESIZE) — EMODnet returns ~125m grid
  const url = `/proxy/emodnet-wcs?SERVICE=WCS&VERSION=2.0.1` +
    `&REQUEST=GetCoverage&COVERAGEID=emodnet__mean` +
    `&FORMAT=text/plain` +
    `&SUBSET=Lat(${wb.minLat},${wb.maxLat})` +
    `&SUBSET=Long(${wb.minLon},${wb.maxLon})`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`WCS ${resp.status}: ${await resp.text()}`);
  const text = await resp.text();

  setLoadingText('Parsing depth grid...');

  // text/plain format: header lines (Grid bounds, CRS, etc) then rows of depth values
  const lines = text.trim().split('\n');

  // Skip all non-numeric header lines
  let headerLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { headerLines++; continue; }
    const first = trimmed.split(/\s+/)[0];
    if (isNaN(parseFloat(first))) headerLines++;
    else break;
  }

  // Parse all numeric values
  const rows = [];
  for (let i = headerLines; i < lines.length; i++) {
    const nums = lines[i].trim().split(/\s+/).map(Number);
    if (nums.length > 0 && !isNaN(nums[0])) rows.push(nums);
  }

  const nrows = rows.length;
  const ncols = rows[0]?.length || 0;
  console.log(`EMODnet WCS grid: ${ncols}x${nrows}`);

  if (nrows < 2 || ncols < 2) throw new Error('WCS returned too few data points');

  // Flatten into values array
  const values = [];
  for (const row of rows) values.push(...row);

  // Resample from the wide WCS grid into our tile bounds (bilinear)
  // The WCS grid covers wb (wide bounds), we need to extract the tile bounds
  const wideLatSpan = wb.maxLat - wb.minLat;
  const wideLonSpan = wb.maxLon - wb.minLon;

  const data = new Float32Array(size * size);
  const isLand = new Uint8Array(size * size);

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const lon = bounds.minLon + (i / (size - 1)) * lonSpan;
      const lat = bounds.maxLat - (j / (size - 1)) * latSpan;

      // Position within the WCS grid (0..ncols, 0..nrows)
      const gx = ((lon - wb.minLon) / wideLonSpan) * (ncols - 1);
      const gy = ((wb.maxLat - lat) / wideLatSpan) * (nrows - 1);

      const x0 = Math.max(0, Math.min(Math.floor(gx), ncols - 2));
      const y0 = Math.max(0, Math.min(Math.floor(gy), nrows - 2));
      const fx = gx - x0, fy = gy - y0;

      const v00 = values[y0 * ncols + x0];
      const v10 = values[y0 * ncols + x0 + 1];
      const v01 = values[(y0 + 1) * ncols + x0];
      const v11 = values[(y0 + 1) * ncols + x0 + 1];

      // Land = positive values near 0 or NaN
      const hasNodata = [v00, v10, v01, v11].some(v => isNaN(v) || v === undefined);
      if (hasNodata) {
        isLand[j * size + i] = 1;
        data[j * size + i] = 0;
      } else {
        const val = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
                    v01 * (1 - fx) * fy + v11 * fx * fy;
        // Values > 0.5 likely indicate land in EMODnet
        if (val > 0.5) {
          isLand[j * size + i] = 1;
          data[j * size + i] = 0;
        } else {
          data[j * size + i] = val; // negative = underwater depth in meters
        }
      }
    }
  }

  // Stats
  let seaMin = Infinity, seaMax = -Infinity, landCount = 0;
  for (let i = 0; i < size * size; i++) {
    if (isLand[i]) { landCount++; continue; }
    if (data[i] < seaMin) seaMin = data[i];
    if (data[i] > seaMax) seaMax = data[i];
  }
  const seaRange = seaMax - seaMin || 1;
  const landPct = landCount / (size * size);

  if (landPct > 0.95) throw new Error('Tile is mostly land');

  console.log(`EMODnet: ${seaMin.toFixed(1)}m to ${seaMax.toFixed(1)}m (${seaRange.toFixed(1)}m range), land ${(landPct * 100).toFixed(0)}%`);

  return { data, isLand, seaMin, seaMax, seaRange, landPct, isMetric: true };
}

// ===== Terrarium terrain tiles (AWS) — fallback for land/mixed tiles =====

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRARIUM_ZOOM = 12;

function latLonToTileXY(lat, lon, zoom) {
  const n = 1 << zoom;
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

async function fetchTerrariumHeightmap(bounds, segments, setLoadingText) {
  const size = segments + 1;
  const zoom = TERRARIUM_ZOOM;
  const tl = latLonToTileXY(bounds.maxLat, bounds.minLon, zoom);
  const br = latLonToTileXY(bounds.minLat, bounds.maxLon, zoom);
  const cols = br.x - tl.x + 1;
  const rows = br.y - tl.y + 1;

  const stitchW = cols * 256, stitchH = rows * 256;
  const stitchCanvas = document.createElement('canvas');
  stitchCanvas.width = stitchW; stitchCanvas.height = stitchH;
  const ctx = stitchCanvas.getContext('2d', { willReadFrequently: true });

  setLoadingText(`Fetching elevation tiles (${cols * rows})...`);
  const fetches = [];
  for (let ty = tl.y; ty <= br.y; ty++) {
    for (let tx = tl.x; tx <= br.x; tx++) {
      const url = `${TERRARIUM_URL}/${zoom}/${tx}/${ty}.png`;
      const dx = (tx - tl.x) * 256, dy = (ty - tl.y) * 256;
      fetches.push(loadImageWithTimeout(url, 12000).then(img => ctx.drawImage(img, dx, dy)));
    }
  }
  await Promise.all(fetches);

  setLoadingText('Decoding elevation...');
  const n = 1 << zoom;
  const lonToPx = lon => ((lon + 180) / 360 * n - tl.x) * 256;
  const latToPx = lat => {
    const r = lat * Math.PI / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - tl.y) * 256;
  };

  const pxL = lonToPx(bounds.minLon), pxR = lonToPx(bounds.maxLon);
  const pxT = latToPx(bounds.maxLat), pxB = latToPx(bounds.minLat);
  const imgData = ctx.getImageData(0, 0, stitchW, stitchH);
  const data = new Float32Array(size * size);

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const px = pxL + (pxR - pxL) * (i / (size - 1));
      const py = pxT + (pxB - pxT) * (j / (size - 1));
      const ix = Math.max(0, Math.min(Math.floor(px), stitchW - 1));
      const iy = Math.max(0, Math.min(Math.floor(py), stitchH - 1));
      const idx = (iy * stitchW + ix) * 4;
      const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
      data[j * size + i] = (r * 256 + g + b / 256) - 32768;
    }
  }
  return data;
}

// ===== GEBCO fallback =====

function gebcoUrl(b, w, h) {
  return `https://wms.gebco.net/mapserv?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=GEBCO_LATEST_2&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png`;
}

function parseGebcoHeightmap(image, segments) {
  const size = segments + 1;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size);
  const data = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = px.data[i * 4], g = px.data[i * 4 + 1], b = px.data[i * 4 + 2];
    data[i] = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
  }
  smoothHeightmap(data, size, 3);
  return data;
}

// ===== Satellite texture =====

function satelliteUrl(b, w, h) {
  return `https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=png&f=image`;
}

// ===== Procedural fallback =====

function seededRandom(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
function smoothNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return (seededRandom(ix, iy) * (1 - sx) + seededRandom(ix + 1, iy) * sx) * (1 - sy) +
         (seededRandom(ix, iy + 1) * (1 - sx) + seededRandom(ix + 1, iy + 1) * sx) * sy;
}
function fbmNoise(x, y, oct = 6) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * smoothNoise(x * f, y * f); a *= 0.5; f *= 2; }
  return v;
}
function generateProceduralHeightmap(segments, bounds) {
  const size = segments + 1;
  const data = new Float32Array(size * size);
  const ox = bounds.minLon * 10, oy = bounds.minLat * 10;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const nx = ox + (i / size) * 5, ny = oy + (j / size) * 5;
      let h = fbmNoise(nx, ny, 7);
      const ridge = 1 - Math.abs(fbmNoise(nx * 0.7 + 10, ny * 0.7 + 10, 5) - 0.5) * 2;
      const channel = fbmNoise(nx * 0.3 + 20, ny * 0.3 + 20, 3);
      data[j * size + i] = h * 0.55 + ridge * ridge * 0.25 + channel * 0.2;
    }
  }
  return data;
}

// ===== Helpers =====

function smoothHeightmap(data, size, passes) {
  const tmp = new Float32Array(data.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(data);
    for (let j = 1; j < size - 1; j++) {
      for (let i = 1; i < size - 1; i++) {
        const idx = j * size + i;
        let sum = 0, w = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const k = (di === 0 && dj === 0) ? 4 : (di === 0 || dj === 0) ? 2 : 1;
          sum += tmp[(j + dj) * size + (i + di)] * k; w += k;
        }
        data[idx] = sum / w;
      }
    }
  }
}

function loadImageWithTimeout(url, timeout) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; reject(new Error('Timeout')); }, timeout);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('Load failed')); };
    img.src = url;
  });
}

// ===== Contour lines (marching squares → proper line segments) =====

function createContourLines(positions, size, numContours) {
  const group = new THREE.Group();

  // Extract Y values
  const yVals = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) yVals[i] = positions[i * 3 + 1];

  let minY = Infinity, maxY = -Infinity;
  for (const y of yVals) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const range = maxY - minY;
  if (range < 0.01) return group;

  for (let c = 1; c < numContours; c++) {
    const level = minY + range * (c / numContours);
    const segs = []; // flat array: x1,y1,z1, x2,y2,z2, ...

    for (let j = 0; j < size - 1; j++) {
      for (let i = 0; i < size - 1; i++) {
        const i00 = j * size + i, i10 = i00 + 1;
        const i01 = i00 + size, i11 = i01 + 1;
        const y00 = yVals[i00], y10 = yVals[i10], y01 = yVals[i01], y11 = yVals[i11];

        // Find edge crossings
        const crossings = [];
        // Top edge (00→10)
        if ((y00 < level) !== (y10 < level)) crossings.push(lerpEdge(positions, i00, i10, y00, y10, level));
        // Right edge (10→11)
        if ((y10 < level) !== (y11 < level)) crossings.push(lerpEdge(positions, i10, i11, y10, y11, level));
        // Bottom edge (01→11)
        if ((y01 < level) !== (y11 < level)) crossings.push(lerpEdge(positions, i01, i11, y01, y11, level));
        // Left edge (00→01)
        if ((y00 < level) !== (y01 < level)) crossings.push(lerpEdge(positions, i00, i01, y00, y01, level));

        if (crossings.length === 2) {
          segs.push(...crossings[0], ...crossings[1]);
        } else if (crossings.length === 4) {
          // Saddle: use center value to disambiguate
          const yCenter = (y00 + y10 + y01 + y11) / 4;
          if ((yCenter >= level) === (y00 >= level)) {
            segs.push(...crossings[0], ...crossings[3]);
            segs.push(...crossings[1], ...crossings[2]);
          } else {
            segs.push(...crossings[0], ...crossings[1]);
            segs.push(...crossings[2], ...crossings[3]);
          }
        }
      }
    }

    if (segs.length < 6) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));

    const depthNorm = (level - minY) / range;
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color().lerpColors(new THREE.Color(0x80d0ff), new THREE.Color(0x102040), depthNorm),
      transparent: true, opacity: 0.6,
    });
    group.add(new THREE.LineSegments(geom, mat));
  }
  return group;
}

function lerpEdge(pos, idxA, idxB, yA, yB, level) {
  const t = (level - yA) / (yB - yA);
  const a = idxA * 3, b = idxB * 3;
  return [
    pos[a] + t * (pos[b] - pos[a]),
    level + 0.15,
    pos[a + 2] + t * (pos[b + 2] - pos[a + 2]),
  ];
}

// ===== Main terrain creation =====

export async function createTerrain(scene, bounds, setLoadingText) {
  const size = SEGMENTS + 1;

  // Real-world tile dimensions
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const widthM = (bounds.maxLon - bounds.minLon) * 111320 * Math.cos(midLat * Math.PI / 180);
  const depthM = (bounds.maxLat - bounds.minLat) * 111320;
  const maxDimM = Math.max(widthM, depthM);

  // Scale: 3D units per real-world meter
  const unitsPerMeter = TERRAIN_BASE / maxDimM;
  const terrainWidth = widthM * unitsPerMeter;
  const terrainDepth = depthM * unitsPerMeter;

  // --- Fetch elevation data ---
  let heightValues = null;
  let isMetric = false;
  let dataSource = 'procedural';
  let gebcoImage = null;
  let satelliteImage = null;

  // 1. Fetch EMODnet (hi-res sea) + Terrarium (land elevation) in parallel
  let emodnetResult = null, terrariumData = null;

  {
    const emodnetPromise = fetchEmodnetHeightmap(bounds, SEGMENTS, setLoadingText)
      .catch(err => { console.warn('EMODnet failed:', err.message); return null; });
    const terrariumPromise = fetchTerrariumHeightmap(bounds, SEGMENTS, setLoadingText)
      .catch(err => { console.warn('Terrarium failed:', err.message); return null; });

    setLoadingText('Fetching elevation data...');
    [emodnetResult, terrariumData] = await Promise.all([emodnetPromise, terrariumPromise]);
  }

  if (emodnetResult && terrariumData) {
    // Merge: EMODnet for sea (real meters, hi-res), Terrarium for land (real meters)
    const { data: eData, isLand } = emodnetResult;
    heightValues = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      heightValues[i] = isLand[i] ? terrariumData[i] : eData[i];
    }
    isMetric = true;
    dataSource = 'EMODnet + Terrarium';
    smoothHeightmap(heightValues, size, 1);
    console.log('Merged EMODnet (sea, real m) + Terrarium (land, real m)');
  } else if (emodnetResult) {
    heightValues = emodnetResult.data;
    const { isLand } = emodnetResult;
    for (let i = 0; i < size * size; i++) if (isLand[i]) heightValues[i] = 0;
    isMetric = true;
    dataSource = 'EMODnet';
    smoothHeightmap(heightValues, size, 1);
  } else if (terrariumData) {
    heightValues = terrariumData;
    isMetric = true;
    dataSource = 'Terrarium';
    smoothHeightmap(heightValues, size, 1);
  }

  // Fallback: GEBCO colour image
  if (!heightValues) {
    try {
      setLoadingText('Fetching GEBCO elevation...');
      gebcoImage = await loadImageWithTimeout(gebcoUrl(bounds, size, size), 10000);
      setLoadingText('Processing heightmap...');
      heightValues = parseGebcoHeightmap(gebcoImage, SEGMENTS);
      dataSource = 'GEBCO';
    } catch (err) {
      console.warn('GEBCO failed:', err.message);
    }
  }

  // 3. Procedural
  if (!heightValues) {
    setLoadingText('Generating procedural sea floor...');
    heightValues = generateProceduralHeightmap(SEGMENTS, bounds);
  }

  // --- Fetch textures ---
  try {
    setLoadingText('Fetching satellite imagery...');
    satelliteImage = await loadImageWithTimeout(satelliteUrl(bounds, 512, 512), 10000);
  } catch (_) {}

  if (!gebcoImage) {
    try { gebcoImage = await loadImageWithTimeout(gebcoUrl(bounds, 512, 512), 8000); } catch (_) {}
  }

  setLoadingText('Building 3D mesh...');

  // --- Elevation stats ---
  let minElev = Infinity, maxElev = -Infinity;
  for (let i = 0; i < heightValues.length; i++) {
    if (heightValues[i] < minElev) minElev = heightValues[i];
    if (heightValues[i] > maxElev) maxElev = heightValues[i];
  }
  const elevRange = maxElev - minElev || 1;

  // --- Auto vertical exaggeration ---
  // Target: terrain relief fills ~60% of the horizontal base size for dramatic depth
  let vertExag;
  if (isMetric) {
    const naturalRelief = elevRange * unitsPerMeter;
    const targetRelief = TERRAIN_BASE * 0.6;
    vertExag = Math.min(30, Math.max(2, targetRelief / naturalRelief));
  } else {
    vertExag = 1; // handled differently below
  }

  // --- Build geometry ---
  const geometry = new THREE.PlaneGeometry(terrainWidth, terrainDepth, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position.array;

  if (isMetric) {
    // Direct mapping: elevation (m) → Y (3D units). Sea level = y=0.
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const idx = j * size + i;
        positions[idx * 3 + 1] = heightValues[idx] * unitsPerMeter * vertExag;
      }
    }
  } else {
    // Non-metric: normalize so shallowest ≈ y=0, deepest fills target relief
    const targetRelief = TERRAIN_BASE * 0.4;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const idx = j * size + i;
        const norm = (heightValues[idx] - minElev) / elevRange; // 0=deepest, 1=shallowest
        positions[idx * 3 + 1] = (norm - 1) * targetRelief;
      }
    }
  }

  // UVs
  const uvs = geometry.attributes.uv.array;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const idx = (j * size + i) * 2;
      uvs[idx] = i / (size - 1);
      uvs[idx + 1] = 1 - j / (size - 1);
    }
  }
  geometry.attributes.uv.needsUpdate = true;
  geometry.computeVertexNormals();

  // --- Texture ---
  const texCanvas = document.createElement('canvas');
  texCanvas.width = 512; texCanvas.height = 512;
  const texCtx = texCanvas.getContext('2d');

  if (satelliteImage) {
    texCtx.drawImage(satelliteImage, 0, 0, 512, 512);
    if (gebcoImage) {
      texCtx.globalAlpha = 0.2;
      texCtx.drawImage(gebcoImage, 0, 0, 512, 512);
      texCtx.globalAlpha = 1.0;
    }
  } else if (gebcoImage) {
    texCtx.drawImage(gebcoImage, 0, 0, 512, 512);
  } else {
    const grad = texCtx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#5bbcd6');
    grad.addColorStop(1, '#041830');
    texCtx.fillStyle = grad;
    texCtx.fillRect(0, 0, 512, 512);
  }

  const texture = new THREE.CanvasTexture(texCanvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({
    map: texture, roughness: 0.8, metalness: 0.1, flatShading: false, side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // --- Contour lines (proper marching squares) ---
  const contours = createContourLines(positions, size, 12);
  scene.add(contours);

  // --- Elevation data for accurate depth readout ---
  const _elevations = isMetric ? heightValues : null;

  // Compute Y stats for camera positioning
  let minY = Infinity, maxY = -Infinity, sumY = 0;
  for (let i = 0; i < size * size; i++) {
    const y = positions[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sumY += y;
  }
  const meanY = sumY / (size * size);

  function positionToGeo(pos) {
    const u = (pos.x + terrainWidth / 2) / terrainWidth;
    const v = (pos.z + terrainDepth / 2) / terrainDepth;
    const lat = bounds.maxLat - v * (bounds.maxLat - bounds.minLat);
    const lon = bounds.minLon + u * (bounds.maxLon - bounds.minLon);

    if (_elevations) {
      const gi = u * (size - 1), gj = v * (size - 1);
      const i0 = Math.max(0, Math.min(Math.floor(gi), size - 2));
      const j0 = Math.max(0, Math.min(Math.floor(gj), size - 2));
      const fi = gi - i0, fj = gj - j0;
      const depth =
        _elevations[j0 * size + i0] * (1 - fi) * (1 - fj) +
        _elevations[j0 * size + i0 + 1] * fi * (1 - fj) +
        _elevations[(j0 + 1) * size + i0] * (1 - fi) * fj +
        _elevations[(j0 + 1) * size + i0 + 1] * fi * fj;
      return { lat, lon, depth };
    }
    // Non-metric: estimate from Y position
    return { lat, lon, depth: pos.y / (unitsPerMeter * (vertExag || 1)) };
  }

  function geoToPosition(lat, lon) {
    const u = (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon);
    const v = (bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat);
    const x = u * terrainWidth - terrainWidth / 2;
    const z = v * terrainDepth - terrainDepth / 2;
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(mesh);
    return new THREE.Vector3(x, hits.length > 0 ? hits[0].point.y : 0, z);
  }

  return {
    mesh, bounds,
    terrainWidth, terrainDepth,
    widthM, depthM,
    unitsPerMeter, vertExag,
    minElev: isMetric ? minElev : null,
    maxElev: isMetric ? maxElev : null,
    minY, maxY, meanY,
    positionToGeo, geoToPosition,
    contours, dataSource, _scene: scene,
  };
}

// ===== Overlay =====

export async function applyOverlay(terrain, url, setLoadingText) {
  try {
    if (setLoadingText) setLoadingText('Loading overlay...');
    const img = await loadImageWithTimeout(url, 10000);
    const texture = new THREE.TextureLoader().load(img.src);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    if (!terrain._origMaterial) terrain._origMaterial = terrain.mesh.material;

    const overlayMat = new THREE.MeshStandardMaterial({
      map: texture, transparent: true, opacity: 0.85, roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide,
    });

    if (terrain._overlayMesh) {
      terrain._scene.remove(terrain._overlayMesh);
      terrain._overlayMesh.material.dispose();
    }

    const overlayGeo = terrain.mesh.geometry.clone();
    const pos = overlayGeo.attributes.position.array;
    for (let i = 1; i < pos.length; i += 3) pos[i] += 0.3;
    overlayGeo.attributes.position.needsUpdate = true;

    terrain._overlayMesh = new THREE.Mesh(overlayGeo, overlayMat);
    terrain._scene.add(terrain._overlayMesh);
    if (setLoadingText) setLoadingText('');
  } catch (err) {
    console.warn('Overlay load failed:', err);
    if (setLoadingText) setLoadingText('Overlay failed to load');
  }
}

export function removeOverlay(terrain) {
  if (!terrain._overlayMesh) return;
  terrain._scene.remove(terrain._overlayMesh);
  terrain._overlayMesh.geometry.dispose();
  terrain._overlayMesh.material.dispose();
  if (terrain._overlayMesh.material.map) terrain._overlayMesh.material.map.dispose();
  terrain._overlayMesh = null;
}

export function destroyTerrain(scene, terrain) {
  if (!terrain) return;
  removeOverlay(terrain);
  if (terrain.mesh) {
    scene.remove(terrain.mesh);
    terrain.mesh.geometry.dispose();
    terrain.mesh.material.dispose();
    if (terrain.mesh.material.map) terrain.mesh.material.map.dispose();
  }
  if (terrain.contours) {
    scene.remove(terrain.contours);
    terrain.contours.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
  }
}
