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

import unittest
import json
from mcp_server import bfs_pathfinder, calculate_navigation_path

class TestNavigationPathfinder(unittest.TestCase):
    def setUp(self):
        # A simple 5x5 grid
        # 0 0 0 0 0
        # 1 1 1 1 0
        # 0 0 0 0 0
        # 0 1 1 1 1
        # 0 0 0 0 0
        self.grid = [
            [0, 0, 0, 0, 0],
            [1, 1, 1, 1, 0],
            [0, 0, 0, 0, 0],
            [0, 1, 1, 1, 1],
            [0, 0, 0, 0, 0]
        ]
        
    def test_clear_straight_path(self):
        # Start at (0, 0), End at (0, 4) - straight line
        path = bfs_pathfinder(self.grid, [0, 0], [0, 4])
        self.assertIsNotNone(path)
        self.assertEqual(len(path), 5)
        self.assertEqual(path[0], [0, 0])
        self.assertEqual(path[-1], [0, 4])
        # Verify coordinates
        for r, c in path:
            self.assertEqual(self.grid[r][c], 0)
            
    def test_obstacle_avoidance_maze(self):
        # Start at (0, 0), End at (4, 4) - must snake around walls
        path = bfs_pathfinder(self.grid, [0, 0], [4, 4])
        self.assertIsNotNone(path)
        # Check path starts and ends correctly
        self.assertEqual(path[0], [0, 0])
        self.assertEqual(path[-1], [4, 4])
        
        # Verify that all tiles in the path are free
        for r, c in path:
            self.assertEqual(self.grid[r][c], 0, f"Path passes through obstacle at ({r}, {c})")
            
        # The shortest path length for this snake maze should be 13 steps:
        # (0,0)->(0,1)->(0,2)->(0,3)->(0,4)->(1,4)->(2,4)->(2,3)->(2,2)->(2,1)->(2,0)->(3,0)->(4,0)->(4,1)->(4,2)->(4,3)->(4,4)
        # Wait, let's recount.
        # (0,0) to (0,4) is 4 steps (length 5).
        # (0,4) to (2,4) is 2 steps.
        # (2,4) to (2,0) is 4 steps.
        # (2,0) to (4,0) is 2 steps.
        # (4,0) to (4,4) is 4 steps.
        # Total steps = 4 + 2 + 4 + 2 + 4 = 16 steps, path length = 17.
        self.assertEqual(len(path), 17)

    def test_blocked_path(self):
        # Fully block the path by adding a wall at column 4, row 2
        blocked_grid = [row.copy() for row in self.grid]
        blocked_grid[2][4] = 1 # now row 1 is blocked [1,1,1,1,0] and row 2 is blocked at end, making it impossible to pass
        
        path = bfs_pathfinder(blocked_grid, [0, 0], [4, 4])
        self.assertIsNone(path)
        
    def test_invalid_coordinates(self):
        # Out of bounds start
        path = bfs_pathfinder(self.grid, [-1, 0], [4, 4])
        self.assertIsNone(path)
        
        # Out of bounds end
        path = bfs_pathfinder(self.grid, [0, 0], [5, 5])
        self.assertIsNone(path)
        
        # Start on obstacle
        path = bfs_pathfinder(self.grid, [1, 0], [4, 4])
        self.assertIsNone(path)
        
    def test_mcp_tool_wrapper(self):
        # Verify the calculate_navigation_path JSON tool wrapper
        result_json = calculate_navigation_path(self.grid, [0, 0], [0, 4])
        result = json.loads(result_json)
        self.assertEqual(result["status"], "success")
        self.assertEqual(len(result["path"]), 5)
        
        # Test error handling in tool wrapper
        error_result_json = calculate_navigation_path(self.grid, [1, 0], [4, 4])
        error_result = json.loads(error_result_json)
        self.assertEqual(error_result["status"], "error")
        self.assertTrue("message" in error_result)

if __name__ == "__main__":
    unittest.main()
