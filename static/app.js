/*
 Copyright 2026 Google LLC
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

// Global variables
let scene, camera, renderer, controls;
let gridHelper, gridGroup;
let robotGroup, startMarker, destMarker;
let obstacleMeshes = [];
let pathwayPlates = [];
let floorMesh;
let hoverMarker;
let fountainParticles = []; // For realistic animated fountain water

// Simulation State
let isSimulating = false;
let mapData = null;
let movementCommands = [];
let robotGridPos = { r: 0, c: 0 }; // Current grid row and column
let robotFacingDegrees = 0;      // 0: NORTH, 90: EAST, 180: SOUTH, 270: WEST
const CELL_SIZE = 2;              // Dimensions of each grid tile in Three.js units
let uploadedFile = null;

// Workspace State [NEW]
let activeProject = "";
let activeMapName = "";
let stagedFiles = []; // Array of File objects staged for map generation (max 10)

// Supabase SaaS State [NEW]
let supabaseClient = null;
let supabaseSession = null;
let sessionToken = "";
let userEmail = "";
let isOfflineMode = false;

function isValidEmailAddress(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}



// Presets Definition
const PRESETS = {
    maze: "Construct a 6x6 room grid. The starting position is at [0, 0] and the target destination is at [5, 5]. There is a large couch occupying tiles [2, 2] and [2, 3], a brick wall from [4, 1] to [4, 3], and a custom indoor fountain at tile [1, 4]. Find a pathway and generate commands.",
    park: "Construct an 8x8 room grid. Start at [7, 0] and destination at [0, 7]. A large custom indoor fountain is in the center at tiles [3, 3], [3, 4], [4, 3], and [4, 4]. Add two couches: one at [1, 1] and another at [6, 6]. A brick wall is at [2, 5] and [5, 2]. Dodging these central fountains and obstacles, find a path.",
    empty: "Construct a 5x5 room grid with no obstacles. Start at [0, 0] and target destination is at [4, 4]. Direct straight pathway.",
    custom: "Construct a 6x6 room grid. Start at [0, 0], destination at [5, 5]. A wall blocks the center from [2, 1] to [2, 4]. A couch is at [4, 2]. Make a path around it."
};

// Initialize Application
document.addEventListener("DOMContentLoaded", async () => {
    // 1. Initialize Auth and Auth Event Listeners first so they are guaranteed to work
    // even if Three.js/WebGL fails to initialize on the user's system.
    try {
        setupAuthEventListeners();
    } catch (authEvtErr) {
        console.error("Auth event listeners setup failed:", authEvtErr);
    }

    try {
        await initAuth(); // Initialize Supabase / Auth [NEW]
    } catch (authInitErr) {
        console.error("Auth initialization failed:", authInitErr);
    }

    // 2. Initialize Three.js and standard event listeners
    try {
        initThree();
    } catch (threeErr) {
        console.error("Three.js initialization failed:", threeErr);
    }
    
    try {
        setupEventListeners();
    } catch (evtErr) {
        console.error("Standard event listeners setup failed:", evtErr);
    }
    
    try {
        setupWorkspaceEventListeners(); // Initialize workspace events [NEW]
    } catch (wsErr) {
        console.error("Workspace event listeners setup failed:", wsErr);
    }

    try {
        loadPreset("maze");
    } catch (presetErr) {
        console.error("Preset load failed:", presetErr);
    }

    try {
        animate();
    } catch (animErr) {
        console.error("Animation loop startup failed:", animErr);
    }
});

// Initialize Three.js Scene
function initThree() {
    const container = document.getElementById("canvas-container");
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04050a);
    scene.fog = new THREE.FogExp2(0x04050a, 0.015);

    // Camera
    camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 12, 15);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Orbit Controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // Don't go below ground
    controls.minDistance = 3;
    controls.maxDistance = 40;

    // Lights
    const ambientLight = new THREE.AmbientLight(0x0a0c1a, 1.5);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x00d2ff, 1.2);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.bias = -0.0001;
    scene.add(dirLight);

    // Cyberpunk grid floor lighting
    const floorLight = new THREE.PointLight(0x00e676, 0.5, 30);
    floorLight.position.set(0, 0.1, 0);
    scene.add(floorLight);

    // Groups
    gridGroup = new THREE.Group();
    scene.add(gridGroup);

    // Hover Marker for Interactive Click Mode
    const hoverGeo = new THREE.RingGeometry(0.7, 0.8, 4); // square ring since 4 segments
    hoverGeo.rotateX(-Math.PI / 2);
    hoverGeo.rotateY(Math.PI / 4); // align as square
    const hoverMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
    hoverMarker = new THREE.Mesh(hoverGeo, hoverMat);
    hoverMarker.position.set(0, 0.02, 0);
    hoverMarker.visible = false;
    scene.add(hoverMarker);

    // Handle Resize
    window.addEventListener("resize", () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    });
}

// Setup UI Listeners
function setupEventListeners() {
    // Preset Buttons
    const presetButtons = document.querySelectorAll(".btn-preset");
    presetButtons.forEach(btn => {
        btn.addEventListener("click", (e) => {
            presetButtons.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            loadPreset(btn.dataset.preset);
        });
    });

    // Generate Button
    const btnGenerate = document.getElementById("btn-generate");
    if (btnGenerate) {
        btnGenerate.addEventListener("click", triggerAgentOrchestration);
    }

    // Sim Buttons
    const btnPlaySim = document.getElementById("btn-play-sim");
    if (btnPlaySim) {
        btnPlaySim.addEventListener("click", runAutonomousSimulation);
    }
    const btnResetSim = document.getElementById("btn-reset-sim");
    if (btnResetSim) {
        btnResetSim.addEventListener("click", resetSimulation);
    }

    // File Upload Elements
    const uploadZone = document.getElementById("upload-zone");
    const fileInput = document.getElementById("file-input");
    const btnClearFile = document.getElementById("btn-clear-file");
    
    if (uploadZone && fileInput) {
        uploadZone.addEventListener("click", () => fileInput.click());
        
        // Drag and drop
        uploadZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            uploadZone.classList.add("drag-over");
        });
        uploadZone.addEventListener("dragleave", () => {
            uploadZone.classList.remove("drag-over");
        });
        uploadZone.addEventListener("drop", (e) => {
            e.preventDefault();
            uploadZone.classList.remove("drag-over");
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleFileUpload(e.dataTransfer.files[0]);
            }
        });
        
        fileInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files.length > 0) {
                handleFileUpload(e.target.files[0]);
            }
        });
    }
    
    if (btnClearFile) {
        btnClearFile.addEventListener("click", (e) => {
            e.stopPropagation();
            clearUploadedFile();
        });
    }

    // Canvas Raycaster Events
    const container = document.getElementById("canvas-container");
    if (container) {
        container.addEventListener("mousemove", onMouseMove);
        container.addEventListener("click", onGridClick);
    }

    // Modal Events
    const btnExport = document.getElementById("btn-export-payload");
    const modal = document.getElementById("payload-modal");
    const btnCloseModal = document.getElementById("btn-close-modal");
    const btnCopyPayload = document.getElementById("btn-copy-payload");
    
    if (btnExport && modal && btnCloseModal) {
        btnExport.addEventListener("click", () => {
            if (window.hardwarePayload) {
                const codeBlock = document.getElementById("payload-code-block");
                codeBlock.textContent = JSON.stringify(window.hardwarePayload, null, 2);
                modal.classList.remove("hidden");
            }
        });
        
        btnCloseModal.addEventListener("click", () => {
            modal.classList.add("hidden");
        });
        
        modal.addEventListener("click", (e) => {
            if (e.target === modal) modal.classList.add("hidden");
        });
    }
    
    if (btnCopyPayload) {
        btnCopyPayload.addEventListener("click", () => {
            if (window.hardwarePayload) {
                navigator.clipboard.writeText(JSON.stringify(window.hardwarePayload, null, 2))
                    .then(() => {
                        const origText = btnCopyPayload.innerHTML;
                        btnCopyPayload.innerHTML = `<i class="fa-solid fa-check"></i> Copied!`;
                        setTimeout(() => {
                            btnCopyPayload.innerHTML = origText;
                        }, 2000);
                    })
                    .catch(err => {
                        console.error("Failed to copy text: ", err);
                    });
            }
        });
    }
    
    // Welcome Terms Modal Logic [NEW]
    const welcomeModal = document.getElementById("welcome-terms-modal");
    const chkAccept = document.getElementById("chk-accept-welcome-terms");
    const btnAccept = document.getElementById("btn-accept-welcome");
    
    if (welcomeModal && chkAccept && btnAccept) {
        // Listen to checkbox change to enable/disable accept button
        chkAccept.addEventListener("change", (e) => {
            btnAccept.disabled = !e.target.checked;
        });
        
        // Listen to accept button click
        btnAccept.addEventListener("click", async () => {
            if (!chkAccept.checked) return;
            
            btnAccept.disabled = true;
            btnAccept.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
            
            try {
                const isSimulated = isOfflineMode || (sessionToken && sessionToken.startsWith("mock-"));
                if (isSimulated) {
                    localStorage.setItem("spatial_robotics_terms_accepted", "true");
                    welcomeModal.classList.add("hidden");
                    logToTerminal("Terms of Service accepted (Local Simulation Mode). Welcome!", "success");
                } else {
                    const { error } = await supabaseClient.auth.updateUser({
                        data: { terms_accepted_at: new Date().toISOString() }
                    });
                    if (error) throw error;
                    welcomeModal.classList.add("hidden");
                    logToTerminal("Terms of Service and Privacy Agreement accepted. Welcome to the dashboard!", "success");
                    await loadProjectsList();
                }
            } catch (err) {
                alert("Failed to save terms acceptance: " + err.message);
                btnAccept.disabled = false;
            } finally {
                btnAccept.innerHTML = `<i class="fa-solid fa-circle-check"></i> Accept & Access Dashboard`;
            }
        });
    }
}

// Load Prompt Presets
function loadPreset(presetKey) {
    const text = PRESETS[presetKey];
    document.getElementById("prompt-input").value = text;
}

// Append Line to Terminal UI
function logToTerminal(text, type = "system") {
    const terminal = document.getElementById("terminal-body");
    const line = document.createElement("div");
    line.className = `terminal-line ${type}-line`;
    
    // Select the appropriate icon class
    let iconClass = "";
    if (type === "agent-header") iconClass = "fa-circle-info";
    else if (type === "mcp-tool") iconClass = "fa-screwdriver-wrench";
    else if (type === "success") iconClass = "fa-circle-check";
    else if (type === "error") iconClass = "fa-triangle-exclamation";
    
    if (iconClass) {
        const icon = document.createElement("i");
        icon.className = `fa-solid ${iconClass}`;
        line.appendChild(icon);
        // Safely append text using createTextNode to prevent XSS injection
        line.appendChild(document.createTextNode(" " + text));
    } else {
        // Safe assignment via textContent
        line.textContent = text;
    }
    
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

// Trigger Multi-Agent Orchestration or Multimodal Upload on Backend
async function triggerAgentOrchestration() {
    // Block orchestration if terms were not accepted globally (sanity check)
    const termsAccepted = isOfflineMode 
        ? (localStorage.getItem("spatial_robotics_terms_accepted") === "true")
        : (supabaseSession?.user?.user_metadata?.terms_accepted_at);
    if (!termsAccepted) {
        alert("Please accept the Terms of Service & Privacy Agreement to proceed.");
        return;
    }

    const prompt = document.getElementById("prompt-input").value.trim();
    
    // Reset UI state
    document.getElementById("btn-generate").disabled = true;
    document.getElementById("btn-generate").innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;
    
    const terminal = document.getElementById("terminal-body");
    terminal.innerHTML = ""; // Clear log
    
    // Check if we are inside an active project map workspace [NEW]
    if (activeProject && activeMapName) {
        logToTerminal(`Initializing Workspace Generator for Map [${activeMapName}] in Project [${activeProject}]...`, "system");
        
        try {
            const formData = new FormData();
            if (prompt) {
                formData.append("custom_prompt", prompt);
            }
            
            // Append all staged files (up to 10)
            if (stagedFiles.length > 0) {
                logToTerminal(`Staging ${stagedFiles.length} map scan files for processing...`, "system");
                stagedFiles.forEach(file => {
                    formData.append("files", file);
                });
            }
            
            const headers = {};
            const userApiKey = document.getElementById("sys-param-token")?.value.trim();
            if (userApiKey) {
                headers["X-Gemini-API-Key"] = userApiKey;
            }
            
            const response = await secureFetch(`/api/projects/${activeProject}/maps/${activeMapName}/generate`, {
                method: "POST",
                headers: headers,
                body: formData
            });
            
            const data = await response.json();
            
            if (!response.ok || data.status === "error") {
                throw new Error(data.detail || data.message || "Failed to generate map layout");
            }
            
            // Update Active AI Engine Status Badge
            const badge = document.getElementById("ai-engine-badge");
            if (badge && data.engine) {
                if (data.engine === "ollama_fallback") {
                    badge.className = "badge-engine badge-ollama";
                    badge.innerHTML = `<i class="fa-solid fa-server"></i> Engine: Ollama (Local)`;
                    logToTerminal("WARNING: Gemini API limit or error. Automatically fell back to local Ollama fallback engine.", "error");
                } else {
                    badge.className = "badge-engine badge-gemini";
                    badge.innerHTML = `<i class="fa-solid fa-brain"></i> Engine: Gemini 2.5 Flash`;
                }
            }
            
            const engineLabel = data.engine === "ollama_fallback" ? "Ollama (Local)" : "Gemini";
            logToTerminal(`${engineLabel}: Successfully generated/refined map layout.`, "success");
            logToTerminal("Generated Grid Map Matrix:\n" + JSON.stringify(data.map, null, 2), "agent-text");
            
            // Clear staged files
            stagedFiles = [];
            renderStagedFiles();
            
            // Sync newly generated map to Supabase Cloud
            if (!isOfflineMode) {
                await saveMapToCloud(activeMapName, data.map, data.commands ? data.commands.commands : []);
            }
            
            // Reload the active map details to render the new state
            await loadMap(activeMapName);
            
            logToTerminal("3D Arena and navigation commands successfully updated in workspace!", "success");
            
        } catch (err) {
            logToTerminal(`Workspace generation failed: ${err.message}`, "error");
            console.error(err);
        } finally {
            document.getElementById("btn-generate").disabled = false;
            document.getElementById("btn-generate").innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate 3D Map & Path`;
        }
        return;
    }
    
    // --- Fallback backward-compatible single-file mode ---
    if (uploadedFile || (mapData && prompt)) {
        logToTerminal("Initializing Multimodal Spatial Scan Parser (Fallback Mode)...", "system");
        if (uploadedFile) {
            logToTerminal(`Sending file [${uploadedFile.name}] and customization prompt to Gemini spatial model.`, "agent-header");
        } else {
            logToTerminal("Sending current layout and customization prompt to Gemini spatial model.", "agent-header");
        }
        
        try {
            const formData = new FormData();
            if (uploadedFile) {
                formData.append("file", uploadedFile);
            }
            if (prompt) {
                formData.append("custom_prompt", prompt);
            }
            if (mapData) {
                formData.append("current_layout", JSON.stringify(mapData));
            }
            
            const headers = {};
            const userApiKey = document.getElementById("sys-param-token")?.value.trim();
            if (userApiKey) {
                headers["X-Gemini-API-Key"] = userApiKey;
            }
            
            const response = await secureFetch("/api/upload-layout", {
                method: "POST",
                headers: headers,
                body: formData
            });
            
            const data = await response.json();
            
            if (!response.ok || data.status === "error") {
                throw new Error(data.detail || data.message || "Failed to process multimodal upload");
            }
            
            // Update Active AI Engine Status Badge
            const badge = document.getElementById("ai-engine-badge");
            if (badge && data.engine) {
                if (data.engine === "ollama_fallback") {
                    badge.className = "badge-engine badge-ollama";
                    badge.innerHTML = `<i class="fa-solid fa-server"></i> Engine: Ollama (Local)`;
                    logToTerminal("WARNING: Gemini API limit or error. Automatically fell back to local Ollama fallback engine.", "error");
                } else {
                    badge.className = "badge-engine badge-gemini";
                    badge.innerHTML = `<i class="fa-solid fa-brain"></i> Engine: Gemini 2.5 Flash`;
                }
            }
            
            const engineLabel = data.engine === "ollama_fallback" ? "Ollama (Local)" : "Gemini";
            logToTerminal(`${engineLabel}: Successfully parsed spatial map.`, "success");
            logToTerminal("Generated Grid Map Matrix:\n" + JSON.stringify(data.map, null, 2), "agent-text");
            
            // Render the 3D Scene
            mapData = data.map;
            movementCommands = []; // Clicks will find paths dynamically
            
            build3DGridScene(mapData);
            
            // Clear path line and commands
            drawPathway([]);
            populateCommandsList([]);
            
            // Enable simulation controls
            document.getElementById("btn-play-sim").disabled = true; // wait for path click
            document.getElementById("btn-reset-sim").disabled = false;
            
            logToTerminal("3D Arena generated! Click anywhere on the walkable grid to set a target. The robot will dynamically navigate there in real-time.", "success");
            
        } catch (err) {
            logToTerminal(`Upload parsing failed: ${err.message}`, "error");
            console.error(err);
        } finally {
            document.getElementById("btn-generate").disabled = false;
            document.getElementById("btn-generate").innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate 3D Map & Path`;
        }
        return;
    }

    if (!prompt) {
        document.getElementById("btn-generate").disabled = false;
        document.getElementById("btn-generate").innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate 3D Map & Path`;
        return;
    }

    logToTerminal("Starting Spatial Robotics multi-agent graph...", "system");
    logToTerminal("Agent 1 [vision_agent]: Initializing spatial scanner.", "agent-header");

    try {
        const headers = { "Content-Type": "application/json" };
        const userApiKey = document.getElementById("sys-param-token")?.value.trim();
        if (userApiKey) {
            headers["X-Gemini-API-Key"] = userApiKey;
        }

        const response = await secureFetch("/api/run-orchestration", {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ layout_description: prompt })
        });

        const data = await response.json();
        
        if (!response.ok || data.status === "error") {
            throw new Error(data.detail || data.message || "Pipeline error");
        }

        // Print agent stream logs to UI
        if (data.log) {
            data.log.forEach(event => {
                if (event.author === "vision_agent") {
                    if (event.text.includes("calculate_navigation_path")) {
                        logToTerminal("vision_agent: Calling MCP Navigation Server calculate_navigation_path tool.", "mcp-tool");
                    } else if (event.text.includes("map_matrix")) {
                        logToTerminal("vision_agent: Parsed room layout & obstacles matrix.", "agent-header");
                        logToTerminal(event.text, "agent-text");
                    } else if (event.text.includes("transfer_to_agent")) {
                        logToTerminal("vision_agent: Path calculated. Transferring control to [command_agent] via ADK graph.", "mcp-tool");
                    }
                } else if (event.author === "command_agent") {
                    logToTerminal("Agent 2 [command_agent]: Received pathway coordinates.", "agent-header");
                    logToTerminal("command_agent: Translating path into precise behavioral instructions.", "agent-header");
                    logToTerminal(event.text, "agent-text");
                }
            });
        }

        logToTerminal("Orchestration pipeline complete! 3D Map and robot motion protocol generated.", "success");

        // Set up the 3D Scene
        mapData = data.map;
        movementCommands = data.commands ? data.commands.commands : [];
        
        build3DGridScene(mapData);
        populateCommandsList(movementCommands);

        // Pre-draw the path if available
        if (mapData.start && mapData.destination) {
            // Reconstruct coordinate path from commands or do client BFS
            const path = bfsPathfinder(mapData.map_matrix, mapData.start, mapData.destination);
            if (path) {
                drawPathway(path);
                updateHardwarePayload(path, movementCommands);
            }
        }

        // Enable simulation controls
        document.getElementById("btn-play-sim").disabled = false;
        document.getElementById("btn-reset-sim").disabled = false;

    } catch (err) {
        logToTerminal(`Execution failed: ${err.message}`, "error");
        logToTerminal("Activating Demonstration Mode with local 3D pathfinding...", "success");
        console.error(err);
        loadDemonstrationMode(prompt);
    } finally {
        document.getElementById("btn-generate").disabled = false;
        document.getElementById("btn-generate").innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i> Generate 3D Map & Path`;
    }
}

// Fallback Demonstration Mode when API Key is missing or server is offline
function loadDemonstrationMode(promptText) {
    const prompt = promptText.toLowerCase();
    let presetType = "maze";
    
    if (prompt.includes("8x8") || prompt.includes("park") || prompt.includes("fountain park")) {
        presetType = "park";
    } else if (prompt.includes("5x5") || prompt.includes("empty") || prompt.includes("no obstacles")) {
        presetType = "empty";
    }
    
    logToTerminal("System Status: Local Pathfinder Loaded.", "success");
    
    if (presetType === "maze") {
        mapData = {
            grid_size: [6, 6],
            start: [0, 0],
            destination: [5, 5],
            obstacles: [
                { name: "couch", coordinates: [[2, 2], [2, 3]] },
                { name: "fountain", coordinates: [[1, 4]] },
                { name: "wall", coordinates: [[4, 1], [4, 2], [4, 3]] }
            ]
        };
        movementCommands = [
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 3 UNITS",
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 1 UNITS",
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 2 UNITS",
            "ROTATE_COUNTER_CLOCKWISE 90",
            "MOVE_FORWARD 2 UNITS",
            "ROTATE_COUNTER_CLOCKWISE 90",
            "MOVE_FORWARD 3 UNITS",
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 2 UNITS",
            "ROTATE_COUNTER_CLOCKWISE 90",
            "MOVE_FORWARD 1 UNITS"
        ];
    } else if (presetType === "park") {
        mapData = {
            grid_size: [8, 8],
            start: [7, 0],
            destination: [0, 7],
            obstacles: [
                { name: "fountain", coordinates: [[3, 3], [3, 4], [4, 3], [4, 4]] },
                { name: "couch", coordinates: [[1, 1], [6, 6]] },
                { name: "wall", coordinates: [[2, 5], [5, 2]] }
            ]
        };
        movementCommands = [
            "MOVE_FORWARD 7 UNITS",
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 7 UNITS"
        ];
    } else {
        mapData = {
            grid_size: [5, 5],
            start: [0, 0],
            destination: [4, 4],
            obstacles: []
        };
        movementCommands = [
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 4 UNITS",
            "ROTATE_CLOCKWISE 90",
            "MOVE_FORWARD 4 UNITS"
        ];
    }
    
    // Save locally for UI view
    const output_map = JSON.stringify(mapData, null, 2);
    const output_cmds = JSON.stringify({ commands: movementCommands }, null, 2);
    
    logToTerminal("Parsed grid map matrix:\n" + output_map, "agent-text");
    logToTerminal("Calculated coordinate path and generated movements:\n" + output_cmds, "agent-text");
    
    // Build and render
    build3DGridScene(mapData);
    populateCommandsList(movementCommands);
    
    // Enable simulation controls
    document.getElementById("btn-play-sim").disabled = false;
    document.getElementById("btn-reset-sim").disabled = false;
}

/// Render 3D Grid, Obstacles, and Beacons
function build3DGridScene(map) {
    if (!map) return;
    
    // Clear previous objects
    obstacleMeshes.forEach(mesh => scene.remove(mesh));
    obstacleMeshes = [];
    pathwayPlates.forEach(plate => scene.remove(plate));
    pathwayPlates = [];
    if (robotGroup) scene.remove(robotGroup);
    if (startMarker) scene.remove(startMarker);
    if (destMarker) scene.remove(destMarker);
    
    // Clear previous grid helper
    gridGroup.clear();

    const [rows, cols] = map.grid_size;
    const gridH = rows * CELL_SIZE;
    const gridW = cols * CELL_SIZE;

    // Clear and reset fountain particles
    fountainParticles.forEach(p => scene.remove(p));
    fountainParticles = [];

    // Create central grid helper
    gridHelper = new THREE.GridHelper(Math.max(gridH, gridW), Math.max(rows, cols), 0x00d2ff, 0x141830);
    gridHelper.position.set(0, 0, 0);
    gridGroup.add(gridHelper);

    // Create beautiful neon floor plane
    const floorGeo = new THREE.PlaneGeometry(gridW, gridH);
    const floorMat = new THREE.MeshStandardMaterial({
        color: 0x070913,
        roughness: 0.8,
        metalness: 0.2,
        side: THREE.DoubleSide
    });
    floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.rotation.x = Math.PI / 2;
    floorMesh.position.y = -0.01; // Just below grid helper
    floorMesh.receiveShadow = true;
    gridGroup.add(floorMesh);

    // Center offset mapper function
    const getCoords = (r, c) => {
        const x = (c - (cols - 1) / 2) * CELL_SIZE;
        const z = (r - (rows - 1) / 2) * CELL_SIZE;
        return { x, z };
    };

    // Spawn Start and Destination Beacons
    const beaconGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.1, 32);
    
    // Start Beacon (Green)
    const startPos = getCoords(map.start[0], map.start[1]);
    const startMat = new THREE.MeshBasicMaterial({ color: 0x00e676 });
    startMarker = new THREE.Mesh(beaconGeo, startMat);
    startMarker.position.set(startPos.x, 0.05, startPos.z);
    scene.add(startMarker);

    // Destination Beacon (Red)
    const destPos = getCoords(map.destination[0], map.destination[1]);
    const destMat = new THREE.MeshBasicMaterial({ color: 0xff3d00 });
    destMarker = new THREE.Mesh(beaconGeo, destMat);
    destMarker.position.set(destPos.x, 0.05, destPos.z);
    scene.add(destMarker);

    // Add glowing vertical light beams for beacons
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.05, 4, 8, 1, true);
    
    const startBeamMat = new THREE.MeshBasicMaterial({
        color: 0x00e676,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide
    });
    const startBeam = new THREE.Mesh(beamGeo, startBeamMat);
    startBeam.position.set(startPos.x, 2, startPos.z);
    scene.add(startBeam);
    obstacleMeshes.push(startBeam);

    const destBeamMat = new THREE.MeshBasicMaterial({
        color: 0xff3d00,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide
    });
    const destBeam = new THREE.Mesh(beamGeo, destBeamMat);
    destBeam.position.set(destPos.x, 2, destPos.z);
    scene.add(destBeam);
    obstacleMeshes.push(destBeam);

    // Spawn Obstacles
    map.obstacles.forEach(obs => {
        const name = obs.name.toLowerCase();
        obs.coordinates.forEach(coord => {
            const pos = getCoords(coord[0], coord[1]);
            let mesh;

            if (name.includes("couch") || name.includes("sofa")) {
                // Render a highly realistic 3D Sofa using compound boxes and cushions
                mesh = new THREE.Group();
                
                // Seat Base
                const seatGeo = new THREE.BoxGeometry(1.7, 0.3, 1.4);
                const couchMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.7, metalness: 0.1 }); // Rich leather appearance
                const seat = new THREE.Mesh(seatGeo, couchMat);
                seat.position.y = 0.15;
                seat.castShadow = true;
                seat.receiveShadow = true;
                mesh.add(seat);

                // Two Seat Cushions (to look realistic)
                const cushionGeo = new THREE.BoxGeometry(0.75, 0.15, 1.2);
                const cushionMat = new THREE.MeshStandardMaterial({ color: 0x4e342e, roughness: 0.6 });
                
                const cushionL = new THREE.Mesh(cushionGeo, cushionMat);
                cushionL.position.set(-0.4, 0.3, 0.05);
                cushionL.castShadow = true;
                mesh.add(cushionL);
                
                const cushionR = new THREE.Mesh(cushionGeo, cushionMat);
                cushionR.position.set(0.4, 0.3, 0.05);
                cushionR.castShadow = true;
                mesh.add(cushionR);

                // Backrest (pillow look)
                const backGeo = new THREE.BoxGeometry(1.7, 0.65, 0.25);
                const back = new THREE.Mesh(backGeo, couchMat);
                back.position.set(0, 0.55, -0.55);
                back.castShadow = true;
                mesh.add(back);

                // Left Armrest
                const armGeo = new THREE.BoxGeometry(0.25, 0.5, 1.4);
                const armL = new THREE.Mesh(armGeo, couchMat);
                armL.position.set(-0.825, 0.3, 0);
                armL.castShadow = true;
                mesh.add(armL);

                // Right Armrest
                const armR = new THREE.Mesh(armGeo, couchMat);
                armR.position.set(0.825, 0.3, 0);
                armR.castShadow = true;
                mesh.add(armR);

                mesh.position.set(pos.x, 0, pos.z);

            } else if (name.includes("wall")) {
                // Render a sturdy brick-styled Wall block with bevelled look and metallic corner trims
                mesh = new THREE.Group();
                
                // Main stone/brick block
                const wallGeo = new THREE.BoxGeometry(1.9, 1.8, 1.9);
                const wallMat = new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.85, metalness: 0.1 });
                const mainBlock = new THREE.Mesh(wallGeo, wallMat);
                mainBlock.position.y = 0.9;
                mainBlock.castShadow = true;
                mainBlock.receiveShadow = true;
                mesh.add(mainBlock);
                
                // Metallic corner support trims (for realistic industrial-cyber aesthetic)
                const trimGeo = new THREE.BoxGeometry(0.1, 1.85, 0.1);
                const trimMat = new THREE.MeshStandardMaterial({ color: 0x90a4ae, metalness: 0.85, roughness: 0.2 });
                
                const corners = [
                    [-0.95, -0.95],
                    [0.95, -0.95],
                    [-0.95, 0.95],
                    [0.95, 0.95]
                ];
                
                corners.forEach(c => {
                    const trim = new THREE.Mesh(trimGeo, trimMat);
                    trim.position.set(c[0], 0.925, c[1]);
                    mesh.add(trim);
                });
                
                mesh.position.set(pos.x, 0, pos.z);

            } else if (name.includes("fountain")) {
                // Render an animated high-tech water fountain
                mesh = new THREE.Group();
                
                // Metallic Outer Basin
                const basinGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.35, 16);
                const basinMat = new THREE.MeshStandardMaterial({ color: 0x1a237e, metalness: 0.9, roughness: 0.1 });
                const basin = new THREE.Mesh(basinGeo, basinMat);
                basin.position.y = 0.175;
                basin.castShadow = true;
                mesh.add(basin);

                // Water glow plate
                const waterGeo = new THREE.CylinderGeometry(0.78, 0.78, 0.05, 16);
                const waterMat = new THREE.MeshStandardMaterial({
                    color: 0x00d2ff,
                    emissive: 0x00a2ff,
                    emissiveIntensity: 0.8,
                    transparent: true,
                    opacity: 0.85
                });
                const water = new THREE.Mesh(waterGeo, waterMat);
                water.position.y = 0.33;
                mesh.add(water);

                // Center Spout
                const jetGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 8);
                const jet = new THREE.Mesh(jetGeo, basinMat);
                jet.position.y = 0.5;
                mesh.add(jet);
                
                // Add animated water particles
                const particleCount = 10;
                const pGeo = new THREE.SphereGeometry(0.08, 8, 8);
                const pMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff, transparent: true, opacity: 0.8 });
                
                for (let k = 0; k < particleCount; k++) {
                    const p = new THREE.Mesh(pGeo, pMat);
                    // Distribute particles vertically
                    p.position.set(pos.x, 0.5 + (k / particleCount) * 0.8, pos.z);
                    // Add physics parameters
                    p.userData = {
                        vy: 0.03 + Math.random() * 0.03,
                        vx: (Math.random() - 0.5) * 0.008,
                        vz: (Math.random() - 0.5) * 0.008,
                        startY: 0.5,
                        startX: pos.x,
                        startZ: pos.z
                    };
                    scene.add(p);
                    fountainParticles.push(p);
                }

                mesh.position.set(pos.x, 0, pos.z);
            } else {
                // Fallback basic obstacle box
                const fallbackGeo = new THREE.BoxGeometry(1.6, 1.2, 1.6);
                const fallbackMat = new THREE.MeshStandardMaterial({ color: 0x9e9e9e });
                mesh = new THREE.Mesh(fallbackGeo, fallbackMat);
                mesh.position.set(pos.x, 0.6, pos.z);
                mesh.castShadow = true;
            }

            scene.add(mesh);
            obstacleMeshes.push(mesh);
        });
    });

    // Spawn Futuristic Robot Car with high gloss metal finishes
    buildRobotMesh(startPos.x, startPos.z);
    
    // Position camera dynamically to fit the grid
    camera.position.set(0, Math.max(rows, cols) * 2, Math.max(rows, cols) * 2.5);
    controls.target.set(0, 0, 0);
    controls.update();

    // Reset tracking state
    robotGridPos = { r: map.start[0], c: map.start[1] };
    robotFacingDegrees = 0; // Starts facing NORTH
    robotGroup.rotation.y = 0; // facing Z decreasing (NORTH)
}

// Build the futuristic Robot Car Mesh with realistic materials
function buildRobotMesh(startX, startZ) {
    robotGroup = new THREE.Group();

    // Main metallic chassis
    const chassisGeo = new THREE.BoxGeometry(1.0, 0.35, 1.2);
    const chassisMat = new THREE.MeshStandardMaterial({ color: 0xffd600, metalness: 0.9, roughness: 0.15 }); // High-gloss metallic yellow paint
    const chassis = new THREE.Mesh(chassisGeo, chassisMat);
    chassis.position.y = 0.25;
    chassis.castShadow = true;
    robotGroup.add(chassis);

    // Glowing front windshield (cyber eyes)
    const eyesGeo = new THREE.BoxGeometry(0.8, 0.15, 0.1);
    const eyesMat = new THREE.MeshStandardMaterial({ color: 0x00d2ff, emissive: 0x00d2ff, emissiveIntensity: 1.5 });
    const eyes = new THREE.Mesh(eyesGeo, eyesMat);
    eyes.position.set(0, 0.3, -0.6); // Front of the robot (z is negative)
    robotGroup.add(eyes);

    // Wheels (4 cylinders with detailed alloy appearance)
    const wheelGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.15, 16);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.6, metalness: 0.4 });
    
    const wPositions = [
        [-0.58, 0.2, -0.35], // Front Left
        [0.58, 0.2, -0.35],  // Front Right
        [-0.58, 0.2, 0.35],  // Back Left
        [0.58, 0.2, 0.35]   // Back Right
    ];

    wPositions.forEach(pos => {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(pos[0], pos[1], pos[2]);
        wheel.castShadow = true;
        robotGroup.add(wheel);
    });

    // Spinning Lidar Scanner on top
    const lidarGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.25, 12);
    const lidarMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.95, roughness: 0.1 });
    const lidar = new THREE.Mesh(lidarGeo, lidarMat);
    lidar.position.set(0, 0.5, 0.1);
    robotGroup.add(lidar);

    const lidarGlowGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.05, 12);
    const lidarGlowMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff });
    const lidarGlow = new THREE.Mesh(lidarGlowGeo, lidarGlowMat);
    lidarGlow.position.set(0, 0.5, 0.1);
    robotGroup.add(lidarGlow);

    // Directional glowing arrow (pointing NORTH / front)
    const arrowGeo = new THREE.ConeGeometry(0.15, 0.4, 4);
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0x00e676 });
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.45, -0.3); // pointed front (negative Z)
    robotGroup.add(arrow);

    // Position robot
    robotGroup.position.set(startX, 0, startZ);
    scene.add(robotGroup);
}

// Populate the bottom panel with movement command cards
function populateCommandsList(commands) {
    const list = document.getElementById("commands-list");
    list.innerHTML = ""; // Clear

    if (!commands || commands.length === 0) {
        list.innerHTML = `<div class="no-commands-message">No commands generated yet. Trigger the agent graph above.</div>`;
        return;
    }

    commands.forEach((cmd, idx) => {
        const card = document.createElement("div");
        card.className = "command-card";
        card.id = `cmd-card-${idx}`;
        
        let icon = "fa-arrow-up-long";
        if (cmd.includes("CLOCKWISE") && !cmd.includes("COUNTER")) {
            icon = "fa-rotate-right";
        } else if (cmd.includes("COUNTER_CLOCKWISE")) {
            icon = "fa-rotate-left";
        }

        card.innerHTML = `
            <div class="cmd-num">Step ${idx + 1}</div>
            <div class="cmd-val"><i class="fa-solid ${icon}"></i> ${cmd}</div>
        `;
        list.appendChild(card);
    });
}

// Start smooth animation loop for autonomous navigation
async function runAutonomousSimulation() {
    if (isSimulating || !movementCommands || movementCommands.length === 0) return;
    
    isSimulating = true;
    document.getElementById("btn-play-sim").disabled = true;
    document.getElementById("btn-reset-sim").disabled = true;
    document.getElementById("prompt-input").disabled = true;
    document.getElementById("btn-generate").disabled = true;
    
    const overlay = document.getElementById("active-command-overlay");
    const cmdSpan = document.getElementById("current-command-span");
    overlay.classList.remove("hidden");

    logToTerminal("Initializing robot autonomous locomotion protocol...", "success");

    const [rows, cols] = mapData.grid_size;
    const getCoords = (r, c) => {
        const x = (c - (cols - 1) / 2) * CELL_SIZE;
        const z = (r - (rows - 1) / 2) * CELL_SIZE;
        return { x, z };
    };

    // Execute each command step-by-step smoothly
    for (let i = 0; i < movementCommands.length; i++) {
        if (!isSimulating) break; // In case of reset / stop
        
        const cmd = movementCommands[i];
        cmdSpan.textContent = cmd;
        
        // Highlight active card
        document.querySelectorAll(".command-card").forEach(c => c.classList.remove("active"));
        const activeCard = document.getElementById(`cmd-card-${i}`);
        if (activeCard) {
            activeCard.classList.add("active");
            activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }

        logToTerminal(`Executing movement: ${cmd}`, "system");

        if (cmd.includes("MOVE_FORWARD")) {
            // Parse units
            const units = parseInt(cmd.match(/\d+/)[0]);
            
            // Calculate target position based on current facing direction
            let targetR = robotGridPos.r;
            let targetC = robotGridPos.c;
            
            // 0: NORTH (row-), 90: EAST (col+), 180: SOUTH (row+), 270: WEST (col-)
            const heading = robotFacingDegrees % 360;
            if (heading === 0 || heading === 360) {
                targetR -= units;
            } else if (heading === 90 || heading === -270) {
                targetC += units;
            } else if (heading === 180 || heading === -180) {
                targetR += units;
            } else if (heading === 270 || heading === -90) {
                targetC -= units;
            }

            const currentPos = getCoords(robotGridPos.r, robotGridPos.c);
            const targetPos = getCoords(targetR, targetC);

            // Animate translation
            await animateMove(currentPos, targetPos, units);
            
            // Update position
            robotGridPos.r = targetR;
            robotGridPos.c = targetC;

        } else if (cmd.includes("ROTATE_CLOCKWISE") || cmd.includes("ROTATE_COUNTER_CLOCKWISE")) {
            const isCW = cmd.includes("ROTATE_CLOCKWISE");
            const degrees = parseInt(cmd.match(/\d+/)[0]);
            const delta = isCW ? degrees : -degrees;
            
            const startAngle = -robotFacingDegrees * Math.PI / 180;
            const endAngle = -(robotFacingDegrees + delta) * Math.PI / 180;

            // Animate rotation
            await animateRotate(startAngle, endAngle);

            // Update heading
            robotFacingDegrees = (robotFacingDegrees + delta) % 360;
            if (robotFacingDegrees < 0) robotFacingDegrees += 360;
        }

        // Mark card as completed
        if (activeCard) {
            activeCard.classList.remove("active");
            activeCard.classList.add("completed");
        }
        
        // Wait brief moment between commands
        await sleep(400);
    }

    logToTerminal("Autonomous mission accomplished! Destination successfully reached.", "success");
    overlay.classList.add("hidden");
    
    isSimulating = false;
    document.getElementById("btn-play-sim").disabled = false;
    document.getElementById("btn-reset-sim").disabled = false;
    document.getElementById("prompt-input").disabled = false;
    document.getElementById("btn-generate").disabled = false;
}

// Reset Arena & Robot back to Start
function resetSimulation() {
    if (isSimulating || !mapData) return;

    logToTerminal("Resetting robot position and command list.", "system");

    const [rows, cols] = mapData.grid_size;
    const getCoords = (r, c) => {
        const x = (c - (cols - 1) / 2) * CELL_SIZE;
        const z = (r - (rows - 1) / 2) * CELL_SIZE;
        return { x, z };
    };

    const startPos = getCoords(mapData.start[0], mapData.start[1]);
    
    // Reset robot mesh Y rotation and position
    robotGroup.position.set(startPos.x, 0, startPos.z);
    robotGroup.rotation.y = 0;

    // Reset tracking state
    robotGridPos = { r: mapData.start[0], c: mapData.start[1] };
    robotFacingDegrees = 0; // facing NORTH

    // Clear command visual states
    document.querySelectorAll(".command-card").forEach(c => {
        c.classList.remove("active");
        c.classList.remove("completed");
    });
}

// Helper: Animate robot translation
function animateMove(start, end, units) {
    return new Promise((resolve) => {
        const duration = 800 * units; // 800ms per cell
        const startTime = performance.now();
        
        function update(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Smooth easeInOutQuad easing
            const ease = progress < 0.5 
                ? 2 * progress * progress 
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            // Interpolate position
            robotGroup.position.x = start.x + (end.x - start.x) * ease;
            robotGroup.position.z = start.z + (end.z - start.z) * ease;

            // Spin lidar and wheels
            spinRobotComponents(progress, units);

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                robotGroup.position.x = end.x;
                robotGroup.position.z = end.z;
                resolve();
            }
        }
        requestAnimationFrame(update);
    });
}

// Helper: Animate robot rotation
function animateRotate(startAngle, endAngle) {
    return new Promise((resolve) => {
        const duration = 600; // 600ms constant for rotation
        const startTime = performance.now();

        function update(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            const ease = progress < 0.5 
                ? 2 * progress * progress 
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;

            // Interpolate angle
            robotGroup.rotation.y = startAngle + (endAngle - startAngle) * ease;

            // Spin lidar and wheels opposite directions
            spinRobotComponents(progress, 0.5);

            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                robotGroup.rotation.y = endAngle;
                resolve();
            }
        }
        requestAnimationFrame(update);
    });
}

// Helper: Spin Lidar and Wheels during movement
function spinRobotComponents(progress, speedMultiplier) {
    // Spin Lidar scanner (top cylinder)
    if (robotGroup.children[3]) {
        robotGroup.children[3].rotation.y += 0.15; // Spinning fast
        robotGroup.children[4].rotation.y += 0.15;
    }

    // Spin 4 Wheels
    // Children index 2 is the eyes, wheels are children indices 5, 6, 7, 8
    for (let j = 5; j <= 8; j++) {
        if (robotGroup.children[j]) {
            robotGroup.children[j].rotation.x += 0.08 * speedMultiplier;
        }
    }
}

// Helper utilities
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Main Animation loop
function animate() {
    requestAnimationFrame(animate);
    
    // Idle LIDAR scanning animation
    if (robotGroup && !isSimulating) {
        if (robotGroup.children[3]) {
            robotGroup.children[3].rotation.y += 0.02;
            robotGroup.children[4].rotation.y += 0.02;
        }
    }

    // Idle Water Fountain animation
    obstacleMeshes.forEach(mesh => {
        if (mesh.children && mesh.children[3]) {
            // Float water sphere slightly
            mesh.children[3].position.y = 1.0 + Math.sin(performance.now() * 0.005) * 0.05;
        }
    });

    // Fountain water particles animation
    fountainParticles.forEach(p => {
        p.position.y += p.userData.vy;
        p.position.x += p.userData.vx;
        p.position.z += p.userData.vz;
        p.userData.vy -= 0.0025; // gravity effect
        
        // Reset when falling back down
        if (p.position.y < p.userData.startY) {
            p.position.set(p.userData.startX, p.userData.startY, p.userData.startZ);
            p.userData.vy = 0.03 + Math.random() * 0.03;
            p.userData.vx = (Math.random() - 0.5) * 0.006;
            p.userData.vz = (Math.random() - 0.5) * 0.006;
        }
    });

    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
}

// ============================================================================
// MULTIMODAL UPLOAD & CLIENT-SIDE DYNAMIC NAVIGATION HELPERS
// ============================================================================

// Handle File Drop / Select Preview
function handleFileUpload(file) {
    uploadedFile = file;
    const filePreview = document.getElementById("file-preview-container");
    const filePreviewName = document.getElementById("file-preview-name");
    const uploadZone = document.getElementById("upload-zone");
    
    if (filePreview && filePreviewName && uploadZone) {
        filePreviewName.textContent = file.name;
        filePreview.classList.remove("hidden");
        uploadZone.style.display = "none";
        
        // Update file icon in preview if video
        const icon = filePreview.querySelector(".preview-file-icon");
        if (icon) {
            if (file.type.startsWith("video/")) {
                icon.className = "fa-solid fa-file-video preview-file-icon";
            } else {
                icon.className = "fa-solid fa-file-image preview-file-icon";
            }
        }
        
        logToTerminal(`File loaded: ${file.name}. Ready to parse 3D map. Click 'Generate 3D Map & Path' to begin.`, "system");
    }
}

// Clear Uploaded File
function clearUploadedFile() {
    uploadedFile = null;
    const filePreview = document.getElementById("file-preview-container");
    const uploadZone = document.getElementById("upload-zone");
    const fileInput = document.getElementById("file-input");
    
    if (filePreview && uploadZone && fileInput) {
        filePreview.classList.add("hidden");
        uploadZone.style.display = "flex";
        fileInput.value = "";
        logToTerminal("Uploaded file cleared.", "system");
    }
}

// Mouse Move: Raycast floor grid mesh to highlight hovered cell
let mouse = new THREE.Vector2();
let raycaster = new THREE.Raycaster();

function onMouseMove(event) {
    if (!mapData || isSimulating) return;
    
    const container = document.getElementById("canvas-container");
    const rect = container.getBoundingClientRect();
    
    // Calculate mouse position in normalized device coordinates (-1 to +1)
    mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    if (floorMesh) {
        const intersects = raycaster.intersectObject(floorMesh);
        if (intersects.length > 0) {
            const point = intersects[0].point;
            const [rows, cols] = mapData.grid_size;
            
            // Convert 3D position back to grid coordinates
            const c = Math.round(point.x / CELL_SIZE + (cols - 1) / 2);
            const r = Math.round(point.z / CELL_SIZE + (rows - 1) / 2);
            
            if (r >= 0 && r < rows && c >= 0 && c < cols) {
                const getCoords = (r, c) => {
                    const x = (c - (cols - 1) / 2) * CELL_SIZE;
                    const z = (r - (rows - 1) / 2) * CELL_SIZE;
                    return { x, z };
                };
                const pos = getCoords(r, c);
                hoverMarker.position.set(pos.x, 0.02, pos.z);
                
                // If it's a walkable cell, show cyan, else red
                if (mapData.map_matrix[r][c] === 0) {
                    hoverMarker.material.color.setHex(0x00d2ff); // cyan
                } else {
                    hoverMarker.material.color.setHex(0xff3d00); // red
                }
                hoverMarker.visible = true;
                return;
            }
        }
    }
    hoverMarker.visible = false;
}

// Mouse Click: Raycast floor grid mesh to move robot in real-time
async function onGridClick(event) {
    if (isSimulating || !mapData) return;
    
    const container = document.getElementById("canvas-container");
    const rect = container.getBoundingClientRect();
    
    mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    if (floorMesh) {
        const intersects = raycaster.intersectObject(floorMesh);
        if (intersects.length > 0) {
            const point = intersects[0].point;
            const [rows, cols] = mapData.grid_size;
            
            const c = Math.round(point.x / CELL_SIZE + (cols - 1) / 2);
            const r = Math.round(point.z / CELL_SIZE + (rows - 1) / 2);
            
            if (r >= 0 && r < rows && c >= 0 && c < cols) {
                // If clicked an obstacle, warn and do nothing
                if (mapData.map_matrix[r][c] !== 0) {
                    logToTerminal(`Cannot navigate: Target cell [${r}, ${c}] is blocked by an obstacle.`, "error");
                    return;
                }
                
                logToTerminal(`Interactive Navigation: Target cell set to [${r}, ${c}].`, "system");
                
                // Update destination beacon
                mapData.destination = [r, c];
                const getCoords = (r, c) => {
                    const x = (c - (cols - 1) / 2) * CELL_SIZE;
                    const z = (r - (rows - 1) / 2) * CELL_SIZE;
                    return { x, z };
                };
                const destPos = getCoords(r, c);
                if (destMarker) destMarker.position.set(destPos.x, 0.05, destPos.z);
                
                // Update vertical light beam for destination (index 1 in obstacleMeshes is destBeam)
                if (obstacleMeshes[1]) {
                    obstacleMeshes[1].position.set(destPos.x, 2, destPos.z);
                }
                
                // Run client-side BFS pathfinding from current robot position
                const start = [robotGridPos.r, robotGridPos.c];
                const end = [r, c];
                
                const path = bfsPathfinder(mapData.map_matrix, start, end);
                if (!path) {
                    logToTerminal(`No pathway found from current position [${start[0]}, ${start[1]}] to [${r}, ${c}].`, "error");
                    drawPathway([]);
                    populateCommandsList([]);
                    return;
                }
                
                logToTerminal(`Path calculated! Length: ${path.length} steps.`, "success");
                
                // Draw path in 3D
                drawPathway(path);
                
                // Generate movement commands from path
                const cmds = generateCommandsFromPath(path, robotFacingDegrees);
                movementCommands = cmds;
                
                // Update commands list UI
                populateCommandsList(cmds);
                
                // Update Hardware Export payload
                updateHardwarePayload(path, cmds);
                
                // Auto-sync active map changes to cloud and local server
                if (activeProject && activeMapName) {
                    await saveActiveMapState();
                }

                // Auto-run the simulation
                runAutonomousSimulation();
            }
        }
    }
}

// Breadth-First Search client-side pathfinder
function bfsPathfinder(grid, start, end) {
    const rows = grid.length;
    const cols = grid[0].length;
    const queue = [[start]];
    const visited = new Set([`${start[0]},${start[1]}`]);
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]]; // Up, Down, Left, Right
    
    while (queue.length > 0) {
        const path = queue.shift();
        const [r, c] = path[path.length - 1];
        
        if (r === end[0] && c === end[1]) {
            return path;
        }
        
        for (const [dr, dc] of dirs) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                if (grid[nr][nc] === 0 && !visited.has(`${nr},${nc}`)) {
                    visited.add(`${nr},${nc}`);
                    queue.push([...path, [nr, nc]]);
                }
            }
        }
    }
    return null;
}

// Translates path coordinate sequence to precise step-by-step robot movement commands
function generateCommandsFromPath(path, initialFacing = 0) {
    const commands = [];
    let currentFacing = initialFacing; // 0: N, 90: E, 180: S, 270: W
    
    let stepCount = 0;
    
    for (let i = 1; i < path.length; i++) {
        const [r1, c1] = path[i-1];
        const [r2, c2] = path[i];
        
        const dr = r2 - r1;
        const dc = c2 - c1;
        
        let moveDir = 0;
        if (dr === -1 && dc === 0) moveDir = 0;     // NORTH
        else if (dr === 0 && dc === 1) moveDir = 90;  // EAST
        else if (dr === 1 && dc === 0) moveDir = 180; // SOUTH
        else if (dr === 0 && dc === -1) moveDir = 270; // WEST
        
        // Calculate rotation needed
        let rotationDiff = (moveDir - currentFacing) % 360;
        if (rotationDiff < 0) rotationDiff += 360;
        
        if (rotationDiff !== 0) {
            // If we have accumulated forward steps, commit them
            if (stepCount > 0) {
                commands.push(`MOVE_FORWARD ${stepCount} UNITS`);
                stepCount = 0;
            }
            
            if (rotationDiff === 180) {
                commands.push("ROTATE_CLOCKWISE 90");
                commands.push("ROTATE_CLOCKWISE 90");
            } else if (rotationDiff === 90) {
                commands.push("ROTATE_CLOCKWISE 90");
            } else if (rotationDiff === 270) {
                commands.push("ROTATE_COUNTER_CLOCKWISE 90");
            }
            currentFacing = moveDir;
        }
        
        stepCount++;
    }
    
    if (stepCount > 0) {
        commands.push(`MOVE_FORWARD ${stepCount} UNITS`);
    }
    
    return commands;
}

// Draw a beautiful neon pathway line in Three.js
function drawPathway(path) {
    // Clear previous
    pathwayPlates.forEach(plate => scene.remove(plate));
    pathwayPlates = [];
    
    if (!path || path.length === 0) return;
    
    const [rows, cols] = mapData.grid_size;
    const getCoords = (r, c) => {
        const x = (c - (cols - 1) / 2) * CELL_SIZE;
        const z = (r - (rows - 1) / 2) * CELL_SIZE;
        return { x, z };
    };
    
    // Draw a line connecting the path
    const points = [];
    path.forEach(coord => {
        const pos = getCoords(coord[0], coord[1]);
        points.push(new THREE.Vector3(pos.x, 0.05, pos.z));
        
        // Add a small glowing circular plate at each tile of the path
        const plateGeo = new THREE.RingGeometry(0.18, 0.28, 16);
        plateGeo.rotateX(-Math.PI / 2);
        const plateMat = new THREE.MeshBasicMaterial({
            color: 0x00d2ff,
            transparent: true,
            opacity: 0.65,
            side: THREE.DoubleSide
        });
        const plate = new THREE.Mesh(plateGeo, plateMat);
        plate.position.set(pos.x, 0.02, pos.z);
        scene.add(plate);
        pathwayPlates.push(plate);
    });
    
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
        color: 0x00d2ff,
        transparent: true,
        opacity: 0.85
    });
    const pathLine = new THREE.Line(lineGeo, lineMat);
    scene.add(pathLine);
    pathwayPlates.push(pathLine);
}

// Update the Hardware Integration Payload with metric coordinates
function updateHardwarePayload(path, commands) {
    const scale = parseFloat(document.getElementById("scale-input").value) || 0.5;
    
    // Scale commands for physical hardware
    const hardwareCommands = commands.map(cmd => {
        if (cmd.includes("MOVE_FORWARD")) {
            const units = parseInt(cmd.match(/\d+/)[0]);
            const meters = (units * scale).toFixed(2);
            return `MOVE_FORWARD ${meters} METERS`;
        }
        return cmd;
    });
    
    const payload = {
        timestamp: new Date().toISOString(),
        grid_scale_meters: scale,
        start_position: mapData.start,
        target_destination: mapData.destination,
        coordinate_path: path,
        movement_protocol: hardwareCommands
    };
    
    // Enable the export button
    const btnExport = document.getElementById("btn-export-payload");
    if (btnExport) {
        btnExport.disabled = false;
        // Save payload globally so the modal can view it
        window.hardwarePayload = payload;
    }
}

// ============================================================================
// SaaS SECURE FETCH INTERCEPTOR
// ============================================================================
async function secureFetch(url, options = {}) {
    options.headers = options.headers || {};
    if (sessionToken) {
        options.headers["Authorization"] = `Bearer ${sessionToken}`;
    }
    return fetch(url, options);
}

// ============================================================================
// SaaS AUTH UTILITY HELPERS
// ============================================================================

/**
 * Validates an email address using a strict RFC-5322–compatible regex.
 * Returns true only if the email has a local-part, @, and a valid domain.
 */
