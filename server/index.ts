import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes, setupGameWebSocket } from "./routes";
import { setupTournamentSchema, startTournamentCron } from "./tournament";
import { setupGameHubWebSocket, ensureGameHubSchema } from "./gamehub";
import { setupArcadeHubWebSocket, ensureSuspiciousUsersCollection, getArcadeLiveCounts } from "./arcadehub";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  initNetworkGuard,
  networkGuardMiddleware,
  guardWebSocketUpgrade,
} from "./networkGuard";
import { apiRateLimiter } from "./rateLimiter";
import { inputGuard } from "./inputGuard";

const app = express();
const log = console.log;

// Behind exactly ONE trusted reverse proxy (Railway edge / Replit ingress).
// `1` (not `true`) — trusting all XFF entries would let clients spoof a clean
// IP. This makes req.ip the real client IP (also fixes mining_sessions.ip_address).
app.set("trust proxy", 1);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

function setupCors(app: express.Application) {
  app.use((req, res, next) => {
    // All /api/app/* endpoints — open to any origin so the web preview works
    // on mobile data, Wi-Fi, and all networks without CORS rejections.
    if (req.path.startsWith("/api/app/") || req.path.startsWith("/api/ws/")) {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") return res.sendStatus(200);
      return next();
    }

    const origins = new Set<string>();

    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }

    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }

    const origin = req.header("origin");

    // Allow localhost origins for Expo web development (any port)
    const isLocalhost =
      origin?.startsWith("http://localhost:") ||
      origin?.startsWith("http://127.0.0.1:");

    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Credentials", "true");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }

    next();
  });
}

function setupBodyParsing(app: express.Application) {
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: false, limit: "10mb" }));
}

function setupRequestLogging(app: express.Application) {
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      if (!path.startsWith("/api")) return;

      const duration = Date.now() - start;

      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    });

    next();
  });
}

function getAppName(): string {
  try {
    const appJsonPath = path.resolve(process.cwd(), "app.json");
    const appJsonContent = fs.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}

function serveExpoManifest(platform: string, res: Response) {
  const manifestPath = path.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json",
  );

  if (!fs.existsSync(manifestPath)) {
    return res
      .status(404)
      .json({ error: `Manifest not found for platform: ${platform}` });
  }

  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");

  const manifest = fs.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}

function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName,
}: {
  req: Request;
  res: Response;
  landingPageTemplate: string;
  appName: string;
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;

  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);

  const html = landingPageTemplate
    .replace(/BASE_URL_PLACEHOLDER/g, baseUrl)
    .replace(/EXPS_URL_PLACEHOLDER/g, expsUrl)
    .replace(/APP_NAME_PLACEHOLDER/g, appName);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}

function configureExpoAndLanding(app: express.Application) {
  // ── PRODUCTION ONLY ──────────────────────────────────────────────────────
  // In development the Metro proxy (registered at the very top of the
  // middleware stack in main()) handles everything.  Nothing here runs in dev.
  if (process.env.NODE_ENV !== "production") {
    log("Dev mode: Metro proxy handles web requests — skipping landing page");
    return;
  }

  const templatePath = path.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html",
  );
  const landingPageTemplate = fs.readFileSync(templatePath, "utf-8");
  const appName = getAppName();

  log("Serving static Expo files with dynamic manifest routing");

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api")) {
      return next();
    }

    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }

    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, res);
    }

    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName,
      });
    }

    next();
  });

  app.use("/assets", express.static(path.resolve(process.cwd(), "assets")));
  app.use("/game", express.static(path.resolve(process.cwd(), "public/game/Knife hit Template")));
  app.use("/arcade", express.static(path.resolve(process.cwd(), "public/arcade")));
  app.use("/flappy", express.static(path.resolve(process.cwd(), "public/flappy")));
  app.use("/fruitcut", express.static(path.resolve(process.cwd(), "public/fruitcut")));
  app.use("/stack", express.static(path.resolve(process.cwd(), "public/stack")));
  app.use("/2048", express.static(path.resolve(process.cwd(), "public/2048")));
  app.use("/iceblock", express.static(path.resolve(process.cwd(), "public/iceblock")));
  app.use("/color", express.static(path.resolve(process.cwd(), "public/color")));
  app.use(express.static(path.resolve(process.cwd(), "static-build")));

  log("Expo routing: Checking expo-platform header on / and /manifest");
}

function setupErrorHandler(app: express.Application) {
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const error = err as {
      status?: number;
      statusCode?: number;
      message?: string;
    };

    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });
}

