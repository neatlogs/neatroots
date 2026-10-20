# browser

A chat widget that sends traces from the browser to neatroots.

```bash
python3 -m http.server 8000      # in this folder, then open http://localhost:8000
```

The page posts to the Neatlogs HTTP trace API with `fetch`. With the Neatlogs Browser SDK
(`npm install neatlogs`, `import { Neatlogs } from "neatlogs/browser"`), pass
`endpoint: "http://localhost:4100"` to send to neatroots instead of Neatlogs Cloud.

neatroots accepts browser traces from pages on this machine. To send from a page on another
origin, add it to `ingest.allowedOrigins` in `~/.neatroots/config.yaml`.
