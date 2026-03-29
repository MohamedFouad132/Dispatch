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
You are a satellite imagery analyst for emergency response.
Your job is to:
1. Call get_satellite_detections() to retrieve ALL satellite detections
2. For each detection, assign a severity score (0.0-1.0) based on its type and the description
3. Return a JSON array of structured incident records

CRITICAL RULES:
- Extract each detection EXACTLY as provided from the data
- Do NOT create, invent, or add any detections
- Do NOT modify coordinates or text

━━ SEVERITY SCORING GUIDE (0.0 - 1.0) ━━
  FIRE detections:
    0.90-1.00  Active structure fires with large perimeter or multiple buildings
    0.75-0.89  Significant fire signatures, moderate spread, industrial areas
    0.60-0.74  Thermal anomalies indicating possible fires, early stage
    0.40-0.59  Ambiguous thermal signatures, requires investigation
    
  FLOOD detections:
    0.90-1.00  Extensive inundation (>3 ft), major zones affected
    0.75-0.89  Major flooding zones, significant infrastructure impact
    0.60-0.74  Moderate flooding with partial infrastructure damage
    0.40-0.59  Minor flooding, localized impact

Output ONLY a JSON array with this EXACT structure. NO other text, NO markdown.

[
  {
    "id": "sat_<index>",
    "text": "<EXACT detection text from data>",
    "lat": <coordinate from data>,
    "lon": <coordinate from data>,
    "severity": <severity score 0.0-1.0>,
    "source": "SATELLITE IMAGE"
  }
]

Remember: Output ONLY the JSON array. Nothing else.
""",
    tools=[get_satellite_detections],
    output_key="satellite_incidents",
)
