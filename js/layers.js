/**
 * Overlay layer definitions for the WMS selector.
 * Terrain is always GEBCO (handled in terrain.js).
 * These are overlays projected on top of the 3D mesh.
 */

export const OVERLAY_GROUPS = [
  {
    label: 'Seabed Info',
    layers: [
      {
        id: 'emodnet-contours',
        name: 'Depth Contours',
        description: 'Contour lines at 50, 100, 200, 500m+',
        url: (b, w, h) =>
          `https://ows.emodnet-bathymetry.eu/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=emodnet:contours&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
      {
        id: 'emodnet-substrate',
        name: 'Seabed Substrate',
        description: 'Bottom type: sand, mud, rock, gravel',
        url: (b, w, h) =>
          `https://drive.emodnet-geology.eu/geoserver/gtk/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=seabed_substrate_1m&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
      {
        id: 'emodnet-habitat',
        name: 'Seabed Habitats',
        description: 'Predicted habitat types (EUSeaMap)',
        url: (b, w, h) =>
          `https://ows.emodnet-seabedhabitats.eu/geoserver/emodnet_view/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=eusm2021_eunis2019_group&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
      {
        id: 'undersea-features',
        name: 'Undersea Features',
        description: 'Named canyons, ridges, seamounts',
        url: (b, w, h) =>
          `https://ows.emodnet-bathymetry.eu/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=gebco:undersea_features&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
    ],
  },
  {
    label: 'Satellite & Context',
    layers: [
      {
        id: 'coastline',
        name: 'Coastlines',
        description: 'EMODnet coastline outlines',
        url: (b, w, h) =>
          `https://ows.emodnet-bathymetry.eu/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=coastlines&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
    ],
  },
  {
    label: 'Regulations & Activity',
    layers: [
      {
        id: 'mpa',
        name: 'Protected Areas',
        description: 'Marine protected areas (Barcelona Conv.)',
        url: (b, w, h) =>
          `https://ows.emodnet-humanactivities.eu/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=emodnet:maprotectedareas&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
      {
        id: 'eez',
        name: 'Maritime Boundaries',
        description: 'EEZ, territorial sea limits',
        url: (b, w, h) =>
          `https://geo.vliz.be/geoserver/MarineRegions/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=eez_boundaries&STYLES=&SRS=EPSG:4326&BBOX=${b.minLon},${b.minLat},${b.maxLon},${b.maxLat}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true`,
      },
    ],
  },
];

export function getOverlayById(id) {
  for (const group of OVERLAY_GROUPS) {
    const layer = group.layers.find(l => l.id === id);
    if (layer) return layer;
  }
  return null;
}
