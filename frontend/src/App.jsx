import { useState, useEffect } from 'react';
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

function App() {
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

  return (
    <div className="app">
      <div className="app-main">
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
      </div>
    </div>
  );
}

export default App;