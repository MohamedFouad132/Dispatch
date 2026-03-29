import json
import logging
from typing import Dict, Any, List
from google.adk.agents import Agent
from google.adk.tools import ToolContext

from .route_optimizer import build_routes

DATA_PATH = "data/simulation.json"
logger = logging.getLogger(__name__)

# Handle both string (JSON array) and list formats
def parse_incidents(raw_data):
    parsed = []
    if isinstance(raw_data, str):
        # parse JSON string
        try:
            parsed_list = json.loads(raw_data)
            if isinstance(parsed_list, list):
                parsed = parsed_list
            elif isinstance(parsed_list, dict):
                parsed = [parsed_list]
        except json.JSONDecodeError:
            logger.error(f"Failed to parse JSON: {raw_data[:100]}")
    elif isinstance(raw_data, list):
        # data is a list
        for item in raw_data:
            if isinstance(item, str):
                try:
                    parsed.append(json.loads(item))
                except json.JSONDecodeError:
                    parsed.append(item)
            else:
                parsed.append(item)
    return parsed

def aggregate_all_incidents(tool_context: ToolContext) -> List[Dict[str, Any]]:
    """Aggregate all incidents from all sources with severity assessment."""
    try:        
        incidents = []

        # The incident data is stored in tool_context.session.state
        state = tool_context.session.state if hasattr(tool_context, 'session') and hasattr(tool_context.session, 'state') else {}
        
        # Get incident data from session state
        social_incidents = state.get("social_incidents", "[]")
        satellite_incidents = state.get("satellite_incidents", "[]")
        call_incidents = state.get("call_incidents", "[]")

        print(f"Route agent: Retrieved incident data from session state")

        # Collect from all sources
        incidents.extend(parse_incidents(social_incidents))
        incidents.extend(parse_incidents(satellite_incidents))
        incidents.extend(parse_incidents(call_incidents))
        
        print(f"Route agent: aggregated {len(incidents)} incidents from all sources")

        return incidents
    except Exception as e:
        logger.error(f"Failed to aggregate incidents: {e}", exc_info=True)
        return []

def get_available_resources() -> Dict[str, Any]:
    """Retrieve all available resources: ambulances, firetrucks, police, hospitals, shelters."""
    try:
        with open(DATA_PATH, "r") as f:
            data = json.load(f)
        
        print("Route agent: loaded resources")

        return {
            "ambulances": data.get("resources", {}).get("ambulances", []),
            "firetrucks": data.get("resources", {}).get("firetrucks", []),
            "police": data.get("resources", {}).get("police", []),
            "hospitals": data.get("hospitals", []),
            "shelters": data.get("shelters", [])
        }
    except Exception as e:
        logger.error(f"Failed to load resources: {e}")
        return {
            "ambulances": [],
            "firetrucks": [],
            "police": [],
            "hospitals": [],
            "shelters": []
        }

def compute_optimal_routes(tool_context: ToolContext) -> Dict[str, Any]:
    """
    Compute optimal routes using collected incidents and available resources.
    This function integrates directly with route_optimizer to build OSRM routes.
    
    Returns routes with proper road-following geometry and turn-by-turn directions.
    """
    try:
        # Aggregate all incidents from all sources
        incidents = aggregate_all_incidents(tool_context)
        logger.info(f"Route agent: aggregated {len(incidents)} incidents")
        
        if not incidents:
            logger.warning("Route agent: no incidents to route")
            return {
                "status": "complete",
                "routes_computed": 0,
                "routes": []
            }
        
        # Get available resources
        resource_data = get_available_resources()
        vehicles = {
            "ambulances": resource_data["ambulances"],
            "firetrucks": resource_data["firetrucks"],
            "police": resource_data["police"]
        }
        hospitals = resource_data["hospitals"]
        shelters = resource_data["shelters"]
        
        logger.info(f"Route agent: {len(vehicles['ambulances'])} ambulances, {len(vehicles['firetrucks'])} firetrucks, {len(vehicles['police'])} police")
        
        # Build optimal routes using route_optimizer
        routes = build_routes(incidents, vehicles, hospitals, shelters)
        tool_context.state["computed_routes"] = routes
        logger.info(f"Route agent: built {len(routes)} routes with OSRM")
        
        # Count total incidents covered
        total_incidents = sum(len(r.get("stops", [])) for r in routes)
        
        return {
            "status": "complete",
            "routes_computed": len(routes),
            "total_incidents": total_incidents,
        }
    except Exception as e:
        logger.error(f"Failed to compute optimal routes: {e}", exc_info=True)
        return {
            "status": "error",
            "message": str(e),
            "routes": []
        }

route_agent = Agent(
    name="route_agent",
    model="gemini-3.1-flash-lite-preview",
    description="Computes optimal routes for emergency vehicles using aggregated incident data and resource locations.",
    instruction="""
You are the route optimization engine for emergency response dispatch.

Your ONLY job is to:
1. Call compute_optimal_routes() to determine optimal dispatch routes for all vehicles
2. Return a success message in JSON format

CRITICAL RULES:
- You MUST call compute_optimal_routes()
- Do NOT modify the output from the tool
- Output ONLY a JSON object with the exact structure returned by the tool

Output format (NO other text or markdown):
{
  "status": "complete",
    "routes_computed": <number_of_routes>,
    "total_incidents": <number_of_incidents_covered>,
}

Remember: Call the tool and output only the JSON result.
""",
    tools=[compute_optimal_routes],
    output_key="routes",
)
