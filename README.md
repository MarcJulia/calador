# Calador

A real-time 3D sea floor explorer for Mediterranean fishing vessels. Built for small boat fishermen operating out of Colonia de Sant Jordi, Mallorca.

## What it does

- **2D map** with configurable grid (500m–5km) covering a 50km fishing range from port
- **3D terrain** of the sea floor using real bathymetry data (EMODnet ~115m resolution + Terrarium elevation)
- **Satellite imagery** draped on the 3D terrain with GEBCO colour blending
- **Live GPS tracking** (simulated) showing vessel position on both 2D and 3D views
- **Marker system** — drop colored pins on the sea floor or at sea level, with substrate type, species, temperature, notes, and custom tags
- **Depth line** — toggle a vertical line from vessel to ocean floor showing real depth
- **Follow mode** — camera auto-follows the vessel across tile boundaries
- **Wide mode** — loads 3x3 neighboring tiles for broader terrain view
- **Edit mode** — box-select multiple markers for bulk deletion
- **Satellite minimap** in the 3D view with vessel tracking and trail
- **WMS overlays** — depth contours, seabed substrate, habitats, protected areas, maritime boundaries

## Data sources

| Source | What | Resolution |
|--------|------|-----------|
| EMODnet WCS | Sea floor depth (meters) | ~115m |
| Terrarium (AWS) | Land elevation (meters) | ~37m |
| GEBCO | Fallback bathymetry | ~450m |
| Esri World Imagery | Satellite texture | varies |
| EMODnet WMS | Overlays (substrate, habitats, contours) | varies |

## Running

Requires the proxy server for EMODnet WCS (bypasses CORS):

```bash
python3 server.py
```

Open http://localhost:8000

## Controls

### 2D Map
- Hover anywhere to see the grid tile outline
- Click a tile to enter 3D view
- Grid size selector in the toolbar (500m, 1km, 2km, 5km)
- Red dot = simulated fishing vessel with trail

### 3D View
- **Orbit** — left-click drag (disabled in edit mode)
- **Zoom** — scroll wheel
- **+ Marker** — click terrain to place markers
- **Edit** — box-select markers, bulk delete
- **Wide** — toggle 3x3 tile view
- **Follow** — auto-follow vessel between tiles
- **Depth** — toggle depth line from vessel to sea floor
- **Speed** — cycle simulation speed (1x, 10x, 30x, 60x, 120x)
- **Layers** — toggle WMS overlays

### Markers
- 8 color options
- Sea Floor or Sea Level placement
- Substrate type, temperature, species, date, notes, tags
- Persisted in localStorage

## Architecture

```
server.py          — Python HTTP server + EMODnet WCS proxy
index.html         — Single page app shell
style.css          — Dark nautical theme
js/
  app.js           — Main controller, view switching, GPS wiring
  terrain.js       — Elevation data fetch (EMODnet/Terrarium/GEBCO), mesh building
  scene.js         — Three.js scene, camera, lighting, controls
  markers.js       — 3D marker system with multi-select
  panel.js         — Marker detail panel with color/placement pickers
  map2d.js         — Leaflet 2D map with hover grid
  boat.js          — Scale-reference fishing boat model
  context.js       — Compass, coordinates, scale bar, water surface
  layers.js        — WMS overlay definitions
  gps.js           — Simulated GPS feed
  data.js          — localStorage persistence
```

## Tech

- [Three.js](https://threejs.org/) — 3D rendering
- [Leaflet](https://leafletjs.com/) — 2D maps
- Vanilla JS, no build step
- Python 3 standard library for the server

## License

MIT