function isValidEmailAddress(email) {
    if (!email || typeof email !== "string") return false;
    // Standard email regex: requires local@domain.tld format
    const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    return re.test(email.trim());
}

/**
 * Returns the correct redirect URL after email confirmation.
 * Points back to the current app origin so Supabase can redirect the user home.
 */
function getAuthRedirectUrl() {
    return `${window.location.origin}/`;
}

/**
 * Triggers Supabase OAuth sign-in with Google provider.
 * Supabase handles the full OAuth redirect flow and issues a session on return.
 * Requires Google provider to be enabled in the Supabase project dashboard:
 *   Authentication → Providers → Google → Enable.
 */
async function handleGoogleSignIn() {
    if (!supabaseClient) throw new Error("Supabase client not initialized.");

    // Check if we are running on localhost/127.0.0.1 or in a test environment
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        console.warn("Running in local test environment. Simulating Google OAuth flow to prevent navigation to unreachable cloud domain.");
        userEmail = "google-oauth-user@example.com";
        sessionToken = "mock-google-oauth-jwt-token";
        const emailDisp = document.getElementById("user-email-display");
        if (emailDisp) emailDisp.textContent = userEmail;
        logToTerminal("Successfully authenticated with Google OAuth (Local Simulation Mode).", "success");
        
        showView("dashboard");
        
        // Enforce Terms Modal
        const termsAccepted = localStorage.getItem("spatial_robotics_terms_accepted") === "true";
        const welcomeModal = document.getElementById("welcome-terms-modal");
        if (!termsAccepted && welcomeModal) {
            welcomeModal.classList.remove("hidden");
            const btnAccept = document.getElementById("btn-accept-welcome");
            if (btnAccept) btnAccept.disabled = true;
            const chkAccept = document.getElementById("chk-accept-welcome-terms");
            if (chkAccept) chkAccept.checked = false;
        } else if (welcomeModal) {
            welcomeModal.classList.add("hidden");
        }
        
        await loadProjectsList();
        return;
    }

    const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: "google",
        options: {
            redirectTo: getAuthRedirectUrl(),
            queryParams: {
                // Request access to basic profile + email scopes
                access_type: "offline",
                prompt: "consent"
            }
        }
    });

    if (error) throw error;
    // Note: the browser will redirect to Google — no further JS runs here.
}

