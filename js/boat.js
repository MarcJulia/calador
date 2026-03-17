import * as THREE from 'three';

/**
 * Build an 8m fishing boat mesh group at the given scale.
 * Bow points toward +X (local space).
 */
export function buildBoatMesh(unitsPerMeter) {
  const scale = unitsPerMeter;
  const L = 8 * scale;     // 8m length
  const B = 2.8 * scale;   // 2.8m beam
  const D = 1.2 * scale;   // 1.2m depth
  const CH = 2.0 * scale;  // 2m cabin height

  const boat = new THREE.Group();

  // Hull
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-L / 2, 0);
  hullShape.quadraticCurveTo(-L / 2, B / 2, -L / 4, B / 2);
  hullShape.lineTo(L / 4, B / 2);
  hullShape.quadraticCurveTo(L / 2, B / 3, L / 2, 0);
  hullShape.quadraticCurveTo(L / 2, -B / 3, L / 4, -B / 2);
  hullShape.lineTo(-L / 4, -B / 2);
  hullShape.quadraticCurveTo(-L / 2, -B / 2, -L / 2, 0);

  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: D, bevelEnabled: false });
  hullGeo.rotateX(-Math.PI / 2);
  hullGeo.translate(0, -D / 2, 0);
  boat.add(new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: 0x2266aa, roughness: 0.6, metalness: 0.2 })));

  // Deck
  const deckGeo = new THREE.PlaneGeometry(L * 0.9, B * 0.85);
  deckGeo.rotateX(-Math.PI / 2);
  const deck = new THREE.Mesh(deckGeo, new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.8 }));
  deck.position.y = D / 2 + 0.01 * scale;
  boat.add(deck);

  // Cabin
  const cabinW = L * 0.25, cabinD = B * 0.55;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(cabinW, CH, cabinD),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 })
  );
  cabin.position.set(-L * 0.05, D / 2 + CH / 2, 0);
  boat.add(cabin);

  // Cabin roof
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(cabinW * 1.1, CH * 0.08, cabinD * 1.1),
    new THREE.MeshStandardMaterial({ color: 0x334455 })
  );
  roof.position.set(-L * 0.05, D / 2 + CH + CH * 0.04, 0);
  boat.add(roof);

  // Mast
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02 * scale, 0.02 * scale, CH * 1.5, 6),
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mast.position.set(-L * 0.05, D / 2 + CH + CH * 0.75, 0);
  boat.add(mast);

  // Waterline stripe
  const wlGeo = new THREE.TorusGeometry((L / 2 + B / 2) / 2 * 0.48, 0.015 * scale, 4, 32);
  wlGeo.rotateX(Math.PI / 2);
  const wl = new THREE.Mesh(wlGeo, new THREE.MeshBasicMaterial({ color: 0xcc3333 }));
  wl.position.y = 0;
  wl.scale.set(1.6, 1, 0.6);
  boat.add(wl);

  return boat;
}

/**
 * Creates the static scale-reference boat + label in a corner.
 */
export function createBoat(scene, terrain) {
  const { terrainWidth, terrainDepth, unitsPerMeter } = terrain;
  const scale = unitsPerMeter;
  const L = 8 * scale;
  const CH = 2.0 * scale;

  const boat = buildBoatMesh(unitsPerMeter);
  boat.position.set(terrainWidth / 2 - L * 3, 0.5, -terrainDepth / 2 + L * 3);
  boat.rotation.y = Math.PI * 0.15;
  scene.add(boat);

  // Label sprite
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 256; labelCanvas.height = 64;
  const ctx = labelCanvas.getContext('2d');
  ctx.fillStyle = 'rgba(10, 22, 40, 0.8)';
  ctx.roundRect(0, 0, 256, 64, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(100, 160, 220, 0.5)';
  ctx.lineWidth = 2;
  ctx.roundRect(0, 0, 256, 64, 8);
  ctx.stroke();
  ctx.fillStyle = '#b0d0f0';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('8m Fishing Boat', 128, 28);
  ctx.font = '16px sans-serif';
  ctx.fillStyle = '#7aa0c0';
  ctx.fillText('(for scale)', 128, 50);

  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true }));
  const labelScale = L * 8;
  label.scale.set(labelScale, labelScale * 0.25, 1);
  label.position.copy(boat.position);
  label.position.y += CH * 3;
  scene.add(label);

  return { boat, label };
}
