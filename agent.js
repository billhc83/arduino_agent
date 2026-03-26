const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { app: electronApp } = require("electron");
const WebSocket = require("ws");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const expressApp = express();

// Unified CORS and Private Network Access (PNA) handling
expressApp.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Private-Network", "true");

  // Preflight requests must return 204/200 immediately with the headers above
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});
expressApp.use(express.json());

// Writable directory for the CLI and its configuration
// Robust path detection for both Electron and standalone Node
const getPath = () => {
  try { return electronApp.getPath("userData"); } 
  catch (e) { return process.cwd(); }
};
const DATA_DIR = path.join(getPath(), "arduino-agent-data");
const CLI_PATH = path.join(DATA_DIR, "arduino-cli.exe");
const SKETCH_DIR = path.join(DATA_DIR, "temp_sketch");
const SKETCH_PATH = path.join(SKETCH_DIR, "temp_sketch.ino");
const BUILD_DIR = path.join(DATA_DIR, "build");

// Source path for the binary (inside the app bundle)
const CLI_SOURCE = path.join(__dirname, "tools", "windows", "arduino-cli.exe");

// Global variable to track the active serial monitor process
let monitorProcess = null;
let lastMonitorSettings = null;

// Setup WebSocket server for Serial Monitor
const wss = new WebSocket.Server({ port: 3211 });
wss.on("connection", (ws) => {
  console.log("WebUI connected to Serial WebSocket");
});

// ---- FIRST-RUN SETUP ----
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR);

  // Copy binary to writable userData directory so it can be executed
  if (!fs.existsSync(CLI_PATH)) {
    console.log("Copying CLI binary to:", CLI_PATH);
    fs.copyFileSync(CLI_SOURCE, CLI_PATH);
  }

  // Initialize CLI config (ignore "already exists" error)
  exec(`"${CLI_PATH}" config init --config-dir "${DATA_DIR}"`, () => {
    // Ensure the AVR core is installed regardless of whether config init was needed
    console.log("Ensuring Arduino AVR core is installed...");
    exec(`"${CLI_PATH}" core install arduino:avr --config-dir "${DATA_DIR}"`, () => {
      console.log("Arduino core environment is ready.");
    });
  });
} catch (e) {
  console.error("First-run setup failed:", e.message);
}

// ---- ROUTES ----

expressApp.get("/", (req, res) => {
  res.send("<h1>Arduino Agent Running</h1><p>Use /boards, /compile, /upload routes.</p>");
});

// Simple status check for the frontend heartbeat
expressApp.get("/status", (req, res) => {
  res.json({ success: true });
});

// List available serial ports (JSON format)
expressApp.get("/ports", (req, res) => {
  console.log("Port list requested from browser...");
  
  // Explicitly disable caching to prevent 304 Not Modified responses
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  exec(`"${CLI_PATH}" board list --format json --config-dir "${DATA_DIR}"`, (err, stdout, stderr) => {
    if (err) {
      console.error("CLI execution failed for /ports:", stderr || err.message);
      return res.status(500).json({ error: "CLI execution failed", details: stderr || err.message });
    }

    try {
      // Find the first occurrence of '{' or '[' to ignore any leading CLI warnings
      const jsonStartIndex = stdout.search(/[{[]/);
      if (jsonStartIndex === -1) throw new Error("No JSON found in CLI output");
      const data = JSON.parse(stdout.substring(jsonStartIndex));
      
      // Handle various wrapping formats (detected_ports, ports, or raw array)
      const portList = Array.isArray(data) ? data : (data.detected_ports || data.ports || []);

      const mapped = portList
        .filter(item => {
          const p = item.port || item;
          return p.boards && p.boards.length > 0; // ✅ ONLY Arduino
        })
        .map(item => {
          const p = item.port || item;
          return {
            port: p.address || p.port || "Unknown",
            label: p.boards[0].name,
            fqbn: p.boards[0].fqbn
          };
        });

      console.log("Mapped Data being sent to browser:", JSON.stringify(mapped));
      res.json(mapped);
    } catch (e) {
      console.error("Failed to parse JSON from CLI for /ports:", e.message, "Raw stdout:", stdout);
      res.status(500).json({ error: "Failed to parse JSON from CLI", details: e.message, rawOutput: stdout });
    }
  });
});

// List connected boards
expressApp.get("/boards", (req, res) => {
  // Using quotes around CLI_PATH to handle spaces in Windows user paths
  exec(`"${CLI_PATH}" board list --config-dir "${DATA_DIR}"`, (err, stdout, stderr) => {
    if (err) return res.status(500).send(stderr || err.message);
    res.send(stdout);
  });
});

// Compile sketch
expressApp.post("/compile", (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ success: false, error: "No code provided" });

  // Store monitor state to restart after compile
  console.log("Received code for compilation:", code);

  const wasMonitoring = !!monitorProcess;
  const monitorSettings = lastMonitorSettings;

  const runCompile = () => {
    // arduino-cli requires the .ino file to be in a folder of the same name
    if (!fs.existsSync(SKETCH_DIR)) fs.mkdirSync(SKETCH_DIR, { recursive: true });
    fs.writeFileSync(SKETCH_PATH, code);

    exec(`"${CLI_PATH}" compile --fqbn arduino:avr:uno --config-dir "${DATA_DIR}" "${SKETCH_DIR}"`, (err, stdout, stderr) => {
      if (wasMonitoring && monitorSettings) {
        spawnMonitor(monitorSettings.port, monitorSettings.baudRate);
      }
      if (err) return res.json({ success: false, error: stderr || err.message });
      res.json({ success: true, output: stdout });
    });
  };

  if (wasMonitoring) {
    console.log("Closing serial port for compile...");
    monitorProcess.close(() => {
      monitorProcess = null;
      runCompile();
    });
  } else {
    runCompile();
  }
});

