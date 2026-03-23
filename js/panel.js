export function createPanel(markerSystem) {
  const panel = document.getElementById('panel');
  const panelTitle = document.getElementById('panel-title');
  const btnClose = document.getElementById('panel-close');
  const btnSave = document.getElementById('btn-save');
  const btnDelete = document.getElementById('btn-delete');
  const btnNavigate = document.getElementById('btn-navigate');
  const btnAddTag = document.getElementById('btn-add-tag');
  const tagsContainer = document.getElementById('tags-container');
  const tagKeyInput = document.getElementById('tag-key');
  const tagValueInput = document.getElementById('tag-value');
  const colorPicker = document.getElementById('color-picker');
  const placementPicker = document.getElementById('placement-picker');
  const placementBtns = placementPicker.querySelectorAll('.placement-btn');

  const fieldName = document.getElementById('field-name');
  const fieldLat = document.getElementById('field-lat');
  const fieldLon = document.getElementById('field-lon');
  const fieldDepth = document.getElementById('field-depth');
  const fieldSubstrate = document.getElementById('field-substrate');
  const fieldTemp = document.getElementById('field-temp');
  const fieldSpecies = document.getElementById('field-species');
  const fieldDate = document.getElementById('field-date');
  const fieldNotes = document.getElementById('field-notes');

  let currentId = null;
  let currentTags = {};
  let currentColor = '#40c0ff';
  let currentPlacement = 'bottom';
  let currentData = null;
  let onNavigate = null;

  // Placement toggle
  placementBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      currentPlacement = btn.dataset.placement;
      placementBtns.forEach(b => b.classList.toggle('active', b === btn));
      if (currentId) {
        markerSystem.updateMarkerData(currentId, { placement: currentPlacement });
        markerSystem.repositionMarker(currentId);
      }
    });
  });

  // Color swatch clicks
  colorPicker.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      currentColor = swatch.dataset.color;
      setActiveColor(currentColor);
      // Live-update the marker color immediately
      if (currentId) {
        markerSystem.updateMarkerData(currentId, { color: currentColor });
        markerSystem.setMarkerColorByData(currentId, currentColor);
      }
    });
  });

  function setActiveColor(color) {
    colorPicker.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });
  }

  function show(data) {
    currentId = data.id;
    currentData = data;
    currentTags = { ...(data.tags || {}) };
    currentColor = data.color || '#40c0ff';
    currentPlacement = data.placement || 'bottom';

    panelTitle.textContent = data.name || `Marker ${data.lat.toFixed(2)}°, ${data.lon.toFixed(2)}°`;
    fieldName.value = data.name || '';
    fieldLat.value = data.lat;
    fieldLon.value = data.lon;
    fieldDepth.value = data.depth;
    fieldSubstrate.value = data.substrate || '';
    fieldTemp.value = data.temperature ?? '';
    fieldSpecies.value = (data.species || []).join(', ');
    fieldDate.value = data.date || '';
    fieldNotes.value = data.notes || '';

    setActiveColor(currentColor);
    placementBtns.forEach(b => b.classList.toggle('active', b.dataset.placement === currentPlacement));
    renderTags();
    panel.classList.remove('hidden');
  }

  function hide() {
    panel.classList.add('hidden');
    currentId = null;
  }

  function renderTags() {
    tagsContainer.innerHTML = '';
    for (const [key, value] of Object.entries(currentTags)) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = `<strong>${esc(key)}:</strong> ${esc(value)} <span class="tag-remove" data-key="${esc(key)}">&times;</span>`;
      tagsContainer.appendChild(tag);
    }
    tagsContainer.querySelectorAll('.tag-remove').forEach(el => {
      el.addEventListener('click', () => {
        delete currentTags[el.dataset.key];
        renderTags();
      });
    });
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function collectData() {
    return {
      name: fieldName.value.trim() || '',
      color: currentColor,
      placement: currentPlacement,
      substrate: fieldSubstrate.value,
      temperature: fieldTemp.value ? parseFloat(fieldTemp.value) : null,
      species: fieldSpecies.value
        ? fieldSpecies.value.split(',').map(s => s.trim()).filter(Boolean)
        : [],
      date: fieldDate.value,
      notes: fieldNotes.value,
      tags: { ...currentTags },
    };
  }

  btnClose.addEventListener('click', () => { hide(); markerSystem.deselectAll(); });

  btnSave.addEventListener('click', () => {
    if (!currentId) return;
    markerSystem.updateMarkerData(currentId, collectData());
    btnSave.textContent = 'Saved!';
    setTimeout(() => { btnSave.textContent = 'Save'; }, 1000);
  });

  btnDelete.addEventListener('click', () => {
    if (!currentId) return;
    if (confirm('Delete this marker?')) { markerSystem.removeMarker(currentId); hide(); }
  });

  btnNavigate.addEventListener('click', () => {
    if (!currentData || !onNavigate) return;
    onNavigate(currentData);
    btnNavigate.textContent = 'Added!';
    setTimeout(() => { btnNavigate.textContent = 'Navigate'; }, 1000);
  });

  btnAddTag.addEventListener('click', () => {
    const key = tagKeyInput.value.trim();
    const value = tagValueInput.value.trim();
    if (key) { currentTags[key] = value; renderTags(); tagKeyInput.value = ''; tagValueInput.value = ''; }
  });

  tagKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tagValueInput.focus(); });
  tagValueInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnAddTag.click(); });

  return {
    show, hide,
    set onNavigate(fn) { onNavigate = fn; },
  };
}

export function createMarkerList(markerSystem) {
  const listEl = document.getElementById('marker-list');
  const itemsEl = document.getElementById('marker-list-items');
  const countEl = document.getElementById('marker-count');
  const btnToggle = document.getElementById('btn-toggle-list');

  let visible = false;

  btnToggle.addEventListener('click', () => {
    visible = !visible;
    listEl.classList.toggle('hidden', !visible);
    btnToggle.classList.toggle('active', visible);
    if (visible) refresh();
  });

  function refresh() {
    const data = markerSystem.getAllData();
    countEl.textContent = data.length;
    itemsEl.innerHTML = '';
    data.forEach(d => {
      const item = document.createElement('div');
      item.className = 'marker-list-item';
      item.innerHTML = `
        <div>${d.substrate || 'Unclassified'}</div>
        <div class="marker-item-coords">${d.lat.toFixed(3)}°N, ${d.lon.toFixed(3)}°E · ${d.depth.toFixed(0)}m</div>
      `;
      item.addEventListener('click', () => markerSystem.focusMarker(d.id));
      itemsEl.appendChild(item);
    });
  }

  return { refresh, get visible() { return visible; } };
}
