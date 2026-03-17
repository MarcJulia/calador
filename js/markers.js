import * as THREE from 'three';

const MARKER_RADIUS = 1.2;
const MARKER_HEIGHT = 4;
const MARKER_COLOR = 0x40c0ff;
const DEFAULT_COLOR_HEX = '#40c0ff';
const MARKER_SELECTED_COLOR = 0xff8040;
const MARKER_MULTI_COLOR = 0xffcc00;
const MARKER_HOVER_COLOR = 0x80e0ff;

export function createMarkerSystem(scene, camera, canvas, terrain, controls) {
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const markers = []; // { id, mesh, data }
  let addMode = false;
  let editMode = false;
  let selectedId = null;
  let multiSelected = new Set(); // ids of multi-selected markers
  let hoveredMesh = null;

  // Box select state
  let boxSelecting = false;
  let boxStart = null;
  let boxOverlay = null;

  // Callbacks
  let onMarkerSelect = null;
  let onMarkerDeselect = null;
  let onHoverUpdate = null;
  let onMarkerChange = null;
  let onMultiSelect = null; // called with array of selected ids

  const pinGeometry = createPinGeometry();
  const defaultMaterial = new THREE.MeshStandardMaterial({
    color: MARKER_COLOR, roughness: 0.4, metalness: 0.3,
    emissive: new THREE.Color(MARKER_COLOR), emissiveIntensity: 0.15,
  });

  function createPinGeometry() {
    const sphere = new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
    const stem = new THREE.CylinderGeometry(0.2, 0.2, MARKER_HEIGHT, 8);
    stem.translate(0, -MARKER_HEIGHT / 2, 0);
    return { sphere, stem };
  }

  function createMarkerMesh(position) {
    const group = new THREE.Group();
    const sphereMesh = new THREE.Mesh(pinGeometry.sphere, defaultMaterial.clone());
    sphereMesh.position.y = MARKER_HEIGHT;
    const stemMesh = new THREE.Mesh(pinGeometry.stem, defaultMaterial.clone());
    stemMesh.position.y = MARKER_HEIGHT / 2;
    const ringGeo = new THREE.RingGeometry(1, 2, 24);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: MARKER_COLOR, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
    }));
    ring.position.y = 0.1;
    group.add(sphereMesh, stemMesh, ring);
    group.position.copy(position);
    return group;
  }

  function addMarker(position, data = null) {
    const id = data?.id || crypto.randomUUID();
    const geo = terrain.positionToGeo(position);
    const mesh = createMarkerMesh(position);
    scene.add(mesh);
    const markerData = data || {
      id, lat: parseFloat(geo.lat.toFixed(4)), lon: parseFloat(geo.lon.toFixed(4)),
      depth: parseFloat(geo.depth.toFixed(1)), color: DEFAULT_COLOR_HEX, placement: 'bottom',
      substrate: '', temperature: null,
      species: [], date: new Date().toISOString().split('T')[0], notes: '', tags: {},
      position: { x: position.x, y: position.y, z: position.z },
    };
    // Apply stored color
    if (markerData.color) setMarkerColor(mesh, new THREE.Color(markerData.color).getHex());
    // Apply placement — surface markers sit at y=0
    if (markerData.placement === 'surface') {
      mesh.position.y = Math.max(mesh.position.y, 0);
    }
    markers.push({ id: markerData.id, mesh, data: markerData });
    if (onMarkerChange) onMarkerChange();
    return markerData;
  }

  function removeMarker(id) {
    const idx = markers.findIndex(m => m.id === id);
    if (idx === -1) return;
    scene.remove(markers[idx].mesh);
    markers.splice(idx, 1);
    multiSelected.delete(id);
    if (selectedId === id) { selectedId = null; if (onMarkerDeselect) onMarkerDeselect(); }
    if (onMarkerChange) onMarkerChange();
  }

  function removeMultiSelected() {
    const ids = [...multiSelected];
    ids.forEach(id => removeMarker(id));
    multiSelected.clear();
    if (onMultiSelect) onMultiSelect([]);
    if (onMarkerChange) onMarkerChange();
  }

  function selectMarker(id) {
    if (selectedId) {
      const prev = markers.find(m => m.id === selectedId);
      if (prev && !multiSelected.has(selectedId)) setMarkerColor(prev.mesh, MARKER_COLOR);
    }
    selectedId = id;
    const marker = markers.find(m => m.id === id);
    if (marker) {
      setMarkerColor(marker.mesh, MARKER_SELECTED_COLOR);
      if (onMarkerSelect) onMarkerSelect(marker.data);
    }
  }

  function toggleMultiSelect(id) {
    if (multiSelected.has(id)) {
      multiSelected.delete(id);
      const m = markers.find(m => m.id === id);
      if (m) setMarkerColor(m.mesh, MARKER_COLOR);
    } else {
      multiSelected.add(id);
      const m = markers.find(m => m.id === id);
      if (m) setMarkerColor(m.mesh, MARKER_MULTI_COLOR);
    }
    if (onMultiSelect) onMultiSelect([...multiSelected]);
  }

  function selectAll() {
    markers.forEach(m => {
      multiSelected.add(m.id);
      setMarkerColor(m.mesh, MARKER_MULTI_COLOR);
    });
    if (onMultiSelect) onMultiSelect([...multiSelected]);
  }

  function deselectAll() {
    if (selectedId) {
      const prev = markers.find(m => m.id === selectedId);
      if (prev) setMarkerColor(prev.mesh, MARKER_COLOR);
      selectedId = null;
    }
    multiSelected.forEach(id => {
      const m = markers.find(m => m.id === id);
      if (m) setMarkerColor(m.mesh, MARKER_COLOR);
    });
    multiSelected.clear();
    if (onMarkerDeselect) onMarkerDeselect();
    if (onMultiSelect) onMultiSelect([]);
  }

  function setMarkerColor(group, color) {
    group.children.forEach(child => {
      if (child.material && child.material.color) {
        child.material.color.setHex(color);
        if (child.material.emissive) child.material.emissive.setHex(color);
      }
    });
  }

  // Box select: find markers whose screen position is inside the rectangle
  function boxSelectMarkers(x1, y1, x2, y2) {
    const rect = canvas.getBoundingClientRect();
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);

    markers.forEach(m => {
      // Project marker world position to screen
      const worldPos = new THREE.Vector3();
      m.mesh.getWorldPosition(worldPos);
      worldPos.y += MARKER_HEIGHT; // top of pin
      worldPos.project(camera);

      const sx = (worldPos.x * 0.5 + 0.5) * rect.width;
      const sy = (-worldPos.y * 0.5 + 0.5) * rect.height;

      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        multiSelected.add(m.id);
        setMarkerColor(m.mesh, MARKER_MULTI_COLOR);
      }
    });
    if (onMultiSelect) onMultiSelect([...multiSelected]);
  }

  function repositionMarker(id) {
    const marker = markers.find(m => m.id === id);
    if (!marker) return;
    const pos = terrain.geoToPosition(marker.data.lat, marker.data.lon);
    if (marker.data.placement === 'surface') {
      marker.mesh.position.set(pos.x, Math.max(pos.y, 0), pos.z);
    } else {
      marker.mesh.position.copy(pos);
    }
    marker.data.position = { x: marker.mesh.position.x, y: marker.mesh.position.y, z: marker.mesh.position.z };
    if (onMarkerChange) onMarkerChange();
  }

  function setMarkerColorByData(id, colorHex) {
    const marker = markers.find(m => m.id === id);
    if (marker) setMarkerColor(marker.mesh, new THREE.Color(colorHex).getHex());
  }

  function updateMarkerData(id, newData) {
    const marker = markers.find(m => m.id === id);
    if (marker) { Object.assign(marker.data, newData); if (onMarkerChange) onMarkerChange(); }
  }

  function getAllData() { return markers.map(m => ({ ...m.data })); }

  function loadMarkers(dataArray) {
    markers.forEach(m => scene.remove(m.mesh));
    markers.length = 0;
    selectedId = null;
    multiSelected.clear();
    dataArray.forEach(data => {
      let pos;
      if (data.position) pos = new THREE.Vector3(data.position.x, data.position.y, data.position.z);
      else pos = terrain.geoToPosition(data.lat, data.lon);
      addMarker(pos, data);
    });
  }

  function focusMarker(id) { selectMarker(id); }

  // --- Mouse handling ---
  function getMouseNDC(event) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function getTerrainIntersection(event) {
    getMouseNDC(event);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(terrain.mesh);
    return hits.length > 0 ? hits[0] : null;
  }

  function getMarkerIntersection(event) {
    getMouseNDC(event);
    raycaster.setFromCamera(mouse, camera);
    const meshes = markers.flatMap(m => m.mesh.children);
    const hits = raycaster.intersectObjects(meshes);
    if (hits.length > 0) {
      const hitObj = hits[0].object;
      return markers.find(m => m.mesh.children.includes(hitObj)) || null;
    }
    return null;
  }

  // Create box select overlay
  function createBoxOverlay() {
    if (boxOverlay) return;
    boxOverlay = document.createElement('div');
    boxOverlay.id = 'box-select';
    boxOverlay.style.cssText = 'position:absolute;border:2px dashed #ffcc00;background:rgba(255,204,0,0.1);pointer-events:none;display:none;z-index:50;';
    canvas.parentElement.appendChild(boxOverlay);
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!editMode || e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    boxStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    boxSelecting = false;
    createBoxOverlay();
    // Disable orbit controls so drag = box select, not rotate
    if (controls) controls.enabled = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    // Box select drag
    if (editMode && boxStart) {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const dx = Math.abs(cx - boxStart.x), dy = Math.abs(cy - boxStart.y);
      if (dx > 5 || dy > 5) {
        boxSelecting = true;
        if (boxOverlay) {
          boxOverlay.style.display = 'block';
          boxOverlay.style.left = Math.min(boxStart.x, cx) + 'px';
          boxOverlay.style.top = Math.min(boxStart.y, cy) + 'px';
          boxOverlay.style.width = dx + 'px';
          boxOverlay.style.height = dy + 'px';
        }
      }
      return;
    }

    // Normal hover
    const hit = getTerrainIntersection(e);
    if (hit && onHoverUpdate) onHoverUpdate(terrain.positionToGeo(hit.point));

    const markerHit = getMarkerIntersection(e);
    if (markerHit && markerHit.id !== selectedId && !multiSelected.has(markerHit.id)) {
      if (hoveredMesh && hoveredMesh !== markerHit.mesh) {
        const prev = markers.find(m => m.mesh === hoveredMesh);
        if (prev && prev.id !== selectedId && !multiSelected.has(prev.id)) setMarkerColor(hoveredMesh, MARKER_COLOR);
      }
      setMarkerColor(markerHit.mesh, MARKER_HOVER_COLOR);
      hoveredMesh = markerHit.mesh;
      canvas.style.cursor = 'pointer';
    } else {
      if (hoveredMesh) {
        const prev = markers.find(m => m.mesh === hoveredMesh);
        if (prev && prev.id !== selectedId && !multiSelected.has(prev.id)) setMarkerColor(hoveredMesh, MARKER_COLOR);
        hoveredMesh = null;
      }
      canvas.style.cursor = editMode ? 'crosshair' : (addMode ? 'crosshair' : 'grab');
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    // Re-enable orbit controls
    if (controls) controls.enabled = true;

    if (editMode && boxSelecting && boxStart) {
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      boxSelectMarkers(boxStart.x, boxStart.y, cx, cy);
      if (boxOverlay) boxOverlay.style.display = 'none';
      boxStart = null;
      boxSelecting = false;
      return;
    }
    boxStart = null;
    boxSelecting = false;
    if (boxOverlay) boxOverlay.style.display = 'none';
  });

  canvas.addEventListener('click', (e) => {
    if (boxSelecting) return; // was a drag, not a click

    const markerHit = getMarkerIntersection(e);

    if (editMode) {
      if (markerHit) {
        toggleMultiSelect(markerHit.id);
      }
      return;
    }

    if (markerHit) { selectMarker(markerHit.id); return; }
    if (addMode) {
      const hit = getTerrainIntersection(e);
      if (hit) { const data = addMarker(hit.point); selectMarker(data.id); }
    }
  });

  return {
    addMarker, removeMarker, removeMultiSelected,
    selectMarker, toggleMultiSelect, selectAll, deselectAll,
    updateMarkerData, setMarkerColorByData, repositionMarker, getAllData, loadMarkers, focusMarker, boxSelectMarkers,
    get markers() { return markers; },
    get multiSelected() { return multiSelected; },
    get addMode() { return addMode; },
    set addMode(v) { addMode = v; canvas.style.cursor = v ? 'crosshair' : 'grab'; },
    get editMode() { return editMode; },
    set editMode(v) { editMode = v; canvas.style.cursor = v ? 'crosshair' : 'grab'; if (!v) deselectAll(); },
    set onMarkerSelect(fn) { onMarkerSelect = fn; },
    set onMarkerDeselect(fn) { onMarkerDeselect = fn; },
    set onHoverUpdate(fn) { onHoverUpdate = fn; },
    set onMarkerChange(fn) { onMarkerChange = fn; },
    set onMultiSelect(fn) { onMultiSelect = fn; },
  };
}