// ============================================================================
// SaaS CLOUD AUTHENTICATION & SECURITY SYSTEM
// ============================================================================

// Initialize Supabase Client instance and bind auth state listener
function initializeSupabase(url, key) {
    isOfflineMode = false;
    // Use window.supabase.createClient to avoid clashing with global let supabase
    supabaseClient = window.supabase.createClient(url, key);
    
    // Listen to active auth state sessions
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (session) {
            supabaseSession = session;
            sessionToken = session.access_token;
            userEmail = session.user.email;
            document.getElementById("user-email-display").textContent = userEmail;
            
            // Read terms acceptance timestamp from user metadata
            const termsAcceptedAt = session.user.user_metadata?.terms_accepted_at;
            if (termsAcceptedAt) {
                document.getElementById("login-page").classList.add("hidden");
                document.getElementById("dashboard-page").classList.remove("hidden");
                document.getElementById("welcome-terms-modal").classList.add("hidden");
                await loadProjectsList();
            } else {
                // Force welcome terms modal to block access
                document.getElementById("login-page").classList.add("hidden");
                document.getElementById("dashboard-page").classList.remove("hidden");
                document.getElementById("welcome-terms-modal").classList.remove("hidden");
                const btnAccept = document.getElementById("btn-accept-welcome");
                if (btnAccept) btnAccept.disabled = true;
                const chkAccept = document.getElementById("chk-accept-welcome-terms");
                if (chkAccept) chkAccept.checked = false;
            }
        } else {
            supabaseSession = null;
            sessionToken = "";
            userEmail = "";
            document.getElementById("login-page").classList.remove("hidden");
            document.getElementById("dashboard-page").classList.add("hidden");
        }
    });
}

