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
  const mod = incidents.filter(x => x.severity >= 0.45 && x.severity < 0.65).length;
  const score = crit * 3 + high * 1.5 + mod * 0.5;
  if (crit === 0 && score < 2) return { level: 'low', label: 'THREAT: LOW' };
  if (crit === 0 && score < 5) return { level: 'guarded', label: 'THREAT: GUARDED' };
  if (crit <= 2 && score < 12) return { level: 'elevated', label: 'THREAT: ELEVATED' };
  if (crit <= 4 && score < 22) return { level: 'high', label: 'THREAT: HIGH' };
  return { level: 'critical', label: 'THREAT: CRITICAL' };
};

// Data loaded from simulation.json — no hardcoded fallbacks
let VEHICLES = [];
let HOSPITALS = [];
let SHELTERS = [];
let SOCIAL_POSTS = [];
let SATELLITE_DETECTIONS = [];
let CALL_TRANSCRIPTS = [];

async function loadSimulationData() {
  const res = await fetch('/simulation.json');
  const data = await res.json();
  const resources = data.resources || {};
  const stationNames = {
    ambulance: ['Station 1 - Downtown', 'Station 2 - Seminole Hts', 'Station 3 - South Tampa'],
    firetruck: ['Fire Station 1 - Downtown', 'Fire Station 2 - Seminole Heights', 'Fire Station 3 - South Tampa'],
    police: ['Precinct A - Kennedy', 'Precinct B - Howard Ave', 'Precinct C - North Tampa'],
  };
  const counters = { ambulance: 0, firetruck: 0, police: 0 };
  VEHICLES = [
    ...(resources.ambulances || []),
    ...(resources.firetrucks || []),
    ...(resources.police || []),
  ].map(v => {
    const type = v.type;
    const idx = counters[type] ?? 0;
    counters[type] = idx + 1;
    return {
      id: v.id,
      type,
      emoji: v.emoji,
      lat: v.lat,
      lon: v.lon,
      label: v.id,
      station: (stationNames[type] || [])[idx] || v.id,
    };
  });
  HOSPITALS = (data.hospitals || []).map(h => ({ name: h.name, lat: h.lat, lon: h.lon, status: h.status }));
  SHELTERS = (data.shelters || []).map(s => ({ name: s.name, lat: s.lat, lon: s.lon, capacity: s.capacity, available: s.available }));
  SOCIAL_POSTS = data.social_posts || [];
  SATELLITE_DETECTIONS = data.satellite_detections || [];
  CALL_TRANSCRIPTS = data.call_transcripts || [];
  return data;
}

function computeSeverity(text) {
  const lower = text.toLowerCase();
  if (lower.includes('trapped') || lower.includes('collapse') || lower.includes('explosion')) return 0.95;
  if (lower.includes('fire') || lower.includes('flood') || lower.includes('rising')) return 0.85;
  if (lower.includes('injury') || lower.includes('car') || lower.includes('pileup')) return 0.75;
  if (lower.includes('power') || lower.includes('stranded')) return 0.65;
  if (lower.includes('medical') || lower.includes('insulin')) return 0.70;
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
    vehicleId: veh.id,
    type: veh.type,
    startLat: veh.lat,
    startLon: veh.lon,
    stops: [],
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
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return null;
    const route = data.routes[0];
    const geometry = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);
    const steps = route.legs.flatMap(leg =>
      leg.steps.map(step => ({
        instruction: step.maneuver.instruction || formatManeuver(step.maneuver),
        name: step.name || '',
        distance: step.distance / 1000,
        duration: step.duration / 60,
        type: step.maneuver.type,
        modifier: step.maneuver.modifier,
        location: step.maneuver.location, // [lon, lat]
      }))
    );
    return { geometry, distance: route.distance / 1000, duration: route.duration / 60, steps, legs: route.legs };
  } catch (err) {
    return null;
  }
}

function formatManeuver(maneuver) {
  const type = maneuver.type || '';
  const mod = maneuver.modifier || '';
  if (type === 'depart') return 'Head ' + mod;
  if (type === 'arrive') return 'Arrive at destination';
  if (type === 'turn') return 'Turn ' + mod;
  if (type === 'continue') return 'Continue straight';
  if (type === 'roundabout') return 'Enter roundabout';
  if (type === 'merge') return 'Merge ' + mod;
  return type + (mod ? ' ' + mod : '');
}

function maneuverIcon(type, modifier) {
  if (type === 'depart') return '▲';
  if (type === 'arrive') return '📍';
  if (!modifier) return '↑';
  if (modifier === 'left') return '←';
  if (modifier === 'right') return '→';
  if (modifier === 'sharp left') return '↙';
  if (modifier === 'sharp right') return '↘';
  if (modifier === 'slight left') return '↖';
  if (modifier === 'slight right') return '↗';
  if (modifier === 'uturn') return '↩';
  return '↑';
}

async function buildFullRoute(start, stops) {
  if (!stops.length) return null;
  const waypoints = [start, ...stops];
  const roadRoute = await fetchRoadRoute(waypoints);
  if (roadRoute) return roadRoute;
  const straightGeo = waypoints.map(wp => [wp.lat, wp.lon]);
  let straightDist = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    straightDist += distance(waypoints[i].lat, waypoints[i].lon, waypoints[i+1].lat, waypoints[i+1].lon);
  }
  return {
    geometry: straightGeo,
    distance: straightDist,
    duration: travelTime(straightDist),
    steps: [{ instruction: "Direct route", distance: straightDist, duration: travelTime(straightDist), type: 'depart', modifier: '' }],
  };
}

// Compute bearing between two lat/lon points in degrees
function computeBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Interpolate point along geometry at fraction t
function interpolateGeometry(geometry, t) {
  if (!geometry || geometry.length < 2) return null;
  const totalSegs = geometry.length - 1;
  const pos = t * totalSegs;
  const segIdx = Math.min(Math.floor(pos), totalSegs - 1);
  const segFrac = pos - segIdx;
  const a = geometry[segIdx];
  const b = geometry[segIdx + 1];
  return [
    a[0] + (b[0] - a[0]) * segFrac,
    a[1] + (b[1] - a[1]) * segFrac
  ];
}

// Get bearing at a point along geometry
function getBearingAtT(geometry, t) {
  if (!geometry || geometry.length < 2) return 0;
  const totalSegs = geometry.length - 1;
  const pos = t * totalSegs;
  const segIdx = Math.min(Math.floor(pos), totalSegs - 1);
  const a = geometry[segIdx];
  const b = geometry[segIdx + 1];
  return computeBearing(a[0], a[1], b[0], b[1]);
}

// Find the current step index based on t progress
function getCurrentStep(steps, t) {
  if (!steps || steps.length === 0) return 0;
  const idx = Math.min(Math.floor(t * steps.length), steps.length - 1);
  return idx;
}

const getVehicleColor = (type) => {
  if (type === 'ambulance') return '#16a34a';
  if (type === 'firetruck') return '#ef4444';
  if (type === 'police') return '#3b82f6';
  return '#f59e0b';
};

