import type { Subprocess } from "bun";

export interface TunnelInfo {
  url: string;
  pid: number;
}

/**
 * Manages a Cloudflare Tunnel (cloudflared) subprocess.
 * Spawns `cloudflared tunnel --url <localUrl>`, captures the assigned URL,
 * and monitors the process lifecycle.
 */
export class TunnelManager {
  private proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private _url: string | null = null;
  private _onUrl: ((url: string) => void) | null = null;

  get url(): string | null {
    return this._url;
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Start a quick tunnel pointing at the local server.
   * Returns a promise that resolves with the tunnel URL once cloudflared
   * prints it to stderr.
   */
  async start(localPort: number): Promise<string> {
    if (this.proc) {
      throw new Error("Tunnel already running");
    }

    // Check if cloudflared is installed
    const which = Bun.spawnSync(["which", "cloudflared"], { stdout: "pipe", stderr: "pipe" });
    if (which.exitCode !== 0) {
      throw new Error(
        "cloudflared not found. Install it:\n" +
        "  macOS:  brew install cloudflared\n" +
        "  Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n" +
        "  Or use Tailscale/ngrok instead and connect manually."
      );
    }

    const localUrl = `http://localhost:${localPort}`;
    this.proc = Bun.spawn(
      ["cloudflared", "tunnel", "--url", localUrl],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );

    // cloudflared prints the tunnel URL to stderr
    const url = await this.waitForUrl(this.proc.stderr);
    this._url = url;

    // Monitor for unexpected exit
    this.proc.exited.then((code) => {
      console.warn(`[tunnel] cloudflared exited with code ${code}`);
      this.proc = null;
      this._url = null;
    });

    return url;
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this._url = null;
    }
  }

  /**
   * Read stderr line-by-line until we find the tunnel URL.
   * cloudflared prints something like:
   *   | https://abc-xyz-123.trycloudflare.com |
   * or in newer versions:
   *   Your quick Tunnel has been created! Visit it at (URL): https://...
   */
  private async waitForUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    const timeoutMs = 30_000;
    const startTime = Date.now();

    for await (const chunk of stderr) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error("Timed out waiting for cloudflared to assign a URL (30s)");
      }

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const match = line.match(urlPattern);
        if (match) {
          return match[0];
        }
      }
    }

    throw new Error("cloudflared exited without providing a tunnel URL");
  }
}

/**
 * Generate a simple QR code as ASCII art for terminal display.
 * Uses a minimal approach without external dependencies.
 */
export function generateQRCodeAscii(url: string): string {
  // For a proper QR code we'd need a library, but for MVP
  // we display the URL prominently with a border
  const lines = [
    "┌─────────────────────────────────────────────┐",
    "│                                             │",
    "│   Scan this URL on your phone:              │",
    "│                                             │",
    `│   ${url.padEnd(41)}│`,
    "│                                             │",
    "│   Or install a QR code reader and scan      │",
    "│   the terminal (coming soon).               │",
    "│                                             │",
    "└─────────────────────────────────────────────┘",
  ];
  return lines.join("\n");
}