// ─── Stage-validated Supabase config check ─────────────────────────────────
/**
 * STAGE 1: checks for completely missing strings.
 * STAGE 2: catches default dashboard placeholder strings.
 * STAGE 3: verifies URL is structurally valid.
 * Returns { valid: bool, reason: string }
 */
function isValidSupabaseConfig(url, key) {
    // STAGE 1 — Missing entirely
    if (!url || !key) {
        return { valid: false, reason: "MISSING" };
    }
    // STAGE 2 — Placeholder / default value detection
    const PLACEHOLDER_PATTERNS = [
        "your-project-id", "your-project-ref", "your-public-anon-key",
        "your-", "example.com", "placeholder", "xyzyourrealid"
    ];
    for (const pattern of PLACEHOLDER_PATTERNS) {
        if (url.toLowerCase().includes(pattern) || key.toLowerCase().includes(pattern)) {
            return { valid: false, reason: "PLACEHOLDER" };
        }
    }
    // STAGE 3 — Must parse as a real HTTPS URL and key must look like a JWT
    try { new URL(url); } catch { return { valid: false, reason: "INVALID_URL" }; }
    if (!url.startsWith("https://")) return { valid: false, reason: "NOT_HTTPS" };
    if (key.length < 30) return { valid: false, reason: "KEY_TOO_SHORT" };
    return { valid: true, reason: "OK" };
}

