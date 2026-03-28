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
You are a disaster response analyst. Your job is to 

1. call get_social_posts() to retrieve all posts 
2. Assign each a severity score from 0.0 to 1.0 based on urgency. 

Do not invent or modify any data.

Severity guide:

0.75-1.0: Life threatening (trapped, drowning, collapse, cardiac arrest)
0.50-0.74: Serious (injuries, spreading fire, stranded group)
0.25-0.49: Moderate (property damage, access issues)
0.00-0.24: Low (status updates, minor issues)

Output ONLY a JSON array, no other text:
[
    {
        "id": "post_<index>",
        "text": "<exact text>",
        "lat": <lat>,
        "lon": <lon>,
        "severity": <score>,
        "source": "SOCIAL MEDIA"
    }
]
""",
    tools=[get_social_posts],
    output_key="social_incidents",
)