// Upload sketch
expressApp.post("/upload", (req, res) => {
  const { port, code } = req.body;
  if (!port) return res.status(400).json({ success: false, error: "Missing port" });

  console.log("Received code for upload:", code);
  // Save current code to disk to ensure it's what gets compiled/uploaded
  if (code) {
    if (!fs.existsSync(SKETCH_DIR)) fs.mkdirSync(SKETCH_DIR, { recursive: true });
    fs.writeFileSync(SKETCH_PATH, code);
  }

  if (!fs.existsSync(SKETCH_PATH)) return res.status(400).json({ success: false, error: "Sketch file missing. Provide 'code' in the request." });

  const compileCommand = `"${CLI_PATH}" compile --fqbn arduino:avr:uno --config-dir "${DATA_DIR}" --output-dir "${BUILD_DIR}" "${SKETCH_DIR}"`;
  const uploadOnlyCommand = `"${CLI_PATH}" upload -p ${port} --fqbn arduino:avr:uno --config-dir "${DATA_DIR}" --input-dir "${BUILD_DIR}"`;

  // Store monitor state to restart after upload
  const wasMonitoring = !!monitorProcess;
  const monitorSettings = lastMonitorSettings;

  const runUpload = () => {
    console.log("Step 1: Compiling...");
    exec(compileCommand, (cErr, cStdout, cStderr) => {
      if (cErr) {
        console.error("Compile Error:", cStderr || cErr.message);
        if (wasMonitoring && monitorSettings) spawnMonitor(monitorSettings.port, monitorSettings.baudRate);
        return res.json({ success: false, error: "Compilation failed: " + (cStderr || cErr.message) });
      }

      console.log("Step 2: Uploading binary...");
      exec(uploadOnlyCommand, (uErr, uStdout, uStderr) => {
        if (wasMonitoring && monitorSettings) {
          console.log("Restarting serial monitor...");
          spawnMonitor(monitorSettings.port, monitorSettings.baudRate);
        }
        if (uErr) return res.json({ success: false, error: "Upload failed: " + (uStderr || uErr.message) });
        res.json({ success: true, output: uStdout });
      });
    });
  };

  if (wasMonitoring) {
    console.log("Closing serial port for upload...");
    monitorProcess.close(() => {
      monitorProcess = null;
      runUpload();
    });
  } else {
    runUpload();
  }
});

// Start serial monitor
expressApp.post("/serial/start", (req, res) => {
  const { port, baudRate } = req.body;
  if (!port) return res.status(400).send("Missing port");
  if (monitorProcess) return res.status(400).send("Serial monitor is already running. Stop it first.");

  spawnMonitor(port, baudRate);
  res.send(`Serial monitor started on ${port}`);
});

function spawnMonitor(port, baudRate) {
  if (monitorProcess) return;

  const baud = parseInt(baudRate) || 9600;
  monitorProcess = new SerialPort({ path: port, baudRate: baud });
  lastMonitorSettings = { port, baudRate };

  // Create parser that splits on newline
  const parser = monitorProcess.pipe(new ReadlineParser({ delimiter: "\n" }));

  parser.on("data", (line) => {
    // Broadcast to all connected WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(line);
      }
    });
    process.stdout.write(`[Serial Out]: ${line}\n`);
  });

  monitorProcess.on("error", (err) => {
    console.error(`[Serial Err]: ${err.message}`);
  });

  monitorProcess.on("close", (code) => {
    console.log(`Serial port connection closed.`);
    monitorProcess = null;
  });
}

// Stop serial monitor
expressApp.post("/serial/stop", (req, res) => {
  if (!monitorProcess) return res.status(400).send("No serial monitor is currently running.");

  monitorProcess.close(() => {
    monitorProcess = null;
    lastMonitorSettings = null;
    res.send("Serial monitor stopped.");
  });
});

// ---- START SERVER ----
const PORT = 3210;

expressApp.listen(PORT, "127.0.0.1", () => {
  console.log(`Server running at http://localhost:${PORT}`);
}).on("error", (err) => {
  console.error("PORT ERROR:", err.message);
});