(async () => {
  // ── Static game files — served before the Metro proxy so they are available
  // in both dev and production without Metro intercepting /game and /arcade.
  app.use("/game",   express.static(path.resolve(process.cwd(), "public/game/Knife hit Template")));
  app.use("/arcade", express.static(path.resolve(process.cwd(), "public/arcade")));
  app.use("/flappy", express.static(path.resolve(process.cwd(), "public/flappy")));
  app.use("/fruitcut", express.static(path.resolve(process.cwd(), "public/fruitcut")));
  app.use("/stack",  express.static(path.resolve(process.cwd(), "public/stack")));
  app.use("/2048",   express.static(path.resolve(process.cwd(), "public/2048")));
  app.use("/iceblock", express.static(path.resolve(process.cwd(), "public/iceblock")));
  app.use("/color",  express.static(path.resolve(process.cwd(), "public/color")));

  // ── DEV-ONLY: Metro proxy — registered FIRST so it wins before anything else ──
  // Non-API requests are forwarded directly to Metro on :8081.
  // /game and /arcade are excluded so the static middleware above serves them.
  // This block is completely absent in production (NODE_ENV=production on Railway).
  if (process.env.NODE_ENV !== "production") {
    const metroProxy = createProxyMiddleware({
      target: "http://localhost:8081",
      changeOrigin: true,
      ws: true,
      pathFilter: (pathname) =>
        !pathname.startsWith("/api") &&
        // Match /game and /game/* only — NOT /game-history (an app route).
        pathname !== "/game" &&
        !pathname.startsWith("/game/") &&
        !pathname.startsWith("/arcade") &&
        !pathname.startsWith("/flappy") &&
        !pathname.startsWith("/fruitcut") &&
        !pathname.startsWith("/stack") &&
        !pathname.startsWith("/2048") &&
        !pathname.startsWith("/iceblock") &&
        !pathname.startsWith("/color"),
      on: {
        error: (_err, _req, res) => {
          if (res && "status" in res) {
            (res as Response)
              .status(502)
              .send("Metro bundler not ready — wait a moment and refresh.");
          }
        },
      },
    });
    app.use(metroProxy);
    log("Dev proxy: Metro on :8081 registered (excludes /api, /game, /arcade, /flappy, /fruitcut, /stack, /2048, /iceblock, /color)");
  }

  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);

  configureExpoAndLanding(app);

  // ── Basic request limiter: per-user/per-IP, keeps the API smooth ─────────
  app.use("/api", apiRateLimiter());
  app.use("/api", inputGuard());

  // ── Network guard: VPN / proxy / datacenter / geo blocking ──────────────
  // Mounted on /api/app only (static /game, /arcade, health etc. stay open).
  // Enforcement is gated by the PB settings kill-switch (network_guard_enabled)
  // wired up inside registerRoutes; the check endpoint is whitelisted inside.
  initNetworkGuard();
  app.use("/api/app", networkGuardMiddleware());

  const server = await registerRoutes(app);

  setupErrorHandler(app);

  // ── Tournament schema + weekly CRON ─────────────────────────────────────
  setupTournamentSchema().catch((e) =>
    console.warn("[tournament] schema setup failed:", e?.message),
  );
  startTournamentCron();

  // ── Game Hub (8-Ball multiplayer) schema ────────────────────────────────
  ensureGameHubSchema().catch((e) =>
    console.warn("[gamehub] schema setup failed:", e?.message),
  );

  // ── Arcade PvP anti-cheat log collection ────────────────────────────────
  ensureSuspiciousUsersCollection().catch((e) =>
    console.warn("[arcade] suspicious_users setup failed:", e?.message),
  );

  // ── WebSocket server for server-authoritative game scoring ──────────────
  // Path: /api/ws/game — starts with /api so the Metro proxy pathFilter
  // excludes it and lets our noServer handler pick it up instead.
  const gameWss = new WebSocketServer({ noServer: true });
  setupGameWebSocket(gameWss);

  // ── Game Hub WebSocket (8-Ball multiplayer) — path /api/ws/hub ──────────
  const hubWss = new WebSocketServer({ noServer: true });
  setupGameHubWebSocket(hubWss);

  // ── Arcade PvP WebSocket — path /api/ws/hub-arcade ──────────────────────
  const arcadeWss = new WebSocketServer({ noServer: true });
  setupArcadeHubWebSocket(arcadeWss);

  // Live player counts for hub / lobby screens — pure in-memory snapshot,
  // no DB. Short-polled (~5s) by the client; trivially cheap per request.
  app.get("/api/app/arcade/live-counts", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(getArcadeLiveCounts());
  });

  // Handle WebSocket upgrade requests for the game scoring path.
  // The Metro proxy upgrade handler skips paths starting with /api (pathFilter),
  // so this listener receives /api/ws/game upgrades cleanly.
  server.on("upgrade", async (request, socket, head) => {
    const url = request.url || "";
    // Network guard covers WebSocket upgrades too (same verdict cache).
    if (url.startsWith("/api/ws/")) {
      const allowed = await guardWebSocketUpgrade(request, socket as any);
      if (!allowed) return; // guard already wrote 403 + destroyed the socket
    }
    if (url.startsWith("/api/ws/hub-arcade")) {
      arcadeWss.handleUpgrade(request, socket as any, head, (ws) => {
        arcadeWss.emit("connection", ws, request);
      });
    } else if (url.startsWith("/api/ws/hub")) {
      hubWss.handleUpgrade(request, socket as any, head, (ws) => {
        hubWss.emit("connection", ws, request);
      });
    } else if (url.startsWith("/api/ws/game")) {
      gameWss.handleUpgrade(request, socket as any, head, (ws) => {
        gameWss.emit("connection", ws, request);
      });
    }
    // All other upgrade requests (e.g. Metro HMR on /hot) are handled by the proxy.
  });

  const port = parseInt(process.env.SERVER_PORT || process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`express server serving on port ${port}`);
    },
  );
})();
