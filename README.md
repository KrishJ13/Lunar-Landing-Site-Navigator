# Lunar Landing Site Navigator

## Run locally on macOS, Windows, or Linux

Install **Git**, **Python 3.10 or later**, and **Node.js 24** (which includes npm). You’ll need an internet connection for first-time setup and for terrain data in areas you haven’t visited before.

### 1. Clone the repository

```sh
git clone https://github.com/KrishJ13/Lunar-Landing-Site-Navigator.git
cd Lunar-Landing-Site-Navigator
```

### 2. Start the backend

From the repository root, run the commands for your operating system.

**macOS or Linux**

```sh
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python scripts/download_kernels.py
.venv/bin/python scripts/fetch_dem.py --tier starter
.venv/bin/python -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8000 --reload
```

**Windows PowerShell**

```powershell
cd backend
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe scripts/download_kernels.py
.\.venv\Scripts\python.exe scripts/fetch_dem.py --tier starter
.\.venv\Scripts\python.exe -m uvicorn lunar_skyline.app:app --host 127.0.0.1 --port 8000 --reload
```

Leave the backend running. On future runs, go into `backend` and run just the last command.

### 3. Start the frontend

Open a second terminal in the cloned repository. On macOS or Linux, run:

```sh
cd frontend
npm ci
npm run dev -- --port 5173 --strictPort
```

On Windows PowerShell, run:

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev -- --port 5173 --strictPort
```

Leave both terminals running and open [Moon Explorer](http://localhost:5173/moon.html) in a WebGL 2-capable browser. On future runs, skip the dependency install and run the final command from `frontend`.

Select one or two landing sites and choose **Explore** or **Compare** to open Skyline V3. Allow **1–2 minutes** for the terrain and shadows to appear on a first visit, especially if NASA elevation data needs to download. Each request has its own 60-second timeout. Repeat visits can reuse cached elevation data.

## Make changes

Create a feature branch before editing. The local development servers reload
changes to the frontend and backend.

Repository collaborators can push their feature branch and open a pull request.
Other contributors can push to their own fork and open a pull request from it.
