const STORAGE_KEY = 'seafloor-markers';

export function saveToStorage(markers) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

export function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const markers = JSON.parse(raw);
      if (Array.isArray(markers)) return markers;
    }
  } catch (e) {
    console.warn('localStorage load failed:', e);
  }
  return [];
}

export function exportJSON(markers, bounds) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    region: {
      bounds: [bounds.minLat, bounds.minLon, bounds.maxLat, bounds.maxLon],
      source: 'Terrarium / Mediterranean Sea',
    },
    markers,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `seafloor-data-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.markers || !Array.isArray(data.markers)) {
          reject(new Error('Invalid file: missing markers array'));
          return;
        }
        resolve(data);
      } catch (e) {
        reject(new Error('Invalid JSON file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
