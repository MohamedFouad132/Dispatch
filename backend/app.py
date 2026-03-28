from dotenv import load_dotenv

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import logging

import json

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def health():
    return {"status": "healthy"}

@app.get("/resources")
async def get_resources():
    """Returns all resources from simulation.json for immediate display."""
    try:
        with open("data/simulation.json", "r") as f:
            data = json.load(f)
        
        return {
            "resources": {
                "ambulances": data.get("resources", {}).get("ambulances", []),
                "firetrucks": data.get("resources", {}).get("firetrucks", []),
                "police": data.get("resources", {}).get("police", [])
            },
            "hospitals": data.get("hospitals", []),
            "shelters": data.get("shelters", [])
        }
    except Exception as e:
        return {"error": str(e), "resources": {}, "hospitals": [], "shelters": []}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
