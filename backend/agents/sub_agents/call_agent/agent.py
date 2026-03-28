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
You are a 911 dispatch data processor. Call get_call_transcripts() to retrieve all transcripts and assign each a severity score from 0.0 to 1.0. Do not invent or modify any data.
Severity guide:

0.75-1.0: Life threatening (trapped, collapse, active fire with victims, drowning)
0.50-0.74: Serious (multiple injuries, spreading fire, stranded groups)
0.25-0.49: Moderate (property damage, access issues, non-emergency medical)
0.00-0.24: Low (status updates, minor issues)

Output ONLY a JSON array, no other text:
[
    {
        "id": "call_<index>",
        "text": "<exact text>",
        "lat": <lat>, "lon": <lon>,
        "severity": <score>,
        "source": "911 DISPATCH"
    }
]
""",
    tools=[get_call_transcripts],
    output_key="call_incidents",
)
