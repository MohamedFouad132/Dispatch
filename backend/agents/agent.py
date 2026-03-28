from google.adk.agents import ParallelAgent, SequentialAgent
from .sub_agents.social_media_agent.agent import social_media_agent
from .sub_agents.satellite_agent.agent import satellite_agent
from .sub_agents.call_agent.agent import call_agent
from .sub_agents.route_agent.agent import route_agent

# Sequential groups run, then the resource agent
root_agent = SequentialAgent(
    name="coordinator",
    sub_agents=[social_media_agent, satellite_agent, call_agent, route_agent]
)
