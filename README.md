# 🚑 Dispatch
A real-time multi-agent disaster response system that turns chaos into coordinated action.

---

## 💡 What is Dispatch?

When a natural disaster hits a city, emergencies need quick and efficient assistance.

Dispatch is a real-time disaster response coordination system built with Google ADK, FastAPI, and React. During a city-wide natural disaster, the system ingests data from three independent sources (social media, satellite imagery, and 911 dispatch), aggregates incidents using a sequential multi-agent pipeline, and computes optimal emergency vehicle routes using OSRM. Results are streamed live to a React frontend via Server-Sent Events.

---

## Demo Link

https://www.youtube.com/watch?v=jyGvXaRvekI&t=133s

---

## ✨ Features

- **📡 Multi-Source Incident Ingestion** — Three AI agents process social media posts, satellite imagery detections, and 911 call transcripts independently, each producing structured, severity-scored incident reports.
- **🧠 Severity-Aware Classification** — Each agent applies a detailed 0.0–1.0 scoring guide calibrated to incident type with imminent death risk scoring between 0.90–1.00.
- **🗺️ Optimal Route Computation** — A route optimizer classifies incidents by type (fire, medical, general), distributes them across available vehicles using nearest-neighbor heuristics, and fetches real road-following geometry from OSRM.
- **📺 Live SSE Streaming** — Incidents appear on the map one by one as agents finish processing, followed by animated vehicle route overlays.
- **🔁 Sequential Agent Pipeline** — Built on Google ADK's `SequentialAgent`, ensuring incident data from earlier agents is available in session state when the route agent runs.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite |
| Backend | Python, FastAPI |
| Agent Framework | Google ADK |
| Routing | OSRM (Open Source Routing Machine) |
| Streaming | Server-Sent Events (SSE) |

---

## 🚀 Getting Started

### Prerequisites

- Python 3.11+
- Node.js 18+
- A Google Cloud project with the Gemini API enabled
- A `.env` file in `backend/` containing your API key

### Setup

```bash
# Clone the repository
git clone https://github.com/MohamedFouad132/Dispatch
cd Dispatch

# frontend
cd frontend
npm install
npm run dev

# backend
cd ../backend
pip install -r requirements.txt
python app.py # if running on mac, use python3
```

Then open [http://localhost:5173](http://localhost:5173).

---

## 🧠 How It Works

```
Google ADK SequentialAgent
- social media posts ─┐
- satellite imagery  ─┼─→ Incident Reports (severity scored)
- 911 transcripts    ─┘         │
                                ▼
                            Route Agent
                                │
                            OSRM Routing
                                │
                                ▼
                            React Frontend (SSE)
                    Live map · Incident feed · Agent log
```

The three data agents run in sequence, each storing their structured incident output in ADK session state. The route agent then reads all incident data, classifies each incident by type, and assigns them to the nearest available vehicle with no capacity limits. OSRM fetches real driving routes with turn-by-turn geometry. Everything streams to the frontend live as it happens.

---

## 📁 Project Structure

```
backend/
├── app.py                        # FastAPI — /resources and /run_simulation (SSE)
├── data/
│   └── simulation.json           # Simulated incidents, vehicles, hospitals, shelters
└── agents/
    ├── agent.py                  # Root SequentialAgent
    └── sub_agents/
        ├── social_media_agent/agent.py
        ├── satellite_agent/agent.py
        ├── call_agent/agent.py
        └── route_agent/
            ├── agent.py          # Aggregates incidents, calls optimizer
            └── route_optimizer.py # Haversine, nearest-neighbor, OSRM

frontend/
├── src/
│   ├── App.jsx                   # Map, SSE consumer, agent log panel
│   └── App.css
├── package.json
└── vite.config.js
```

---

## 🌆 What Does Dispatch Solve?

When disaster strikes, information comes from everywhere and chaos results in delay of aid. 911 dispatchers are overwhelmed and social media is flooded with unread posts. This can lead to unecessary deaths that could have been prevented by efficiently routing available resources. Dispatch changes that. It pulls every signal into one pipeline, figures out what's urgent, and gets the right vehicle moving faster than any human team could.

---

## 🏆 Built At

This project was built during **HackUSF** a **24-hour hackathon**.

---

## 👥 Team

| Name | Role |
|---|---|
| Menna | Backend |
| Mohamed | Frontend |
