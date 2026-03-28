import math
import json
import requests
from typing import List, Dict, Any, Tuple, Optional

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in km between two points."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

def travel_time_minutes(distance_km: float) -> float:
    """Estimate travel time in minutes assuming 50 km/h average speed."""
    return (distance_km / 50.0) * 60.0

def fetch_osrm_route(coordinates: List[Tuple[float, float]], timeout: float = 30.0, max_retries: int = 3) -> Optional[Dict[str, Any]]:
    """
    Fetch route from OSRM API (synchronous) with retry logic.
    coordinates: List of (lon, lat) tuples
    max_retries: Number of retry attempts (default: 3)
    Returns: Dict with geometry, distance, duration, or None if request fails
    """
    if len(coordinates) < 2:
        return None
    
    # Filter out duplicate/very-close coordinates (within 0.0001 degrees ~ 11 meters)
    unique_coords = []
    for lon, lat in coordinates:
        if not unique_coords or haversine(unique_coords[-1][1], unique_coords[-1][0], lat, lon) > 0.01:
            unique_coords.append((lon, lat))
    
    if len(unique_coords) < 2:
        return None
    
    # Format: lon1,lat1;lon2,lat2;...
    coords_str = ";".join([f"{lon},{lat}" for lon, lat in unique_coords])
    url = f"https://router.project-osrm.org/route/v1/driving/{coords_str}?overview=full&geometries=geojson&steps=true"
    
    # Retry loop with exponential backoff
    last_error = None
    for attempt in range(max_retries):
        try:
            response = requests.get(url, timeout=timeout)
            response.raise_for_status()
            data = response.json()
            
            if data.get("code") != "Ok" or not data.get("routes"):
                print(f"OSRM returned code: {data.get('code')}")
                last_error = f"OSRM returned code: {data.get('code')}"
                if attempt < max_retries - 1:
                    import time
                    time.sleep(0.5 * (attempt + 1))  # Exponential backoff
                    continue
                return None
            
            route = data["routes"][0]
            
            # Convert geometry from [lon,lat] to [lat,lon]
            geometry = [[lat, lon] for lon, lat in route["geometry"]["coordinates"]]
            
            # Extract steps with turn-by-turn information
            steps = []
            if route.get("legs"):
                for leg in route["legs"]:
                    for step in leg.get("steps", []):
                        maneuver = step.get("maneuver", {})
                        steps.append({
                            "instruction": step.get("name", "Continue"),
                            "distance": step.get("distance", 0) / 1000.0,  # Convert to km
                            "duration": step.get("duration", 0) / 60.0,    # Convert to minutes
                            "type": maneuver.get("type", ""),
                            "modifier": maneuver.get("modifier", ""),
                            "name": step.get("name", "")
                        })
            
            print(f"OSRM route fetched successfully on attempt {attempt + 1}")
            return {
                "geometry": geometry,
                "distance": route.get("distance", 0) / 1000.0,  # km
                "duration": route.get("duration", 0) / 60.0,    # minutes
                "steps": steps,
                "source": "osrm"
            }
        except requests.exceptions.Timeout:
            last_error = "OSRM request timed out"
            print(f"OSRM attempt {attempt + 1}/{max_retries}: Request timed out")
            if attempt < max_retries - 1:
                import time
                time.sleep(0.5 * (attempt + 1))
                continue
        except requests.exceptions.ConnectionError as e:
            last_error = f"OSRM connection error: {e}"
            print(f"OSRM attempt {attempt + 1}/{max_retries}: Connection error - {e}")
            if attempt < max_retries - 1:
                import time
                time.sleep(1 * (attempt + 1))  # Longer delay for connection errors
                continue
        except Exception as e:
            last_error = f"OSRM error: {e}"
            print(f"OSRM API Error: {e}")
            if attempt < max_retries - 1:
                import time
                time.sleep(0.5 * (attempt + 1))
                continue
    
    print(f"OSRM failed after {max_retries} attempts. Route discarded (no fallback). Last error: {last_error}")
    return None  # NO FALLBACK - return None to discard this route

