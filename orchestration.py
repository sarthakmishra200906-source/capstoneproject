# Copyright 2026 Google LLC
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import os
import sys
import json
import logging
import asyncio
from google.adk import Agent, Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools.mcp_tool import McpToolset, StdioConnectionParams
from mcp.client.stdio import StdioServerParameters
from google.genai import types

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orchestration")

# Ensure API Key is present
if not os.environ.get("GEMINI_API_KEY"):
    logger.warning("GEMINI_API_KEY environment variable is not set. Please ensure it is set before running.")

# Define the Command Agent (runs second)
command_agent = Agent(
    name="command_agent",
    model="gemini-2.5-flash",
    description="Translates coordinate paths into precise step-by-step robot movement commands.",
    instruction=(
        "You are the Robot Command Agent. Your role is to translate a sequence of coordinate path grid tiles "
        "into exact movement instructions for a grid-based robot car.\n\n"
        "Rules:\n"
        "1. The path is a list of [row, col] coordinates representing consecutive grid tiles. "
        "The first coordinate is the start position, and the last is the destination.\n"
        "2. The robot starts at the first coordinate, facing NORTH (towards decreasing row numbers, i.e., up the grid).\n"
        "3. You must output the instructions in a JSON list. The valid actions are:\n"
        "   - 'MOVE_FORWARD <N> UNITS' (moves straight by N grid tiles)\n"
        "   - 'ROTATE_CLOCKWISE 90' (turns 90 degrees right)\n"
        "   - 'ROTATE_COUNTER_CLOCKWISE 90' (turns 90 degrees left)\n"
        "4. Calculate the rotations and movements step-by-step as the robot moves from tile to tile along the path. "
        "IMPORTANT: Facing NORTH means: \n"
        "   - Moving to [row-1, col] is moving FORWARD.\n"
        "   - Moving to [row+1, col] is moving BACKWARD (requires rotating 180 degrees or twice 90 degrees first, then moving forward).\n"
        "   - Moving to [row, col+1] is moving EAST (requires rotating CLOCKWISE 90 degrees first, then moving forward).\n"
        "   - Moving to [row, col-1] is moving WEST (requires rotating COUNTER_CLOCKWISE 90 degrees first, then moving forward).\n"
        "Keep track of the robot's current facing direction at each step! Update its facing direction after each rotation.\n"
        "5. Try to combine sequential forward steps in the same direction into a single 'MOVE_FORWARD <N> UNITS' command where possible.\n"
        "6. Output your final response in a clean JSON format. Write the commands inside a JSON block like this:\n"
        "```json\n"
        "{\n"
        "  \"commands\": [\"MOVE_FORWARD 2 UNITS\", \"ROTATE_CLOCKWISE 90\", \"MOVE_FORWARD 3 UNITS\"]\n"
        "}\n"
        "```\n"
        "Do not add any conversational text before or after the JSON block."
    )
)

# Initialize MCP toolset pointing to our local mcp_server.py
mcp_toolset = McpToolset(
    connection_params=StdioConnectionParams(
        server_params=StdioServerParameters(
            command=sys.executable,
            args=["mcp_server.py"],
            env={**os.environ, "PYTHONPATH": "."}
        )
    )
)

# Define the Spatial Vision Agent (runs first)
vision_agent = Agent(
    name="vision_agent",
    model="gemini-2.5-flash",
    description="Parses room layout descriptions, generates a map matrix, calls the MCP pathfinder, and transfers to command_agent.",
    tools=[mcp_toolset],
    sub_agents=[command_agent],
    instruction=(
        "You are the Spatial Vision Agent. Your task is to process a room layout narrative and coordinate the pathfinding process.\n\n"
        "Steps to follow:\n"
        "1. Parse the room description to identify: \n"
        "   - The grid dimensions (width and height)\n"
        "   - The start [row, col] position\n"
        "   - The destination [row, col] position\n"
        "   - Any obstacle names and their [row, col] coordinates (e.g. couch, wall, fountain)\n"
        "2. Represent this room layout as a 2D map matrix of integers (0 for free tile, 1 for obstacle).\n"
        "3. Output the parsed grid layout in a clean JSON format so that the system can render the 3D map. Format it exactly like this:\n"
        "```json\n"
        "{\n"
        "  \"grid_size\": [height, width],\n"
        "  \"start\": [row, col],\n"
        "  \"destination\": [row, col],\n"
        "  \"obstacles\": [\n"
        "    {\"name\": \"couch\", \"coordinates\": [[r1, c1], [r2, c2]]},\n"
        "    {\"name\": \"fountain\", \"coordinates\": [[r3, c3]]}\n"
        "  ],\n"
        "  \"map_matrix\": [[0, 0, ...], ...]\n"
        "}\n"
        "```\n"
        "4. Call the `calculate_navigation_path` tool from your connected MCP toolset. Pass the map_matrix, start, and destination coordinates as arguments.\n"
        "5. Once you receive the pathway coordinates from the tool, print the path and then immediately transfer control to the 'command_agent' using the 'transfer_to_agent' tool. "
        "Pass the coordinate path list to the command agent so it can generate the robot movement commands.\n"
        "Your final action MUST be to call `transfer_to_agent(agent_name='command_agent')`."
    )
)

