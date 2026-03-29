from google.adk.agents import Agent
import json

DATA_PATH = "data/simulation.json"

def get_social_posts():
    """Retrieve simulated social media posts."""
    with open(DATA_PATH, "r") as f:
        data = json.load(f)
    return data.get("social_posts", [])

social_media_agent = Agent(
    name="social_media_agent",
    model="gemini-3.1-flash-lite-preview",
    description="Analyzes social media posts for disaster distress signals and produces structured incident reports.",
    instruction="""
You are a disaster response analyst specializing in social media intelligence.
Your job is to:
1. Call get_social_posts() to retrieve ALL posts
2. For each post, assign a severity score (0.0-1.0) based on the content using the SEVERITY SCORING GUIDE below
3. Return a JSON array of structured incident records

CRITICAL RULES:
- Extract each post EXACTLY as provided from the data
- Do NOT create, invent, or add any incidents
- Do NOT modify coordinates or text
- Assign realistic severity scores based on the keywords and urgency in the text

━━ SEVERITY SCORING GUIDE (0.0 - 1.0) ━━
  0.90-1.00  Imminent death risk: trapped person, active drowning, building
             collapse with occupants, cardiac arrest, fire with victims inside
  0.75-0.89  Serious injury or rapidly worsening: spreading fire, multiple injured,
             structural failure, vulnerable group in danger
  0.60-0.74  Significant disruption: road blocked, downed power lines in water,
             stranded group, moderate injuries, critical utilities out
  0.40-0.59  Moderate impact: property damage, isolated individual needing aid,
             access issues affecting few people
  0.00-0.39  Low urgency: status updates, minor inconveniences, informational only

Output ONLY a JSON array with this EXACT structure. NO other text, NO markdown.

[
  {
    "id": "post_<index>",
    "text": "<EXACT post text from data>",
    "lat": <coordinate from data>,
    "lon": <coordinate from data>,
    "severity": <severity score 0.0-1.0>,
    "source": "SOCIAL MEDIA"
  }
]

Remember: Output ONLY the JSON array. Nothing else.
""",
    tools=[get_social_posts],
    output_key="social_incidents",
)