def build_routes(incidents: List[Dict[str, Any]], vehicles: Dict[str, List[Dict[str, Any]]], 
                                    hospitals: List[Dict[str, Any]], shelters: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Build optimal routes for all vehicles using OSRM.
    
    incidents: List of incident dicts with id, lat, lon, severity, text, source
    vehicles: Dict with keys "ambulances", "firetrucks", "police" - each contains vehicle list
    hospitals: List of hospital dicts with lat, lon, name
    shelters: List of shelter dicts with lat, lon, name

    Incidents are distributed round-robin based on proximity.
    
    Returns: List of route dicts for each vehicle
    """
    routes = []
    
    # Classify incidents by type
    ambulance_incidents = []
    firetruck_incidents = []
    police_incidents = []
    
    for inc in incidents:
        text_lower = inc["text"].lower()
        if "fire" in text_lower or "explosion" in text_lower:
            firetruck_incidents.append(inc)
        elif "injury" in text_lower or "medical" in text_lower or "trapped" in text_lower or "ambulance" in text_lower:
            ambulance_incidents.append(inc)
        else:
            police_incidents.append(inc)
    
    # Get vehicle lists
    ambulances = vehicles.get("ambulances", [])
    firetrucks = vehicles.get("firetrucks", [])
    police = vehicles.get("police", [])
    
    # Distribute ambulance incidents across ambulances
    if ambulances and ambulance_incidents:
        amb_assignments = {i: [] for i in range(len(ambulances))}
        remaining = list(ambulance_incidents)
        round_robin_idx = 0
        
        while remaining:
            # Find nearest incident to the current ambulance in round-robin
            amb = ambulances[round_robin_idx % len(ambulances)]
            best_inc_idx = 0
            best_dist = haversine(amb["lat"], amb["lon"], remaining[0]["lat"], remaining[0]["lon"])
            
            for i in range(1, len(remaining)):
                d = haversine(amb["lat"], amb["lon"], remaining[i]["lat"], remaining[i]["lon"])
                if d < best_dist:
                    best_inc_idx = i
                    best_dist = d
            
            amb_assignments[round_robin_idx % len(ambulances)].append(remaining.pop(best_inc_idx))
            round_robin_idx += 1
        
        # Build routes for all ambulances with incidents
        for amb_idx, assigned_incidents in amb_assignments.items():
            if assigned_incidents:
                route = build_vehicle_route_with_osrm(ambulances[amb_idx], assigned_incidents, hospitals, None)
                if route:
                    routes.append(route)
    
    # Distribute firetruck incidents across all firetrucks
    if firetrucks and firetruck_incidents:
        ft_assignments = {i: [] for i in range(len(firetrucks))}
        remaining = list(firetruck_incidents)
        round_robin_idx = 0
        
        while remaining:
            ft = firetrucks[round_robin_idx % len(firetrucks)]
            best_inc_idx = 0
            best_dist = haversine(ft["lat"], ft["lon"], remaining[0]["lat"], remaining[0]["lon"])
            
            for i in range(1, len(remaining)):
                d = haversine(ft["lat"], ft["lon"], remaining[i]["lat"], remaining[i]["lon"])
                if d < best_dist:
                    best_inc_idx = i
                    best_dist = d
            
            ft_assignments[round_robin_idx % len(firetrucks)].append(remaining.pop(best_inc_idx))
            round_robin_idx += 1
        
        # Build routes for all firetrucks with incidents
        for ft_idx, assigned_incidents in ft_assignments.items():
            if assigned_incidents:
                route = build_vehicle_route_with_osrm(firetrucks[ft_idx], assigned_incidents, None, None)
                if route:
                    routes.append(route)
    
    # Distribute police incidents across all police cars
    if police and police_incidents:
        pol_assignments = {i: [] for i in range(len(police))}
        remaining = list(police_incidents)
        round_robin_idx = 0
        
        while remaining:
            pol = police[round_robin_idx % len(police)]
            best_inc_idx = 0
            best_dist = haversine(pol["lat"], pol["lon"], remaining[0]["lat"], remaining[0]["lon"])
            
            for i in range(1, len(remaining)):
                d = haversine(pol["lat"], pol["lon"], remaining[i]["lat"], remaining[i]["lon"])
                if d < best_dist:
                    best_inc_idx = i
                    best_dist = d
            
            pol_assignments[round_robin_idx % len(police)].append(remaining.pop(best_inc_idx))
            round_robin_idx += 1
        
        # Build routes for all police cars with incidents
        for pol_idx, assigned_incidents in pol_assignments.items():
            if assigned_incidents:
                route = build_vehicle_route_with_osrm(police[pol_idx], assigned_incidents, None, shelters)
                if route:
                    routes.append(route)
    
    print(f"Route optimizer: Assigned all {len(incidents)} incidents to {len(routes)} vehicles")
    return routes

def build_vehicle_route_with_osrm(vehicle: Dict[str, Any], incidents: List[Dict[str, Any]], 
                                  endpoints: Optional[List[Dict[str, Any]]], 
                                  shelters: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """
    Build a route for a single vehicle using OSRM (synchronous).
    NO FALLBACK - If OSRM fails, returns None (route will be discarded).
    Endpoints (hospitals/shelters) are NOT included in stops array.
    """
    if not incidents:
        return None
    
    # Sort incidents using nearest neighbor
    sorted_incidents = nearest_neighbor_sort((vehicle["lat"], vehicle["lon"]), incidents)
    
    # Build coordinate list for OSRM (lon, lat format)
    coordinates = [(vehicle["lon"], vehicle["lat"])]
    
    # Add incident coordinates
    for inc in sorted_incidents:
        coordinates.append((inc["lon"], inc["lat"]))
    
    # Find endpoint (hospitals/shelters) if needed
    endpoint = None
    if endpoints:
        best = endpoints[0]
        best_dist = haversine(sorted_incidents[-1]["lat"], sorted_incidents[-1]["lon"], best["lat"], best["lon"])
        for ep in endpoints[1:]:
            d = haversine(sorted_incidents[-1]["lat"], sorted_incidents[-1]["lon"], ep["lat"], ep["lon"])
            if d < best_dist:
                best = ep
                best_dist = d
        endpoint = best
        coordinates.append((best["lon"], best["lat"]))
    elif shelters:
        best = shelters[0]
        best_dist = haversine(sorted_incidents[-1]["lat"], sorted_incidents[-1]["lon"], best["lat"], best["lon"])
        for shelter in shelters[1:]:
            d = haversine(sorted_incidents[-1]["lat"], sorted_incidents[-1]["lon"], shelter["lat"], shelter["lon"])
            if d < best_dist:
                best = shelter
                best_dist = d
        endpoint = best
        coordinates.append((best["lon"], best["lat"]))
    
    # Fetch OSRM route - NO FALLBACK
    route_data = fetch_osrm_route(coordinates)
    
    if not route_data:
        # return None if OSRM failed
        print(f"Route for {vehicle['id']} discarded: OSRM failed")
        return None
    
    # Build stops list - INCIDENTS ONLY (no hospitals/shelters)
    stops = []
    for inc in sorted_incidents:
        stops.append({
            "id": inc.get("id", f"inc-{inc['lat']}-{inc['lon']}"),
            "lat": inc["lat"],
            "lon": inc["lon"],
            "severity": inc.get("severity", 0),
            "text": inc.get("text", "Incident"),
            "source": inc.get("source", "")
        })
    
    # Endpoint (hospitals/shelters) info stored separately (NOT in stops)
    endpoint_info = None
    if endpoint:
        endpoint_type = "Hospital" if endpoints else "Shelter"
        endpoint_info = {
            "id": f"{endpoint_type.lower()}-{endpoint.get('name', 'unknown')}",
            "lat": endpoint["lat"],
            "lon": endpoint["lon"],
            "text": f"{endpoint_type}: {endpoint.get('name', 'unknown')}",
            "type": endpoint_type.lower()
        }
    
    return {
        "vehicleId": vehicle["id"],
        "type": vehicle.get("type", "ambulance"),
        "startLat": vehicle["lat"],
        "startLon": vehicle["lon"],
        "distance": round(route_data["distance"], 2),
        "duration": round(route_data["duration"], 1),
        "stops": stops,  # incidents stops only
        "endpoint": endpoint_info,  # Hospital/shelter stored separately
        "geometry": route_data["geometry"],
        "steps": route_data.get("steps", [])
    }


def find_nearest_endpoint(lat: float, lon: float, endpoints: List[Dict[str, Any]]) -> Tuple[Dict[str, Any], float]:
    """Find the nearest endpoint (hospital or shelter) and return it with distance."""
    if not endpoints:
        return None, None
    
    best = endpoints[0]
    best_dist = haversine(lat, lon, best["lat"], best["lon"])
    
    for endpoint in endpoints[1:]:
        d = haversine(lat, lon, endpoint["lat"], endpoint["lon"])
        if d < best_dist:
            best = endpoint
            best_dist = d
    
    return best, best_dist

def nearest_neighbor_sort(origin: Tuple[float, float], points: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort points using nearest-neighbor heuristic starting from origin."""
    if not points:
        return []
    
    remaining = list(points)
    ordered = []
    current = origin
    
    while remaining:
        best_idx = 0
        best_dist = haversine(current[0], current[1], remaining[0]["lat"], remaining[0]["lon"])
        
        for i in range(1, len(remaining)):
            d = haversine(current[0], current[1], remaining[i]["lat"], remaining[i]["lon"])
            if d < best_dist:
                best_idx = i
                best_dist = d
        
        ordered.append(remaining[best_idx])
        current = (remaining[best_idx]["lat"], remaining[best_idx]["lon"])
        remaining.pop(best_idx)
    
    return ordered

def evaluate_routes(routes: List[Dict[str, Any]], incidents: List[Dict[str, Any]]) -> float:
    """Calculate a score for the route quality (0-100)."""
    if not routes:
        return 0.0
    
    total_dist = sum(r.get("distance", 0) for r in routes)
    total_time = sum(r.get("duration", 0) for r in routes)
    max_time = max(r.get("duration", 0) for r in routes) if routes else 0
    
    # Penalty for high severity incidents not addressed quickly
    severity_wait = 0
    incident_map = {inc["id"]: inc for inc in incidents}
    
    for route in routes:
        elapsed = 0
        for stop in route.get("stops", []):
            elapsed += travel_time_minutes(haversine(
                route["startLat"], route["startLon"],
                stop["lat"], stop["lon"]
            )) if stop.get("severity", 0) > 0 else 0
            inc = incident_map.get(stop.get("id"))
            if inc and inc.get("severity", 0) >= 0.85:
                severity_wait += elapsed * 2
            elif inc and inc.get("severity", 0) >= 0.65:
                severity_wait += elapsed * 1
    
    # Distance score (lower is better)
    dist_score = max(0, 100 - (total_dist / max(len(incidents), 1) / 2) * 30)
    # Balance score (avoid sending one vehicle to do everything)
    balance_score = max(0, 100 - (max_time / 120) * 30)
    # Severity response score (respond quickly to critical incidents)
    wait_score = max(0, 100 - (severity_wait / 60) * 40)
    
    return min(100, max(0, (dist_score + balance_score + wait_score) / 3))
