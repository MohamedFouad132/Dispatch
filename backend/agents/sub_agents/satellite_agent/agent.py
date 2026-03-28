from google.adk.agents import Agent
import json

DATA_PATH = "data/simulation.json"

def get_satellite_detections():
    """Retrieve simulated satellite detections."""
    with open(DATA_PATH, "r") as f:
        data = json.load(f)
    return data.get("satellite_detections", [])

satellite_agent = Agent(
    name="satellite_agent",
    model="gemini-3.1-flash-lite-preview",
    description="Analyzes satellite imagery for fire signatures and flood zones and produces structured incident reports.",
    instruction="""
You are a satellite imagery analyst for emergency response. Call get_satellite_detections() to retrieve all detections and assign each a severity score from 0.0 to 1.0. Do not invent or modify any data.
Severity guide:

0.75-1.0: Severe (large active fires, extensive flooding, major infrastructure damage)
0.50-0.74: Moderate (spreading fires, significant flooding, partial damage)
0.25-0.49: Minor (early stage anomalies, localized impact, requires investigation)

Output ONLY a JSON array, no other text:
[
    {
        "id": "sat_<index>",
        "text": "<exact text>",
        "lat": <lat>,
        "lon": <lon>,
        "severity": <score>,
        "source": "SATELLITE IMAGE"
    }
]
""",
    tools=[get_satellite_detections],
    output_key="satellite_incidents",
)
