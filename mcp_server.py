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

import collections
import json
import logging
from fastmcp import FastMCP

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("navigation_mcp_server")

# Initialize FastMCP Server
mcp = FastMCP("Spatial Navigation Server")

def bfs_pathfinder(grid: list[list[int]], start: list[int], destination: list[int]) -> list[list[int]] | None:
    """
    Performs BFS on an unweighted 2D grid to find the shortest path from start to destination.
    Grid values: 0 is free space, 1 is obstacle.
    """
    H = len(grid)
    if H == 0:
        return None
    W = len(grid[0])
    
    sr, sc = start[0], start[1]
    er, ec = destination[0], destination[1]
    
    # Boundary and obstacle checks
    if not (0 <= sr < H and 0 <= sc < W) or not (0 <= er < H and 0 <= ec < W):
        logger.error(f"Coordinates out of bounds. Start: {start}, Destination: {destination}, Grid: {H}x{W}")
        return None
        
    if grid[sr][sc] == 1:
        logger.warning(f"Start coordinate {start} is occupied by an obstacle.")
        # We can bypass this if the starting tile has to be clear, but let's be strict
        return None
        
    if grid[er][ec] == 1:
        logger.error(f"Destination coordinate {destination} is occupied by an obstacle.")
        return None
        
    # Queue stores lists of coordinate pairs representing the path taken
    queue = collections.deque([[(sr, sc)]])
    visited = {(sr, sc)}
    
    while queue:
        path = queue.popleft()
        r, c = path[-1]
        
        if r == er and c == ec:
            # Path found! Convert tuples back to lists of [row, col]
            return [list(node) for node in path]
            
        # Explore 4-directional neighbors (Up, Down, Left, Right)
        for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            nr, nc = r + dr, c + dc
            if 0 <= nr < H and 0 <= nc < W:
                if grid[nr][nc] == 0 and (nr, nc) not in visited:
                    visited.add((nr, nc))
                    queue.append(path + [(nr, nc)])
                    
    logger.warning(f"No pathway found between {start} and {destination}.")
    return None

@mcp.tool()
def calculate_navigation_path(map_matrix: list[list[int]], start: list[int], destination: list[int]) -> str:
    """
    Calculates the shortest pathway from a start coordinate to a destination coordinate
    in a 2D grid matrix, dodging all obstacle tiles (represented by 1).
    
    Args:
        map_matrix: A 2D list of integers representing the grid layout (0 is free space, 1 is obstacle).
        start: A list of 2 integers [row, col] representing the starting position.
        destination: A list of 2 integers [row, col] representing the target destination position.
        
    Returns:
        A JSON string containing a dictionary with:
        - "status": "success" or "error"
        - "path": A list of [row, col] coordinates representing the pathway (including start and destination)
        - "message": Error message if no path is found
    """
    logger.info(f"Received pathfinding request. Start: {start}, Destination: {destination}, Grid dimensions: {len(map_matrix)}x{len(map_matrix[0]) if map_matrix else 0}")
    
    try:
        path = bfs_pathfinder(map_matrix, start, destination)
        if path is None:
            return json.dumps({
                "status": "error",
                "message": f"No valid pathway could be calculated from {start} to {destination} dodging obstacles."
            })
            
        logger.info(f"Path successfully calculated. Length: {len(path)} steps.")
        return json.dumps({
            "status": "success",
            "path": path
        })
    except Exception as e:
        logger.error(f"Error during pathfinding: {str(e)}")
        return json.dumps({
            "status": "error",
            "message": f"Internal pathfinding error: {str(e)}"
        })

if __name__ == "__main__":
    logger.info("Starting Navigation MCP Server on stdio...")
    mcp.run()