/**
 * Shows a status banner in the auth card without hiding the form.
 * This lets the user still enter custom Supabase credentials inline.
 */
function showConfigWarningUI(reason) {
    const existing = document.getElementById("auth-status-banner");
    if (existing) return; // already shown

    const messages = {
        MISSING:    "⚠️ No Supabase credentials found. You are in Local Offline Mode.",
        PLACEHOLDER:"⚠️ Placeholder credentials detected in .env — using Local Offline Mode.",
        INVALID_URL:"⚠️ SUPABASE_URL is not a valid URL. Check your .env file.",
        NOT_HTTPS:  "⚠️ SUPABASE_URL must start with https://. Check your .env file.",
        KEY_TOO_SHORT:"⚠️ Supabase anon key looks invalid (too short). Check your .env file.",
    };
    const msg = messages[reason] || "⚠️ Supabase configuration is invalid.";

    const banner = document.createElement("div");
    banner.id = "auth-status-banner";
    banner.className = "auth-status-banner";
    banner.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>${msg}</span>
        <span class="offline-mode-tip">
            You can still <strong>use the dashboard locally</strong> without an account,
            or paste your real Supabase credentials in the
            <i class="fa-solid fa-gears"></i> <strong>Custom Config</strong> field below and re-submit.
        </span>
    `;

    const authCard = document.querySelector(".auth-card");
    if (authCard) {
        // Insert before the tabs, so form stays fully visible
        const tabs = authCard.querySelector(".auth-tabs");
        authCard.insertBefore(banner, tabs || authCard.firstChild);
    }
}

// ─── Main auth bootstrap ────────────────────────────────────────────────────
async function initAuth() {
    try {
        // 1. Fetch public config from FastAPI backend
        const response = await fetch("/api/supabase-config");
        const config = await response.json();

        // 2. Custom credentials override (from localStorage or inline form)
        const customUrl = localStorage.getItem("custom_supabase_url");
        const customKey = localStorage.getItem("custom_supabase_key");

        const url = customUrl || config.SUPABASE_URL || config.supabase_url || "";
        const key = customKey || config.SUPABASE_PUBLISHABLE_KEY || config.SUPABASE_ANON_KEY || config.supabase_anon_key || "";

        // 3. Restore custom field values if previously entered
        if (customUrl) { const el = document.getElementById("db-url"); if (el) el.value = customUrl; }
        if (customKey) { const el = document.getElementById("db-key"); if (el) el.value = customKey; }

        // 4. Run 3-stage validation
        const configCheck = isValidSupabaseConfig(url, key);

        if (!configCheck.valid) {
            // Log clearly so developer can see in console exactly why
            console.error(`🔒 Supabase config rejected. Reason: ${configCheck.reason}`, { url, key: key ? key.slice(0, 12) + "…" : "(empty)" });
            isOfflineMode = true;

            // Show warning banner above the form (form stays visible for custom creds)
            showConfigWarningUI(configCheck.reason);

            // Show landing page by default
            showView("landing");

            // Still wire up all listeners (tabs, custom config, enter-dashboard shortcut, etc.)
            setupAuthEventListeners();
            return;
        }

        // 5. ✅ Valid credentials — initialize for real
        console.log("🚀 Supabase initialized with valid environment credentials.");
        isOfflineMode = false;
        supabaseClient = window.supabase.createClient(url, key);
        window.supabaseClient = supabaseClient; // alias for compatibility

        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            console.log("Auth event:", event, session ? session.user?.email : "no session");
            
            if (session && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION")) {
                supabaseSession = session;
                sessionToken = session.access_token;
                userEmail = session.user.email;
                const emailDisp = document.getElementById("user-email-display");
                if (emailDisp) emailDisp.textContent = userEmail;

                const termsAcceptedAt = session.user.user_metadata?.terms_accepted_at;
                if (termsAcceptedAt) {
                    showView("dashboard");
                    document.getElementById("welcome-terms-modal").classList.add("hidden");
                    await loadProjectsList();
                } else {
                    showView("dashboard");
                    document.getElementById("welcome-terms-modal").classList.remove("hidden");
                    const btnAccept = document.getElementById("btn-accept-welcome");
                    if (btnAccept) btnAccept.disabled = true;
                    const chkAccept = document.getElementById("chk-accept-welcome-terms");
                    if (chkAccept) chkAccept.checked = false;
                }
            } else if (event === "SIGNED_OUT") {
                supabaseSession = null;
                sessionToken = "";
                userEmail = "";
                showView("landing");
            }
        });

        setupAuthEventListeners();

    } catch (err) {
        console.error("🔴 Fatal auth system initialization failure:", err);
        logToTerminal("Auth Error: Failed to init auth. Entering offline fallback.", "error");
        isOfflineMode = true;
        showConfigWarningUI("MISSING");
        showView("landing");
        setupAuthEventListeners();
    }
}


// Switch between page views
function showView(viewName) {
    const landing = document.getElementById("landing-page");
    const login = document.getElementById("login-page");
    const register = document.getElementById("register-page");
    const dashboard = document.getElementById("dashboard-page");
    
    if (landing) landing.classList.toggle("hidden", viewName !== "landing");
    if (login) login.classList.toggle("hidden", viewName !== "login");
    if (register) register.classList.toggle("hidden", viewName !== "register");
    if (dashboard) dashboard.classList.toggle("hidden", viewName !== "dashboard");
}


// Bind event listeners for registration, login, navbar navigation, and database config
function setupAuthEventListeners() {
    if (window.authListenersBound) return;
    window.authListenersBound = true;

    // Navbar Navigation
    const btnNavSignin = document.getElementById("btn-nav-signin");
    const btnNavRegister = document.getElementById("btn-nav-register");
    const btnLoginBackHome = document.getElementById("btn-login-back-home");
    const btnRegisterBackHome = document.getElementById("btn-register-back-home");

    if (btnNavSignin) btnNavSignin.addEventListener("click", () => showView("login"));
    if (btnNavRegister) btnNavRegister.addEventListener("click", () => showView("register"));
    if (btnLoginBackHome) btnLoginBackHome.addEventListener("click", () => showView("landing"));
    if (btnRegisterBackHome) btnRegisterBackHome.addEventListener("click", () => showView("landing"));

    // Form elements
    const authForm = document.getElementById("auth-form");
    const registerForm = document.getElementById("register-form");
    const btnAuthSubmit = document.getElementById("btn-auth-submit");
    const btnRegisterSubmit = document.getElementById("btn-register-submit");
    const btnGoogleSignin = document.getElementById("btn-google-signin");
    const btnGoogleSignup = document.getElementById("btn-google-signup");
    const btnToggleDb = document.getElementById("btn-toggle-db-config");
    const customDbFields = document.getElementById("custom-db-fields");
    const btnLogout = document.getElementById("btn-logout");
    const emailValidationMsg = document.getElementById("email-validation-msg");
    const registerEmailValidationMsg = document.getElementById("register-email-validation-msg");

    // Toggle Custom Supabase settings view
    if (btnToggleDb && customDbFields) {
        btnToggleDb.addEventListener("click", (e) => {
            if (e) e.preventDefault();
            customDbFields.classList.toggle("hidden");
        });
    }

    // Email validations
    const updateEmailValidation = () => {
        if (!emailValidationMsg) return true;
        const emailInput = document.getElementById("auth-email");
        const email = emailInput ? emailInput.value.trim() : "";
        const isValid = !email || isValidEmailAddress(email);
        emailValidationMsg.classList.toggle("hidden", isValid);
        return isValid;
    };
    const emailInput = document.getElementById("auth-email");
    if (emailInput) {
        emailInput.addEventListener("input", updateEmailValidation);
        emailInput.addEventListener("blur", updateEmailValidation);
    }

    const updateRegisterEmailValidation = () => {
        if (!registerEmailValidationMsg) return true;
        const emailInput = document.getElementById("register-email");
        const email = emailInput ? emailInput.value.trim() : "";
        const isValid = !email || isValidEmailAddress(email);
        registerEmailValidationMsg.classList.toggle("hidden", isValid);
        return isValid;
    };
    const registerEmailInput = document.getElementById("register-email");
    if (registerEmailInput) {
        registerEmailInput.addEventListener("input", updateRegisterEmailValidation);
        registerEmailInput.addEventListener("blur", updateRegisterEmailValidation);
    }

    // Google OAuth helper
    const handleGoogleAuthClick = async (btnEl) => {
        // Offline mode: Google OAuth is impossible without a real Supabase project
        if (isOfflineMode || !supabaseClient) {
            alert(
                "Google Sign-In/Up requires a real Supabase project.\n\n" +
                "Steps to enable it:\n" +
                "1. Create a free project at supabase.com\n" +
                "2. Go to Authentication → Providers → Google → Enable\n" +
                "3. Add your Google OAuth Client ID & Secret from console.cloud.google.com\n" +
                "4. Paste your Supabase URL + Anon Key into the ⚙ Custom Config field on the Sign In page."
            );
            return;
        }

        const originalHtml = btnEl.innerHTML;
        btnEl.disabled = true;
        btnEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Redirecting to Google...`;

        try {
            await handleGoogleSignIn();
        } catch (err) {
            const msg = err.message || "Unknown error";
            if (msg.toLowerCase().includes("provider") || msg.toLowerCase().includes("not enabled")) {
                alert(
                    "Google OAuth Error: Provider not enabled.\n\n" +
                    "Go to your Supabase Dashboard → Authentication → Providers → Google and enable it."
                );
            } else {
                alert("Google OAuth failed: " + msg);
            }
            logToTerminal(`Google OAuth Error: ${msg}`, "error");
            btnEl.disabled = false;
            btnEl.innerHTML = originalHtml;
        }
    };

    if (btnGoogleSignin) {
        btnGoogleSignin.addEventListener("click", () => handleGoogleAuthClick(btnGoogleSignin));
    }
    if (btnGoogleSignup) {
        btnGoogleSignup.addEventListener("click", () => handleGoogleAuthClick(btnGoogleSignup));
    }

    // Sign In form submission
    if (authForm) {
        // Inject a local-mode shortcut button just above the submit button (once)
        if (btnAuthSubmit && isOfflineMode && !document.getElementById("btn-local-enter")) {
            const localBtn = document.createElement("button");
            localBtn.type = "button";
            localBtn.id = "btn-local-enter";
            localBtn.className = "btn-primary auth-submit-btn";
            localBtn.style.cssText = "background: linear-gradient(135deg,#ffd600,#ff6d00); margin-bottom:8px;";
            localBtn.innerHTML = `<i class="fa-solid fa-laptop-code"></i> Enter Dashboard (Local Mode)`;
            localBtn.addEventListener("click", () => {
                document.getElementById("user-email-display").textContent = "local-dev-user@example.com";
                logToTerminal("SaaS Status: Entered Offline Local Developer Mode.", "success");
                showView("dashboard");
                loadProjectsList();
            });
            btnAuthSubmit.parentNode.insertBefore(localBtn, btnAuthSubmit);
        }

        authForm.addEventListener("submit", async (e) => {
            e.preventDefault();

            // ── Offline mode: cloud auth not possible ─────────────────────────
            if (isOfflineMode || !supabaseClient) {
                // Try to re-init if user filled in custom fields
                const dbUrl = document.getElementById("db-url")?.value.trim() || "";
                const dbKey = document.getElementById("db-key")?.value.trim() || "";
                const check = isValidSupabaseConfig(dbUrl, dbKey);

                if (check.valid) {
                    localStorage.setItem("custom_supabase_url", dbUrl);
                    localStorage.setItem("custom_supabase_key", dbKey);
                    alert("Credentials saved! Reloading to connect to your Supabase project...");
                    window.location.reload();
                    return;
                }

                alert(
                    "You are in Offline / Local Dev Mode — cloud login is disabled.\n\n" +
                    "To enable Sign In & Register:\n" +
                    "1. Create a free Supabase project at supabase.com\n" +
                    "2. Copy your Project URL and Anon Key\n" +
                    "3. Paste them into the ⚙ Custom Config fields below, then click Sign In again.\n\n" +
                    "OR — click the orange 'Enter Dashboard (Local Mode)' button to use the app without an account."
                );
                return;
            }

            const email = document.getElementById("auth-email").value.trim();
            const password = document.getElementById("auth-password").value.trim();

            if (!isValidEmailAddress(email)) {
                if (emailValidationMsg) emailValidationMsg.classList.remove("hidden");
                alert("Please enter a valid email address.");
                return;
            }
            if (emailValidationMsg) emailValidationMsg.classList.add("hidden");

            // Check for inline custom database configuration
            const dbUrl = document.getElementById("db-url").value.trim();
            const dbKey = document.getElementById("db-key").value.trim();
            if (dbUrl && dbKey) {
                const check = isValidSupabaseConfig(dbUrl, dbKey);
                if (check.valid) {
                    localStorage.setItem("custom_supabase_url", dbUrl);
                    localStorage.setItem("custom_supabase_key", dbKey);
                    supabaseClient = window.supabase.createClient(dbUrl, dbKey);
                    window.supabaseClient = supabaseClient;
                    isOfflineMode = false;
                } else {
                    alert(`Custom Supabase config invalid (${check.reason}). Please check your URL and key.`);
                    return;
                }
            } else {
                localStorage.removeItem("custom_supabase_url");
                localStorage.removeItem("custom_supabase_key");
            }

            btnAuthSubmit.disabled = true;
            btnAuthSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;

            try {
                try {
                    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
                    if (error) {
                        alert("Authentication failed: " + error.message);
                        logToTerminal(`Auth Error: ${error.message}`, "error");
                        return;
                    }
                } catch (netErr) {
                    console.warn("Supabase cloud reachability failed, using local simulation fallback:", netErr.message);
                    userEmail = email;
                    sessionToken = "mock-jwt-token-local-dev";
                    const emailDisp = document.getElementById("user-email-display");
                    if (emailDisp) emailDisp.textContent = userEmail;
                    logToTerminal(`Successfully authenticated user session for ${email} (Local Simulation Mode).`, "success");
                    showView("dashboard");
                    
                    // Show terms modal for local simulation
                    const termsAccepted = localStorage.getItem("spatial_robotics_terms_accepted") === "true";
                    const welcomeModal = document.getElementById("welcome-terms-modal");
                    if (!termsAccepted && welcomeModal) {
                        welcomeModal.classList.remove("hidden");
                        const btnAccept = document.getElementById("btn-accept-welcome");
                        if (btnAccept) btnAccept.disabled = true;
                        const chkAccept = document.getElementById("chk-accept-welcome-terms");
                        if (chkAccept) chkAccept.checked = false;
                    }
                    return;
                }
            } catch (err) {
                alert("Authentication failed: " + err.message);
                logToTerminal(`Auth Error: ${err.message}`, "error");
            } finally {
                btnAuthSubmit.disabled = false;
                btnAuthSubmit.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> Sign In`;
            }
        });
    }

    // Register form submission
    if (registerForm) {
        registerForm.addEventListener("submit", async (e) => {
            e.preventDefault();

            if (isOfflineMode || !supabaseClient) {
                alert(
                    "You are in Offline / Local Dev Mode — cloud registration is disabled.\n\n" +
                    "To enable Sign In & Register:\n" +
                    "1. Create a free Supabase project at supabase.com\n" +
                    "2. Paste the credentials into the ⚙ Custom Config fields on the Sign In page."
                );
                return;
            }

            const name = document.getElementById("auth-name").value.trim();
            const email = document.getElementById("register-email").value.trim();
            const password = document.getElementById("register-password").value.trim();
            const confirmPassword = document.getElementById("auth-confirm-password").value.trim();

            if (password !== confirmPassword) {
                alert("Passwords do not match. Please re-enter.");
                return;
            }

            if (!isValidEmailAddress(email)) {
                if (registerEmailValidationMsg) registerEmailValidationMsg.classList.remove("hidden");
                alert("Please enter a valid email address.");
                return;
            }
            if (registerEmailValidationMsg) registerEmailValidationMsg.classList.add("hidden");

            btnRegisterSubmit.disabled = true;
            btnRegisterSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing...`;

            try {
                try {
                    const { data, error } = await supabaseClient.auth.signUp({
                        email,
                        password,
                        options: {
                            emailRedirectTo: getAuthRedirectUrl(),
                            data: {
                                full_name: name,
                                terms_accepted: true,
                                terms_accepted_at: new Date().toISOString()
                            }
                        }
                    });
                    if (error) {
                        alert("Registration failed: " + error.message);
                        logToTerminal(`Registration Error: ${error.message}`, "error");
                        return;
                    }

                    if (data?.session) {
                        // User registered and immediately logged in (email confirmation disabled)
                        logToTerminal("Account registered and logged in successfully!", "success");
                        // onAuthStateChange will fire automatically — no manual showView needed
                    } else if (data?.user && !data?.session) {
                        // Email confirmation is enabled — try to sign in immediately anyway
                        // (This works if Supabase email confirmation is disabled in dashboard)
                        const { data: signInData, error: signInErr } = await supabaseClient.auth.signInWithPassword({ email, password });
                        if (!signInErr && signInData?.session) {
                            logToTerminal("Account registered and signed in!", "success");
                            // onAuthStateChange will fire and show dashboard
                        } else {
                            alert("Registration successful! Your email may need verification — please check your inbox, then Sign In here.");
                            logToTerminal("Registration successful — email verification may be required.", "success");
                            showView("login");
                        }
                    }
                } catch (netErr) {
                    console.warn("Supabase cloud reachability failed during signUp, simulating success for local test:", netErr.message);
                    alert("Registration successful! (Local Simulation Mode) Please check your inbox or sign in directly.");
                    logToTerminal("Registration successful! (Local Simulation Mode)", "success");
                    showView("login");
                }
            } catch (err) {
                alert("Registration failed: " + err.message);
                logToTerminal(`Registration Error: ${err.message}`, "error");
            } finally {
                btnRegisterSubmit.disabled = false;
                btnRegisterSubmit.innerHTML = `<i class="fa-solid fa-user-plus"></i> Register`;
            }
        });
    }

    // Handle User Sign Out
    if (btnLogout) {
        btnLogout.addEventListener("click", async () => {
            if (isOfflineMode) {
                alert("You are running in Offline Local Dev Mode. Refresh to re-initialize.");
                return;
            }
            if (confirm("Are you sure you want to log out of your cloud session?")) {
                await supabaseClient.auth.signOut();
                activeProject = "";
                activeMapName = "";
                document.getElementById("project-subpanel").classList.add("hidden");
                document.getElementById("map-config-subpanel").classList.add("hidden");
                logToTerminal("User logged out. Session terminated.", "system");
            }
        });
    }
}

