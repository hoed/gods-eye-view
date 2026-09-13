import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const AUSTIN = [30.2672, -97.7431];
const REFRESH_MS = 30000;

function markerIcon(kind) {
  const colors = { aircraft: '#f5c542', vessel: '#39ffd5', camera: '#ff6b5b' };
  const symbols = { aircraft: '✈', vessel: '◆', camera: '●' };
  return L.divIcon({
    className: 'gev-leaflet-marker',
    html: `<span style="--marker-color:${colors[kind] || '#fff'}">${symbols[kind] || '•'}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function aircraftRows(payload) {
  return (Array.isArray(payload?.states) ? payload.states : [])
    .map((state) => ({
      id: String(state?.[0] || ''),
      callsign: String(state?.[1] || '').trim(),
      lon: finite(state?.[5]),
      lat: finite(state?.[6]),
      altitude: finite(state?.[7]),
      speed: finite(state?.[9]),
      track: finite(state?.[10]),
    }))
    .filter((row) => row.id && row.lat !== null && row.lon !== null);
}

function vesselRows(payload) {
  return (Array.isArray(payload?.rows) ? payload.rows : [])
    .map((row) => ({
      id: String(row?.mmsi || row?.id || ''),
      name: String(row?.name || '').trim(),
      lat: finite(row?.lat),
      lon: finite(row?.lon),
      speed: finite(row?.speed),
      course: finite(row?.course),
    }))
    .filter((row) => row.id && row.lat !== null && row.lon !== null);
}

function cameraRows(payload) {
  return (Array.isArray(payload?.sources) ? payload.sources : [])
    .map((camera) => ({
      id: String(camera?.id || ''),
      name: String(camera?.name || camera?.city || 'CCTV').trim(),
      lat: finite(camera?.lat),
      lon: finite(camera?.lon),
    }))
    .filter((row) => row.id && row.lat !== null && row.lon !== null);
}

function upsertMarkers(layer, rows, kind, label) {
  const seen = new Set();
  const markers = layer._gevMarkers || (layer._gevMarkers = new Map());
  for (const row of rows) {
    seen.add(row.id);
    let marker = markers.get(row.id);
    if (!marker) {
      marker = L.marker([row.lat, row.lon], { icon: markerIcon(kind), keyboard: false });
      marker.options.id = row.id;
      marker.addTo(layer);
      markers.set(row.id, marker);
    } else {
      marker.setLatLng([row.lat, row.lon]);
    }
    const details = kind === 'aircraft'
      ? `${row.callsign || row.id}<br>ALT ${Math.round(row.altitude || 0)} m`
      : kind === 'vessel'
        ? `${row.name || row.id}<br>SPEED ${Math.round(row.speed || 0)} kt`
        : row.name;
    marker.bindTooltip(`${label}: ${details}`, { direction: 'top', opacity: 0.9 });
  }
  layer.eachLayer((marker) => {
    if (!seen.has(marker.options.id)) {
      layer.removeLayer(marker);
      markers.delete(marker.options.id);
    }
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

/**
 * Keyless map fallback used only when Cesium cannot create a WebGL context.
 * It consumes the same server feeds as the production Cesium layers.
 */
export function startLeafletFallback({ container = document.getElementById('cesiumContainer'), status } = {}) {
  if (!container) throw new Error('Map container is missing');
  container.replaceChildren();
  container.classList.add('gev-leaflet-container');
  const map = L.map(container, { zoomControl: false, preferCanvas: true }).setView(AUSTIN, 5);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const aircraft = L.layerGroup().addTo(map);
  const vessels = L.layerGroup().addTo(map);
  const cameras = L.layerGroup().addTo(map);
  L.control.layers(null, {
    'Pesawat': aircraft,
    'Kapal': vessels,
    'CCTV / Kamera': cameras,
  }, { position: 'topright', collapsed: false }).addTo(map);

  let stopped = false;
  const refresh = async () => {
    const [flightResult, vesselResult, cameraResult] = await Promise.allSettled([
      fetchJson('/api/opensky'),
      fetchJson('/api/ais-live'),
      fetchJson('/api/cctv/sources'),
    ]);
    if (stopped) return;
    if (flightResult.status === 'fulfilled') upsertMarkers(aircraft, aircraftRows(flightResult.value), 'aircraft', 'Pesawat');
    if (vesselResult.status === 'fulfilled') upsertMarkers(vessels, vesselRows(vesselResult.value), 'vessel', 'Kapal');
    if (cameraResult.status === 'fulfilled') upsertMarkers(cameras, cameraRows(cameraResult.value), 'camera', 'Kamera');
    if (status) status.textContent = `LEAFLET FALLBACK · ${aircraft.getLayers().length} pesawat · ${vessels.getLayers().length} kapal · ${cameras.getLayers().length} kamera`;
  };
  void refresh();
  const timer = window.setInterval(refresh, REFRESH_MS);
  return {
    map,
    stop() {
      stopped = true;
      window.clearInterval(timer);
      map.remove();
    },
  };
}
