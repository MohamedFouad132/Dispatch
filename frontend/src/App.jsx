import { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import './App.css';

// --------------------------------------------------------------
// Helper functions
// --------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

const sevCol = (s) => {
  if (s >= 0.90) return '#dc2626';
  if (s >= 0.78) return '#f97316';
  if (s >= 0.65) return '#f59e0b';
  if (s >= 0.50) return '#eab308';
  if (s >= 0.35) return '#84cc16';
  return '#16a34a';
};

const calcThreat = (incidents) => {
  const crit = incidents.filter(x => x.severity >= 0.85).length;
  const high = incidents.filter(x => x.severity >= 0.65 && x.severity < 0.85).length;
  const mod  = incidents.filter(x => x.severity >= 0.45 && x.severity < 0.65).length;
  const score = crit * 3 + high * 1.5 + mod * 0.5;
  if (crit === 0 && score < 2)  return { level: 'low',      label: 'THREAT: LOW' };
  if (crit === 0 && score < 5)  return { level: 'guarded',  label: 'THREAT: GUARDED' };
  if (crit <= 2  && score < 12) return { level: 'elevated', label: 'THREAT: ELEVATED' };
  if (crit <= 4  && score < 22) return { level: 'high',     label: 'THREAT: HIGH' };
  return { level: 'critical', label: 'THREAT: CRITICAL' };
};

let VEHICLES             = [];
let HOSPITALS            = [];
let SHELTERS             = [];
let SOCIAL_POSTS         = [];
let SATELLITE_DETECTIONS = [];
let CALL_TRANSCRIPTS     = [];

async function loadSimulationData() {
  const res  = await fetch('/simulation.json');
  const data = await res.json();
  const resources = data.resources || {};
  const stationNames = {
    ambulance: ['Station 1 - Downtown', 'Station 2 - Seminole Hts', 'Station 3 - South Tampa'],
    firetruck: ['Fire Station 1 - Downtown', 'Fire Station 2 - Seminole Heights', 'Fire Station 3 - South Tampa'],
    police:    ['Precinct A - Kennedy', 'Precinct B - Howard Ave', 'Precinct C - North Tampa'],
  };
  const counters = { ambulance: 0, firetruck: 0, police: 0 };
  VEHICLES = [
    ...(resources.ambulances || []),
    ...(resources.firetrucks || []),
    ...(resources.police     || []),
  ].map(v => {
    const type = v.type;
    const idx  = counters[type] ?? 0;
    counters[type] = idx + 1;
    return {
      id: v.id, type,
      emoji: v.emoji,
      lat: v.lat, lon: v.lon,
      label: v.id,
      station: (stationNames[type] || [])[idx] || v.id,
    };
  });
  HOSPITALS            = (data.hospitals            || []).map(h => ({ name: h.name, lat: h.lat, lon: h.lon, status: h.status }));
  SHELTERS             = (data.shelters             || []).map(s => ({ name: s.name, lat: s.lat, lon: s.lon, capacity: s.capacity, available: s.available }));
  SOCIAL_POSTS         = data.social_posts         || [];
  SATELLITE_DETECTIONS = data.satellite_detections || [];
  CALL_TRANSCRIPTS     = data.call_transcripts     || [];
  return data;
}

const getVehicleColor = (type) => {
  if (type === 'ambulance') return '#16a34a';
  if (type === 'firetruck') return '#ef4444';
  if (type === 'police')    return '#3b82f6';
  return '#f59e0b';
};

function computeSeverity(text) {
  const lower = text.toLowerCase();
  if (lower.includes('trapped') || lower.includes('collapse') || lower.includes('explosion')) return 0.95;
  if (lower.includes('fire')    || lower.includes('flood')    || lower.includes('rising'))    return 0.85;
  if (lower.includes('injury')  || lower.includes('car')      || lower.includes('pileup'))    return 0.75;
  if (lower.includes('medical') || lower.includes('insulin'))                                 return 0.70;
  if (lower.includes('power')   || lower.includes('stranded'))                                return 0.65;
  return 0.50;
}

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function travelTime(distKm) {
  return (distKm / 50) * 60;
}

function buildInitialRoutes(incidents, vehicles) {
  if (!incidents.length) return [];
  const routes = vehicles.map(veh => ({
    vehicleId: veh.id, type: veh.type,
    startLat: veh.lat, startLon: veh.lon, stops: [],
  }));
  incidents.forEach(inc => {
    let minDist = Infinity, bestVeh = 0;
    vehicles.forEach((veh, idx) => {
      const d = distance(inc.lat, inc.lon, veh.lat, veh.lon);
      if (d < minDist) { minDist = d; bestVeh = idx; }
    });
    routes[bestVeh].stops.push({ incidentId: inc.id, lat: inc.lat, lon: inc.lon, severity: inc.severity, text: inc.text });
  });
  routes.forEach(route => {
    if (!route.stops.length) return;
    const ordered = [];
    let current = { lat: route.startLat, lon: route.startLon };
    const remaining = [...route.stops];
    while (remaining.length) {
      let nearestIdx = 0, nearestDist = distance(current.lat, current.lon, remaining[0].lat, remaining[0].lon);
      for (let i = 1; i < remaining.length; i++) {
        const d = distance(current.lat, current.lon, remaining[i].lat, remaining[i].lon);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      ordered.push(remaining[nearestIdx]);
      current = remaining[nearestIdx];
      remaining.splice(nearestIdx, 1);
    }
    route.stops = ordered;
  });
  routes.forEach(route => {
    if (route.type === 'ambulance' && route.stops.length) {
      const last = route.stops[route.stops.length - 1];
      let best = HOSPITALS[0], bestD = distance(last.lat, last.lon, best.lat, best.lon);
      for (let i = 1; i < HOSPITALS.length; i++) {
        const d = distance(last.lat, last.lon, HOSPITALS[i].lat, HOSPITALS[i].lon);
        if (d < bestD) { bestD = d; best = HOSPITALS[i]; }
      }
      route.stops.push({ incidentId: `hospital-${best.name}`, lat: best.lat, lon: best.lon, severity: 0, text: `Hospital: ${best.name}` });
    } else if (route.type === 'police' && route.stops.length) {
      const last = route.stops[route.stops.length - 1];
      let best = SHELTERS[0], bestD = distance(last.lat, last.lon, best.lat, best.lon);
      for (let i = 1; i < SHELTERS.length; i++) {
        const d = distance(last.lat, last.lon, SHELTERS[i].lat, SHELTERS[i].lon);
        if (d < bestD) { bestD = d; best = SHELTERS[i]; }
      }
      route.stops.push({ incidentId: `shelter-${best.name}`, lat: best.lat, lon: best.lon, severity: 0, text: `Shelter: ${best.name}` });
    }
  });
  return routes;
}

async function fetchRoadRoute(waypoints) {
  if (waypoints.length < 2) return null;
  const coords = waypoints.map(wp => `${wp.lon},${wp.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    const route    = data.routes[0];
    const geometry = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);
    return { geometry, distance: route.distance / 1000, duration: route.duration / 60 };
  } catch (err) {
    return null;
  }
}

async function buildFullRoute(start, stops) {
  if (!stops.length) return null;
  const waypoints  = [start, ...stops];
  const roadRoute  = await fetchRoadRoute(waypoints);
  if (roadRoute) return roadRoute;
  const straightGeo = waypoints.map(wp => [wp.lat, wp.lon]);
  let straightDist  = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    straightDist += distance(waypoints[i].lat, waypoints[i].lon, waypoints[i+1].lat, waypoints[i+1].lon);
  }
  return {
    geometry: straightGeo,
    distance: straightDist,
    duration: travelTime(straightDist),
  };
}

// ─── Navigation View (static, pre-dispatch) ───────────────────────────────────
function NavView({ vehicleId, vehicleData, routeData, routeStops, onClose }) {
  const navMapInstanceRef = useRef(null);
  const color = getVehicleColor(vehicleData.type);

  useEffect(() => {
    if (navMapInstanceRef.current) return;
    const map = L.map('nav-map', { zoomControl: false, attributionControl: false });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors, © CartoDB', maxZoom: 19,
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    if (routeData?.geometry?.length) {
      const latlngs = routeData.geometry;
      L.polyline(latlngs, { color: '#000', weight: 10, opacity: 0.25 }).addTo(map);
      L.polyline(latlngs, { color, weight: 6, opacity: 1 }).addTo(map);
      map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });
    } else {
      map.setView([vehicleData.lat, vehicleData.lon], 14);
    }

    // Vehicle start marker
    const vehHtml = `<div class="nav-vehicle-marker" style="border-color:${color}"><span>${vehicleData.emoji}</span></div>`;
    const vehIcon = L.divIcon({ className: '', html: vehHtml, iconSize: [48, 48], iconAnchor: [24, 24] });
    L.marker([vehicleData.lat, vehicleData.lon], { icon: vehIcon }).addTo(map);

    // Stop markers — numbered, incident stops only
    const allStops      = routeStops || [];
    const incidentStops = allStops.filter(s => s.severity > 0);
    allStops.forEach((stop, idx) => {
      if (stop.severity === 0) return;
      const stopNum = incidentStops.indexOf(stop) + 1;
      const col     = sevCol(stop.severity);
      let offsetLat = stop.lat, offsetLon = stop.lon;
      if (idx > 0) {
        const prev = allStops[idx - 1];
        if (distance(prev.lat, prev.lon, stop.lat, stop.lon) < 0.01) {
          offsetLat += 0.00015 * idx;
          offsetLon += 0.00015 * idx;
        }
      }
      const html = `<div class="nav-stop-marker" style="background:${col};border-color:${col}"><span>${stopNum}</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([offsetLat, offsetLon], { icon }).addTo(map);
    });

    // Endpoint marker
    const endpoint = routeData?.endpoint;
    if (endpoint) {
      const ec   = endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6';
      const eHtml = `<div class="nav-endpoint-marker" style="background:${ec};border-color:${ec}">🚩</div>`;
      L.marker([endpoint.lat, endpoint.lon], { icon: L.divIcon({ className: '', html: eHtml, iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(map);
    }

    // Hospital / shelter markers
    HOSPITALS.forEach(h => {
      const html = `<div class="facility-emoji-marker hospital-emoji-marker"><span>🏥</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([h.lat, h.lon], { icon })
        .bindTooltip(`<b>🏥 ${h.name}</b>${h.status ? `<br><span style="color:#4ade80;font-size:10px">${h.status}</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
        .addTo(map);
    });
    SHELTERS.forEach(s => {
      const pct  = s.capacity ? Math.round((s.available / s.capacity) * 100) : null;
      const html = `<div class="facility-emoji-marker shelter-emoji-marker"><span>🏠</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([s.lat, s.lon], { icon })
        .bindTooltip(`<b>🏠 ${s.name}</b>${pct !== null ? `<br><span style="font-size:10px">${s.available}/${s.capacity} capacity (${pct}% free)</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
        .addTo(map);
    });

    navMapInstanceRef.current = map;
    return () => { map.remove(); navMapInstanceRef.current = null; };
  }, []);

  const totalDist  = routeData?.distance?.toFixed(1) || '—';
  const totalTime  = routeData?.duration ? Math.round(routeData.duration) : '—';
  const eta        = new Date(Date.now() + (routeData?.duration || 0) * 60000);
  const etaStr     = `${pad(eta.getHours())}:${pad(eta.getMinutes())}`;

  return (
    <div className="nav-view">
      <div className="nav-topbar" style={{ borderBottomColor: color }}>
        <button className="nav-back" onClick={onClose} style={{ color }}>← Back</button>
        <div className="nav-vehicle-id" style={{ color }}>{vehicleData.emoji} {vehicleData.label}</div>
        <div className="nav-station">{vehicleData.station}</div>
      </div>
      <div className="nav-body">
        <div className="nav-map-wrap">
          <div id="nav-map"></div>
          <div className="nav-stats-bar">
            <div className="nav-stat">
              <div className="nav-stat-val" style={{ color }}>{totalDist} <span>km</span></div>
              <div className="nav-stat-label">Total Distance</div>
            </div>
            <div className="nav-stat-divider"></div>
            <div className="nav-stat">
              <div className="nav-stat-val" style={{ color }}>{totalTime} <span>min</span></div>
              <div className="nav-stat-label">Est. Time</div>
            </div>
            <div className="nav-stat-divider"></div>
            <div className="nav-stat">
              <div className="nav-stat-val" style={{ color }}>{etaStr}</div>
              <div className="nav-stat-label">ETA</div>
            </div>
          </div>
        </div>
        <div className="nav-side">
          {/* Route stops */}
          <div className="nav-side-section">
            <div className="nav-side-header">ROUTE STOPS</div>
            <div className="nav-stops-scroll">
              {routeStops?.length ? routeStops.map((stop, idx) => {
                const stopNum = stop.severity > 0
                  ? routeStops.filter((s, i) => i <= idx && s.severity > 0).length
                  : null;
                return (
                  <div className="nav-stop-item" key={idx}>
                    <div className="nav-stop-num" style={{ background: stop.severity > 0 ? sevCol(stop.severity) : '#6b7280' }}>
                      {stopNum || '◆'}
                    </div>
                    <div className="nav-stop-body">
                      {stop.severity > 0 && (
                        <div className="nav-stop-sev" style={{ color: sevCol(stop.severity) }}>SEV {Math.round(stop.severity * 100)}</div>
                      )}
                      <div className="nav-stop-text">{stop.text}</div>
                      <div className="nav-stop-coords">{stop.lat.toFixed(4)}, {stop.lon.toFixed(4)}</div>
                    </div>
                  </div>
                );
              }) : <div className="nav-empty">No stops assigned</div>}
              {routeData?.endpoint && (
                <div className="nav-stop-item">
                  <div className="nav-stop-num" style={{ background: routeData.endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6', fontSize: '10px', lineHeight: '1' }}>
                    🚩
                  </div>
                  <div className="nav-stop-body">
                    <div className="nav-stop-sev" style={{ color: routeData.endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6' }}>
                      {routeData.endpoint.type === 'hospital' ? '🏥 HOSPITAL' : '🏠 SHELTER'}
                    </div>
                    <div className="nav-stop-text">{routeData.endpoint.name}</div>
                    <div className="nav-stop-coords">{routeData.endpoint.lat.toFixed(4)}, {routeData.endpoint.lon.toFixed(4)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const mapRef         = useRef(null);
  const incMarkersRef  = useRef([]);
  const heatLayerRef   = useRef(null);
  const vehicleMarkersRef = useRef([]);
  const routeLinesRef  = useRef([]);
  const allIncidentsRef = useRef([]);
  const completedAgentsSet = useRef(new Set());
  const logOutRef      = useRef(null);

  const [running,       setRunning]       = useState(false);
  const [logs,          setLogs]          = useState([{ time: '00:00:00', agent: 'sys', msg: 'Agents on standby.' }]);
  const [feedIncidents, setFeedIncidents] = useState([]);
  const [incidentCount, setIncidentCount] = useState(0);
  const [agentStatus,   setAgentStatus]   = useState({
    social: { status: 'idle', msg: 'Standby', count: '—' },
    image:  { status: 'idle', msg: 'Standby', count: '—' },
    call:   { status: 'idle', msg: 'Standby', count: '—' },
    route:  { status: 'idle', msg: 'Standby', count: '—' },
  });
  const [threat,        setThreat]        = useState({ level: 'low', label: 'THREAT: ASSESSING…' });
  const [clock,         setClock]         = useState('--:--:-- ET');
  const [routes,        setRoutes]        = useState([]);
  const [optimizing,    setOptimizing]    = useState(false);
  const [vehicleRoutesData, setVehicleRoutesData] = useState({});
  const [vehicleRouteStops, setVehicleRouteStops] = useState({});

  // Nav view state (pre-dispatch route inspection)
  const [navVehicleId, setNavVehicleId] = useState(null);

  const hasRoutes = Object.keys(vehicleRoutesData).length > 0;

  // ── Clock ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      setClock(`${formatter.format(now)} ET`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logOutRef.current) logOutRef.current.scrollTop = logOutRef.current.scrollHeight;
  }, [logs]);

  // ── Map init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map('map', { zoomControl: true }).setView([27.9506, -82.4572], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors, © CartoDB', maxZoom: 19,
    }).addTo(map);
    map.on('mousemove', (e) => {
      const el  = document.getElementById('cur-lat');
      const el2 = document.getElementById('cur-lon');
      if (el)  el.innerText  = e.latlng.lat.toFixed(4);
      if (el2) el2.innerText = e.latlng.lng.toFixed(4);
    });
    mapRef.current = map;

    loadSimulationData().then(() => {
      VEHICLES.forEach(veh => {
        const col  = getVehicleColor(veh.type);
        const html = `<div class="vehicle-marker" style="border-color:${col};box-shadow:0 0 10px ${col}60">
          <span class="vehicle-emoji">${veh.emoji}</span>
          <span class="vehicle-label" style="color:${col}">${veh.label}</span>
        </div>`;
        const icon   = L.divIcon({ className: '', html, iconSize: [60, 42], iconAnchor: [30, 21] });
        const marker = L.marker([veh.lat, veh.lon], { icon, zIndexOffset: 1000 });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          setNavVehicleId(veh.id);
        });
        marker.bindTooltip(`<b>${veh.label}</b> — ${veh.station}`, { direction: 'top', offset: [0, -10] });
        marker.addTo(map);
        vehicleMarkersRef.current.push({ marker, data: veh });
      });

      HOSPITALS.forEach(h => {
        const html = `<div class="facility-emoji-marker hospital-emoji-marker"><span>🏥</span></div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
        L.marker([h.lat, h.lon], { icon, zIndexOffset: 500 })
          .bindTooltip(`<b>🏥 ${h.name}</b>${h.status ? `<br><span style="color:#4ade80;font-size:10px">${h.status}</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
          .addTo(map);
      });

      SHELTERS.forEach(s => {
        const pct  = s.capacity ? Math.round((s.available / s.capacity) * 100) : null;
        const html = `<div class="facility-emoji-marker shelter-emoji-marker"><span>🏠</span></div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
        L.marker([s.lat, s.lon], { icon, zIndexOffset: 500 })
          .bindTooltip(`<b>🏠 ${s.name}</b>${pct !== null ? `<br><span style="font-size:10px">${s.available}/${s.capacity} capacity (${pct}% free)</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
          .addTo(map);
      });
    });

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const addLog = (agent, msg) => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    setLogs(prev => [...prev.slice(-80), { time: formatter.format(now), agent, msg }]);
  };

  const setAgent = (agent, status, msg, count = null) => {
    setAgentStatus(prev => ({ ...prev, [agent]: { status, msg, count: count !== null ? count : prev[agent].count } }));
  };

  const addIncident = (incident, source) => {
    setFeedIncidents(prev => [{ ...incident, source }, ...prev]);
    const col   = sevCol(incident.severity);
    const short = incident.text.length > 36 ? incident.text.substring(0, 34) + '…' : incident.text;
    const html  = `<div class="inc-pin">
      <div class="inc-label" style="color:${col};border-color:${col}40;display:none;">${short}</div>
      <div class="inc-dot" style="background:${col}20;border-color:${col};cursor:pointer;"></div>
    </div>`;
    const icon   = L.divIcon({ className: 'inc-marker-wrap', html, iconSize: [185, 52], iconAnchor: [92, 52] });
    const marker = L.marker([incident.lat, incident.lon], { icon }).addTo(mapRef.current);
    let labelVisible = false;
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const labelEl = marker.getElement()?.querySelector('.inc-label');
      if (labelEl) { labelVisible = !labelVisible; labelEl.style.display = labelVisible ? 'block' : 'none'; }
    });
    incMarkersRef.current.push(marker);
  };

  const clearMap = () => {
    incMarkersRef.current.forEach(m => { try { mapRef.current?.removeLayer(m); } catch(e) {} });
    incMarkersRef.current = [];
    if (heatLayerRef.current) { try { mapRef.current?.removeLayer(heatLayerRef.current); } catch(e) {} heatLayerRef.current = null; }
    routeLinesRef.current.forEach(line => { try { mapRef.current?.removeLayer(line); } catch(e) {} });
    routeLinesRef.current = [];
    setRoutes([]);
    setVehicleRoutesData({});
    setVehicleRouteStops({});
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // ── Route optimization ────────────────────────────────────────────────────────
  const optimizeRoutes = async (incidents) => {
    if (!incidents.length) return;
    setOptimizing(true);
    setAgent('route', 'active', 'Optimizing routes…');
    addLog('route', 'Initializing route optimization across all units…');
    const currentRoutes    = buildInitialRoutes(incidents, VEHICLES);
    const newVehicleRoutes = {};
    const newVehicleStops  = {};
    for (const route of currentRoutes) {
      const vehicle = VEHICLES.find(v => v.id === route.vehicleId);
      if (!vehicle) continue;
      const allStops      = route.stops;
      const lastStop      = allStops[allStops.length - 1];
      const hasEndpoint   = lastStop && lastStop.severity === 0;
      const incidentStops = hasEndpoint ? allStops.slice(0, -1) : allStops;
      const endpoint = hasEndpoint ? {
        lat: lastStop.lat, lon: lastStop.lon,
        name: lastStop.text.replace(/^Hospital: |^Shelter: /, ''),
        type: lastStop.incidentId?.startsWith('hospital') ? 'hospital' : 'shelter',
      } : null;
      const start     = { lat: route.startLat, lon: route.startLon };
      const waypoints = [...incidentStops.map(s => ({ lat: s.lat, lon: s.lon }))];
      if (endpoint) waypoints.push({ lat: endpoint.lat, lon: endpoint.lon });
      const fullRoute = await buildFullRoute(start, waypoints);
      if (fullRoute) {
        newVehicleRoutes[vehicle.id] = { ...fullRoute, endpoint };
        newVehicleStops[vehicle.id]  = incidentStops;
      }
      await sleep(400);
    }
    setVehicleRoutesData(newVehicleRoutes);
    setVehicleRouteStops(newVehicleStops);
    setRoutes(currentRoutes);
    routeLinesRef.current.forEach(line => { try { mapRef.current?.removeLayer(line); } catch(e) {} });
    routeLinesRef.current = [];
    addLog('route', `✓ Complete — ${currentRoutes.length} routes calculated and ready for dispatch`);
    setAgent('route', 'done', 'Complete', `${currentRoutes.length} routes`);
    setOptimizing(false);
  };

  // ── Backend SSE stream ────────────────────────────────────────────────────────
  const processBackendStream = async (reader, decoder) => {
    const agentCounts = { social: 0, image: 0, call: 0 };
    const allIncidents = [];
    let buffer = '';
    while (true) {
      let readResult;
      try { readResult = await reader.read(); } catch(e) { break; }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.substring(6)); } catch(e) { continue; }
        if (event.type === 'incident') {
          const incident = event.incident;
          addIncident(incident, incident.source);
          allIncidents.push(incident);
          if (incident.source === 'SOCIAL MEDIA'    && !completedAgentsSet.current.has('social')) { agentCounts.social++; setAgent('social', 'active', 'Filtering social media…', agentCounts.social); }
          else if (incident.source === 'SATELLITE IMAGE' && !completedAgentsSet.current.has('image'))  { agentCounts.image++;  setAgent('image',  'active', 'Processing imagery…',      agentCounts.image); }
          else if (incident.source === '911 DISPATCH'    && !completedAgentsSet.current.has('call'))   { agentCounts.call++;   setAgent('call',   'active', 'Processing 911 calls…',   agentCounts.call); }
        } else if (event.type === 'agent_log') {
          const agentMap = { social_media_agent: 'social', satellite_agent: 'image', call_agent: 'call', dispatch_agent: 'route', route_agent: 'route' };
          const agent = agentMap[event.agent] || event.agent;
          addLog(agent, event.content);
          if (event.content.includes('✓ Complete')) {
            if (event.agent === 'social_media_agent') { completedAgentsSet.current.add('social'); setAgent('social', 'done', 'Complete', agentCounts.social); setAgent('image', 'active', 'Processing satellite imagery…'); addLog('image', 'Analyzing satellite imagery for damage signatures…'); }
            else if (event.agent === 'satellite_agent') { completedAgentsSet.current.add('image'); setAgent('image', 'done', 'Complete', agentCounts.image); setAgent('call', 'active', 'Processing 911 transcripts…'); addLog('call', 'Transcribing and triaging 911 call queue…'); }
            else if (event.agent === 'call_agent') { completedAgentsSet.current.add('call'); setAgent('call', 'done', 'Complete', agentCounts.call); setAgent('route', 'active', 'Calculating optimal routes…'); addLog('route', 'Initializing route optimization across all units…'); }
          }
        } else if (event.type === 'routes') {
          await processBackendRoutes(event.routes || []);
        } else if (event.type === 'system') {
          if (event.message !== 'Agents started.') addLog('sys', event.message);
        } else if (event.type === 'complete') {
          addLog('route', event.message || '✓ Complete — routes assigned');
        } else if (event.type === 'error') {
          addLog('sys', `Error: ${event.message}`);
        }
      }
    }
    return allIncidents;
  };

  const processBackendRoutes = async (backendRoutes) => {
    const newVehicleRoutes = {};
    const newVehicleStops  = {};
    for (const route of backendRoutes) {
      if (route.geometry && route.geometry.length > 0) {
        newVehicleRoutes[route.vehicleId] = {
          geometry: route.geometry, distance: route.distance || 0,
          duration: route.duration || 0, endpoint: route.endpoint || null,
        };
        newVehicleStops[route.vehicleId] = route.stops || [];
      }
      await sleep(300);
    }
    setVehicleRoutesData(newVehicleRoutes);
    setVehicleRouteStops(newVehicleStops);
    setRoutes(backendRoutes);
    routeLinesRef.current.forEach(line => { try { mapRef.current?.removeLayer(line); } catch(e) {} });
    routeLinesRef.current = [];
    setAgent('route', 'done', 'Complete', `${backendRoutes.length} routes`);
  };

  // ── Local simulation fallback ─────────────────────────────────────────────────
  const updateMapWithIncidents = (allIncidents) => {
    allIncidentsRef.current = allIncidents;
    setIncidentCount(allIncidents.length);
    if (allIncidents.length > 0) setThreat(calcThreat(allIncidents));
    const heatPoints = allIncidents.map(p => [p.lat, p.lon, p.severity]);
    if (heatLayerRef.current && mapRef.current) mapRef.current.removeLayer(heatLayerRef.current);
    if (mapRef.current && heatPoints.length > 0) {
      heatLayerRef.current = L.heatLayer(heatPoints, {
        radius: 42, blur: 26, maxZoom: 17, max: 1.0,
        gradient: { 0.0: '#22c55e', 0.28: '#eab308', 0.52: '#f59e0b', 0.72: '#f97316', 1.0: '#ef4444' },
      }).addTo(mapRef.current);
    }
  };

  const runLocalSimulation = async () => {
    const allIncidents = [];
    const progressBar  = document.getElementById('progress-bar');
    const setProg = (pct) => { if (progressBar) progressBar.style.width = pct + '%'; };

    setProg(10);
    await sleep(700);
    for (let i = 0; i < SOCIAL_POSTS.length; i++) {
      const post = SOCIAL_POSTS[i];
      addIncident({ ...post, id: `social-${i}`, severity: computeSeverity(post.text), text: post.text }, 'SOCIAL MEDIA');
      allIncidents.push({ ...post, id: `social-${i}`, severity: computeSeverity(post.text) });
      setProg(10 + (i / SOCIAL_POSTS.length) * 17);
      await sleep(200);
    }
    setAgent('social', 'done', 'Complete', `${SOCIAL_POSTS.length} signals`);
    addLog('social', `✓ Complete — ${SOCIAL_POSTS.length} incidents queued.`);

    setAgent('image', 'active', 'Processing satellite imagery…');
    addLog('image', 'Analyzing satellite imagery for damage signatures…');
    setProg(30);
    await sleep(900);
    for (let i = 0; i < SATELLITE_DETECTIONS.length; i++) {
      const sat = SATELLITE_DETECTIONS[i];
      const inc = { id: `sat-${i}`, source: 'SATELLITE IMAGE', text: sat.text, lat: sat.lat, lon: sat.lon, severity: sat.type === 'fire' ? 0.9 : 0.7 };
      addIncident(inc, 'SATELLITE IMAGE');
      allIncidents.push(inc);
      setProg(30 + (i / SATELLITE_DETECTIONS.length) * 16);
      await sleep(200);
    }
    setAgent('image', 'done', 'Complete', `${SATELLITE_DETECTIONS.length} detections`);
    addLog('image', `✓ Complete — ${SATELLITE_DETECTIONS.length} detections confirmed.`);

    setAgent('call', 'active', 'Processing 911 transcripts…');
    addLog('call', 'Transcribing and triaging 911 call queue…');
    setProg(50);
    await sleep(650);
    for (let i = 0; i < CALL_TRANSCRIPTS.length; i++) {
      const call = CALL_TRANSCRIPTS[i];
      const inc  = { ...call, id: `call-${i}`, severity: computeSeverity(call.text), text: call.text };
      addIncident(inc, '911 DISPATCH');
      allIncidents.push(inc);
      setProg(50 + (i / CALL_TRANSCRIPTS.length) * 17);
      await sleep(220);
    }
    setAgent('call', 'done', 'Complete', `${CALL_TRANSCRIPTS.length} calls`);
    addLog('call', `✓ Complete — ${CALL_TRANSCRIPTS.length} calls processed.`);

    setAgent('route', 'active', 'Calculating optimal routes…');
    updateMapWithIncidents(allIncidents);
    await sleep(400);
    setProg(70);
    await optimizeRoutes(allIncidents);
    addLog('sys', 'Routes ready. Click NAV on any unit to inspect routes.');
    setProg(100);
  };

  // ── Main run handler ──────────────────────────────────────────────────────────
  const runSimulation = async () => {
    if (running || optimizing || !mapRef.current) return;
    setRunning(true);
    clearMap();
    setFeedIncidents([]);
    setIncidentCount(0);
    allIncidentsRef.current = [];
    completedAgentsSet.current.clear();

    const now  = new Date();
    const fmt0 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const t0   = fmt0.format(now);
    setLogs([
      { time: t0, agent: 'sys',    msg: 'Agents started.' },
      { time: t0, agent: 'social', msg: 'Scanning social media for distress signals…' },
    ]);
    setAgentStatus({
      social: { status: 'active', msg: 'Scanning social media…', count: '—' },
      image:  { status: 'idle',   msg: 'Standby', count: '—' },
      call:   { status: 'idle',   msg: 'Standby', count: '—' },
      route:  { status: 'idle',   msg: 'Standby', count: '—' },
    });
    setThreat({ level: 'low', label: 'THREAT: ASSESSING…' });

    const progressWrap = document.getElementById('progress-wrap');
    const progressBar  = document.getElementById('progress-bar');
    const scanLine     = document.getElementById('scan-line');
    if (progressWrap) progressWrap.style.display = 'block';
    if (scanLine) scanLine.classList.add('on');
    const setProg = (pct) => { if (progressBar) progressBar.style.width = pct + '%'; };
    setProg(5);

    let backendSuccess = false;
    try {
      const response = await fetch('http://localhost:8000/run_simulation');
      if (!response.ok) throw new Error('Backend unavailable');
      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      const allInc  = await processBackendStream(reader, decoder);
      allIncidentsRef.current = allInc;
      updateMapWithIncidents(allInc);
      setProg(100);
      backendSuccess = true;
    } catch (e) {
      addLog('sys', 'Backend unavailable — using local simulation');
    }

    if (!backendSuccess) await runLocalSimulation();

    setTimeout(() => { if (progressWrap) progressWrap.style.display = 'none'; }, 900);
    if (scanLine) scanLine.classList.remove('on');
    setRunning(false);
  };

  // Derived nav state
  const navVehicle   = navVehicleId ? VEHICLES.find(v => v.id === navVehicleId) : null;
  const navRouteData = navVehicleId ? vehicleRoutesData[navVehicleId] : null;
  const navStops     = navVehicleId ? (vehicleRouteStops[navVehicleId] || []) : [];

  return (
    <div className="app">
      {/* Nav view overlay */}
      {navVehicleId && navVehicle && (
        <NavView
          vehicleId={navVehicleId}
          vehicleData={navVehicle}
          routeData={navRouteData}
          routeStops={navStops}
          onClose={() => setNavVehicleId(null)}
        />
      )}

      <div className={`app-main ${navVehicleId ? 'app-hidden' : ''}`}>
        {/* Topbar */}
        <div className="topbar">
          <div className="logo">
            <div className="logo-emoji">🚑</div>
            <div className="logo-text">Dispatch</div>
          </div>
          <div className="topbar-right">
            <div className="clock">{clock}</div>
            <div className={`threat-badge level-${threat.level}`}>{threat.label}</div>
          </div>
        </div>

        <div className="layout">
          {/* Left panel */}
          <div className="left-panel">
            <div className="ph">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <circle cx="5.5" cy="5.5" r="4" stroke="#8fa3b8" strokeWidth="1.2"/>
                <path d="M5.5 3.5V6.5M5.5 7.5V8" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              <span className="ph-label">Agent Network</span>
              <span className="ph-badge">{Object.values(agentStatus).filter(a => a.status === 'done').length} / 4</span>
            </div>

            <div className="agents-wrap">
              {['social', 'image', 'call', 'route'].map(agent => (
                <div className="agent-row" key={agent}>
                  <div className={`ag-dot ${agentStatus[agent].status}`}></div>
                  <div className="ag-info">
                    <div className="ag-name">
                      {agent === 'social' && 'Social Media Agent'}
                      {agent === 'image'  && 'Satellite Image Agent'}
                      {agent === 'call'   && '911 Call Agent'}
                      {agent === 'route'  && 'Route Agent'}
                    </div>
                    <div className="ag-sub">{agentStatus[agent].msg}</div>
                  </div>
                  <div className="ag-count">{agentStatus[agent].count}</div>
                </div>
              ))}
            </div>

            {/* Vehicle legend — shown once routes are ready */}
            {hasRoutes && (
              <div className="vehicles-legend">
                <div className="ph" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="ph-label">Vehicles — Click to Navigate</span>
                </div>
                {VEHICLES.map((veh) => {
                  const hasRoute = !!vehicleRoutesData[veh.id];
                  const col      = getVehicleColor(veh.type);
                  const stops    = vehicleRouteStops[veh.id]?.length || 0;
                  return (
                    <div
                      key={veh.id}
                      className={`vehicle-row ${hasRoute ? 'clickable' : ''}`}
                      onClick={() => { if (hasRoute) setNavVehicleId(veh.id); }}
                      style={{ borderLeft: `3px solid ${col}` }}
                    >
                      <span className="veh-emoji">{veh.emoji}</span>
                      <div className="veh-info">
                        <div className="veh-name">{veh.label}</div>
                        <div className="veh-detail">
                          {hasRoute
                            ? `${vehicleRoutesData[veh.id].distance.toFixed(1)} km · ${Math.round(vehicleRoutesData[veh.id].duration)} min · ${stops} stops 🚩`
                            : 'No route assigned'}
                        </div>
                      </div>
                      {hasRoute && (
                        <span className="veh-nav-btn" style={{ color: col }}>NAV →</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="metrics-strip">
              <div className="met">
                <div className="met-label">Incidents Detected</div>
                <div className="met-val c-red">{incidentCount}</div>
              </div>
              <div className="met">
                <div className="met-label">Agents Complete</div>
                <div className="met-val c-green">{Object.values(agentStatus).filter(a => a.status === 'done').length}/4</div>
              </div>
            </div>

            <div className="run-wrap">
              <button
                id="run-btn"
                onClick={runSimulation}
                className={running || optimizing ? 'running' : ''}
                disabled={running || optimizing}
              >
                <span>{running ? '⟳ Agents Running…' : optimizing ? '⟳ Optimizing Routes…' : '▶ Run Simulation'}</span>
              </button>
            </div>
          </div>

          {/* Map */}
          <div className="map-area">
            <div id="progress-wrap"><div id="progress-bar"></div></div>
            <div id="scan-line"></div>
            <div id="map"></div>
            {hasRoutes && (
              <div className="map-hint">Click any vehicle on the map or use NAV → to inspect routes</div>
            )}
            <div className="map-foot">
              <div className="mf-stat">LAT <span id="cur-lat">—</span></div>
              <div className="mf-stat">LON <span id="cur-lon">—</span></div>
              <div className="mf-stat" style={{ marginLeft: 'auto' }}>Tampa Bay, FL · Emergency Coordination</div>
            </div>
          </div>

          {/* Right panel */}
          <div className="right-panel">
            <div className="ph">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M1 8L4 5L6 7L9 3" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="ph-label">Incident Feed</span>
              <span className="ph-badge">{feedIncidents.length}</span>
            </div>
            <div className="incident-list">
              {feedIncidents.length === 0 ? (
                <div style={{ padding: '24px 14px', textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-dim)' }}>
                  Awaiting simulation…
                </div>
              ) : (
                feedIncidents.map((inc, idx) => {
                  const col = sevCol(inc.severity);
                  return (
                    <div className="inc-item" key={idx}>
                      <div className="inc-bar" style={{ background: col }}></div>
                      <div className="inc-body">
                        <div className="inc-src">{inc.source}</div>
                        <div className="inc-txt">{inc.text}</div>
                        <div className="inc-coord">{inc.lat.toFixed(4)}, {inc.lon.toFixed(4)}</div>
                      </div>
                      <div className="inc-sev" style={{ color: col }}>{Math.round(inc.severity * 100)}</div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="log-panel">
              <div className="log-head">
                <div className="log-dot"></div>
                <span className="log-lbl">Agent Log</span>
              </div>
              <div className="log-out" id="log-out" ref={logOutRef}>
                {logs.map((log, i) => (
                  <div className="ll" key={i}>
                    <span className="ll-time">{log.time}</span>
                    <span className={`ll-ag ${log.agent}`}>
                      {log.agent === 'social' && '[SOCIAL]'}
                      {log.agent === 'image'  && '[IMAGE]'}
                      {log.agent === 'call'   && '[911]'}
                      {log.agent === 'route'  && '[ROUTE]'}
                      {log.agent === 'sys'    && '[SYS]'}
                    </span>
                    <span className="ll-msg">{log.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;