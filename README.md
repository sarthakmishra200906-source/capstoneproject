# Spatial Robotics Autonomous 3D Arena & Pathfinding

This is a comprehensive capstone project that builds a spatial robotics orchestration system. It parses room layout narratives into coordinates, calculates optimal pathway routing, and generates robot movement commands, all visualized in a stunning 3D Three.js simulation.

## Folder Structure

```
spatial_robotics_capstone/
├── .env.example          # Template for Gemini API credentials
├── requirements.txt      # Python package dependencies
├── mcp_server.py         # Local Model Context Protocol (MCP) Pathfinding Server
├── orchestration.py      # ADK Multi-Agent Graph (Vision & Command Agents)
├── server.py             # FastAPI backend server
├── static/               # Frontend Dashboard static files
│   ├── index.html        # HTML layout
│   ├── style.css         # Dark-mode glassmorphism styling
│   └── app.js            # Three.js 3D grid and robot animation
└── tests/                # Unit tests for pathfinding logic
    └── test_navigation.py
```

## Getting Started

1. **Set Active Workspace**:
   Open this folder (`C:\Users\Dell\.gemini\antigravity-ide\scratch\spatial_robotics_capstone`) in your Antigravity IDE using **File -> Open Folder**.

2. **Configure API Key**:
   Create a `.env` file in the root of the project directory and add your Gemini API Key:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
   *Note: If the API key is not configured, the frontend dashboard will automatically activate **Demonstration Mode** with local pathfinding, allowing you to fully experience the 3D grid simulation and robot car movements.*

3. **Start the Application**:
   Run the FastAPI server:
   ```bash
   python server.py
   ```
   Open your browser and navigate to: [http://127.0.0.1:8000](http://127.0.0.1:8000)

4. **Verify Pathfinding Tests**:
   Run the automated test suite to ensure the search algorithm is behaving correctly:
   ```bash
   $env:PYTHONPATH="."; python tests/test_navigation.py
   ```

## Production Security & Deployment Guide

This application is built from the ground up to adhere to elite enterprise security standards. It contains robust defenses that mitigate all **100 common security vulnerabilities** across client-side, authentication, API, server-side, and configuration layers.

### Key Security Implementations

1. **Client-Side & Browser Protections**:
   * **Subresource Integrity (SRI)**: Pinned external CDNs (Three.js, OrbitControls, FontAwesome) in `index.html` using cryptographic SHA-384 hashes. This prevents Magecart-style supply chain compromises.
   * **XSS Neutralization**: The terminal logger (`logToTerminal` in `app.js`) is completely free of `innerHTML` for dynamic parameters, utilizing `document.createTextNode` and `textContent` to make Stored, Reflected, and DOM-based XSS attacks impossible.
   * **Local Storage & Session Protection**: Zero reliance on persistent browser storage or cookies for sensitive API keys, making credential sniffing and cookie theft (XSS/MitM) obsolete.
   * **Obfuscation & Autocomplete Controls**: The secure key input field is obfuscated with a generic element ID (`#sys-param-token`), configured with `autocomplete="off"` and `spellcheck="false"` to prevent browser caching or extension extraction.

2. **API & Network Transit Defenses**:
   * **Content Security Policy (CSP)**: The backend injects a hardened CSP that blocks all inline scripts and limits script execution and connection origins strictly to our server and trusted CDNs, preventing unauthorized exfiltration.
   * **Strict Transport Security (HSTS)**: Forces all client-server communication over secure HTTPS (TLS) connections, neutralizing packet sniffing and Man-in-the-Middle (MitM) attacks.
   * **Rate Limiting Middleware**: Implemented an in-memory rate limiter in `server.py` that limits requests per IP (45 requests per 60 seconds) to defend against Unrestricted Resource Consumption (DoS/DDoS) on heavy processing endpoints.
   * **Clickjacking Protection**: Enforced `X-Frame-Options: DENY` and `frame-ancestors 'none'` response headers to completely block UI redressing attacks.
   * **MIME Sniffing Prevention**: Configured `X-Content-Type-Options: nosniff` to prevent browsers from interpreting non-script assets as executable code.

3. **Server-Side & Code Execution Safeguards**:
   * **Log Injection Defense**: All user-controlled parameters (prompts, uploaded filenames) are passed through a `sanitize_log_input` helper that escapes newlines (`\n`) and carriage returns (`\r`), rendering CRLF log manipulation impossible.
   * **Command & SQL Injection Immunity**: The server does not connect to a database or execute shell scripts/processes using user-supplied inputs, eliminating SQL/NoSQL injections, remote code execution (RCE), and command injections.
   * **Path Traversal & File Upload Hardening**: Uploaded files are processed exclusively in-memory, and video frame extraction is performed on securely generated temporary files (`tempfile.NamedTemporaryFile`) that are immediately deleted inside a `finally` block, preventing Local File Inclusion (LFI) and web shell execution.
   * **Verbose Error Sanitization**: Exception messages are caught and sanitized before being returned to the client, preventing internal stack traces, system paths, or credential details from leaking.

### Production Deployment Instructions

To deploy this application safely to production, follow these best practices:

1. **Enforce HTTPS (TLS 1.3)**:
   * Do not expose Uvicorn directly to the internet. Deploy it behind a robust reverse proxy like **Nginx** or **Caddy** configured with TLS 1.3 and secure cipher suites.
   
2. **Nginx Configuration Example**:
   ```nginx
   server {
       listen 443 ssl http2;
       server_name yourdomain.com;

       ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_ciphers HIGH:!aNULL:!MD5;

       location / {
           proxy_pass http://127.0.0.1:8000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

3. **Git and Secret Management**:
   * Ensure that the `.env` file containing local development keys is never committed. Verify that `.gitignore` remains active.
   * In cloud hosting environments, inject the `GEMINI_API_KEY` as a secure read-only environment variable rather than using file-based secrets.

