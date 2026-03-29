import { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

// --------------------------------------------------------------
// Helper functions
// --------------------------------------------------------------

// Pad a number with leading zeros to ensure it has at least 2 digits
const pad = (n) => String(n).padStart(2, '0');

// Picks a color based on severity score
const sevCol = (s) => {
  if (s >= 0.90) return '#dc2626';
  if (s >= 0.78) return '#f97316';
  if (s >= 0.65) return '#f59e0b';
  if (s >= 0.50) return '#eab308';
  if (s >= 0.35) return '#84cc16';
  return '#16a34a';
};

// Calculates the overall threat level based on the incidents
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

// Data loaded from simulation.json — populated by loadSimulationData()
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
  const counters  = { ambulance: 0, firetruck: 0, police: 0 };
  VEHICLES = [
    ...(resources.ambulances || []),
    ...(resources.firetrucks || []),
    ...(resources.police     || []),
  ].map(v => {
    const type = v.type;
    const idx  = counters[type] ?? 0;
    counters[type] = idx + 1;
    return { id: v.id, type, emoji: v.emoji, lat: v.lat, lon: v.lon, label: v.id };
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

// Scores incident severity from text keywords — used as local fallback when backend is offline
function computeSeverity(text) {
  const lower = text.toLowerCase();
  if (lower.includes('trapped') || lower.includes('collapse') || lower.includes('explosion')) return 0.95;
  if (lower.includes('fire')    || lower.includes('flood')    || lower.includes('rising'))    return 0.85;
  if (lower.includes('injury')  || lower.includes('car')      || lower.includes('pileup'))    return 0.75;
  if (lower.includes('medical') || lower.includes('insulin'))                                 return 0.70;
  if (lower.includes('power')   || lower.includes('stranded'))                                return 0.65;
  return 0.50;
}

// Haversine distance in km between two lat/lon points
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Estimated travel time in minutes at 50km/h average
function travelTime(distKm) {
  return (distKm / 50) * 60;
}

// Assigns incidents to nearest vehicles, orders stops by nearest-neighbor,
// appends hospital endpoint for ambulances and shelter endpoint for police
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
  // Order each vehicle's stops by nearest-neighbor greedy
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
  // Append hospital for ambulances, shelter for police
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

// Fetch real road geometry from OSRM for a list of waypoints
async function fetchRoadRoute(waypoints) {
  if (waypoints.length < 2) return null;
  const coords = waypoints.map(wp => `${wp.lon},${wp.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    const route    = data.routes[0];
    const geometry = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);
    const steps    = route.legs.flatMap(leg =>
      leg.steps.map(step => ({
        instruction: step.maneuver.instruction || (step.maneuver.type + ' ' + (step.maneuver.modifier || '')).trim(),
        name: step.name || '',
        distance: step.distance / 1000,
        duration: step.duration / 60,
        type: step.maneuver.type,
        modifier: step.maneuver.modifier,
        location: step.maneuver.location,
      }))
    );
    return { geometry, distance: route.distance / 1000, duration: route.duration / 60, steps };
  } catch (err) {
    return null;
  }
}

// Build a full route from start through all stops — falls back to straight lines if OSRM fails
async function buildFullRoute(start, stops) {
  if (!stops.length) return null;
  const waypoints  = [start, ...stops];
  const roadRoute  = await fetchRoadRoute(waypoints);
  if (roadRoute) return roadRoute;
  // Straight-line fallback
  const straightGeo = waypoints.map(wp => [wp.lat, wp.lon]);
  let straightDist  = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    straightDist += distance(waypoints[i].lat, waypoints[i].lon, waypoints[i+1].lat, waypoints[i+1].lon);
  }
  return {
    geometry: straightGeo,
    distance: straightDist,
    duration: travelTime(straightDist),
    steps: [{ instruction: 'Direct route', distance: straightDist, duration: travelTime(straightDist), type: 'depart', modifier: '' }],
  };
}

// Interpolate a position along a geometry array at fraction t (0..1)
function interpolateGeometry(geometry, t) {
  if (!geometry || geometry.length < 2) return null;
  const totalSegs = geometry.length - 1;
  const pos       = t * totalSegs;
  const segIdx    = Math.min(Math.floor(pos), totalSegs - 1);
  const segFrac   = pos - segIdx;
  const a         = geometry[segIdx];
  const b         = geometry[segIdx + 1];
  return [a[0] + (b[0] - a[0]) * segFrac, a[1] + (b[1] - a[1]) * segFrac];
}

// Get bearing in degrees at position t along a geometry
function getBearingAtT(geometry, t) {
  if (!geometry || geometry.length < 2) return 0;
  const totalSegs = geometry.length - 1;
  const segIdx    = Math.min(Math.floor(t * totalSegs), totalSegs - 1);
  const a         = geometry[segIdx];
  const b         = geometry[segIdx + 1];
  const toRad     = (d) => d * Math.PI / 180;
  const dLon      = toRad(b[1] - a[1]);
  const y         = Math.sin(dLon) * Math.cos(toRad(b[0]));
  const x         = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Find current step index based on progress t
function getCurrentStep(steps, t) {
  if (!steps || steps.length === 0) return 0;
  return Math.min(Math.floor(t * steps.length), steps.length - 1);
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const mapRef            = useRef(null);
  const vehicleMarkersRef = useRef([]);
  const incMarkersRef     = useRef([]); // incident pin markers on map
  const logOutRef         = useRef(null);

  const [threat,        setThreat]        = useState({ level: 'low', label: 'THREAT: ASSESSING…' });
  const [clock,         setClock]         = useState('--:--:-- ET');
  const [running,       setRunning]       = useState(false);
  const [feedIncidents, setFeedIncidents] = useState([]);
  const [agentStatus,   setAgentStatus]   = useState({
    social: { status: 'idle', msg: 'Standby', count: '—' },
    image:  { status: 'idle', msg: 'Standby', count: '—' },
    call:   { status: 'idle', msg: 'Standby', count: '—' },
    route:  { status: 'idle', msg: 'Standby', count: '—' },
  });

  // Deliberation log — capped at 80 entries to avoid memory bloat
  const [logs, setLogs] = useState([
    { time: '00:00:00', agent: 'sys', msg: 'Agents on standby.' },
  ]);

  const routeLinesRef      = useRef([]);
  const allIncidentsRef    = useRef([]);
  const [routes,           setRoutes]           = useState([]);
  const [optimizing,       setOptimizing]       = useState(false);
  const [vehicleRoutesData, setVehicleRoutesData] = useState({});
  const [vehicleRouteStops, setVehicleRouteStops] = useState({});
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  // Updates a single agent's status, message, and optional count
  const setAgent = (agent, status, msg, count = null) => {
    setAgentStatus(prev => ({
      ...prev,
      [agent]: { status, msg, count: count !== null ? count : prev[agent].count },
    }));
  };

  // Appends a timestamped entry to the deliberation log
  const addLog = (agent, msg) => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    setLogs(prev => [...prev.slice(-80), { time: formatter.format(now), agent, msg }]);
  };

  // Drops a colored dot pin on the map and adds incident to the feed
  // iconAnchor is [6,6] (center of the 12px dot) — prevents any shift on click
  const addIncident = useCallback((incident, source) => {
    setFeedIncidents(prev => {
      const next = [{ ...incident, source }, ...prev];
      setThreat(calcThreat(next));
      return next;
    });
    if (!mapRef.current) return;
    const col  = sevCol(incident.severity);
    const html = `<div class="inc-dot" style="background:${col}20;border-color:${col};"></div>`;
    const icon = L.divIcon({ className: 'inc-marker-wrap', html, iconSize: [12, 12], iconAnchor: [6, 6] });
    const marker = L.marker([incident.lat, incident.lon], { icon })
      .bindTooltip(`<b>${incident.source || source}</b><br>${incident.text}`, { direction: 'top', offset: [0, -8], className: 'facility-tooltip' })
      .addTo(mapRef.current);
    incMarkersRef.current.push(marker);
  }, []);

  // Removes all incident pins from the map and clears the feed
  const clearMap = useCallback(() => {
    incMarkersRef.current.forEach(m => { try { mapRef.current?.removeLayer(m); } catch(e) {} });
    incMarkersRef.current = [];
    routeLinesRef.current.forEach(line => { try { mapRef.current?.removeLayer(line); } catch(e) {} });
    routeLinesRef.current = [];
    setRoutes([]);
    setVehicleRoutesData({});
    setVehicleRouteStops({});
  }, []);

  // Builds OSRM road routes for all vehicles after incidents are collected
  const optimizeRoutes = async (incidents) => {
    if (!incidents.length) return;
    setOptimizing(true);
    setAgent('route', 'active', 'Optimizing routes…');
    addLog('route', 'Initializing route optimization across all units…');
    const currentRoutes  = buildInitialRoutes(incidents, VEHICLES);
    const newVehicleRoutes = {};
    const newVehicleStops  = {};
    for (const route of currentRoutes) {
      const vehicle = VEHICLES.find(v => v.id === route.vehicleId);
      if (!vehicle) continue;
      // Separate endpoint (hospital/shelter, severity 0) from incident stops
      const allStops   = route.stops;
      const lastStop   = allStops[allStops.length - 1];
      const hasEndpoint = lastStop && lastStop.severity === 0;
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

  // Auto-scroll log to bottom whenever a new entry is appended
  useEffect(() => {
    if (logOutRef.current) {
      logOutRef.current.scrollTop = logOutRef.current.scrollHeight;
    }
  }, [logs]);

  // Live clock — ticks every second in Eastern Time
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      setClock(`${formatter.format(now)} ET`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Map init + simulation data load
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
      // Vehicle markers
      VEHICLES.forEach(veh => {
        const col  = getVehicleColor(veh.type);
        const html = `<div class="vehicle-marker" style="color:${col}">
          <span class="vehicle-emoji">${veh.emoji}</span>
          <span class="vehicle-label" style="color:${col}">${veh.label}</span>
        </div>`;
        const icon   = L.divIcon({ className: '', html, iconSize: [60, 42], iconAnchor: [30, 21] });
        const marker = L.marker([veh.lat, veh.lon], { icon, zIndexOffset: 1000 });
        marker.bindTooltip(`<b>${veh.label}</b>`, { direction: 'top', offset: [0, -10] });
        marker.addTo(map);
        vehicleMarkersRef.current.push({ marker, data: veh });
      });

      // Hospital markers — emoji only, info on hover
      HOSPITALS.forEach(h => {
        const html = `<div class="facility-emoji-marker hospital-emoji-marker"><span>🏥</span></div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
        L.marker([h.lat, h.lon], { icon, zIndexOffset: 500 })
          .bindTooltip(
            `<b>🏥 ${h.name}</b>${h.status ? `<br><span style="color:#4ade80;font-size:10px">${h.status}</span>` : ''}`,
            { direction: 'top', offset: [0, -10], className: 'facility-tooltip' }
          )
          .addTo(map);
      });

      // Shelter markers — emoji only, info on hover
      SHELTERS.forEach(s => {
        const pct  = s.capacity ? Math.round((s.available / s.capacity) * 100) : null;
        const html = `<div class="facility-emoji-marker shelter-emoji-marker"><span>🏠</span></div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
        L.marker([s.lat, s.lon], { icon, zIndexOffset: 500 })
          .bindTooltip(
            `<b>🏠 ${s.name}</b>${pct !== null ? `<br><span style="font-size:10px">${s.available}/${s.capacity} capacity (${pct}% free)</span>` : ''}`,
            { direction: 'top', offset: [0, -10], className: 'facility-tooltip' }
          )
          .addTo(map);
      });
    });

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Agents run strictly one after the other
  const runSimulation = async () => {
    if (running || !mapRef.current) return;
    setRunning(true);
    clearMap();
    setFeedIncidents([]);
    setThreat({ level: 'low', label: 'THREAT: ASSESSING…' });
    setAgentStatus({
      social: { status: 'idle', msg: 'Standby', count: '—' },
      image:  { status: 'idle', msg: 'Standby', count: '—' },
      call:   { status: 'idle', msg: 'Standby', count: '—' },
      route:  { status: 'idle', msg: 'Standby', count: '—' },
    });

    // Reset log with a fresh start entry
    const now = new Date();
    const formatter0 = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    setLogs([{ time: formatter0.format(now), agent: 'sys', msg: 'Agents started.' }]);

    // Show progress bar and scan line on map
    const progressWrap = document.getElementById('progress-wrap');
    const progressBar  = document.getElementById('progress-bar');
    const scanLine     = document.getElementById('scan-line');
    if (progressWrap) progressWrap.style.display = 'block';
    if (scanLine) scanLine.classList.add('on');
    const setProg = (pct) => { if (progressBar) progressBar.style.width = pct + '%'; };
    setProg(5);

    // 1 — Social Media Agent
    setAgent('social', 'active', 'Scanning social feeds…');
    addLog('social', 'Scanning social media for distress signals…');
    await new Promise(r => setTimeout(r, 9000));
    const socialInc = SOCIAL_POSTS.map((post, i) => ({
      id: `social-${i}`, source: 'SOCIAL MEDIA',
      text: post.text, lat: post.lat, lon: post.lon,
      severity: computeSeverity(post.text),
    }));
    setAgent('social', 'done', 'Complete', socialInc.length);
    for (let i = 0; i < socialInc.length; i++) {
      await new Promise(r => setTimeout(r, 300));
      addIncident(socialInc[i], 'SOCIAL MEDIA');
    }
    addLog('social', `✓ Complete — ${socialInc.length} incidents queued.`);
    setProg(30);

    // 2 — Satellite Image Agent
    setAgent('image', 'active', 'Processing satellite imagery…');
    addLog('image', 'Analyzing satellite imagery for damage signatures…');
    await new Promise(r => setTimeout(r, 9000));
    const satInc = SATELLITE_DETECTIONS.map((det, i) => ({
      id: `sat-${i}`, source: 'SATELLITE IMAGE',
      text: det.description || det.text || 'Anomaly detected',
      lat: det.lat, lon: det.lon,
      severity: det.severity ?? computeSeverity(det.description || det.text || ''),
    }));
    setAgent('image', 'done', 'Complete', satInc.length);
    for (let i = 0; i < satInc.length; i++) {
      await new Promise(r => setTimeout(r, 300));
      addIncident(satInc[i], 'SATELLITE IMAGE');
    }
    addLog('image', `✓ Complete — ${satInc.length} detections confirmed.`);
    setProg(55);

    // 3 — 911 Call Agent
    setAgent('call', 'active', 'Processing 911 transcripts…');
    addLog('call', 'Transcribing and triaging 911 call queue…');
    await new Promise(r => setTimeout(r, 9000));
    const callInc = CALL_TRANSCRIPTS.map((call, i) => ({
      id: `call-${i}`, source: '911 DISPATCH',
      text: call.transcript || call.text || 'Emergency reported',
      lat: call.lat, lon: call.lon,
      severity: computeSeverity(call.transcript || call.text || ''),
    }));
    setAgent('call', 'done', 'Complete', callInc.length);
    for (let i = 0; i < callInc.length; i++) {
      await new Promise(r => setTimeout(r, 300));
      addIncident(callInc[i], '911 DISPATCH');
    }
    addLog('call', `✓ Complete — ${callInc.length} calls processed.`);
    setProg(75);

    // 4 — Route Agent
    setAgent('route', 'active', 'Calculating optimal routes…');
    addLog('route', 'Initializing route optimization across all units…');
    const allInc = [...socialInc, ...satInc, ...callInc];
    allIncidentsRef.current = allInc;
    await optimizeRoutes(allInc);
    addLog('sys', 'Routes ready. Click DISPATCH to deploy all units.');
    setProg(100);

    setTimeout(() => { if (progressWrap) progressWrap.style.display = 'none'; }, 900);
    if (scanLine) scanLine.classList.remove('on');
    setRunning(false);
  };

  return (
    <div className="app">
      <div className="app-main">

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

        {/* Three-panel layout */}
        <div className="layout">

          {/* Left panel */}
          <div className="left-panel">
            <div className="ph">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <circle cx="5.5" cy="5.5" r="4" stroke="#8fa3b8" strokeWidth="1.2"/>
                <path d="M5.5 3.5V6.5M5.5 7.5V8" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              <span className="ph-label">Agent Network</span>
              <span className="ph-badge">
                {Object.values(agentStatus).filter(a => a.status === 'done').length} / 4
              </span>
            </div>

            {/* Agent rows */}
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

            {/* Metrics strip — incidents detected and agents complete */}
            <div className="metrics-strip">
              <div className="met">
                <div className="met-label">Incidents Detected</div>
                <div className="met-val c-red">{feedIncidents.length}</div>
              </div>
              <div className="met">
                <div className="met-label">Agents Complete</div>
                <div className="met-val c-green">
                  {Object.values(agentStatus).filter(a => a.status === 'done').length}/4
                </div>
              </div>
            </div>

            {/* Run button */}
            <div className="run-wrap">
              <button
                id="run-btn"
                onClick={runSimulation}
                className={running ? 'running' : ''}
                disabled={running}
              >
                <span>{running ? '⟳ Agents Running…' : '▶ Start Agents'}</span>
              </button>
            </div>
          </div>

          {/* Map area */}
          <div className="map-area">
            {/* Progress bar along top edge of map */}
            <div id="progress-wrap"><div id="progress-bar"></div></div>
            {/* Scan line sweeps top-to-bottom during simulation */}
            <div id="scan-line"></div>
            <div id="map"></div>
            <div className="map-foot">
              <div className="mf-stat">LAT <span id="cur-lat">—</span></div>
              <div className="mf-stat">LON <span id="cur-lon">—</span></div>
              <div className="mf-stat" style={{ marginLeft: 'auto' }}>
                Tampa Bay, FL · Emergency Coordination
              </div>
            </div>
          </div>

          {/* Right panel — Incident Feed + Deliberation Log */}
          <div className="right-panel">
            <div className="ph">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M1 8L4 5L6 7L9 3" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="ph-label">Incident Feed</span>
              <span className="ph-badge">{feedIncidents.length}</span>
            </div>

            {/* Scrollable incident list */}
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

            {/* Agent Deliberation Log — fixed height at bottom of right panel */}
            <div className="log-panel">
              <div className="log-head">
                <div className="log-dot"></div>
                <span className="log-lbl">Agent Deliberation Log</span>
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