// ─── Google Maps POV Follow View ──────────────────────────────────────────────
function PovView({ vehicleId, vehicleData, routeData, routeStops, dispatchProgress, onClose }) {
  const povMapRef = useRef(null);
  const povMapInstanceRef = useRef(null);
  const vehicleMarkerRef = useRef(null);
  const routeLineRef = useRef(null);
  const traveledLineRef = useRef(null);
  const prevBearingRef = useRef(0);
  const color = getVehicleColor(vehicleData.type);

  const t = dispatchProgress[vehicleId] ?? 0;
  const isComplete = t >= 1;

  // Init map
  useEffect(() => {
    if (povMapInstanceRef.current) return;
    const map = L.map('pov-map', {
      zoomControl: false,
      attributionControl: false,
      rotate: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap contributors, © CartoDB',
      maxZoom: 20,
    }).addTo(map);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const geo = routeData?.geometry || [];

    // Full route line (grey)
    if (geo.length > 1) {
      L.polyline(geo, { color: 'rgba(0,0,0,0.18)', weight: 12, opacity: 1 }).addTo(map);
      L.polyline(geo, { color: 'rgba(255,255,255,0.55)', weight: 8, opacity: 1 }).addTo(map);
      routeLineRef.current = L.polyline(geo, { color: '#b0bec5', weight: 6, opacity: 1 }).addTo(map);
    }

    // Traveled line (colored)
    traveledLineRef.current = L.polyline([], { color, weight: 7, opacity: 1 }).addTo(map);

    // Stop markers - FIXED: Number ALL stops consistently (both map and side panel use same logic)
    // Map markers: sequential numbering for all stops (including hospitals/shelters)
    const allStops = routeStops || [];
    allStops.forEach((stop, idx) => {
      // Skip hospitals/shelters from numbering (they have severity 0)
      if (stop.severity === 0) return;
     
      const col = sevCol(stop.severity);
      // Find which number this stop is among incident stops only
      const incidentStops = allStops.filter(s => s.severity > 0);
      const stopNum = incidentStops.findIndex(s => s === stop) + 1;
     
      // Offset markers at same location by small amounts
      let offsetLat = stop.lat;
      let offsetLon = stop.lon;
      if (idx > 0) {
        const prevStop = allStops[idx - 1];
        const dist = distance(prevStop.lat, prevStop.lon, stop.lat, stop.lon);
        if (dist < 0.01) { // Less than ~1km apart, offset slightly
          const offset = 0.00015 * idx; // ~15 meters per stop
          offsetLat += offset;
          offsetLon += offset;
        }
      }
      const html = `<div class="pov-stop-dot" style="background:${col};border-color:${col}"><span>${stopNum}</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([offsetLat, offsetLon], { icon }).addTo(map);
    });

    // Add endpoint marker (hospital/shelter) with checkered flag
    const endpoint = routeData?.endpoint;
    if (endpoint) {
      const endpointColor = endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6';
      const endpointHtml = `<div class="pov-endpoint-marker" style="background:${endpointColor};border-color:${endpointColor}">🚩</div>`;
      const endpointIcon = L.divIcon({ className: '', html: endpointHtml, iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([endpoint.lat, endpoint.lon], { icon: endpointIcon }).addTo(map);
    }

    // Vehicle marker
    const vehHtml = `<div class="pov-vehicle-icon" style="border-color:${color};box-shadow:0 0 0 4px ${color}40,0 0 20px ${color}60">
      <span class="pov-vehicle-emoji">${vehicleData.emoji}</span>
    </div>`;
    const vehIcon = L.divIcon({ className: '', html: vehHtml, iconSize: [52, 52], iconAnchor: [26, 26] });

    const startPos = geo.length > 0 ? geo[0] : [vehicleData.lat, vehicleData.lon];
    vehicleMarkerRef.current = L.marker(startPos, { icon: vehIcon, zIndexOffset: 2000 }).addTo(map);

    // Hospital markers — emoji only, info on hover
    HOSPITALS.forEach(h => {
      const html = `<div class="facility-emoji-marker hospital-emoji-marker"><span>🏥</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([h.lat, h.lon], { icon })
        .bindTooltip(`<b>🏥 ${h.name}</b>${h.status ? `<br><span style="color:#4ade80;font-size:10px">${h.status}</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
        .addTo(map);
    });

    // Shelter markers — emoji only, info on hover
    SHELTERS.forEach(s => {
      const pct = s.capacity ? Math.round((s.available / s.capacity) * 100) : null;
      const html = `<div class="facility-emoji-marker shelter-emoji-marker"><span>🏠</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([s.lat, s.lon], { icon })
        .bindTooltip(`<b>🏠 ${s.name}</b>${pct !== null ? `<br><span style="font-size:10px">${s.available}/${s.capacity} capacity (${pct}% free)</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
        .addTo(map);
    });

    // Set initial view — street level, tilted feel
    map.setView(startPos, 17);
    povMapInstanceRef.current = map;

    return () => {
      map.remove();
      povMapInstanceRef.current = null;
    };
  }, []);

  // Sync vehicle position whenever dispatchProgress changes
  // FIXED: Removed map.panTo() - vehicles move but map stays STATIC (no rotation/following)
  useEffect(() => {
    const geo = routeData?.geometry;
    if (!geo || !povMapInstanceRef.current || !vehicleMarkerRef.current) return;

    const pos = interpolateGeometry(geo, t);
    if (!pos) return;

    // Keep bearing calculation for potential future use (e.g., rotating vehicle icon)
    // but DO NOT apply it to the map rotation
    const bearing = getBearingAtT(geo, t);
    // Smooth bearing interpolation (stored but not used for map rotation)
    let b = bearing;
    const prev = prevBearingRef.current;
    const diff = ((b - prev + 540) % 360) - 180;
    b = prev + diff * 0.15;
    prevBearingRef.current = b;

    // Update vehicle marker position - THIS IS THE ONLY CHANGE
    vehicleMarkerRef.current.setLatLng(pos);

    // Update traveled polyline
    const traveledGeo = geo.slice(0, Math.floor(t * (geo.length - 1)) + 2);
    if (traveledLineRef.current) {
      traveledLineRef.current.setLatLngs(traveledGeo.slice(0, Math.ceil(t * geo.length)));
    }

    // REMOVED: map.panTo() - map stays static while vehicle moves
    // REMOVED: map.setZoom() - no zoom changes during dispatch
  }, [t]);

  const steps = routeData?.steps || [];
  const currentStepIdx = getCurrentStep(steps, t);
  const currentStep = steps[currentStepIdx] || {};
  const totalDist = routeData?.distance?.toFixed(1) || '—';
  const totalTime = routeData?.duration ? Math.round(routeData.duration * (1 - t)) : '—';
  const eta = new Date(Date.now() + (routeData?.duration || 0) * (1 - t) * 60000);
  const etaStr = `${pad(eta.getHours())}:${pad(eta.getMinutes())}`;
  const progress = Math.round(t * 100);
  const distRemaining = routeData?.distance ? (routeData.distance * (1 - t)).toFixed(1) : '—';

  return (
    <div className="pov-view">
      {/* Header */}
      <div className="pov-topbar" style={{ borderBottomColor: color }}>
        <button className="pov-back" onClick={onClose} style={{ color, borderColor: color }}>
          ← Map
        </button>
        <div className="pov-vehicle-id" style={{ color }}>
          {vehicleData.emoji} {vehicleData.label}
        </div>
        <div className="pov-station">{vehicleData.station}</div>
        {isComplete && (
          <div className="pov-complete-badge">✓ ARRIVED</div>
        )}
      </div>

      <div className="pov-body">
        {/* Map */}
        <div className="pov-map-wrap">
          <div id="pov-map"></div>

          {isComplete && (
            <div className="pov-arrived-overlay" style={{ borderColor: color }}>
              <div className="pov-arrived-icon">{vehicleData.emoji}</div>
              <div className="pov-arrived-text" style={{ color }}>Destination Reached</div>
              <div className="pov-arrived-sub">{vehicleData.label} has completed all stops</div>
            </div>
          )}

          {/* Progress bar */}
          <div className="pov-progress-bar-wrap">
            <div className="pov-progress-bar-fill" style={{ width: `${progress}%`, background: color }}></div>
          </div>
        </div>

        {/* Side panel */}
        <div className="pov-side">
          {/* ETA stats */}
          <div className="pov-stats-row" style={{ borderBottomColor: `${color}30` }}>
            <div className="pov-stat">
              <div className="pov-stat-val" style={{ color }}>{isComplete ? '0.0' : distRemaining}<span> km</span></div>
              <div className="pov-stat-lbl">Distance to 🚩</div>
            </div>
            <div className="pov-stat-div"></div>
            <div className="pov-stat">
              <div className="pov-stat-val" style={{ color }}>{isComplete ? '0' : totalTime}<span> min</span></div>
              <div className="pov-stat-lbl">Time Remaining</div>
            </div>
          </div>

          {/* Progress indicator */}
          <div className="pov-progress-section">
            <div className="pov-progress-label">
              <span style={{ color }}>DISPATCH PROGRESS</span>
              <span style={{ color }}>{progress}%</span>
            </div>
            <div className="pov-progress-track">
              <div className="pov-progress-fill" style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${color}99, ${color})` }}></div>
            </div>
          </div>

          {/* Stops */}
          <div className="pov-section-header">ASSIGNED STOPS</div>
          <div className="pov-stops-list">
            {routeStops?.length ? routeStops.map((stop, idx) => {
              const stopT = (idx + 1) / routeStops.length;
              const reached = t >= stopT * 0.9;
              const stopNum = stop.severity > 0 ? (routeStops.filter((s, i) => i <= idx && s.severity > 0).length) : null;
              return (
                <div className={`pov-stop-row ${reached ? 'reached' : ''}`} key={idx}>
                  <div className="pov-stop-num" style={{ background: reached ? sevCol(stop.severity) : 'transparent', borderColor: sevCol(stop.severity), color: reached ? '#000' : sevCol(stop.severity) }}>
                    {stopNum ? (reached ? '✓' : stopNum) : '◆'}
                  </div>
                  <div className="pov-stop-body">
                    {stop.severity > 0 && (
                      <div className="pov-stop-sev" style={{ color: sevCol(stop.severity) }}>SEV {Math.round(stop.severity * 100)}</div>
                    )}
                    <div className="pov-stop-text">{stop.text}</div>
                    <div className="pov-stop-coords">{stop.lat.toFixed(4)}, {stop.lon.toFixed(4)}</div>
                  </div>
                </div>
              );
            }) : <div className="pov-empty">No stops assigned</div>}
            {routeData?.endpoint && (
              <div className={`pov-stop-row ${t >= 1 ? 'reached' : ''}`}>
                <div className="pov-stop-num" style={{ background: t >= 1 ? (routeData.endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6') : 'transparent', borderColor: routeData.endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6', color: t >= 1 ? '#000' : (routeData.endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6'), fontSize: '10px', lineHeight: '1' }}>
                  {t >= 1 ? '✓' : '🚩'}
                </div>
                <div className="pov-stop-body">
                  <div className="pov-stop-sev" style={{ color: routeData.endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6' }}>
                    {routeData.endpoint.type === 'hospital' ? '🏥 HOSPITAL' : '🏠 SHELTER'}
                  </div>
                  <div className="pov-stop-text">{routeData.endpoint.name}</div>
                  <div className="pov-stop-coords">{routeData.endpoint.lat.toFixed(4)}, {routeData.endpoint.lon.toFixed(4)}</div>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Navigation POV View (static, pre-dispatch) ───────────────────────────────
function NavView({ vehicleId, vehicleData, routeData, routeStops, onClose }) {
  const navMapRef = useRef(null);
  const navMapInstanceRef = useRef(null);
  const [activeStep, setActiveStep] = useState(0);

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
      const bounds = L.latLngBounds(latlngs);
      map.fitBounds(bounds, { padding: [60, 60] });
    } else {
      map.setView([vehicleData.lat, vehicleData.lon], 14);
    }

    const vehHtml = `<div class="nav-vehicle-marker" style="border-color:${color}"><span>${vehicleData.emoji}</span></div>`;
    const vehIcon = L.divIcon({ className: '', html: vehHtml, iconSize: [48, 48], iconAnchor: [24, 24] });
    L.marker([vehicleData.lat, vehicleData.lon], { icon: vehIcon }).addTo(map);

    // FIXED: Number stops consistently - use same logic as POV view
    const allStops = routeStops || [];
    const incidentStops = allStops.filter(stop => stop.severity > 0);
   
    // Create a map of stop reference to its number
    const stopNumberMap = new Map();
    incidentStops.forEach((stop, idx) => {
      stopNumberMap.set(stop, idx + 1);
    });
   
    allStops.forEach((stop, idx) => {
      // Skip hospitals/shelters (severity 0)
      if (stop.severity === 0) return;
     
      const stopNum = stopNumberMap.get(stop);
      const col = sevCol(stop.severity);
     
      // Offset markers at same location by small amounts
      let offsetLat = stop.lat;
      let offsetLon = stop.lon;
      if (idx > 0) {
        const prevStop = allStops[idx - 1];
        const dist = distance(prevStop.lat, prevStop.lon, stop.lat, stop.lon);
        if (dist < 0.01) { // Less than ~1km apart, offset slightly
          const offset = 0.00015 * idx; // ~15 meters per stop
          offsetLat += offset;
          offsetLon += offset;
        }
      }
      const stopHtml = `<div class="nav-stop-marker" style="background:${col};border-color:${col}"><span>${stopNum}</span></div>`;
      const stopIcon = L.divIcon({ className: '', html: stopHtml, iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([offsetLat, offsetLon], { icon: stopIcon }).addTo(map);
    });

    // Add endpoint marker (hospital/shelter) with checkered flag
    const endpoint = routeData?.endpoint;
    if (endpoint) {
      const endpointColor = endpoint.type === 'hospital' ? '#ef4444' : '#8b5cf6';
      const endpointHtml = `<div class="nav-endpoint-marker" style="background:${endpointColor};border-color:${endpointColor}">🚩</div>`;
      const endpointIcon = L.divIcon({ className: '', html: endpointHtml, iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker([endpoint.lat, endpoint.lon], { icon: endpointIcon }).addTo(map);
    }

    // Hospital markers on nav map
    HOSPITALS.forEach(h => {
      const html = `<div class="facility-emoji-marker hospital-emoji-marker"><span>🏥</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([h.lat, h.lon], { icon })
        .bindTooltip(`<b>🏥 ${h.name}</b>${h.status ? `<br><span style="color:#4ade80;font-size:10px">${h.status}</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
        .addTo(map);
    });

    // Shelter markers on nav map
    SHELTERS.forEach(s => {
      const pct = s.capacity ? Math.round((s.available / s.capacity) * 100) : null;
      const html = `<div class="facility-emoji-marker shelter-emoji-marker"><span>🏠</span></div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
      L.marker([s.lat, s.lon], { icon })
        .bindTooltip(`<b>🏠 ${s.name}</b>${pct !== null ? `<br><span style="font-size:10px">${s.available}/${s.capacity} capacity (${pct}% free)</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
        .addTo(map);
    });

    navMapInstanceRef.current = map;
    return () => { map.remove(); navMapInstanceRef.current = null; };
  }, []);

  const steps = routeData?.steps || [];
  const totalDist = routeData?.distance?.toFixed(1) || '—';
  const totalTime = routeData?.duration ? Math.round(routeData.duration) : '—';
  const eta = new Date(Date.now() + (routeData?.duration || 0) * 60000);
  const etaStr = `${pad(eta.getHours())}:${pad(eta.getMinutes())}`;

  const focusStep = (idx) => {
    setActiveStep(idx);
    if (routeData?.geometry?.length && navMapInstanceRef.current) {
      const geo = routeData.geometry;
      const pos = Math.floor((idx / Math.max(steps.length - 1, 1)) * (geo.length - 1));
      navMapInstanceRef.current.setView(geo[pos], 16, { animate: true, duration: 0.8 });
    }
  };

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
            <div className="nav-stat"><div className="nav-stat-val" style={{ color }}>{totalDist} <span>km</span></div><div className="nav-stat-label">Distance to 🚩</div></div>
            <div className="nav-stat-divider"></div>
            <div className="nav-stat"><div className="nav-stat-val" style={{ color }}>{totalTime} <span>min</span></div><div className="nav-stat-label">Time Remaining</div></div>
          </div>
        </div>
        <div className="nav-side">
          <div className="nav-side-section">
            <div className="nav-side-header">ROUTE STOPS</div>
            <div className="nav-stops-scroll">
              {routeStops?.length ? routeStops.map((stop, idx) => {
                const stopNum = stop.severity > 0 ? (routeStops.filter((s, i) => i <= idx && s.severity > 0).length) : null;
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
  const mapRef = useRef(null);
  const incMarkersRef = useRef([]);
  const heatLayerRef = useRef(null);
  const vehicleMarkersRef = useRef([]); // { marker, data, animMarker? }
  const routeLinesRef = useRef([]);
  const allIncidentsRef = useRef([]);

  // Dispatch animation state
  const dispatchActiveRef = useRef(false);
  const dispatchAnimFrameRef = useRef(null);
  const dispatchStartTimeRef = useRef(null);
  // Per-vehicle progress: vehicleId -> t (0..1)
  const [dispatchProgress, setDispatchProgress] = useState({});
  const [dispatched, setDispatched] = useState(false);

  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [logs, setLogs] = useState([{ time: '00:00:00', agent: 'sys', msg: 'Agents on standby.' }]);
  const [feedIncidents, setFeedIncidents] = useState([]);
  const [incidentCount, setIncidentCount] = useState(0);
  const [agentStatus, setAgentStatus] = useState({
    social: { status: 'idle', msg: 'Standby', count: '—' },
    image: { status: 'idle', msg: 'Standby', count: '—' },
    call: { status: 'idle', msg: 'Standby', count: '—' },
    route: { status: 'idle', msg: 'Standby', count: '—' },
  });
  const [threat, setThreat] = useState({ level: 'low', label: 'THREAT: ASSESSING…' });
  const [clock, setClock] = useState('--:--:-- ET');
  const [routes, setRoutes] = useState([]);
  const [optimizing, setOptimizing] = useState(false);
  const [vehicleRoutesData, setVehicleRoutesData] = useState({});
  const [vehicleRouteStops, setVehicleRouteStops] = useState({});
  const [vehicleRouteEndpoints, setVehicleRouteEndpoints] = useState({}); // Store endpoints separately

  // View states
  const [navVehicleId, setNavVehicleId] = useState(null);   // static route view (pre-dispatch)
  const [povVehicleId, setPovVehicleId] = useState(null);   // live follow view (post-dispatch)

  const hasRoutes = Object.keys(vehicleRoutesData).length > 0;

  // Clock
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      setClock(`${formatter.format(now)} ET`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  // Map init — load simulation.json first, then build map
  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map('map', { zoomControl: true }).setView([27.9506, -82.4572], 12);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors, © CartoDB', maxZoom: 19,
    }).addTo(map);
    map.on('mousemove', (e) => {
      const el = document.getElementById('cur-lat');
      const el2 = document.getElementById('cur-lon');
      if (el) el.innerText = e.latlng.lat.toFixed(4);
      if (el2) el2.innerText = e.latlng.lng.toFixed(4);
    });
    mapRef.current = map;

    loadSimulationData().then(() => {
      // Vehicle markers
      VEHICLES.forEach(veh => {
        const col = getVehicleColor(veh.type);
        const html = `<div class="vehicle-marker" style="border-color:${col};box-shadow:0 0 10px ${col}60">
          <span class="vehicle-emoji">${veh.emoji}</span>
          <span class="vehicle-label" style="color:${col}">${veh.label}</span>
        </div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [60, 42], iconAnchor: [30, 21] });
        const marker = L.marker([veh.lat, veh.lon], { icon, zIndexOffset: 1000 });
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          if (dispatchActiveRef.current) {
            setPovVehicleId(veh.id);
          } else {
            setNavVehicleId(veh.id);
          }
        });
        marker.bindTooltip(`<b>${veh.label}</b> — ${veh.station}`, { direction: 'top', offset: [0, -10] });
        marker.addTo(map);
        vehicleMarkersRef.current.push({ marker, data: veh });
      });

      // Hospital markers — emoji only, info on hover
      HOSPITALS.forEach(h => {
        const html = `<div class="facility-emoji-marker hospital-emoji-marker"><span>🏥</span></div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
        L.marker([h.lat, h.lon], { icon, zIndexOffset: 500 })
          .bindTooltip(`<b>🏥 ${h.name}</b>${h.status ? `<br><span style="color:#4ade80;font-size:10px">${h.status}</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
          .addTo(map);
      });

      // Shelter markers — emoji only, info on hover
      SHELTERS.forEach(s => {
        const pct = s.capacity ? Math.round((s.available / s.capacity) * 100) : null;
        const html = `<div class="facility-emoji-marker shelter-emoji-marker"><span>🏠</span></div>`;
        const icon = L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
        L.marker([s.lat, s.lon], { icon, zIndexOffset: 500 })
          .bindTooltip(`<b>🏠 ${s.name}</b>${pct !== null ? `<br><span style="font-size:10px">${s.available}/${s.capacity} capacity (${pct}% free)</span>` : ''}`, { direction: 'top', offset: [0, -10], className: 'facility-tooltip' })
          .addTo(map);
      });
    });

    return () => { map.remove(); mapRef.current = null; };
  }, []);

  const addLog = (agent, msg) => {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    setLogs(prev => [...prev.slice(-80), { time: formatter.format(now), agent, msg }]);
  };

  const setAgent = (agent, status, msg, count = null) => {
    setAgentStatus(prev => ({ ...prev, [agent]: { status, msg, count: count !== null ? count : prev[agent].count } }));
  };

  const addIncident = (incident, source) => {
    setFeedIncidents(prev => [{ ...incident, source }, ...prev]);
    const col = sevCol(incident.severity);
    const short = incident.text.length > 36 ? incident.text.substring(0, 34) + '…' : incident.text;
    const html = `<div class="inc-pin">
      <div class="inc-label" style="color:${col};border-color:${col}40;display:none;">${short}</div>
      <div class="inc-dot" style="background:${col}20;border-color:${col};cursor:pointer;"></div>
    </div>`;
    const icon = L.divIcon({ className: 'inc-marker-wrap', html, iconSize: [185, 52], iconAnchor: [92, 52] });
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
    setDispatched(false);
    stopDispatch();
  };

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const optimizeRoutes = async (incidents) => {
    if (!incidents.length) return;
    setOptimizing(true);
    setAgent('route', 'active', 'Optimizing routes…');
    addLog('route', 'Initializing route optimization across all units…');
    const currentRoutes = buildInitialRoutes(incidents, VEHICLES);
    const newVehicleRoutes = {};
    const newVehicleStops = {};
    for (const route of currentRoutes) {
      const vehicle = VEHICLES.find(v => v.id === route.vehicleId);
      if (!vehicle) continue;

      // Separate endpoint (last stop with severity 0 = hospital/shelter) from incident stops
      const allStops = route.stops;
      const lastStop = allStops[allStops.length - 1];
      const hasEndpoint = lastStop && lastStop.severity === 0;
      const incidentStops = hasEndpoint ? allStops.slice(0, -1) : allStops;
      const endpoint = hasEndpoint ? {
        lat: lastStop.lat,
        lon: lastStop.lon,
        name: lastStop.text.replace(/^Hospital: |^Shelter: /, ''),
        type: lastStop.incidentId?.startsWith('hospital') ? 'hospital' : 'shelter',
      } : null;

      const start = { lat: route.startLat, lon: route.startLon };
      const waypoints = [...incidentStops.map(s => ({ lat: s.lat, lon: s.lon }))];
      if (endpoint) waypoints.push({ lat: endpoint.lat, lon: endpoint.lon });
      const fullRoute = await buildFullRoute(start, waypoints);
      if (fullRoute) {
        newVehicleRoutes[vehicle.id] = { ...fullRoute, endpoint };
        newVehicleStops[vehicle.id] = incidentStops;
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

  const completedAgentsSet = useRef(new Set());

  const processBackendStream = async (reader, decoder, completionCallback) => {
    const agentCounts = { social: 0, image: 0, call: 0 };
    let buffer = '';
    let allIncidents = [];
    while (true) {
      let readResult;
      try { readResult = await reader.read(); } catch (e) { break; }
      const { done, value } = readResult;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines[lines.length - 1];
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.substring(6)); } catch (e) { continue; }
        if (event.type === 'incident') {
          const incident = event.incident;
          addIncident(incident, incident.source);
          allIncidents.push(incident);
          if (incident.source === 'SOCIAL MEDIA' && !completedAgentsSet.current.has('social')) { agentCounts.social++; setAgent('social', 'active', 'Filtering social media…', agentCounts.social); }
          else if (incident.source === 'SATELLITE IMAGE' && !completedAgentsSet.current.has('image')) { agentCounts.image++; setAgent('image', 'active', 'Processing imagery…', agentCounts.image); }
          else if (incident.source === '911 DISPATCH' && !completedAgentsSet.current.has('call')) { agentCounts.call++; setAgent('call', 'active', 'Processing 911 calls…', agentCounts.call); }
        } else if (event.type === 'agent_log') {
          const agentMap = { 'social_media_agent': 'social', 'satellite_agent': 'image', 'call_agent': 'call', 'dispatch_agent': 'route', 'route_agent': 'route' };
          const agent = agentMap[event.agent] || event.agent;
          // Prefix route agent messages with [ROUTE] tag embedded in message for log rendering
          const msg = agent === 'route' ? event.content : event.content;
          addLog(agent, msg);
          if (event.content.includes('✓ Complete')) {
            if (event.agent === 'social_media_agent') {
              completedAgentsSet.current.add('social');
              setAgent('social', 'done', 'Complete', agentCounts.social);
              // Immediately set image agent as processing
              setAgent('image', 'active', 'Processing satellite imagery…');
              addLog('image', 'Analyzing satellite imagery for damage signatures…');
            }
            else if (event.agent === 'satellite_agent') {
              completedAgentsSet.current.add('image');
              setAgent('image', 'done', 'Complete', agentCounts.image);
              // Immediately set call agent as processing
              setAgent('call', 'active', 'Processing 911 transcripts…');
              addLog('call', 'Transcribing and triaging 911 call queue…');
            }
            else if (event.agent === 'call_agent') {
              completedAgentsSet.current.add('call');
              setAgent('call', 'done', 'Complete', agentCounts.call);
              // Immediately set route agent as processing
              setAgent('route', 'active', 'Calculating optimal routes…');
              addLog('route', 'Initializing route optimization across all units…');
            }
          }
        } else if (event.type === 'routes') {
          setAgent('route', 'active', 'Loading route geometry…');
          await processRoutes(event.routes || [], (event.routes || []).length);
        } else if (event.type === 'system') { if (event.message !== 'Agents started.') addLog('sys', event.message); }
        else if (event.type === 'complete') {
          addLog('route', event.message || `✓ Complete — routes assigned`);
        }
        else if (event.type === 'error') { addLog('sys', `Error: ${event.message}`); }
      }
    }
    completionCallback(allIncidents);
  };

  const processRoutes = async (routes, routeCount) => {
    const newVehicleRoutes = {};
    const newVehicleStops = {};
    const newVehicleEndpoints = {}; // Store endpoints separately
   
    for (const route of routes) {
      const stops = route.stops || [];
     
      // Check if backend already provided geometry (from OSRM)
      if (route.geometry && route.geometry.length > 0) {
        newVehicleRoutes[route.vehicleId] = {
          geometry: route.geometry,
          distance: route.distance || 0,
          duration: route.duration || 0,
          steps: route.steps || [],
          source: 'backend-osrm',
          endpoint: route.endpoint || null,
        };
        newVehicleStops[route.vehicleId] = stops;
        // Store endpoint separately (not in stops)
        if (route.endpoint) {
          newVehicleEndpoints[route.vehicleId] = route.endpoint;
        }
      } else {
        // NO FALLBACK - If no geometry from backend, skip this route
        console.warn(`Route for ${route.vehicleId} has no geometry - route discarded`);
        continue;
      }
      await sleep(300);
    }
    setVehicleRoutesData(newVehicleRoutes);
    setVehicleRouteStops(newVehicleStops);
    setVehicleRouteEndpoints(newVehicleEndpoints); // Set endpoints separately
   
    setRoutes(routes);
    // Ensure route lines are not shown on general map until dispatch
    routeLinesRef.current.forEach(line => { try { mapRef.current?.removeLayer(line); } catch(e) {} });
    routeLinesRef.current = [];
    setAgent('route', 'done', 'Complete', `${routeCount} routes`);
  };

  // ─── DISPATCH ANIMATION ─────────────────────────────────────────────────────
  // Duration: simulate a 30-second full traversal for demo effect
  const DISPATCH_DURATION_MS = 20000; // 20 seconds for full route

  // Moving vehicle markers on the main map (separate from static icons)
  const dispatchMarkersRef = useRef({}); // vehicleId -> L.Marker

  const stopDispatch = () => {
    dispatchActiveRef.current = false;
    if (dispatchAnimFrameRef.current) {
      cancelAnimationFrame(dispatchAnimFrameRef.current);
      dispatchAnimFrameRef.current = null;
    }
    // Remove dispatch markers
    Object.values(dispatchMarkersRef.current).forEach(m => {
      try { mapRef.current?.removeLayer(m); } catch(e) {}
    });
    dispatchMarkersRef.current = {};
  };

  // We keep a ref to the latest vehicleRoutesData so animation frame can read it
  const vehicleRoutesDataRef = useRef({});
  useEffect(() => { vehicleRoutesDataRef.current = vehicleRoutesData; }, [vehicleRoutesData]);
  const dispatchProgressRef = useRef({});
  useEffect(() => { dispatchProgressRef.current = dispatchProgress; }, [dispatchProgress]);

  const startDispatch = useCallback(() => {
    if (dispatched) return;
    const vrdKeys = Object.keys(vehicleRoutesDataRef.current);
    if (!vrdKeys.length) return;

    setDispatched(true);
    dispatchActiveRef.current = true;
    dispatchStartTimeRef.current = performance.now();

    // Hide static vehicle markers, create animated ones
    vehicleMarkersRef.current.forEach(({ marker, data }) => {
      if (!vehicleRoutesDataRef.current[data.id]) return;
      // Hide static marker label to avoid clutter but keep it for click
      marker.setOpacity(0.25);
    });

    // Create dispatch markers for vehicles with routes
    vrdKeys.forEach(vehicleId => {
      const vehData = VEHICLES.find(v => v.id === vehicleId);
      if (!vehData) return;
      const col = getVehicleColor(vehData.type);
      const geo = vehicleRoutesDataRef.current[vehicleId]?.geometry;
      if (!geo || geo.length === 0) return;

      const html = `<div class="dispatch-marker" style="border-color:${col};box-shadow:0 0 0 3px ${col}50,0 0 16px ${col}80" id="dm-${vehicleId}">
        <span class="dispatch-emoji">${vehData.emoji}</span>
        <span class="dispatch-label" style="color:${col}">${vehData.label}</span>
        <div class="dispatch-pulse" style="border-color:${col}"></div>
      </div>`;
      const icon = L.divIcon({ className: '', html, iconSize: [62, 44], iconAnchor: [31, 22] });
      const marker = L.marker(geo[0], { icon, zIndexOffset: 2000 });
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        setPovVehicleId(vehicleId);
      });
      marker.addTo(mapRef.current);
      dispatchMarkersRef.current[vehicleId] = marker;
    });

    // Draw route lines on map
    routeLinesRef.current.forEach(l => { try { mapRef.current?.removeLayer(l); } catch(e) {} });
    routeLinesRef.current = [];
    vrdKeys.forEach((vehicleId, idx) => {
      const geo = vehicleRoutesDataRef.current[vehicleId]?.geometry;
      if (!geo || geo.length < 2) return;
      const vehData = VEHICLES.find(v => v.id === vehicleId);
      const col = getVehicleColor(vehData?.type || 'ambulance');
      // Ghost route
      const ghostLine = L.polyline(geo, { color: col, weight: 4, opacity: 0.22, dashArray: '8 6' }).addTo(mapRef.current);
      // Traveled line (will be updated)
      const traveledLine = L.polyline([], { color: col, weight: 5, opacity: 0.85 }).addTo(mapRef.current);
      routeLinesRef.current.push(ghostLine, traveledLine);
      dispatchMarkersRef.current[`${vehicleId}_traveled`] = traveledLine;
    });

    // Animation loop
    const animate = (now) => {
      if (!dispatchActiveRef.current) return;
      const elapsed = now - dispatchStartTimeRef.current;
      const newProgress = {};
      let allDone = true;

      Object.keys(vehicleRoutesDataRef.current).forEach(vehicleId => {
        const geo = vehicleRoutesDataRef.current[vehicleId]?.geometry;
        if (!geo || geo.length === 0) { newProgress[vehicleId] = 1; return; }

        const t = Math.min(elapsed / DISPATCH_DURATION_MS, 1);
        newProgress[vehicleId] = t;
        if (t < 1) allDone = false;

        // Update marker position
        const pos = interpolateGeometry(geo, t);
        if (pos && dispatchMarkersRef.current[vehicleId]) {
          dispatchMarkersRef.current[vehicleId].setLatLng(pos);
        }

        // Update traveled line
        const traveledLine = dispatchMarkersRef.current[`${vehicleId}_traveled`];
        if (traveledLine && geo.length > 1) {
          const cutIdx = Math.ceil(t * (geo.length - 1));
          const traveledGeo = geo.slice(0, cutIdx + 1);
          const lastPos = interpolateGeometry(geo, t);
          if (lastPos) traveledGeo[traveledGeo.length - 1] = lastPos;
          traveledLine.setLatLngs(traveledGeo);
        }

        if (t >= 1) {
          // Mark as arrived
          const el = dispatchMarkersRef.current[vehicleId]?.getElement();
          if (el) el.classList.add('arrived');
        }
      });

      setDispatchProgress({ ...newProgress });

      if (!allDone) {
        dispatchAnimFrameRef.current = requestAnimationFrame(animate);
      } else {
        dispatchActiveRef.current = false;
        addLog('sys', '✓ All units have reached their destinations.');
      }
    };

    dispatchAnimFrameRef.current = requestAnimationFrame(animate);
    addLog('sys', `🚨 DISPATCH — ${vrdKeys.length} units en route.`);
  }, [dispatched, vehicleRoutesData]);

  const runSimulation = async () => {
    if (running || optimizing) return;
    setRunning(true);
    setHasRun(true);
    clearMap();
    setFeedIncidents([]);
    setIncidentCount(0);
    allIncidentsRef.current = [];
    completedAgentsSet.current.clear();

    // [SYS] first, then immediately show social agent as processing to hide latency
    const now = new Date();
    const formatter0 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const t0 = formatter0.format(now);
    setLogs([
      { time: t0, agent: 'sys', msg: 'Agents started.' },
      { time: t0, agent: 'social', msg: 'Scanning social media for distress signals…' },
    ]);
    setAgentStatus({
      social: { status: 'active', msg: 'Scanning social media…', count: '—' },
      image: { status: 'idle', msg: 'Standby', count: '—' },
      call: { status: 'idle', msg: 'Standby', count: '—' },
      route: { status: 'idle', msg: 'Standby', count: '—' },
    });

    const progressWrap = document.getElementById('progress-wrap');
    const progressBar = document.getElementById('progress-bar');
    const scanLine = document.getElementById('scan-line');
    if (progressWrap) progressWrap.style.display = 'block';
    if (scanLine) scanLine.classList.add('on');
    const setProg = (pct) => { if (progressBar) progressBar.style.width = pct + '%'; };
    setProg(5);

    let backendSuccess = false;
    try {
      const response = await fetch('http://localhost:8000/run_simulation');
      if (!response.ok) throw new Error(`Backend API failed`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      await processBackendStream(reader, decoder, (allIncidents) => {
        setProg(85);
        updateMapWithIncidents(allIncidents);
        setProg(100);
      });
      backendSuccess = true;
    } catch (e) {
      addLog('sys', `Backend unavailable, using local simulation`);
    }

    if (!backendSuccess) await runLocalSimulation();

    setTimeout(() => { if (progressWrap) progressWrap.style.display = 'none'; }, 900);
    if (scanLine) scanLine.classList.remove('on');
    setRunning(false);
  };

  const updateMapWithIncidents = (allIncidents) => {
    allIncidentsRef.current = allIncidents;
    setIncidentCount(allIncidents.length);
    if (allIncidents.length > 0) setThreat(calcThreat(allIncidents));
    const heatPoints = allIncidents.map(p => [p.lat, p.lon, p.severity]);
    if (heatLayerRef.current && mapRef.current) mapRef.current.removeLayer(heatLayerRef.current);
    if (mapRef.current && heatPoints.length > 0) {
      heatLayerRef.current = L.heatLayer(heatPoints, {
        radius: 42, blur: 26, maxZoom: 17, max: 1.0,
        gradient: { 0.0: '#22c55e', 0.28: '#eab308', 0.52: '#f59e0b', 0.72: '#f97316', 1.0: '#ef4444' }
      }).addTo(mapRef.current);
    }
  };

  const runLocalSimulation = async () => {
    const allIncidents = [];
    const progressBar = document.getElementById('progress-bar');
    const setProg = (pct) => { if (progressBar) progressBar.style.width = pct + '%'; };

    // Social agent already set to active + first log in runSimulation before this is called
    setProg(10);
    await sleep(700);
    for (let i = 0; i < SOCIAL_POSTS.length; i++) {
      const post = SOCIAL_POSTS[i];
      const incident = { ...post, id: `social-${i}`, severity: computeSeverity(post.text), text: post.text };
      addIncident(incident, 'SOCIAL MEDIA');
      allIncidents.push(incident);
      setProg(10 + (i / SOCIAL_POSTS.length) * 17);
      await sleep(200);
    }
    setAgent('social', 'done', 'Complete', `${SOCIAL_POSTS.length} signals`);
    await sleep(100);

    // Immediately activate image agent
    setAgent('image', 'active', 'Processing satellite imagery…');
    addLog('image', 'Analyzing satellite imagery for damage signatures…');
    setProg(30);
    await sleep(900);
    for (let i = 0; i < SATELLITE_DETECTIONS.length; i++) {
      const sat = SATELLITE_DETECTIONS[i];
      const incident = { text: sat.text, lat: sat.lat, lon: sat.lon, id: `sat-${i}`, severity: sat.type === 'fire' ? 0.9 : 0.7 };
      addIncident(incident, 'SATELLITE IMAGE');
      allIncidents.push(incident);
      setProg(30 + (i / SATELLITE_DETECTIONS.length) * 16);
      await sleep(200);
    }
    setAgent('image', 'done', 'Complete', `${SATELLITE_DETECTIONS.length} detections`);
    await sleep(100);

    // Immediately activate call agent
    setAgent('call', 'active', 'Processing 911 transcripts…');
    addLog('call', 'Transcribing and triaging 911 call queue…');
    setProg(50);
    await sleep(650);
    for (let i = 0; i < CALL_TRANSCRIPTS.length; i++) {
      const call = CALL_TRANSCRIPTS[i];
      const incident = { ...call, id: `call-${i}`, severity: computeSeverity(call.text), text: call.text };
      addIncident(incident, '911 DISPATCH');
      allIncidents.push(incident);
      setProg(50 + (i / CALL_TRANSCRIPTS.length) * 17);
      await sleep(220);
    }
    setAgent('call', 'done', 'Complete', `${CALL_TRANSCRIPTS.length} calls`);
    await sleep(100);

    // Immediately activate route agent
    setAgent('route', 'active', 'Calculating optimal routes…');

    allIncidentsRef.current = allIncidents;
    setIncidentCount(allIncidents.length);
    setThreat(calcThreat(allIncidents));

    const heatPoints = allIncidents.map(p => [p.lat, p.lon, p.severity]);
    if (heatLayerRef.current && mapRef.current) mapRef.current.removeLayer(heatLayerRef.current);
    if (mapRef.current) {
      heatLayerRef.current = L.heatLayer(heatPoints, {
        radius: 42, blur: 26, maxZoom: 17, max: 1.0,
        gradient: { 0.0: '#22c55e', 0.28: '#eab308', 0.52: '#f59e0b', 0.72: '#f97316', 1.0: '#ef4444' }
      }).addTo(mapRef.current);
    }
    await sleep(400);
    setProg(70);
    await optimizeRoutes(allIncidents);
    addLog('sys', 'Routes ready. Click DISPATCH to deploy all units.');
    setProg(100);
  };

  // Derived
  const navVehicle = navVehicleId ? VEHICLES.find(v => v.id === navVehicleId) : null;
  const navRouteData = navVehicleId ? vehicleRoutesData[navVehicleId] : null;
  const navStops = navVehicleId ? (vehicleRouteStops[navVehicleId] || []) : [];

  const povVehicle = povVehicleId ? VEHICLES.find(v => v.id === povVehicleId) : null;
  const povRouteData = povVehicleId ? vehicleRoutesData[povVehicleId] : null;
  const povStops = povVehicleId ? (vehicleRouteStops[povVehicleId] || []) : [];

  const allComplete = dispatched && Object.values(dispatchProgress).every(t => t >= 1) && Object.keys(dispatchProgress).length > 0;

  return (
    <div className="app">
      {/* Static route view (pre-dispatch) */}
      {navVehicleId && navVehicle && !dispatched && (
        <NavView vehicleId={navVehicleId} vehicleData={navVehicle} routeData={navRouteData} routeStops={navStops} onClose={() => setNavVehicleId(null)} />
      )}

      {/* Live POV follow view (post-dispatch) */}
      {povVehicleId && povVehicle && dispatched && (
        <PovView
          vehicleId={povVehicleId}
          vehicleData={povVehicle}
          routeData={povRouteData}
          routeStops={povStops}
          dispatchProgress={dispatchProgress}
          onClose={() => setPovVehicleId(null)}
        />
      )}

      <div className={`app-main ${(navVehicleId && !dispatched) || (povVehicleId && dispatched) ? 'app-hidden' : ''}`}>
        <div className="topbar">
          <div className="logo">
            <div className="logo-emoji">🚑</div>
            <div className="logo-text">Dispatch</div>
          </div>
          <div className="topbar-right">
            <div className="clock">{clock}</div>
            {dispatched && !allComplete && (
              <div className="dispatch-status-badge">
                <span className="dispatch-pulse-dot"></span>
                UNITS EN ROUTE
              </div>
            )}
            {allComplete && <div className="dispatch-complete-badge">✓ ALL UNITS ARRIVED</div>}
            <div className={`threat-badge level-${threat.level}`}>{threat.label}</div>
          </div>
        </div>

        <div className="layout">
          {/* Left panel */}
          <div className="left-panel">
            <div className="ph">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="4" stroke="#8fa3b8" strokeWidth="1.2"/><path d="M5.5 3.5V6.5M5.5 7.5V8" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round"/></svg>
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
                      {agent === 'image' && 'Satellite Image Agent'}
                      {agent === 'call' && '911 Call Agent'}
                      {agent === 'route' && 'Route Agent'}
                    </div>
                    <div className="ag-sub">{agentStatus[agent].msg}</div>
                  </div>
                  <div className="ag-count">{agentStatus[agent].count}</div>
                </div>
              ))}
            </div>

            {/* Vehicle legend with progress bars when dispatched */}
            {Object.keys(vehicleRoutesData).length > 0 && (
              <div className="vehicles-legend">
                <div className="ph" style={{ borderTop: '1px solid var(--border)' }}>
                  <span className="ph-label">
                    {dispatched ? 'Live Unit Tracker' : 'Vehicles — Click to Navigate'}
                  </span>
                </div>
                {VEHICLES.map((veh) => {
                  const hasRoute = !!vehicleRoutesData[veh.id];
                  const col = getVehicleColor(veh.type);
                  const stops = vehicleRouteStops[veh.id]?.length || 0;
                  const prog = dispatchProgress[veh.id] ?? 0;
                  const vehComplete = dispatched && prog >= 1;
                  return (
                    <div
                      key={veh.id}
                      className={`vehicle-row ${hasRoute ? 'clickable' : ''}`}
                      onClick={() => {
                        if (!hasRoute) return;
                        if (dispatched) setPovVehicleId(veh.id);
                        else setNavVehicleId(veh.id);
                      }}
                      style={{ borderLeft: `3px solid ${col}` }}
                    >
                      <span className="veh-emoji">{veh.emoji}</span>
                      <div className="veh-info">
                        <div className="veh-name">{veh.label}</div>
                        {dispatched && hasRoute ? (
                          <div className="veh-progress-wrap">
                            <div className="veh-progress-track">
                              <div className="veh-progress-fill" style={{ width: `${prog * 100}%`, background: col }}></div>
                            </div>
                            <span className="veh-progress-pct" style={{ color: vehComplete ? col : 'var(--text-dim)' }}>
                              {vehComplete ? '✓ ARRIVED' : `${Math.round(prog * 100)}%`}
                            </span>
                          </div>
                        ) : (
                          <div className="veh-detail">
                            {hasRoute
                              ? `${vehicleRoutesData[veh.id].distance.toFixed(1)} km · ${Math.round(vehicleRoutesData[veh.id].duration)} min · ${stops} stops 🚩`
                              : 'No route assigned'}
                          </div>
                        )}
                      </div>
                      {hasRoute && (
                        <span className="veh-nav-btn" style={{ color: col }}>
                          {dispatched ? 'POV →' : 'NAV →'}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="metrics-strip">
              <div className="met"><div className="met-label">Incidents Detected</div><div className="met-val c-red">{incidentCount}</div></div>
              <div className="met"><div className="met-label">Agents Complete</div><div className="met-val c-green">{Object.values(agentStatus).filter(a => a.status === 'done').length}/4</div></div>
            </div>

            <div className="run-wrap">
              {/* Dispatch button — shown when routes are ready and not yet dispatched */}
              {hasRoutes && !dispatched && (
                <button
                  className="dispatch-btn"
                  onClick={startDispatch}
                  disabled={running || optimizing}
                >
                  <span className="dispatch-btn-icon">🚨</span>
                  <span>DISPATCH ALL UNITS</span>
                  <span className="dispatch-btn-count">{Object.keys(vehicleRoutesData).length}</span>
                </button>
              )}
              {dispatched && (
                <div className="dispatch-live-indicator">
                  {allComplete ? (
                    <span style={{ color: '#16a34a' }}>✓ Mission Complete</span>
                  ) : (
                    <>
                      <span className="dispatch-pulse-dot"></span>
                      <span style={{ color: 'var(--red)' }}>DISPATCHED — Click a unit for POV</span>
                    </>
                  )}
                </div>
              )}
              <button id="run-btn" onClick={runSimulation} className={running || optimizing ? 'running' : ''} disabled={running || optimizing || hasRun}>
                <span>{running ? '⟳ Agents Running…' : optimizing ? '⟳ Optimizing Routes…' : '▶ Start Agents'}</span>
              </button>
            </div>
          </div>

          {/* Map */}
          <div className="map-area">
            <div id="progress-wrap"><div id="progress-bar"></div></div>
            <div id="scan-line"></div>
            <div id="map"></div>
            {dispatched && !allComplete && (
              <div className="map-dispatch-banner">
                🚨 UNITS DISPATCHED — Click any moving vehicle for POV navigation
              </div>
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
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 8L4 5L6 7L9 3" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
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
              <div className="log-head"><div className="log-dot"></div><span className="log-lbl">Agent Log</span></div>
              <div className="log-out" id="log-out">
                {logs.map((log, i) => (
                  <div className="ll" key={i}>
                    <span className="ll-time">{log.time}</span>
                    <span className={`ll-ag ${log.agent}`}>
                      {log.agent === 'social' && '[SOCIAL]'}
                      {log.agent === 'image' && '[IMAGE]'}
                      {log.agent === 'call' && '[911]'}
                      {log.agent === 'route' && '[ROUTE]'}
                      {log.agent === 'sys' && '[SYS]'}
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