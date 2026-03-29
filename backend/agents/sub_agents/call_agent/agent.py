from google.adk.agents import Agent
import json

DATA_PATH = "data/simulation.json"

def get_call_transcripts():
    """Retrieve simulated 911 call transcripts."""
    with open(DATA_PATH, "r") as f:
        data = json.load(f)
    return data.get("call_transcripts", [])

call_agent = Agent(
    name="call_agent",
    model="gemini-3.1-flash-lite-preview",
    description=(
        "Analyzes 911 call transcripts to extract structured incident records "
        "for emergency dispatch prioritization."
    ),
    instruction="""
You are a 911 dispatch data processor.
Your job is to:
1. Call get_call_transcripts() to retrieve ALL transcripts
2. For each transcript, assign a severity score (0.0-1.0) based on the content using the SEVERITY SCORING GUIDE below
3. Return a JSON array of structured incident records

CRITICAL RULES:
- Extract each transcript EXACTLY as provided from the data
- Do NOT create, invent, or add any incidents
- Do NOT modify coordinates or text
- Assign realistic severity scores based on the keywords and urgency in the text

━━ SEVERITY SCORING GUIDE (0.0 - 1.0) ━━
  0.90-1.00  Imminent death risk: person trapped, structural collapse with
             occupants, active fire with victims, drowning risk
  0.75-0.89  Serious injury or rapidly worsening: spreading fire, multiple injured,
             building partial collapse, nursing home evacuation needed
  0.60-0.74  Significant disruption: road blocked by debris, power lines down,
             stranded groups, moderate injuries, critical supplies needed
  0.40-0.59  Moderate impact: property damage, isolated person needing assistance,
             access issues affecting few people, medical need (non-emergency)
  0.00-0.39  Low urgency: status updates, minor issues, informational requests

Output ONLY a JSON array with this EXACT structure. NO other text, NO markdown.

[
  {
    "id": "call_<index>",
    "text": "<EXACT call text from data>",
    "lat": <coordinate from data>,
    "lon": <coordinate from data>,
    "severity": <severity score 0.0-1.0>,
    "source": "911 DISPATCH"
  }
]

Remember: Output ONLY the JSON array. Nothing else.
""",
    tools=[get_call_transcripts],
    output_key="call_incidents",
)
