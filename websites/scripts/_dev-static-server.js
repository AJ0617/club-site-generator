// Throwaway static file server for previewing websites/dist/ during development.
// Not part of the build/deploy pipeline — safe to delete any time.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "dist");
const PORT = 8877;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".jpg": "image/jpeg", ".png": "image/png" };

http.createServer((req, res) => {
    let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
    });
}).listen(PORT, () => console.log(`serving dist/ at http://localhost:${PORT}`));