def run_orchestration_sync(layout_description: str) -> dict:
    """
    Synchronous wrapper to run the ADK multi-agent pipeline.
    Useful for CLI testing and running inside FastAPI endpoint.
    """
    user_id = "user_1"
    session_id = "session_1"
    
    logger.info("Initializing ADK Runner...")
    session_service = InMemorySessionService()
    
    async def init_session():
        await session_service.create_session(
            app_name="spatial_robotics",
            user_id=user_id,
            session_id=session_id
        )
    asyncio.run(init_session())
    
    runner = Runner(app_name="spatial_robotics", agent=vision_agent, session_service=session_service)
    
    user_content = types.Content(
        parts=[types.Part.from_text(text=layout_description)]
    )
    
    logger.info(f"Sending prompt to vision_agent: {layout_description[:100]}...")
    
    events_log = []
    parsed_map = None
    parsed_commands = None
    
    try:
        # Run the runner and iterate over events
        for event in runner.run(
            user_id=user_id,
            session_id=session_id,
            new_message=user_content
        ):
            # Extract text content from the event
            text = ""
            if event.content and event.content.parts:
                text = "".join(part.text for part in event.content.parts if part.text and not part.thought)
            
            author = event.author
            logger.info(f"Event from [{author}]: {text[:80]}...")
            
            events_log.append({
                "author": author,
                "text": text,
                "is_final": event.is_final_response()
            })
            
            # Check if this is from vision_agent and contains the JSON map
            if author == "vision_agent" and "map_matrix" in text:
                try:
                    # Look for JSON block in the text
                    start_idx = text.find("```json")
                    if start_idx != -1:
                        end_idx = text.find("```", start_idx + 7)
                        json_str = text[start_idx + 7:end_idx].strip()
                    else:
                        # Fallback: find first '{' and last '}'
                        start_idx = text.find("{")
                        end_idx = text.rfind("}") + 1
                        json_str = text[start_idx:end_idx].strip()
                    
                    parsed_map = json.loads(json_str)
                    logger.info("Successfully parsed grid map from vision_agent response.")
                except Exception as e:
                    logger.warning(f"Failed to parse map JSON from vision_agent: {str(e)}")
            
            # Check if this is from command_agent and contains the movement commands
            if author == "command_agent" and ("commands" in text or "[" in text):
                try:
                    # Look for JSON block in the text
                    start_idx = text.find("```json")
                    if start_idx != -1:
                        end_idx = text.find("```", start_idx + 7)
                        json_str = text[start_idx + 7:end_idx].strip()
                    else:
                        start_idx = text.find("{")
                        end_idx = text.rfind("}") + 1
                        json_str = text[start_idx:end_idx].strip()
                    
                    parsed_commands = json.loads(json_str)
                    logger.info("Successfully parsed movement commands from command_agent response.")
                except Exception as e:
                    logger.warning(f"Failed to parse commands JSON from command_agent: {str(e)}")
                    
        # Write outputs to files for simulation ingestion
        output_dir = os.path.dirname(os.path.abspath(__file__))
        
        if parsed_map:
            map_file = os.path.join(output_dir, "map_data.json")
            with open(map_file, "w") as f:
                json.dump(parsed_map, f, indent=2)
            logger.info(f"Saved map data to {map_file}")
            
        if parsed_commands:
            commands_file = os.path.join(output_dir, "movement_commands.json")
            with open(commands_file, "w") as f:
                json.dump(parsed_commands, f, indent=2)
            logger.info(f"Saved movement commands to {commands_file}")
            
        return {
            "status": "success",
            "map": parsed_map,
            "commands": parsed_commands,
            "log": events_log
        }
    except Exception as e:
        logger.error(f"Error during orchestration: {str(e)}")
        return {
            "status": "error",
            "message": str(e),
            "log": events_log
        }

if __name__ == "__main__":
    # Test layout description
    test_layout = (
        "Construct a 6x6 room grid. The starting position is at [0, 0] and the target destination "
        "is at [5, 5]. There is a large couch occupying tiles [2, 2] and [2, 3], a brick wall from "
        "[4, 1] to [4, 3], and a custom indoor fountain at tile [1, 4]. Find a pathway and generate commands."
    )
    
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        print("Running orchestration test...")
        res = run_orchestration_sync(test_layout)
        print("\n--- TEST RUN RESULTS ---")
        print("Status:", res["status"])
        if res["map"]:
            print("Parsed Grid Dimensions:", res["map"].get("grid_size"))
        if res["commands"]:
            print("Parsed Commands:", res["commands"].get("commands"))
        else:
            print("Failed to parse commands. Check logs.")