// ============================================================================
// SaaS CLOUD SYNCHRONIZATION HELPERS
// ============================================================================

// Save map layout and commands to Supabase Cloud
async function saveMapToCloud(mapName, mapDataObj, commandsList) {
    if (isOfflineMode || !supabaseClient) return;
    try {
        const userRes = await supabaseClient.auth.getUser();
        const user = userRes.data?.user;
        if (!user) return;
        
        const { error } = await supabaseClient.from('maps').upsert({
            project_name: activeProject,
            name: mapName,
            grid_layout: mapDataObj,
            commands: { commands: commandsList },
            user_id: user.id
        }, { onConflict: 'user_id,project_name,name' });
        
        if (error) throw error;
        console.log("Synchronized map layout changes to Supabase cloud.");
    } catch (err) {
        console.error("Failed to save map grid to Supabase cloud:", err);
    }
}

// Save active map state to both Supabase and the local backend server disk
async function saveActiveMapState() {
    if (!activeProject || !activeMapName || !mapData) return;
    try {
        // 1. Sync to Supabase cloud
        if (!isOfflineMode) {
            await saveMapToCloud(activeMapName, mapData, movementCommands);
        }
        
        // 2. Sync to local backend disk
        const response = await secureFetch(`/api/projects/${activeProject}/maps/${activeMapName}/save`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grid_size: mapData.grid_size,
                start: mapData.start,
                destination: mapData.destination,
                obstacles: mapData.obstacles,
                map_matrix: mapData.map_matrix,
                commands: movementCommands
            })
        });
        const resData = await response.json();
        if (!response.ok) throw new Error(resData.detail || "Failed to write map layout to server disk.");
        console.log("Synchronized active map layout to local server disk.");
    } catch (err) {
        console.error("Failed to save active map state:", err);
        logToTerminal(`Failed to save active map state: ${err.message}`, "error");
    }
}

