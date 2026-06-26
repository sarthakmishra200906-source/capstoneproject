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
import json
import logging
from dotenv import load_dotenv
import re
from typing import Optional
import time
from collections import defaultdict
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Header, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from pydantic import BaseModel
from google import genai
from google.genai import types
import cv2
import httpx
import tempfile
import base64
import uuid

def verify_file_magic_number(content: bytes, filename: str) -> bool:
    """Verifies the actual binary headers (magic numbers) of uploaded files to prevent MIME spoofing."""
    if len(content) < 4:
        return False
        
    lower_name = filename.lower()
    
    # PNG Magic Number: 89 50 4E 47 0D 0A 1A 0A
    if lower_name.endswith(".png"):
        return content.startswith(b"\x89PNG")
        
    # JPEG Magic Number: FF D8 FF
    if lower_name.endswith((".jpg", ".jpeg")):
        return content.startswith(b"\xff\xd8\xff")
        
    # PDF Magic Number: 25 50 44 46 (%PDF)
    if lower_name.endswith(".pdf"):
        return content.startswith(b"%PDF-")
        
    # MP4 Magic Number: Look for 'ftyp' at offset 4
    if lower_name.endswith(".mp4"):
        return len(content) >= 12 and content[4:8] == b"ftyp"
        
    # WebM Magic Number: 1A 45 DF A3 (EBML header)
    if lower_name.endswith(".webm"):
        return content.startswith(b"\x1a\x45\xdf\xa3")
        
    return False


# Load environment variables
load_dotenv()

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("api_server")

# Import the orchestration runner
from orchestration import run_orchestration_sync

app = FastAPI(
    title="Spatial Robotics Capstone API",
    description="Backend API for multi-agent spatial vision, pathfinding, and robot command generation."
)

