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
  private proc: Subprocess<"ignore", "ignore", "pipe"> | null = null;
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

    const localUrl = `http://127.0.0.1:${localPort}`;
    this.proc = Bun.spawn(
      ["cloudflared", "tunnel", "--url", localUrl],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );

    // cloudflared prints the tunnel URL to stderr
    const url = await this.waitForUrl(this.proc.stderr);
    this._url = url;

    // Monitor for unexpected exit
    this.proc.exited.then((code) => {
      // SIGTERM (143) during stop() is expected
      if (this.proc !== null) {
        console.warn(`[tunnel] cloudflared exited with code ${code}`);
      }
      this.proc = null;
      this._url = null;
    });

    return url;
  }

  stop(): void {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      this._url = null;
      p.kill();
    }
  }

  /**
   * Read stderr line-by-line until we find the tunnel URL.
   * cloudflared prints something like:
   *   | https://abc-xyz-123.trycloudflare.com |
   * or in newer versions:
   *   Your quick Tunnel has been created! Visit it at (URL): https://...
   *
   * After finding the URL, continues draining stderr in the background
   * to avoid SIGPIPE killing cloudflared.
   */
  private waitForUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder();
      let buffer = "";
      let found = false;
      const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

      const timeoutMs = 30_000;
      const timeout = setTimeout(() => {
        if (!found) {
          reject(new Error("Timed out waiting for cloudflared to assign a URL (30s)"));
        }
      }, timeoutMs);

      // Drain stderr continuously — never abandon the stream
      (async () => {
        try {
          for await (const chunk of stderr) {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            if (!found) {
              for (const line of lines) {
                const match = line.match(urlPattern);
                if (match) {
                  found = true;
                  clearTimeout(timeout);
                  resolve(match[0]);
                  break;
                }
              }
            }
          }
        } catch {
          // Stream closed — process exiting
        }

        if (!found) {
          clearTimeout(timeout);
          reject(new Error("cloudflared exited without providing a tunnel URL"));
        }
      })();
    });
  }
}

/**
 * Generate a QR code as terminal output.
 * Uses qrcode-terminal to render a scannable QR code.
 */
export function generateQRCodeAscii(url: string): Promise<string> {
  return new Promise((resolve) => {
    import("qrcode-terminal").then((qrcode) => {
      qrcode.generate(url, { small: true }, (code: string) => {
        resolve(code);
      });
    });
  });
}
