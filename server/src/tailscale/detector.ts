import type { TailscaleStatus } from "shared";

interface TailscaleStatusJson {
  Self?: {
    TailscaleIPs?: string[];
    DNSName?: string;
    Online?: boolean;
  };
  MagicDNSSuffix?: string;
}

interface CachedResult {
  status: TailscaleStatus;
  timestamp: number;
}

/** CLI paths to try, in order (macOS GUI app uses capital-T path) */
const CLI_PATHS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/**
 * Detects Tailscale installation status, IP, hostname, and serve configuration.
 * Caches results to avoid frequent subprocess spawns.
 * This class has NO security role — it is purely informational for UI and startup output.
 */
export class TailscaleDetector {
  private cache: CachedResult | null = null;
  private cacheTtlMs: number;
  private cliPath: string | null = null;
  private cliChecked = false;

  constructor(private orchestraPort: number, cacheTtlMs = 10_000) {
    this.cacheTtlMs = cacheTtlMs;
  }

  /** Get full Tailscale status, using cache if fresh. */
  async detect(): Promise<TailscaleStatus> {
    if (this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.status;
    }
    return this.refresh();
  }

  /** Force a fresh detection, bypassing cache (including CLI path cache). */
  async refresh(): Promise<TailscaleStatus> {
    // Reset CLI path cache so we re-detect if tailscale was installed/started after boot
    this.cliChecked = false;
    this.cliPath = null;
    const status = await this.detectFresh();
    this.cache = { status, timestamp: Date.now() };
    return status;
  }

  /** Resolve the working CLI path (cached after first successful check). */
  private async resolveCliPath(): Promise<string | null> {
    if (this.cliChecked && this.cliPath) return this.cliPath;
    this.cliChecked = true;

    for (const path of CLI_PATHS) {
      try {
        const proc = Bun.spawnSync(["which", path], { stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode === 0) {
          this.cliPath = path;
          return path;
        }
      } catch {
        // Try next path
      }

      // For absolute paths, check directly
      if (path.startsWith("/")) {
        try {
          const proc = Bun.spawnSync([path, "version"], { stdout: "pipe", stderr: "pipe" });
          if (proc.exitCode === 0) {
            this.cliPath = path;
            return path;
          }
        } catch {
          // Try next path
        }
      }
    }

    return null;
  }

  private async detectFresh(): Promise<TailscaleStatus> {
    const base: TailscaleStatus = {
      installed: false,
      running: false,
      ip: null,
      hostname: null,
      httpsAvailable: false,
      httpsUrl: null,
      portMatch: false,
      orchestraPort: this.orchestraPort,
      remoteUrl: "",
    };

    const cli = await this.resolveCliPath();
    if (!cli) return base;

    base.installed = true;

    // Parse tailscale status --json
    try {
      const proc = Bun.spawn([cli, "status", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) return base;

      const parsed = JSON.parse(stdout) as TailscaleStatusJson;
      base.running = true;

      if (parsed.Self?.TailscaleIPs?.length) {
        // Prefer IPv4
        base.ip = parsed.Self.TailscaleIPs.find((ip) => !ip.includes(":")) ?? parsed.Self.TailscaleIPs[0];
      }

      if (parsed.Self?.DNSName) {
        // DNSName has trailing dot, remove it
        base.hostname = parsed.Self.DNSName.replace(/\.$/, "");
      }
    } catch {
      // JSON parse or spawn error — return what we have
      return base;
    }

    // Check tailscale serve status
    try {
      const proc = Bun.spawn([cli, "serve", "status", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0 && stdout.trim()) {
        const serveConfig = JSON.parse(stdout);
        // Check if serve is configured and maps to our port
        const { httpsAvailable, httpsUrl, portMatch } = this.parseServeConfig(serveConfig, base.hostname);
        base.httpsAvailable = httpsAvailable;
        base.httpsUrl = httpsUrl;
        base.portMatch = portMatch;
      }
    } catch {
      // tailscale serve status --json may not exist in older versions
      // Leave httpsAvailable as false
    }

    return base;
  }

  /**
   * Parse tailscale serve status JSON to determine HTTPS availability.
   * The format varies by version, but typically includes TCP/Web handlers.
   */
  private parseServeConfig(config: Record<string, unknown>, hostname: string | null): {
    httpsAvailable: boolean;
    httpsUrl: string | null;
    portMatch: boolean;
  } {
    try {
      // Look for any HTTPS handler that proxies to our port
      const configStr = JSON.stringify(config);
      const portPattern = new RegExp(`localhost:${this.orchestraPort}|127\\.0\\.0\\.1:${this.orchestraPort}`);
      const hasPortMapping = portPattern.test(configStr);

      // If there are any web handlers, serve is active
      const hasHandlers = configStr.includes("Handlers") || configStr.includes("handlers") ||
        configStr.includes("http://") || configStr.includes("https://");

      if (!hasHandlers) {
        return { httpsAvailable: false, httpsUrl: null, portMatch: false };
      }

      // Build HTTPS URL from the currently-detected hostname (not cache)
      const httpsUrl = hostname ? `https://${hostname}/` : null;

      return {
        httpsAvailable: true,
        httpsUrl: hasPortMapping ? httpsUrl : null,
        portMatch: hasPortMapping,
      };
    } catch {
      return { httpsAvailable: false, httpsUrl: null, portMatch: false };
    }
  }
}
