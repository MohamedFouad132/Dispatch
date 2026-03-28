import { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Helper functions

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
  if (crit === 0 && score < 2)   return { level: 'low',      label: 'THREAT: LOW' };
  if (crit === 0 && score < 5)   return { level: 'guarded',  label: 'THREAT: GUARDED' };
  if (crit <= 2  && score < 12)  return { level: 'elevated', label: 'THREAT: ELEVATED' };
  if (crit <= 4  && score < 22)  return { level: 'high',     label: 'THREAT: HIGH' };
  return                                { level: 'critical',  label: 'THREAT: CRITICAL' };
};

let VEHICLES   = [];
let HOSPITALS  = [];
let SHELTERS   = [];
let SOCIAL_POSTS         = [];
let SATELLITE_DETECTIONS = [];
let CALL_TRANSCRIPTS     = [];

async function loadSimulationData() {
  const res  = await fetch('/simulation.json');
  const data = await res.json();
  const resources    = data.resources || {};
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
      id:      v.id,
      type,
      emoji:   v.emoji,
      lat:     v.lat,
      lon:     v.lon,
      label:   v.id,
    };
  });

  HOSPITALS  = (data.hospitals  || []).map(h => ({ name: h.name, lat: h.lat, lon: h.lon, status: h.status }));
  SHELTERS   = (data.shelters   || []).map(s => ({ name: s.name, lat: s.lat, lon: s.lon, capacity: s.capacity, available: s.available }));
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


function App() {
  const mapRef            = useRef(null);
  const vehicleMarkersRef = useRef([]);
 
  const [threat, setThreat] = useState({ level: 'low', label: 'THREAT: ASSESSING…' });
  const [clock,  setClock]  = useState('--:--:-- ET');
 
  // Live clock
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
      attribution: '© OpenStreetMap contributors, © CartoDB',
      maxZoom: 19,
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
 
      // Hospital markers
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
 
      // Shelter markers
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
              <span className="ph-badge">0 / 4</span>
            </div>
            <div className="panel-placeholder">
              Agents will appear here
            </div>
          </div>
 
          {/* Map area */}
          <div className="map-area">
            <div id="map"></div>
            <div className="map-foot">
              <div className="mf-stat">LAT <span id="cur-lat">—</span></div>
              <div className="mf-stat">LON <span id="cur-lon">—</span></div>
              <div className="mf-stat" style={{ marginLeft: 'auto' }}>
                Tampa Bay, FL · Emergency Coordination
              </div>
            </div>
          </div>
 
          {/* Right panel */}
          <div className="right-panel">
            <div className="ph">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M1 8L4 5L6 7L9 3" stroke="#8fa3b8" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span className="ph-label">Incident Feed</span>
              <span className="ph-badge">0</span>
            </div>
            <div className="panel-placeholder">
              Incidents will appear here
            </div>
          </div>
 
        </div>
      </div>
    </div>
  );
}
 
export default App;