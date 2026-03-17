import * as THREE from 'three';

/**
 * Adds orientation and location context to the 3D scene:
 * - Compass rose (N/S/E/W labels at terrain edges)
 * - Coordinate labels along edges
 * - Scale bar
 * - Semi-transparent water surface plane at y=0
 *
 * @param {Object} terrain - terrain object returned by createTerrain
 */
export function addContext(scene, terrain) {
  const { bounds, terrainWidth, terrainDepth, widthM, depthM } = terrain;
  const group = new THREE.Group();

  // --- Water surface at y=0 (sea level) ---
  const waterGeo = new THREE.PlaneGeometry(terrainWidth * 1.5, terrainDepth * 1.5);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1a4a6e, transparent: true, opacity: 0.35,
    roughness: 0.2, metalness: 0.4, side: THREE.DoubleSide,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = 0.05;
  group.add(water);

  // --- Compass labels ---
  const compassLabels = [
    { text: 'N', x: 0, z: -terrainDepth / 2 - 8, color: '#ff6644' },
    { text: 'S', x: 0, z: terrainDepth / 2 + 8, color: '#b0d0f0' },
    { text: 'E', x: terrainWidth / 2 + 8, z: 0, color: '#b0d0f0' },
    { text: 'W', x: -terrainWidth / 2 - 8, z: 0, color: '#b0d0f0' },
  ];

  compassLabels.forEach(({ text, x, z, color }) => {
    const sprite = makeTextSprite(text, {
      fontSize: 48, fontWeight: 'bold', color,
      bgColor: 'rgba(10, 22, 40, 0.7)', width: 80, height: 64,
    });
    sprite.position.set(x, 10, z);
    sprite.scale.set(12, 10, 1);
    group.add(sprite);
  });

  // --- Edge coordinate labels ---
  const steps = 5;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lon = bounds.minLon + t * (bounds.maxLon - bounds.minLon);
    const x = -terrainWidth / 2 + t * terrainWidth;
    const sprite = makeTextSprite(`${lon.toFixed(3)}°E`, {
      fontSize: 20, color: '#6a8aa8',
      bgColor: 'rgba(10, 22, 40, 0.5)', width: 140, height: 32,
    });
    sprite.position.set(x, 6, -terrainDepth / 2 - 3);
    sprite.scale.set(8, 2, 1);
    group.add(sprite);
  }

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = bounds.maxLat - t * (bounds.maxLat - bounds.minLat);
    const z = -terrainDepth / 2 + t * terrainDepth;
    const sprite = makeTextSprite(`${lat.toFixed(3)}°N`, {
      fontSize: 20, color: '#6a8aa8',
      bgColor: 'rgba(10, 22, 40, 0.5)', width: 140, height: 32,
    });
    sprite.position.set(-terrainWidth / 2 - 6, 6, z);
    sprite.scale.set(8, 2, 1);
    group.add(sprite);
  }

  // --- Scale bar (1km or adaptive) ---
  const scaleM = widthM > 3000 ? 1000 : widthM > 800 ? 500 : 100;
  const scaleLabel = scaleM >= 1000 ? `${scaleM / 1000} km` : `${scaleM}m`;
  const barLengthUnits = (scaleM / widthM) * terrainWidth;
  const barY = 4;
  const barZ = terrainDepth / 2 + 5;

  const barGeo = new THREE.BoxGeometry(barLengthUnits, 0.3, 0.3);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const bar = new THREE.Mesh(barGeo, barMat);
  bar.position.set(-terrainWidth / 2 + barLengthUnits / 2 + 5, barY, barZ);
  group.add(bar);

  const tickGeo = new THREE.BoxGeometry(0.3, 2, 0.3);
  const tick1 = new THREE.Mesh(tickGeo, barMat);
  tick1.position.set(-terrainWidth / 2 + 5, barY, barZ);
  group.add(tick1);
  const tick2 = new THREE.Mesh(tickGeo, barMat);
  tick2.position.set(-terrainWidth / 2 + 5 + barLengthUnits, barY, barZ);
  group.add(tick2);

  const scaleSpr = makeTextSprite(scaleLabel, {
    fontSize: 24, color: '#ffffff',
    bgColor: 'rgba(10, 22, 40, 0.6)', width: 80, height: 36,
  });
  scaleSpr.position.set(-terrainWidth / 2 + 5 + barLengthUnits / 2, barY + 3, barZ);
  scaleSpr.scale.set(6, 2.5, 1);
  group.add(scaleSpr);

  // --- Tile border outline ---
  const edgeGeo = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(terrainWidth, 0.1, terrainDepth)
  );
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x4080b0, transparent: true, opacity: 0.5 });
  const edgeLine = new THREE.LineSegments(edgeGeo, edgeMat);
  edgeLine.position.y = 1;
  group.add(edgeLine);

  scene.add(group);
  return group;
}

function makeTextSprite(text, opts = {}) {
  const {
    fontSize = 28, fontWeight = 'normal', color = '#ffffff',
    bgColor = 'rgba(0,0,0,0.5)', width = 128, height = 48,
  } = opts;

  const canvas = document.createElement('canvas');
  canvas.width = width * 2; canvas.height = height * 2;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = bgColor;
  ctx.roundRect(0, 0, canvas.width, canvas.height, 8);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.font = `${fontWeight} ${fontSize * 2}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  return new THREE.Sprite(material);
}
