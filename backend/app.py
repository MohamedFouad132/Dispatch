from dotenv import load_dotenv
import asyncio
import json
import re
import uuid
from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import logging

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types as genai_types
from agents.agent import root_agent

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

def parse_json_blocks(text: str) -> List[dict]:
    """Extract all ```json ... ``` blocks from agent text output."""
    blocks = []
    pattern = r'```json\s*(.*?)\s*```'
    matches = re.findall(pattern, text, re.DOTALL)
    for match in matches:
        try:
            blocks.append(json.loads(match))
        except json.JSONDecodeError:
            pass
    
    # Try to parse the entire text as JSON if no blocks found
    if not blocks:
        try:
            # Try to find JSON array or object
            text = text.strip()
            if text.startswith('[') or text.startswith('{'):
                blocks.append(json.loads(text))
        except json.JSONDecodeError:
            pass
    
    return blocks

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

@app.get("/run_simulation")
async def run_simulation():
    """
    Triggers the multi-agent pipeline and streams updates to the frontend via SSE.
    Each agent runs sequentially. Incidents are streamed as they are processed,
    followed by the computed routes once the route agent finishes.
    """

    # Create a new session for this simulation run
    session_service = InMemorySessionService()
    session_id = str(uuid.uuid4())
    user_id = "dispatch_user"

    session = await session_service.create_session(
        app_name="dispatch_app",
        user_id=user_id,
        session_id=session_id,
        state={}
    )

    runner = Runner(
        agent=root_agent,
        app_name="dispatch_app",
        session_service=session_service
    )

    # Queue used to pass events from the pipeline task to the SSE stream
    queue = asyncio.Queue()

    # Accumulate incidents across all data agents for route computation
    all_incidents = []
    agent_incident_counts = {
        "social_media_agent": 0,
        "satellite_agent": 0,
        "call_agent": 0,
        "route_agent": 0
    }
    route_agent_output = None

    async def run_pipeline():
        try:
            await queue.put({"type": "system", "message": "Agents started."})

            prompt_text = "Start the disaster response simulation. Collect all incidents from social media, satellite, and 911 calls. Process them sequentially and output results."

            # Track which agents have already sent their completion log
            completed_agents = set()

            # Stream events from the ADK runner as each agent finishes
            async for event in runner.run_async(
                user_id=user_id,
                session_id=session.id,
                new_message=genai_types.Content(
                    role="user",
                    parts=[genai_types.Part(text=prompt_text)]
                )
            ):
                if event.is_final_response():
                    if event.content and event.content.parts:
                        for part in event.content.parts:
                            if hasattr(part, "text") and part.text:
                                raw_text = part.text
                                agent_name = event.author or "unknown"
                                
                                # Extract all JSON blocks from the agent's response
                                json_blocks = parse_json_blocks(raw_text)
                                
                                for block in json_blocks:
                                    try:
                                        if isinstance(block, list):
                                            # Data agents return a list of incidents
                                            for idx, item in enumerate(block):
                                                if "id" in item or "text" in item:
                                                    if "source" not in item:
                                                        item["source"] = "UNKNOWN"
                                                    
                                                    all_incidents.append(item)
                                                    
                                                    if agent_name in agent_incident_counts:
                                                        agent_incident_counts[agent_name] += 1
                                                    
                                                    # Stream each incident individually with a small delay
                                                    await queue.put({
                                                        "type": "incident",
                                                        "agent": agent_name,
                                                        "incident": {
                                                            "id": item.get("id", f"{agent_name}_{idx}"),
                                                            "text": item.get("text", ""),
                                                            "lat": item.get("lat"),
                                                            "lon": item.get("lon"),
                                                            "severity": item.get("severity", 0),
                                                            "source": item.get("source", "UNKNOWN")
                                                        }
                                                    })
                                                    await asyncio.sleep(0.4)

                                        elif isinstance(block, dict) and agent_name == "route_agent":
                                            # Route agent returns a single dict with status and routes
                                            if "status" in block:
                                                route_agent_output = block
                                                logger.info(f"Route agent output: status={block.get('status')}, routes={block.get('routes_computed', 0)}")
                                    except Exception as e:
                                        logger.error(f"Error processing JSON block: {e}")
                                
                                # Send completion log for each agent once
                                if agent_name not in completed_agents:
                                    completed_agents.add(agent_name)
                                    incident_count = agent_incident_counts.get(agent_name, 0)
                                    
                                    if agent_name in ["social_media_agent", "satellite_agent", "call_agent"]:
                                        await queue.put({
                                            "type": "agent_log",
                                            "agent": agent_name,
                                            "content": f"✓ Complete — {incident_count} incidents processed"
                                        })

            logger.info(f"Total incidents collected: {len(all_incidents)}")

            # Use routes from the route agent if it succeeded
            if route_agent_output and route_agent_output.get("status") == "complete":
                routes = route_agent_output.get("routes", [])
                logger.info(f"Using routes from route_agent: {len(routes)} routes")
            else:
                logger.warning("Route agent did not provide routes")
                routes = []

            # Send routes to the frontend followed by the route agent completion log
            if routes:
                await asyncio.sleep(0.5)
                
                await queue.put({
                    "type": "routes",
                    "routes": routes
                })
                
                total_incidents = sum(len(r.get("stops", [])) for r in routes)
                await queue.put({
                    "type": "agent_log",
                    "agent": "route_agent",
                    "content": f"✓ Complete — {total_incidents} incidents assigned to {len(routes)} units"
                })

        except Exception as e:
            logger.error(f"Pipeline error: {e}", exc_info=True)
            await queue.put({"type": "error", "message": str(e)})
        finally:
            # Signal the event stream to close
            await queue.put(None)

    # Run the pipeline as a background task so the SSE stream can start immediately
    asyncio.create_task(run_pipeline())

    async def event_stream():
        while True:
            event = await queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
