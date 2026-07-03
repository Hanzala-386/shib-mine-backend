import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerRoutes, setupGameWebSocket } from "./routes";
import { setupTournamentSchema, startTournamentCron } from "./tournament";
import { setupGameHubWebSocket, ensureGameHubSchema } from "./gamehub";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const log = console.log;

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
        !pathname.startsWith("/game") &&
        !pathname.startsWith("/arcade"),
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
    log("Dev proxy: Metro on :8081 registered (excludes /api, /game, /arcade)");
  }

  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);

  configureExpoAndLanding(app);

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

  // ── WebSocket server for server-authoritative game scoring ──────────────
  // Path: /api/ws/game — starts with /api so the Metro proxy pathFilter
  // excludes it and lets our noServer handler pick it up instead.
  const gameWss = new WebSocketServer({ noServer: true });
  setupGameWebSocket(gameWss);

  // ── Game Hub WebSocket (8-Ball multiplayer) — path /api/ws/hub ──────────
  const hubWss = new WebSocketServer({ noServer: true });
  setupGameHubWebSocket(hubWss);

  // Handle WebSocket upgrade requests for the game scoring path.
  // The Metro proxy upgrade handler skips paths starting with /api (pathFilter),
  // so this listener receives /api/ws/game upgrades cleanly.
  server.on("upgrade", (request, socket, head) => {
    const url = request.url || "";
    if (url.startsWith("/api/ws/hub")) {
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