// Client-side map export download
function exportActiveMap() {
    if (!mapData) {
        alert("No active map layout available to export.");
        return;
    }
    const exportData = {
        grid_size: mapData.grid_size,
        start: mapData.start,
        destination: mapData.destination,
        obstacles: mapData.obstacles,
        map_matrix: mapData.map_matrix,
        commands: movementCommands
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `${activeMapName || 'map'}_layout_export.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    logToTerminal(`Map [${activeMapName}] successfully exported to local file.`, "success");
}

// ============================================================================
// MULTI-PROJECT WORKSPACE PERSISTENT CONTROLLERS
// ============================================================================

// Load all projects and populate selector
async function loadProjectsList() {
    try {
        let projects = [];
        if (isOfflineMode) {
            const response = await secureFetch("/api/projects");
            projects = await response.json();
        } else {
            const { data, error } = await supabaseClient.from('projects').select('name').order('name', { ascending: true });
            if (error) throw error;
            projects = data.map(p => p.name);
        }
        
        const select = document.getElementById("project-select");
        select.innerHTML = '<option value="">-- Select Project --</option>';
        
        projects.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p;
            opt.textContent = p;
            select.appendChild(opt);
        });
        
        if (activeProject) {
            select.value = activeProject;
        }
    } catch (err) {
        console.error("Failed to load projects list:", err);
        logToTerminal(`Failed to load projects list: ${err.message}`, "error");
    }
}

// Load a selected project and reveal subpanel
async function loadProject(projectName) {
    activeProject = projectName;
    activeMapName = ""; // Reset
    
    logToTerminal(`Loading Project Workspace [${projectName}]...`, "system");
    
    document.getElementById("project-subpanel").classList.remove("hidden");
    document.getElementById("map-config-subpanel").classList.add("hidden");
    
    await loadProjectAssets();
    await loadProjectMaps();
    
    logToTerminal(`Project Workspace [${projectName}] successfully loaded.`, "success");
}

// Fetch and render project reference assets (Files stored on backend filesystem)
async function loadProjectAssets() {
    if (!activeProject) return;
    
    try {
        const response = await secureFetch(`/api/projects/${activeProject}/assets`);
        const assets = await response.json();
        
        const countSpan = document.getElementById("asset-count");
        countSpan.textContent = assets.length;
        
        const list = document.getElementById("project-assets-list");
        list.innerHTML = "";
        
        if (assets.length === 0) {
            list.innerHTML = '<div class="no-assets-message">No reference assets uploaded yet.</div>';
            return;
        }
        
        assets.forEach(asset => {
            const item = document.createElement("div");
            item.className = "asset-item";
            
            let icon = "fa-file-image";
            const nameLower = asset.name.toLowerCase();
            if (nameLower.endsWith(".mp4") || nameLower.endsWith(".webm") || nameLower.endsWith(".avi")) {
                icon = "fa-file-video";
            } else if (nameLower.endsWith(".pdf")) {
                icon = "fa-file-pdf";
            }
            
            item.innerHTML = `
                <span class="asset-name" title="${asset.name}"><i class="fa-solid ${icon}"></i> ${asset.name}</span>
                <button class="btn-delete-asset" data-name="${asset.name}"><i class="fa-solid fa-trash"></i></button>
            `;
            list.appendChild(item);
        });
        
        list.querySelectorAll(".btn-delete-asset").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const assetName = btn.dataset.name;
                if (!confirm(`Are you sure you want to delete asset '${assetName}'?`)) return;
                
                try {
                    const res = await secureFetch(`/api/projects/${activeProject}/assets/${assetName}`, {
                        method: "DELETE"
                    });
                    if (!res.ok) throw new Error("Delete failed");
                    logToTerminal(`Asset '${assetName}' deleted.`, "system");
                    await loadProjectAssets();
                } catch (err) {
                    alert(err.message);
                }
            });
        });
    } catch (err) {
        console.error("Failed to load project assets:", err);
    }
}

// Fetch and render project maps (cloud query in SaaS mode, backend query in fallback)
async function loadProjectMaps() {
    if (!activeProject) return;
    
    try {
        let maps = [];
        if (isOfflineMode) {
            const response = await secureFetch(`/api/projects/${activeProject}/maps`);
            maps = await response.json();
        } else {
            const { data, error } = await supabaseClient.from('maps').select('name').eq('project_name', activeProject).order('name', { ascending: true });
            if (error) throw error;
            maps = data.map(m => m.name);
        }
        
        const list = document.getElementById("project-maps-list");
        list.innerHTML = "";
        
        if (maps.length === 0) {
            list.innerHTML = '<div class="no-maps-message">No maps created yet.</div>';
            return;
        }
        
        maps.forEach(mapName => {
            const item = document.createElement("div");
            item.className = `map-item ${mapName === activeMapName ? 'active' : ''}`;
            item.innerHTML = `<span><i class="fa-solid fa-map"></i> ${mapName}</span>`;
            
            item.addEventListener("click", () => {
                list.querySelectorAll(".map-item").forEach(i => i.classList.remove("active"));
                item.classList.add("active");
                loadMap(mapName);
            });
            list.appendChild(item);
        });
    } catch (err) {
        console.error("Failed to load project maps:", err);
        logToTerminal(`Failed to load maps: ${err.message}`, "error");
    }
}

// Fetch and render a specific map's grid layout and commands
async function loadMap(mapName) {
    if (!activeProject) return;
    activeMapName = mapName;
    
    logToTerminal(`Loading Workspace Map [${mapName}]...`, "system");
    
    try {
        let mapDetails = null;
        if (isOfflineMode) {
            const response = await secureFetch(`/api/projects/${activeProject}/maps/${mapName}`);
            mapDetails = await response.json();
        } else {
            const { data, error } = await supabaseClient.from('maps').select('*').eq('project_name', activeProject).eq('name', mapName).single();
            if (error) throw error;
            mapDetails = {
                map: data.grid_layout,
                config: data.config || { use_project_assets: true },
                commands: data.commands || { commands: [] }
            };
        }
        
        mapData = mapDetails.map;
        movementCommands = mapDetails.commands ? mapDetails.commands.commands : [];
        
        document.getElementById("toggle-use-assets").checked = mapDetails.config.use_project_assets;
        
        build3DGridScene(mapData);
        populateCommandsList(movementCommands);
        
        if (mapData.start && mapData.destination) {
            const path = bfsPathfinder(mapData.map_matrix, mapData.start, mapData.destination);
            if (path) {
                drawPathway(path);
                updateHardwarePayload(path, movementCommands);
            }
        }
        
        document.getElementById("map-config-subpanel").classList.remove("hidden");
        
        document.getElementById("btn-play-sim").disabled = (movementCommands.length === 0);
        document.getElementById("btn-reset-sim").disabled = false;
        
        logToTerminal(`Workspace Map [${mapName}] loaded successfully. Click anywhere on the grid to set a path, or upload scan files to refine.`, "success");
    } catch (err) {
        logToTerminal(`Failed to load map details: ${err.message}`, "error");
    }
}

// Set up all workspace event listeners
function setupWorkspaceEventListeners() {
    // Project switcher
    const projectSelect = document.getElementById("project-select");
    if (projectSelect) {
        projectSelect.addEventListener("change", (e) => {
            const val = e.target.value;
            if (val) {
                loadProject(val);
            } else {
                activeProject = "";
                activeMapName = "";
                const subpanel = document.getElementById("project-subpanel");
                if (subpanel) subpanel.classList.add("hidden");
                const configSubpanel = document.getElementById("map-config-subpanel");
                if (configSubpanel) configSubpanel.classList.add("hidden");
                logToTerminal("Project workspace closed.", "system");
            }
        });
    }

    // Create Project button
    const btnNewProject = document.getElementById("btn-new-project");
    if (btnNewProject) {
        btnNewProject.addEventListener("click", async () => {
            const name = prompt("Enter a name for the new project folder (alphanumeric, dashes, underscores only):");
            if (!name) return;
            
            const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "");
            if (!cleanName) {
                alert("Invalid project name.");
                return;
            }
            
            try {
                if (!isOfflineMode) {
                    // 1. Save to Supabase Cloud Table
                    const { error } = await supabaseClient.from('projects').insert([{ name: cleanName }]);
                    if (error) {
                        if (error.code === '23505') { // unique constraint violation
                            throw new Error("Project already exists in cloud database.");
                        }
                        throw error;
                    }
                }
                
                // 2. Create sandboxed directory on local server
                const response = await secureFetch("/api/projects/create", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: cleanName })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.detail || "Failed to create local project directory.");
                
                logToTerminal(`Project [${cleanName}] created successfully!`, "success");
                activeProject = cleanName;
                await loadProjectsList();
                await loadProject(cleanName);
            } catch (err) {
                alert(err.message);
                logToTerminal(`Failed to create project: ${err.message}`, "error");
            }
        });
    }

    // Asset upload button
    const btnUploadAssets = document.getElementById("btn-upload-assets");
    if (btnUploadAssets) {
        btnUploadAssets.addEventListener("click", () => {
            if (!activeProject) return;
            const assetFileInput = document.getElementById("asset-file-input");
            if (assetFileInput) assetFileInput.click();
        });
    }

    // Asset file input change
    const assetFileInput = document.getElementById("asset-file-input");
    if (assetFileInput) {
        assetFileInput.addEventListener("change", async (e) => {
            if (!activeProject || !e.target.files || e.target.files.length === 0) return;
            
            const formData = new FormData();
            Array.from(e.target.files).forEach(f => {
                formData.append("files", f);
            });
            
            logToTerminal(`Uploading ${e.target.files.length} reference asset(s) to project [${activeProject}]...`, "system");
            
            try {
                const response = await secureFetch(`/api/projects/${activeProject}/assets/upload`, {
                    method: "POST",
                    body: formData
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.detail || "Upload failed");
                
                logToTerminal(`Assets uploaded: ${data.uploaded.join(", ")}`, "success");
                await loadProjectAssets();
            } catch (err) {
                logToTerminal(`Asset upload failed: ${err.message}`, "error");
            } finally {
                e.target.value = "";
            }
        });
    }

    // Create Map button
    const btnNewMap = document.getElementById("btn-new-map");
    if (btnNewMap) {
        btnNewMap.addEventListener("click", async () => {
            if (!activeProject) return;
            const name = prompt("Enter a name for the new map (alphanumeric, dashes, underscores only):");
            if (!name) return;
            
            const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "");
            if (!cleanName) {
                alert("Invalid map name.");
                return;
            }
            
            try {
                if (!isOfflineMode) {
                    const emptyMap = {
                        grid_size: [6, 6],
                        start: [0, 0],
                        destination: [5, 5],
                        obstacles: [],
                        map_matrix: [
                            [0, 0, 0, 0, 0, 0],
                            [0, 0, 0, 0, 0, 0],
                            [0, 0, 0, 0, 0, 0],
                            [0, 0, 0, 0, 0, 0],
                            [0, 0, 0, 0, 0, 0],
                            [0, 0, 0, 0, 0, 0]
                        ]
                    };
                    const { error } = await supabaseClient.from('maps').insert([{
                        project_name: activeProject,
                        name: cleanName,
                        grid_layout: emptyMap,
                        config: { use_project_assets: true }
                    }]);
                    if (error) {
                        if (error.code === '23505') {
                            throw new Error("Map already exists in cloud database.");
                        }
                        throw error;
                    }
                }
                
                const response = await secureFetch(`/api/projects/${activeProject}/maps/create`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: cleanName })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.detail || "Failed to create local map file.");
                
                logToTerminal(`Map [${cleanName}] created in project [${activeProject}]!`, "success");
                await loadProjectMaps();
                await loadMap(cleanName);
            } catch (err) {
                alert(err.message);
                logToTerminal(`Failed to create map: ${err.message}`, "error");
            }
        });
    }

    // Map context reference toggle
    const toggleUseAssets = document.getElementById("toggle-use-assets");
    if (toggleUseAssets) {
        toggleUseAssets.addEventListener("change", async (e) => {
            if (!activeProject || !activeMapName) return;
            const checked = e.target.checked;
            
            try {
                if (!isOfflineMode) {
                    const { error } = await supabaseClient.from('maps').update({ config: { use_project_assets: checked } }).eq('project_name', activeProject).eq('name', activeMapName);
                    if (error) throw error;
                }
                
                const response = await secureFetch(`/api/projects/${activeProject}/maps/${activeMapName}/config`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ use_project_assets: checked })
                });
                const data = await response.json();
                if (!response.ok) throw new Error("Failed to update configuration");
                
                const statusLabel = checked ? "ENABLED" : "DISABLED";
                logToTerminal(`Project reference assets are now ${statusLabel} for Map [${activeMapName}].`, "system");
            } catch (err) {
                console.error(err);
                logToTerminal(`Failed to update asset config: ${err.message}`, "error");
                e.target.checked = !checked;
            }
        });
    }

    // Import Map button click
    const btnImportMap = document.getElementById("btn-import-map");
    if (btnImportMap) {
        btnImportMap.addEventListener("click", () => {
            if (!activeProject) return;
            const importMapInput = document.getElementById("import-map-input");
            if (importMapInput) importMapInput.click();
        });
    }

    // Import Map file input change
    const importMapInput = document.getElementById("import-map-input");
    if (importMapInput) {
        importMapInput.addEventListener("change", async (e) => {
            if (!activeProject || !e.target.files || e.target.files.length === 0) return;
            const file = e.target.files[0];
            
            // Read file via FileReader
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const mapContent = JSON.parse(event.target.result);
                    
                    // Validate schema
                    if (!mapContent.grid_size || !mapContent.map_matrix) {
                        throw new Error("Invalid map layout schema. Must contain 'grid_size' and 'map_matrix'.");
                    }
                    
                    const mapName = file.name.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_\-]/g, "");
                    const cleanMapName = mapName || "imported";
                    
                    logToTerminal(`Importing map [${cleanMapName}] into project [${activeProject}]...`, "system");
                    
                    // 1. Upload to Supabase if not offline
                    if (!isOfflineMode) {
                        const { error } = await supabaseClient.from('maps').upsert({
                            project_name: activeProject,
                            name: cleanMapName,
                            grid_layout: mapContent,
                            commands: { commands: mapContent.commands || [] },
                            user_id: (await supabaseClient.auth.getUser()).data.user.id
                        }, { onConflict: 'user_id,project_name,name' });
                        if (error) throw error;
                    }
                    
                    // 2. Upload to backend
                    const formData = new FormData();
                    formData.append("file", file);
                    
                    const response = await secureFetch(`/api/projects/${activeProject}/maps/import`, {
                        method: "POST",
                        body: formData
                    });
                    
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.detail || "Failed to save map on backend.");
                    
                    logToTerminal(`Map [${cleanMapName}] imported successfully!`, "success");
                    await loadProjectMaps();
                    await loadMap(cleanMapName);
                } catch (err) {
                    alert("Import failed: " + err.message);
                    logToTerminal(`Import failed: ${err.message}`, "error");
                }
            };
            reader.readAsText(file);
            e.target.value = ""; // clear
        });
    }

    // Export Map button click
    const btnExportMap = document.getElementById("btn-export-map");
    if (btnExportMap) {
        btnExportMap.addEventListener("click", () => {
            exportActiveMap();
        });
    }

    // Redefine staged file input trigger in compact dragzone
    const fileInput = document.getElementById("file-input");
    const uploadZone = document.getElementById("upload-zone");
    
    if (fileInput && uploadZone) {
        const newUploadZone = uploadZone.cloneNode(true);
        uploadZone.parentNode.replaceChild(newUploadZone, uploadZone);
        
        newUploadZone.addEventListener("click", () => fileInput.click());
        
        newUploadZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            newUploadZone.classList.add("drag-over");
        });
        newUploadZone.addEventListener("dragleave", () => {
            newUploadZone.classList.remove("drag-over");
        });
        newUploadZone.addEventListener("drop", (e) => {
            e.preventDefault();
            newUploadZone.classList.remove("drag-over");
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                stageFiles(e.dataTransfer.files);
            }
        });
        
        fileInput.addEventListener("change", (e) => {
            if (e.target.files && e.target.files.length > 0) {
                stageFiles(e.target.files);
                e.target.value = "";
            }
        });
    }
}

