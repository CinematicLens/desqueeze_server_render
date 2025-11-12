// server.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;

const app = express();
const PORT = process.env.PORT || 3001;

// If deployed behind a proxy (Render/Railway/Fly/NGINX), this ensures req.protocol is correct
app.set("trust proxy", true);

// CORS: allow your public site; add localhost for your own testing if you want
app.use(
  cors({
    origin: [
      "https://anamorphic-desqueeze.com",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000"
    ],
  })
);

app.use(morgan("dev"));

// Static downloads directory (public links)
const downloadsDir = path.join(__dirname, "downloads");
app.use("/downloads", express.static(downloadsDir));

// Optional: also provide a force-download route (adds Content-Disposition: attachment)
app.get("/download/:name", (req, res, next) => {
  const file = path.join(downloadsDir, req.params.name);
  // Use res.download to suggest a save dialog
  res.download(file, req.params.name, (err) => {
    if (err) next(err);
  });
});

// Health / root
app.get("/", (_req, res) => res.send("✅ Desqueeze backend running"));

// Multer temp uploads
const upload = multer({ dest: path.join(os.tmpdir(), "desq_uploads") });

// --- helper: probe duration (seconds) ---
function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);
    let out = "";
    p.stdout.on("data", d => (out += d.toString()));
    p.on("close", () => {
      const sec = parseFloat(out.trim());
      resolve(isFinite(sec) ? sec : 0);
    });
    p.on("error", () => resolve(0));
  });
}

// --- upload & transcode with streaming progress ---
app.post("/upload", upload.single("file"), async (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    const inFile = req.file.path;
    const origName = req.file.originalname.replace(/\.[^.]+$/, "");
    const factor = Math.max(1, parseFloat(req.body.factor || "1"));
    const fps = req.body.fps === "copy" ? null : parseInt(req.body.fps || "0", 10) || null;
    const bitrate = parseInt(req.body.bitrate || "8000000", 10);

    // Output
    fs.mkdirSync(downloadsDir, { recursive: true });
    const outBase = `${origName}_desq_${Date.now()}.mp4`;
    const outPath = path.join(downloadsDir, outBase);

    // Duration (may be 0 if unknown)
    const dur = await probeDuration(inFile);

    // scale width by factor, keep height; setsar=1 fixes pixel aspect ratio
    const vf = `scale=trunc(iw*${factor}/2)*2:ih,setsar=1`;

    const args = [
      "-y", "-i", inFile,
      ...(fps ? ["-r", String(fps)] : []),
      "-c:v", "libx264", "-b:v", String(bitrate),
      "-pix_fmt", "yuv420p",
      "-vf", vf,
      "-c:a", "copy",
      "-movflags", "faststart",
      outPath
    ];

    const ff = spawn(ffmpegPath, args);

    let lastPct = -1;
    ff.stderr.on("data", (buf) => {
      const s = buf.toString();

      // Use time= from ffmpeg stderr when duration is known
      const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
      if (m && dur > 0) {
        const t = (parseInt(m[1],10)*3600) + (parseInt(m[2],10)*60) + parseFloat(m[3]);
        const pct = Math.max(0, Math.min(100, Math.floor((t / dur) * 100)));
        if (pct !== lastPct) {
          lastPct = pct;
          res.write(`progress:${pct}\n`);
        }
      }
    });

    ff.on("close", (code) => {
      // Clean temp upload
      fs.unlink(req.file.path, () => {});

      if (code === 0) {
        // Build an ABSOLUTE URL so the frontend can use it cross-origin
        // Use req.protocol (with trust proxy) to get https on managed hosts/CDNs
        const publicUrl = `${req.protocol}://${req.get("host")}/downloads/${encodeURIComponent(outBase)}`;
        res.write(`download:${publicUrl}\n`);
        res.write("status:done\n");
      } else {
        res.write("status:error\n");
      }
      res.end();
    });

    ff.on("error", () => {
      fs.unlink(req.file.path, () => {});
      res.write("status:error\n");
      res.end();
    });
  } catch (e) {
    try { fs.unlink(req.file.path, () => {}); } catch {}
    res.write("status:error\n");
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Desqueeze server running on http://localhost:${PORT}`);
});