class RateLimiterMiddleware(BaseHTTPMiddleware):
    """In-memory rate limiter to protect against Unrestricted Resource Consumption (DoS)."""
    def __init__(self, app, requests_limit: int = 60, window_seconds: int = 60):
        super().__init__(app)
        self.requests_limit = requests_limit
        self.window_seconds = window_seconds
        self.clients = defaultdict(list)

    async def dispatch(self, request: Request, call_next):
        # Allow static files and main page to load without rate limiting
        if request.url.path.startswith("/static") or request.url.path == "/":
            return await call_next(request)
            
        client_ip = request.client.host if request.client else "unknown"
        now = time.time()
        
        # Filter out timestamps older than the window
        self.clients[client_ip] = [t for t in self.clients[client_ip] if now - t < self.window_seconds]
        
        if len(self.clients[client_ip]) >= self.requests_limit:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Rate limit exceeded. Please try again later."}
            )
            
        self.clients[client_ip].append(now)
        return await call_next(request)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Security headers to mitigate Clickjacking, XSS exfiltration, MIME sniffing, and MITM attacks."""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        
        # Clickjacking & Framing Protection
        response.headers["X-Frame-Options"] = "DENY"
        
        # MIME Sniffing Protection
        response.headers["X-Content-Type-Options"] = "nosniff"
        
        # Referrer Information Leakage Protection
        response.headers["Referrer-Policy"] = "no-referrer"
        
        # Strict Transport Security (HSTS) - Enforce HTTPS
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload"
        
        # Server Header Obfuscation (prevent version disclosure)
        response.headers["Server"] = "Secure-Server"
        
        # Content Security Policy (CSP) - Hardened script and connection origins
        csp_directives = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
            "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
            "img-src 'self' data:; "
            "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.googleapis.com http://localhost:11434 http://127.0.0.1:11434; "
            "frame-ancestors 'none';"
        )
        response.headers["Content-Security-Policy"] = csp_directives
        
        return response

# Register security and rate-limiting middlewares
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RateLimiterMiddleware, requests_limit=45, window_seconds=60)

def sanitize_log_input(text: str) -> str:
    """Sanitizes user input for logging to prevent Log Injection (CRLF injection) attacks."""
    if not text:
        return ""
    # Escape newlines and carriage returns
    return text.replace("\r", "\\r").replace("\n", "\\n")

def sanitize_prompt(text: str) -> str:
    """
    Sanitizes prompt layout inputs to prevent prompt injection and hidden script execution.
    Removes potential HTML/script tags and trims length to prevent denial-of-service.
    """
    if not text:
        return ""
    # Remove HTML/XML tags
    clean = re.sub(r"<[^>]*>", "", text)
    # Strip carriage returns and control characters
    clean = re.sub(r"[\r\n\t]+", " ", clean)
    # Trim to a reasonable maximum size (e.g. 4000 characters)
    return clean.strip()[:4000]

def validate_api_key(api_key: str) -> bool:
    """
    Strictly validates the format of a Gemini API key to prevent injection attacks.
    Gemini API keys are alphanumeric, containing underscores, hyphens, and dots, and are usually 35-100 characters long.
    """
    if not api_key:
        return False
    # Strict regex: alphanumeric, underscores, hyphens, dots. Length 20 to 120.
    pattern = r"^[a-zA-Z0-9_\-\.]{20,120}$"
    return bool(re.match(pattern, api_key))

# Ensure static directory exists
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

# Mount static folder for CSS and JS assets
app.mount("/static", StaticFiles(directory=static_dir), name="static")

def extract_video_frames(video_bytes: bytes, num_frames: int = 5) -> list[tuple[bytes, str]]:
    """
    Extracts num_frames evenly-spaced JPEG frames from video_bytes.
    Returns a list of tuples containing (frame_bytes, mime_type).
    """
    frames = []
    # Save the video bytes to a temporary file
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as temp_file:
        temp_file.write(video_bytes)
        temp_file_path = temp_file.name

    try:
        # Open video file using OpenCV
        cap = cv2.VideoCapture(temp_file_path)
        if not cap.isOpened():
            logger.error("Failed to open video file with OpenCV.")
            return []

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total_frames <= 0:
            logger.error("Total frames count is 0 or invalid.")
            return []

        # Calculate frame indices to extract
        step = max(1, total_frames // num_frames)
        frame_indices = [min(i * step, total_frames - 1) for i in range(num_frames)]

        for idx in frame_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret, frame = cap.read()
            if not ret:
                continue

            # Compress frame to JPEG bytes
            success, buffer = cv2.imencode('.jpg', frame)
            if success:
                frames.append((buffer.tobytes(), "image/jpeg"))

        cap.release()
        logger.info(f"Successfully extracted {len(frames)} frames from video locally.")
    except Exception as e:
        logger.error(f"Error during video frame extraction: {str(e)}")
    finally:
        # Clean up temporary file
        try:
            os.remove(temp_file_path)
        except Exception:
            pass

    return frames

def call_ollama_fallback(prompt: str, images: list[bytes] = None) -> dict:
    """
    Queries local Ollama instance as a fallback layout parser.
    Uses OLLAMA_API_BASE and OLLAMA_MODEL from environment variables.
    """
    api_base = os.environ.get("OLLAMA_API_BASE", "http://localhost:11434").rstrip("/")
    model = os.environ.get("OLLAMA_MODEL", "llama3")
    
    url = f"{api_base}/api/generate"
    
    logger.info(f"Ollama Fallback: Querying local model [{model}] at {url}...")
    
    system_instruction = (
        "You are a spatial robotics assistant. Your task is to output a grid map layout JSON. "
        "The output MUST be a JSON object with the following structure:\n\n"
        "{\n"
        "  \"grid_size\": [height, width],\n"
        "  \"start\": [row, col],\n"
        "  \"destination\": [row, col],\n"
        "  \"obstacles\": [\n"
        "    {\"name\": \"couch\", \"coordinates\": [[r1, c1], [r2, c2]]},\n"
        "    {\"name\": \"wall\", \"coordinates\": [[r3, c3]]}\n"
        "  ],\n"
        "  \"map_matrix\": [[0, 0, ...], ...]\n"
        "}\n\n"
        "Guidelines:\n"
        "1. Estimate the grid size (typically 6x6 to 10x10).\n"
        "2. Identify walkable paths (0s) and obstacles (1s).\n"
        "3. Ensure the map_matrix matches the obstacles, grid size, start, and destination coordinates.\n"
        "4. Return ONLY the raw JSON object inside a ```json ``` block. No other text."
    )
    
    full_prompt = f"{system_instruction}\n\nUser Request: {prompt}"
    
    payload = {
        "model": model,
        "prompt": full_prompt,
        "stream": False,
        "format": "json"
    }
    
    if images:
        payload["images"] = [base64.b64encode(img).decode('utf-8') for img in images]
        logger.info(f"Ollama Fallback: Attached {len(images)} images to payload.")
        
    try:
        with httpx.Client(timeout=45.0) as client:
            response = client.post(url, json=payload)
            response.raise_for_status()
            response_json = response.json()
            
            text = response_json.get("response", "").strip()
            
            try:
                start_idx = text.find("```json")
                if start_idx != -1:
                    end_idx = text.find("```", start_idx + 7)
                    json_str = text[start_idx + 7:end_idx].strip()
                else:
                    start_idx = text.find("{")
                    end_idx = text.rfind("}") + 1
                    json_str = text[start_idx:end_idx].strip()
                
                return json.loads(json_str)
            except Exception:
                return json.loads(text)
    except Exception as e:
        logger.error(f"Failed to query Ollama local fallback: {str(e)}")
        raise RuntimeError(f"Ollama local fallback failed: {str(e)}. Make sure Ollama is running (`ollama serve`) and you have the model pulled (`ollama run {model}`).")

def analyze_multimodal_layout(file_bytes: bytes, mime_type: str, custom_prompt: str = None, x_gemini_api_key: str = None) -> tuple[dict, str]:
    """
    Analyzes an uploaded image or video using Gemini 2.5 Flash.
    Optimizes videos by extracting key frames locally to prevent rate limits.
    Automatically falls back to local Ollama if Gemini fails or is missing.
    Returns a tuple of (layout_dict, engine_name).
    """
    base_instruction = (
        "Analyze this room layout image/video/blueprint and represent its spatial layout as a grid map matrix of integers "
        "(0 for free walkable tile, 1 for obstacle). The output MUST be a JSON object with the following structure:\n\n"
        "{\n"
        "  \"grid_size\": [height, width],\n"
        "  \"start\": [row, col],\n"
        "  \"destination\": [row, col],\n"
        "  \"obstacles\": [\n"
        "    {\"name\": \"couch\", \"coordinates\": [[r1, c1], [r2, c2]]},\n"
        "    {\"name\": \"wall\", \"coordinates\": [[r3, c3]]}\n"
        "  ],\n"
        "  \"map_matrix\": [[0, 0, ...], ...]\n"
        "}\n\n"
        "Guidelines:\n"
        "1. Estimate the grid size based on visible room dimensions or blueprint layout (typically between 5x5 and 10x10).\n"
        "2. Identify clear walkable paths (0s) and obstacles (1s).\n"
        "3. Mark furniture like couches, tables, walls, or fountains under 'obstacles' with their name and grid coordinates.\n"
        "4. Place a starting position (e.g. [0,0] or similar) and a destination position (e.g. [height-1, width-1]) where a robot could reasonably navigate.\n"
        "5. Return ONLY the raw JSON object inside a ```json ``` block. No other explanation."
    )
    
    if custom_prompt:
        prompt = (
            f"{base_instruction}\n\n"
            f"CRITICAL: The user has requested the following custom refinements or descriptions to apply to the map:\n"
            f"\"{custom_prompt}\"\n"
            f"Please adjust the generated grid size, obstacles, start, destination, and matrix accordingly to match this description."
        )
    else:
        prompt = base_instruction

    # Process video vs image locally
    frames = []
    if mime_type.startswith("video/"):
        logger.info("Local video frame extraction triggered to optimize token consumption...")
        frames = extract_video_frames(file_bytes, 5)
    else:
        frames = [(file_bytes, mime_type)]

    # Attempt Gemini Primary
    api_key = x_gemini_api_key or os.environ.get("GEMINI_API_KEY")
    if api_key and api_key != "your_gemini_api_key_here":
        try:
            logger.info("Attempting Gemini API primary parsing...")
            client = genai.Client(api_key=api_key)
            
            # Construct content parts
            contents = []
            for img_bytes, img_mime in frames:
                contents.append(types.Part.from_bytes(data=img_bytes, mime_type=img_mime))
            contents.append(prompt)
            
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=contents
            )
            
            text = response.text
            start_idx = text.find("```json")
            if start_idx != -1:
                end_idx = text.find("```", start_idx + 7)
                json_str = text[start_idx + 7:end_idx].strip()
            else:
                start_idx = text.find("{")
                end_idx = text.rfind("}") + 1
                json_str = text[start_idx:end_idx].strip()
            
            return json.loads(json_str), "gemini"
        except Exception as e:
            logger.warning(f"Gemini API execution failed: {str(e)}. Triggering local Ollama fallback...")
    else:
        logger.warning("GEMINI_API_KEY is not set or placeholder. Triggering local Ollama fallback...")

    # Fallback to local Ollama
    try:
        # Use frames as images for Ollama
        images_list = [img_bytes for img_bytes, _ in frames] if frames else None
        result = call_ollama_fallback(prompt, images_list)
        return result, "ollama_fallback"
    except Exception as fallback_err:
        logger.error(f"Fallback to Ollama failed: {str(fallback_err)}")
        raise ValueError(
            f"Gemini parsing failed and local Ollama fallback was unsuccessful. "
            f"Details: {str(fallback_err)}"
        )

def customize_existing_layout(current_layout: dict, customization_prompt: str, x_gemini_api_key: str = None) -> tuple[dict, str]:
    """
    Refines an existing layout using Gemini or falls back to local Ollama.
    Returns a tuple of (layout_dict, engine_name).
    """
    prompt = (
        f"You are a spatial layout assistant. Your task is to update an existing grid map layout based on the user's customization request.\n\n"
        f"Here is the current layout JSON:\n"
        f"{json.dumps(current_layout, indent=2)}\n\n"
        f"User's Customization Request:\n"
        f"\"{customization_prompt}\"\n\n"
        f"Instructions:\n"
        f"1. Modify the layout JSON according to the user's request. You may change the grid_size, start, destination, obstacles, or map_matrix.\n"
        f"2. Ensure the map_matrix matches the obstacles, grid size, start, and destination coordinates (0 for free tile, 1 for obstacle).\n"
        f"3. Return ONLY the updated JSON object inside a ```json ``` block. No other explanation."
    )
    
    api_key = x_gemini_api_key or os.environ.get("GEMINI_API_KEY")
    if api_key and api_key != "your_gemini_api_key_here":
        try:
            logger.info("Attempting Gemini API customization...")
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt
            )
            
            text = response.text
            start_idx = text.find("```json")
            if start_idx != -1:
                end_idx = text.find("```", start_idx + 7)
                json_str = text[start_idx + 7:end_idx].strip()
            else:
                start_idx = text.find("{")
                end_idx = text.rfind("}") + 1
                json_str = text[start_idx:end_idx].strip()
            
            return json.loads(json_str), "gemini"
        except Exception as e:
            logger.warning(f"Gemini API customization failed: {str(e)}. Triggering local Ollama fallback...")
    else:
        logger.warning("GEMINI_API_KEY is not set or placeholder. Triggering local Ollama fallback...")

    # Fallback to local Ollama
    try:
        result = call_ollama_fallback(prompt)
        return result, "ollama_fallback"
    except Exception as fallback_err:
        logger.error(f"Fallback customization to Ollama failed: {str(fallback_err)}")
        raise ValueError(
            f"Gemini customization failed and local Ollama fallback was unsuccessful. "
            f"Details: {str(fallback_err)}"
        )

@app.post("/api/upload-layout")
async def upload_layout(
    file: UploadFile = File(None),
    custom_prompt: str = Form(None),
    current_layout: str = Form(None),
    x_gemini_api_key: Optional[str] = Header(None)
):
    """
    Endpoint to process uploaded image/video to generate/refine a 3D map.
    Includes local frame extraction and automatic local Ollama fallback.
    Accepts secure, request-specific X-Gemini-API-Key header.
    """
    logger.info("Received upload-layout request...")
    
    # Sanitize and validate custom key if provided
    if x_gemini_api_key:
        if not validate_api_key(x_gemini_api_key):
            logger.error("Security Alert: Invalid API key format received in X-Gemini-API-Key header.")
            raise HTTPException(status_code=400, detail="Invalid API Key format.")
    
    result_map = None
    engine = "gemini"
    
    try:
        if file is not None:
            # Case 1: File is uploaded (image or video)
            file_bytes = await file.read()
            
            # Security: cap file uploads at 20MB
            if len(file_bytes) > 20 * 1024 * 1024:
                raise HTTPException(status_code=400, detail="Uploaded layout file exceeds the 20MB limit.")
                
            # Security: verify actual binary headers (magic numbers) to prevent MIME-type spoofing
            if not verify_file_magic_number(file_bytes, file.filename):
                raise HTTPException(status_code=400, detail=f"MIME-type spoofing detected or invalid file content for {file.filename}.")
                
            mime_type = file.content_type
            safe_filename = sanitize_log_input(file.filename)
            logger.info(f"Processing uploaded file: {safe_filename} ({mime_type})")
            
            safe_custom_prompt = sanitize_prompt(custom_prompt) if custom_prompt else None
            result_map, engine = analyze_multimodal_layout(file_bytes, mime_type, safe_custom_prompt, x_gemini_api_key)
        elif custom_prompt and current_layout:
            # Case 2: Customization prompt is provided for an existing layout
            logger.info("Customizing existing layout based on prompt...")
            current_layout_dict = json.loads(current_layout)
            safe_custom_prompt = sanitize_prompt(custom_prompt)
            result_map, engine = customize_existing_layout(current_layout_dict, safe_custom_prompt, x_gemini_api_key)
        else:
            raise HTTPException(
                status_code=400,
                detail="Either an image/video file or both custom_prompt and current_layout must be provided."
            )
            
        # Save map locally to map_data.json
        output_dir = os.path.dirname(os.path.abspath(__file__))
        map_file = os.path.join(output_dir, "map_data.json")
        with open(map_file, "w") as f:
            json.dump(result_map, f, indent=2)
            
        # Also clean up movement_commands.json since the map changed
        commands_file = os.path.join(output_dir, "movement_commands.json")
        if os.path.exists(commands_file):
            try:
                os.remove(commands_file)
            except Exception:
                pass
                
        return {"status": "success", "map": result_map, "engine": engine}
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.exception("Error in upload-layout:")
        raise HTTPException(
            status_code=500,
            detail="An error occurred while processing the spatial layout scan."
        )

class LayoutRequest(BaseModel):
    layout_description: str

@app.post("/api/run-orchestration")
def run_orchestration(
    request: LayoutRequest,
    x_gemini_api_key: Optional[str] = Header(None)
):
    """
    Triggers the multi-agent ADK graph to parse the layout description.
    Uses request-specific key if provided, otherwise falls back to local env key.
    """
    # Security: sanitize description prompt input
    safe_description = sanitize_prompt(request.layout_description)
    logger.info(f"Received orchestration request: {safe_description[:100]}...")
    
    # Validate custom key if provided
    if x_gemini_api_key:
        if not validate_api_key(x_gemini_api_key):
            logger.error("Security Alert: Invalid API key format received in X-Gemini-API-Key header.")
            raise HTTPException(status_code=400, detail="Invalid API Key format.")
            
    active_api_key = x_gemini_api_key or os.environ.get("GEMINI_API_KEY")
    
    if not active_api_key or active_api_key == "your_gemini_api_key_here":
        logger.error("Gemini API Key missing from both headers and local environment.")
        raise HTTPException(
            status_code=400,
            detail="Gemini API Key is missing. Please enter your key in the header or configure a local .env file."
        )
        
    # Volatile execution: Temporarily set the key for the duration of the multi-agent graph run
    old_key = os.environ.get("GEMINI_API_KEY")
    os.environ["GEMINI_API_KEY"] = active_api_key
    
    try:
        result = run_orchestration_sync(safe_description)
        
        if result["status"] == "error":
            logger.error("Orchestration pipeline failed during execution.")
            raise HTTPException(
                status_code=500,
                detail="Orchestration pipeline failed during execution. Please check your prompt."
            )
            
        logger.info("Orchestration pipeline completed successfully.")
        return result
        
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.exception("Unexpected error in run-orchestration:")
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred during multi-agent pathfinding orchestration."
        )
    finally:
        # Securely restore the previous environment state
        if old_key is not None:
            os.environ["GEMINI_API_KEY"] = old_key
        else:
            os.environ.pop("GEMINI_API_KEY", None)

@app.get("/api/get-commands")
def get_commands():
    """
    Retrieves the last generated map data and robot movement commands from disk.
    """
    output_dir = os.path.dirname(os.path.abspath(__file__))
    map_file = os.path.join(output_dir, "map_data.json")
    commands_file = os.path.join(output_dir, "movement_commands.json")
    
    map_data = None
    commands_data = None
    
    if os.path.exists(map_file):
        try:
            with open(map_file, "r") as f:
                map_data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read map data: {str(e)}")
            
    if os.path.exists(commands_file):
        try:
            with open(commands_file, "r") as f:
                commands_data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read commands: {str(e)}")
            
    return {
        "map": map_data,
        "commands": commands_data
    }

@app.get("/")
def read_root():
    """
    Serves the 3D grid arena frontend dashboard.
    """
    index_path = os.path.join(static_dir, "index.html")
    if not os.path.exists(index_path):
        logger.error(f"Frontend index.html not found at: {index_path}")
        return HTMLResponse(
            content="<h3>Frontend assets not found. Make sure static/index.html is created.</h3>",
            status_code=404
        )
        
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            html_content = f.read()
        return HTMLResponse(content=html_content)
    except Exception as e:
        logger.error(f"Failed to read index.html: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/supabase-config")
def get_supabase_config():
    """
    Exposes the public Supabase URL and anon public key to the frontend.
    These are public credentials designed for client-side SDK use.
    """
    public_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    return {
        "supabase_url": os.environ.get("SUPABASE_URL", ""),
        "supabase_anon_key": public_key
    }

# ============================================================================
# MULTI-PROJECT WORKSPACE PERSISTENT APIS
# ============================================================================

PROJECTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "projects")
if not os.path.exists(PROJECTS_DIR):
    os.makedirs(PROJECTS_DIR)

def verify_supabase_token(token: str) -> dict:
    """Verifies a Supabase JWT token by calling the Supabase Auth server."""
    supabase_url = os.environ.get("SUPABASE_URL")
    if not supabase_url:
        # Fallback to local developer account in development/anonymous mode
        logger.warning("SUPABASE_URL not configured. Running in local fallback mode.")
        return {"id": "local-dev-id", "email": "local-dev-user@example.com"}

    public_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
        
    headers = {
        "Authorization": f"Bearer {token}",
        "apikey": public_key
    }
    try:
        with httpx.Client() as client:
            response = client.get(f"{supabase_url}/auth/v1/user", headers=headers, timeout=5.0)
            if response.status_code == 200:
                return response.json()
            else:
                logger.warning(f"Supabase auth token validation failed: {response.status_code} - {response.text}")
                raise HTTPException(status_code=401, detail="Invalid session token.")
    except httpx.HTTPError as e:
        logger.error(f"Supabase auth server request failed: {str(e)}")
        raise HTTPException(status_code=401, detail="Authentication server unavailable.")
    except Exception as e:
        logger.error(f"Supabase verification unexpected error: {str(e)}")
        raise HTTPException(status_code=401, detail="Session verification failed.")

def get_username_from_user(user: dict) -> str:
    """Derives a safe username folder name from the user email or id."""
    email = user.get("email", "")
    if email:
        username = email.split("@")[0]
    else:
        username = user.get("id", "anonymous")
    username = re.sub(r"[^a-zA-Z0-9_\-\.]", "", username)
    if not username:
        username = "anonymous"
    return username

def get_safe_project_path(project_name: str, username: Optional[str] = None) -> str:
    """Returns a sanitized absolute path for a project, sandboxed to a user if authenticated."""
    sanitized_proj = re.sub(r"[^a-zA-Z0-9_\-]", "", project_name)
    if not sanitized_proj:
        raise HTTPException(status_code=400, detail="Invalid project name.")
        
    if username:
        sanitized_user = re.sub(r"[^a-zA-Z0-9_\-\.]", "", username)
        if not sanitized_user:
            raise HTTPException(status_code=400, detail="Invalid username.")
        user_dir = os.path.join(PROJECTS_DIR, sanitized_user)
        if not os.path.exists(user_dir):
            os.makedirs(user_dir)
        return os.path.join(user_dir, sanitized_proj)
        
    return os.path.join(PROJECTS_DIR, sanitized_proj)

def get_safe_filepath(base_dir: str, filename: str) -> str:
    """Returns a sanitized path for a file inside a directory, preventing traversal."""
    clean_filename = os.path.basename(filename)
    clean_filename = re.sub(r"[^a-zA-Z0-9_\-\.]", "", clean_filename)
    if not clean_filename or clean_filename in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid file name.")
    return os.path.join(base_dir, clean_filename)

def find_path_and_commands(map_data: dict) -> dict:
    """Calculates the BFS path and translates it into movement commands on the backend."""
    grid = map_data.get("map_matrix")
    start = map_data.get("start")
    end = map_data.get("destination")
    
    if not grid or start is None or end is None:
        return {"path": [], "commands": []}
        
    start = tuple(start)
    end = tuple(end)
    
    rows = len(grid)
    cols = len(grid[0])
    
    # BFS
    queue = [[start]]
    visited = {start}
    dirs = [(-1, 0), (1, 0), (0, -1), (0, 1)] # North, South, West, East
    
    path = None
    while queue:
        current_path = queue.pop(0)
        r, c = current_path[-1]
        
        if (r, c) == end:
            path = current_path
            break
            
        for dr, dc in dirs:
            nr, nc = r + dr, c + dc
            if 0 <= nr < rows and 0 <= nc < cols:
                if grid[nr][nc] == 0 and (nr, nc) not in visited:
                    visited.add((nr, nc))
                    queue.append(current_path + [(nr, nc)])
                    
    if not path:
        return {"path": [], "commands": []}
        
    # Translate to commands
    commands = []
    current_facing = 0 # 0: N, 90: E, 180: S, 270: W
    step_count = 0
    
    for i in range(1, len(path)):
        r1, c1 = path[i-1]
        r2, c2 = path[i]
        
        dr, dc = r2 - r1, c2 - c1
        
        move_dir = 0
        if dr == -1 and dc == 0: move_dir = 0
        elif dr == 0 and dc == 1: move_dir = 90
        elif dr == 1 and dc == 0: move_dir = 180
        elif dr == 0 and dc == -1: move_dir = 270
        
        rotation_diff = (move_dir - current_facing) % 360
        if rotation_diff != 0:
            if step_count > 0:
                commands.append(f"MOVE_FORWARD {step_count} UNITS")
                step_count = 0
                
            if rotation_diff == 180:
                commands.append("ROTATE_CLOCKWISE 90")
                commands.append("ROTATE_CLOCKWISE 90")
            elif rotation_diff == 90:
                commands.append("ROTATE_CLOCKWISE 90")
            elif rotation_diff == 270:
                commands.append("ROTATE_COUNTER_CLOCKWISE 90")
            current_facing = move_dir
            
        step_count += 1
        
    if step_count > 0:
        commands.append(f"MOVE_FORWARD {step_count} UNITS")
        
    return {
        "path": path,
        "commands": commands
    }

@app.get("/api/projects")
def list_projects(authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
            
    base_dir = os.path.join(PROJECTS_DIR, username) if username else PROJECTS_DIR
    if not os.path.exists(base_dir):
        return []
    projects = []
    for name in os.listdir(base_dir):
        p_path = os.path.join(base_dir, name)
        if os.path.isdir(p_path) and name not in ("assets", "maps"):
            projects.append(name)
    return sorted(projects)

class CreateProjectRequest(BaseModel):
    name: str

@app.post("/api/projects/create")
def create_project(req: CreateProjectRequest, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
            
    p_path = get_safe_project_path(req.name, username)
    if os.path.exists(p_path):
        raise HTTPException(status_code=400, detail="Project already exists.")
    os.makedirs(p_path)
    os.makedirs(os.path.join(p_path, "assets"))
    os.makedirs(os.path.join(p_path, "maps"))
    return {"status": "success", "message": f"Project '{req.name}' created."}

@app.get("/api/projects/{project_name}/assets")
def list_assets(project_name: str, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
            
    p_path = get_safe_project_path(project_name, username)
    assets_dir = os.path.join(p_path, "assets")
    if not os.path.exists(assets_dir):
        return []
    assets = []
    for name in os.listdir(assets_dir):
        f_path = os.path.join(assets_dir, name)
        if os.path.isfile(f_path):
            assets.append({
                "name": name,
                "size": os.path.getsize(f_path)
            })
    return assets

@app.post("/api/projects/{project_name}/assets/upload")
async def upload_assets(project_name: str, authorization: Optional[str] = Header(None), files: list[UploadFile] = File(...)):
    """
    Uploads reference asset files to a project's asset library.
    Security measures applied:
      - 20-file cap per project.
      - 20MB per-file size limit.
      - Binary magic number verification (prevents MIME spoofing).
      - UUID filename renaming (Security Rule #18 — prevents directory traversal).
    """
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
            
    p_path = get_safe_project_path(project_name, username)
    assets_dir = os.path.join(p_path, "assets")
    if not os.path.exists(assets_dir):
        os.makedirs(assets_dir)
        
    existing_files = [f for f in os.listdir(assets_dir) if os.path.isfile(os.path.join(assets_dir, f))]
    if len(existing_files) + len(files) > 20:
        raise HTTPException(status_code=400, detail="Project asset library cannot exceed 20 files.")
        
    # Allowed extensions mapped to their canonical MIME prefix
    ALLOWED_EXTENSIONS = (".pdf", ".png", ".jpg", ".jpeg", ".mp4", ".webm")
    
    uploaded = []
    for file in files:
        original_name = file.filename or "upload"
        lower_name = original_name.lower()
        
        # Security: whitelist file extensions
        if not lower_name.endswith(ALLOWED_EXTENSIONS):
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type for '{original_name}'. Allowed: images, videos, PDFs."
            )
        
        content = await file.read()
        
        # Security Rule #17: enforce 20MB cap
        if len(content) > 20 * 1024 * 1024:
            raise HTTPException(status_code=400, detail=f"File '{original_name}' exceeds the 20MB size limit.")
        
        # Security Rule #16: binary magic number verification
        if not verify_file_magic_number(content, original_name):
            logger.warning(f"Security Alert: Magic number mismatch for uploaded asset '{sanitize_log_input(original_name)}'. Rejected.")
            raise HTTPException(
                status_code=400,
                detail=f"File content for '{original_name}' does not match its declared type. Upload rejected."
            )
        
        # Security Rule #18: rename to UUID to prevent directory traversal and collisions
        ext = os.path.splitext(lower_name)[1]  # e.g. ".png"
        secure_filename = f"asset-{uuid.uuid4().hex[:12]}{ext}"
        secure_path = os.path.join(assets_dir, secure_filename)
        
        with open(secure_path, "wb") as f:
            f.write(content)
        
        logger.info(f"Asset saved: '{sanitize_log_input(original_name)}' → '{secure_filename}'")
        uploaded.append(secure_filename)
        
    return {"status": "success", "uploaded": uploaded}


@app.delete("/api/projects/{project_name}/assets/{filename}")
def delete_asset(project_name: str, filename: str, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
            
    p_path = get_safe_project_path(project_name, username)
    assets_dir = os.path.join(p_path, "assets")
    safe_path = get_safe_filepath(assets_dir, filename)
    if os.path.exists(safe_path):
        os.remove(safe_path)
        return {"status": "success", "message": f"Asset '{filename}' deleted."}
    raise HTTPException(status_code=404, detail="Asset not found.")

@app.get("/api/projects/{project_name}/maps")
def list_maps(project_name: str, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    if not os.path.exists(maps_dir):
        return []
    maps_list = []
    for name in os.listdir(maps_dir):
        if name.endswith(".json") and not name.endswith("_config.json") and not name.endswith("_cmds.json"):
            map_display = name[:-5]
            maps_list.append(map_display)
    return sorted(maps_list)

class CreateMapRequest(BaseModel):
    name: str

@app.post("/api/projects/{project_name}/maps/create")
def create_map(project_name: str, req: CreateMapRequest, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    if not os.path.exists(maps_dir):
        os.makedirs(maps_dir)
        
    safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "", req.name)
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid map name.")
        
    map_file = os.path.join(maps_dir, f"{safe_name}.json")
    config_file = os.path.join(maps_dir, f"{safe_name}_config.json")
    
    if os.path.exists(map_file):
        raise HTTPException(status_code=400, detail="Map already exists.")
        
    empty_map = {
        "grid_size": [6, 6],
        "start": [0, 0],
        "destination": [5, 5],
        "obstacles": [],
        "map_matrix": [
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0]
        ]
    }
    with open(map_file, "w") as f:
        json.dump(empty_map, f, indent=2)
        
    config = {"use_project_assets": True}
    with open(config_file, "w") as f:
        json.dump(config, f, indent=2)
        
    return {"status": "success", "message": f"Map '{req.name}' created."}

@app.get("/api/projects/{project_name}/maps/{map_name}")
def get_map_details(project_name: str, map_name: str, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    
    safe_map_name = re.sub(r"[^a-zA-Z0-9_\-]", "", map_name)
    map_file = os.path.join(maps_dir, f"{safe_map_name}.json")
    config_file = os.path.join(maps_dir, f"{safe_map_name}_config.json")
    commands_file = os.path.join(maps_dir, f"{safe_map_name}_cmds.json")
    
    if not os.path.exists(map_file):
        raise HTTPException(status_code=404, detail="Map not found.")
        
    try:
        with open(map_file, "r") as f:
            map_data = json.load(f)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to load map data.")
        
    config = {"use_project_assets": True}
    if os.path.exists(config_file):
        try:
            with open(config_file, "r") as f:
                config = json.load(f)
        except Exception:
            pass
            
    commands_data = None
    if os.path.exists(commands_file):
        try:
            with open(commands_file, "r") as f:
                commands_data = json.load(f)
        except Exception:
            pass
            
    return {
        "map": map_data,
        "config": config,
        "commands": commands_data
    }

class UpdateConfigRequest(BaseModel):
    use_project_assets: bool

@app.post("/api/projects/{project_name}/maps/{map_name}/config")
def update_map_config(project_name: str, map_name: str, req: UpdateConfigRequest, authorization: Optional[str] = Header(None)):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    
    safe_map_name = re.sub(r"[^a-zA-Z0-9_\-]", "", map_name)
    config_file = os.path.join(maps_dir, f"{safe_map_name}_config.json")
    
    if not os.path.exists(os.path.join(maps_dir, f"{safe_map_name}.json")):
        raise HTTPException(status_code=404, detail="Map not found.")
        
    config = {"use_project_assets": req.use_project_assets}
    try:
        with open(config_file, "w") as f:
            json.dump(config, f, indent=2)
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to save configuration.")
        
    return {"status": "success", "config": config}

class SaveMapRequest(BaseModel):
    grid_size: list[int]
    start: list[int]
    destination: list[int]
    obstacles: list[dict]
    map_matrix: list[list[int]]
    commands: list[str]

@app.post("/api/projects/{project_name}/maps/{map_name}/save")
def save_project_map(
    project_name: str,
    map_name: str,
    req: SaveMapRequest,
    authorization: Optional[str] = Header(None)
):
    username = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        try:
            user = verify_supabase_token(token)
            username = get_username_from_user(user)
        except Exception:
            pass
            
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    
    safe_map_name = re.sub(r"[^a-zA-Z0-9_\-]", "", map_name)
    map_file = os.path.join(maps_dir, f"{safe_map_name}.json")
    commands_file = os.path.join(maps_dir, f"{safe_map_name}_cmds.json")
    
    if not os.path.exists(maps_dir):
        os.makedirs(maps_dir)
        
    map_data = {
        "grid_size": req.grid_size,
        "start": req.start,
        "destination": req.destination,
        "obstacles": req.obstacles,
        "map_matrix": req.map_matrix
    }
    
    try:
        with open(map_file, "w") as f:
            json.dump(map_data, f, indent=2)
            
        with open(commands_file, "w") as f:
            json.dump({"commands": req.commands}, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save map file: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to save map layout to disk.")
        
    return {"status": "success", "message": "Map layout and commands saved successfully."}


@app.post("/api/projects/{project_name}/maps/import")
async def import_project_map(
    project_name: str,
    authorization: Optional[str] = Header(None),
    file: UploadFile = File(...)
):
    """
    Imports a map JSON file from the computer and saves it to the user's project workspace.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header.")
    token = authorization.split(" ")[1]
    user = verify_supabase_token(token)
    username = get_username_from_user(user)
    
    # Security: validate file size (max 2MB for map JSON)
    content = await file.read()
    if len(content) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Map JSON exceeds 2MB size limit.")
        
    try:
        map_data = json.loads(content.decode("utf-8"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON file format.")
        
    # Validate map schema
    if not isinstance(map_data, dict) or "grid_size" not in map_data or "map_matrix" not in map_data:
        raise HTTPException(status_code=400, detail="Invalid map layout schema. Must contain 'grid_size' and 'map_matrix'.")
        
    # Sanitize map name
    filename = file.filename or "imported_map.json"
    map_name = os.path.splitext(os.path.basename(filename))[0]
    safe_map_name = re.sub(r"[^a-zA-Z0-9_\-]", "", map_name)
    if not safe_map_name:
        safe_map_name = "imported"
        
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    if not os.path.exists(maps_dir):
        os.makedirs(maps_dir)
        
    map_file = os.path.join(maps_dir, f"{safe_map_name}.json")
    commands_file = os.path.join(maps_dir, f"{safe_map_name}_cmds.json")
    
    # Save locally
    with open(map_file, "w") as f:
        json.dump(map_data, f, indent=2)
        
    # Pre-calculate path
    path_info = find_path_and_commands(map_data)
    with open(commands_file, "w") as f:
        json.dump({"commands": path_info["commands"]}, f, indent=2)
        
    return {
        "status": "success",
        "map_name": safe_map_name,
        "map": map_data,
        "commands": {"commands": path_info["commands"]}
    }

@app.post("/api/projects/{project_name}/maps/{map_name}/generate")
async def generate_project_map(
    project_name: str,
    map_name: str,
    authorization: Optional[str] = Header(None),
    files: Optional[list[UploadFile]] = File(None),
    custom_prompt: Optional[str] = Form(None),
    x_gemini_api_key: Optional[str] = Header(None)
):
    """
    Core generator endpoint. Parses multiple uploaded files (up to 10) and prompt.
    Includes project assets context if enabled, and generates the map and path commands.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header.")
    token = authorization.split(" ")[1]
    user = verify_supabase_token(token)
    username = get_username_from_user(user)
    
    safe_map_name = re.sub(r"[^a-zA-Z0-9_\-]", "", map_name)
    safe_project_name = re.sub(r"[^a-zA-Z0-9_\-]", "", project_name)
    logger.info(f"Generating map '{safe_map_name}' for project '{safe_project_name}' for user '{username}'...")
    
    # Validation
    p_path = get_safe_project_path(project_name, username)
    maps_dir = os.path.join(p_path, "maps")
    assets_dir = os.path.join(p_path, "assets")
    
    if not os.path.exists(maps_dir):
        os.makedirs(maps_dir)
        
    map_file = os.path.join(maps_dir, f"{safe_map_name}.json")
    config_file = os.path.join(maps_dir, f"{safe_map_name}_config.json")
    commands_file = os.path.join(maps_dir, f"{safe_map_name}_cmds.json")
    
    # Auto-initialize empty map if it doesn't exist yet
    if not os.path.exists(map_file):
        empty_map = {
            "grid_size": [6, 6],
            "start": [0, 0],
            "destination": [5, 5],
            "obstacles": [],
            "map_matrix": [
                [0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0]
            ]
        }
        with open(map_file, "w") as f:
            json.dump(empty_map, f, indent=2)
            
    if x_gemini_api_key:
        if not validate_api_key(x_gemini_api_key):
            raise HTTPException(status_code=400, detail="Invalid API Key format.")
            
    # Check config
    use_project_assets = True
    if os.path.exists(config_file):
        try:
            with open(config_file, "r") as f:
                cfg = json.load(f)
                use_project_assets = cfg.get("use_project_assets", True)
        except Exception:
            pass

    # Stage files (Max 10 uploaded)
    if files and len(files) > 10:
        raise HTTPException(status_code=400, detail="Cannot stage more than 10 files for map generation.")

    current_layout_dict = None
    if os.path.exists(map_file):
        try:
            with open(map_file, "r") as f:
                current_layout_dict = json.load(f)
        except Exception:
            pass

    all_media_parts = []
    
    # Process Map-Specific Uploaded Files
    if files:
        for file in files:
            file_bytes = await file.read()
            mime_type = file.content_type or ""
            
            # Local frame extraction for video uploads
            if mime_type.startswith("video/") or file.filename.lower().endswith((".mp4", ".webm")):
                frames = extract_video_frames(file_bytes, 5)
                for f_bytes, f_mime in frames:
                    all_media_parts.append((f_bytes, f_mime))
            else:
                if not mime_type:
                    mime_type = "application/pdf" if file.filename.lower().endswith(".pdf") else "image/jpeg"
                all_media_parts.append((file_bytes, mime_type))
                
    # Process Project-Level Reference Assets if enabled
    if use_project_assets and os.path.exists(assets_dir):
        asset_files = [f for f in os.listdir(assets_dir) if os.path.isfile(os.path.join(assets_dir, f))]
        for asset_name in asset_files[:20]:
            asset_path = os.path.join(assets_dir, asset_name)
            mime_type = "application/pdf"
            if asset_name.lower().endswith((".png", ".jpg", ".jpeg")):
                mime_type = "image/jpeg"
            elif asset_name.lower().endswith((".mp4", ".webm", ".avi")):
                mime_type = "video/mp4"
                
            try:
                with open(asset_path, "rb") as af:
                    asset_bytes = af.read()
                
                if mime_type.startswith("video/"):
                    frames = extract_video_frames(asset_bytes, 5)
                    for f_bytes, f_mime in frames:
                        all_media_parts.append((f_bytes, f_mime))
                else:
                    all_media_parts.append((asset_bytes, mime_type))
            except Exception as ae:
                logger.warning(f"Failed to load reference asset {asset_name}: {str(ae)}")

    base_instruction = (
        "Analyze this room layout and represent its spatial layout as a grid map matrix of integers "
        "(0 for free walkable tile, 1 for obstacle). The output MUST be a JSON object with the following structure:\n\n"
        "{\n"
        "  \"grid_size\": [height, width],\n"
        "  \"start\": [row, col],\n"
        "  \"destination\": [row, col],\n"
        "  \"obstacles\": [\n"
        "    {\"name\": \"couch\", \"coordinates\": [[r1, c1], [r2, c2]]},\n"
        "    {\"name\": \"wall\", \"coordinates\": [[r3, c3]]}\n"
        "  ],\n"
        "  \"map_matrix\": [[0, 0, ...], ...]\n"
        "}\n\n"
        "Guidelines:\n"
        "1. Estimate the grid size based on visible room dimensions or blueprint layout (typically between 5x5 and 10x10).\n"
        "2. Identify walkable paths (0s) and obstacles (1s).\n"
        "3. Mark furniture like couches, tables, walls, or fountains under 'obstacles' with their name and grid coordinates.\n"
        "4. Place a starting position (e.g. [0,0] or similar) and a destination position (e.g. [height-1, width-1]) where a robot could reasonably navigate.\n"
        "5. Return ONLY the raw JSON object inside a ```json ``` block. No other explanation."
    )

    if current_layout_dict and custom_prompt:
        prompt = (
            f"You are a spatial layout assistant. Update the existing layout JSON based on the user's customization request.\n\n"
            f"Current Layout JSON:\n{json.dumps(current_layout_dict, indent=2)}\n\n"
            f"User's Customization Request:\n\"{custom_prompt}\"\n\n"
            f"Modify the layout JSON accordingly. Ensure the map_matrix matches the obstacles, grid size, start, and destination (0 for free tile, 1 for obstacle).\n"
            f"Return ONLY the updated JSON object inside a ```json ``` block. No other explanation."
        )
    elif custom_prompt:
        prompt = (
            f"{base_instruction}\n\n"
            f"CRITICAL: The user has requested the following custom refinements or descriptions to apply to the map:\n"
            f"\"{custom_prompt}\"\n"
            f"Please adjust the generated grid size, obstacles, start, destination, and matrix to match this description."
        )
    else:
        prompt = base_instruction

    # Call Model (Gemini Primary with local Ollama fallback)
    api_key = x_gemini_api_key or os.environ.get("GEMINI_API_KEY")
    result_map = None
    engine = "gemini"

    if api_key and api_key != "your_gemini_api_key_here":
        try:
            logger.info("Attempting Gemini API primary parsing...")
            client = genai.Client(api_key=api_key)
            
            contents = []
            for m_bytes, m_mime in all_media_parts:
                contents.append(types.Part.from_bytes(data=m_bytes, mime_type=m_mime))
            contents.append(prompt)
            
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=contents
            )
            
            text = response.text
            start_idx = text.find("```json")
            if start_idx != -1:
                end_idx = text.find("```", start_idx + 7)
                json_str = text[start_idx + 7:end_idx].strip()
            else:
                start_idx = text.find("{")
                end_idx = text.rfind("}") + 1
                json_str = text[start_idx:end_idx].strip()
            
            result_map = json.loads(json_str)
            engine = "gemini"
        except Exception as e:
            logger.warning(f"Gemini API primary parsing failed: {str(e)}. Falling back to Ollama...")

    if not result_map:
        try:
            images_list = [m_bytes for m_bytes, m_mime in all_media_parts if m_mime.startswith("image/")][:1]
            result_map = call_ollama_fallback(prompt, images_list if images_list else None)
            engine = "ollama_fallback"
        except Exception as fallback_err:
            logger.exception("Ollama fallback failed:")
            raise HTTPException(
                status_code=500,
                detail=f"Both Gemini API and local Ollama fallback failed. Details: {str(fallback_err)}"
            )

    # Calculate path and commands on the backend instantly
    path_info = find_path_and_commands(result_map)
    
    # Save map and commands persistently
    try:
        with open(map_file, "w") as f:
            json.dump(result_map, f, indent=2)
            
        with open(commands_file, "w") as f:
            json.dump({"commands": path_info["commands"]}, f, indent=2)
    except Exception as se:
        logger.error(f"Failed to save generated map files: {str(se)}")
        raise HTTPException(status_code=500, detail="Failed to save generated map files to workspace.")

    return {
        "status": "success",
        "map": result_map,
        "commands": {"commands": path_info["commands"]},
        "engine": engine
    }

@app.get("/")
def read_root():
    """
    Serves the 3D grid arena frontend dashboard.
    """
    index_path = os.path.join(static_dir, "index.html")
    if not os.path.exists(index_path):
        logger.error(f"Frontend index.html not found at: {index_path}")
        return HTMLResponse(
            content="<h3>Frontend assets not found. Make sure static/index.html is created.</h3>",
            status_code=404
        )
        
    try:
        with open(index_path, "r", encoding="utf-8") as f:
            html_content = f.read()
        return HTMLResponse(content=html_content)
    except Exception as e:
        logger.error(f"Failed to read index.html: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting FastAPI Server on http://127.0.0.1:8000...")
    uvicorn.run(app, host="127.0.0.1", port=8000)
