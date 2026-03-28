import { useCallback, useEffect, useState } from "react";
import type { TailscaleStatus } from "shared";
import { api } from "../hooks/useApi";

export function RemoteAccessSettings() {
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [savingUrl, setSavingUrl] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const fetchStatus = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const s = await api.getTailscaleStatus(refresh);
      setStatus(s);
      if (s.remoteUrl) setManualUrl(s.remoteUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const copyToClipboard = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  const saveRemoteUrl = useCallback(async () => {
    setSavingUrl(true);
    try {
      await api.updateSettings({ remoteUrl: manualUrl.trim() });
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingUrl(false);
    }
  }, [manualUrl, fetchStatus]);

  // Derive state: Not Detected → Detected → HTTPS Ready (but not if proxy is misconfigured)
  const state = !status || !status.installed || !status.running
    ? "not-detected"
    : status.httpsAvailable && status.portMatch && status.httpsUrl && !status.proxyMismatch
      ? "https-ready"
      : "detected";

  const serveCommand = status
    ? `tailscale serve --bg ${status.orchestraPort}`
    : "";
  const serveResetCommand = "tailscale serve reset";

  return (
    <div>
      <label className="block text-sm font-medium text-content-2 mb-1.5">
        Remote Access
      </label>

      <div className="border border-edge-2 rounded-lg p-3 space-y-2">
        {loading && !status ? (
          <div className="text-sm text-content-3 animate-pulse">Detecting Tailscale...</div>
        ) : error && !status ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : state === "https-ready" ? (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" role="img" aria-label="HTTPS active" />
              <span className="text-sm font-medium text-content-1">Tailscale HTTPS active</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-surface-1 border border-edge-1 rounded px-2 py-1.5 truncate">
                {status!.httpsUrl}
              </code>
              <button
                onClick={() => copyToClipboard(status!.httpsUrl!, "url")}
                className="shrink-0 p-1.5 rounded hover:bg-surface-3 text-content-3 hover:text-content-1"
                title="Copy URL"
              >
                {copied === "url" ? "✓" : "📋"}
              </button>
            </div>
            <p className="text-xs text-content-3">
              This URL works from devices on your tailnet. Orchestra will sign browser sessions in with your Tailscale identity.
            </p>
            <p className="text-xs text-amber-400/80">
              Tagged-device and fallback access still use the bearer token from <code className="font-mono">~/.orchestra/auth-token</code>.
            </p>
          </>
        ) : state === "detected" ? (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400 shrink-0" role="img" aria-label="Tailscale detected" />
              <span className="text-sm font-medium text-content-1">
                Tailscale detected ({status!.ip})
              </span>
            </div>
            {status!.proxyMismatch ? (
              <>
                <p className="text-xs text-red-400">
                  ⚠ tailscale serve is proxying to HTTPS but Orchestra runs plain HTTP — this causes a 502 error. Fix:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono bg-surface-1 border border-red-500/30 rounded px-2 py-1.5 truncate">
                    {serveResetCommand} && {serveCommand}
                  </code>
                  <button
                    onClick={() => copyToClipboard(`${serveResetCommand} && ${serveCommand}`, "fix")}
                    className="shrink-0 p-1.5 rounded hover:bg-surface-3 text-content-3 hover:text-content-1"
                    title="Copy fix command"
                  >
                    {copied === "fix" ? "✓" : "📋"}
                  </button>
                </div>
              </>
            ) : status!.httpsAvailable && !status!.portMatch ? (
              <p className="text-xs text-amber-400/80">
                ⚠ tailscale serve is active but not mapped to this Orchestra port.
              </p>
            ) : null}
            {!status!.proxyMismatch && (
              <>
                <p className="text-xs text-content-3 mb-1">
                  Enable HTTPS for remote access + push notifications:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono bg-surface-1 border border-edge-1 rounded px-2 py-1.5 truncate">
                    {serveCommand}
                  </code>
                  <button
                    onClick={() => copyToClipboard(serveCommand, "cmd")}
                    className="shrink-0 p-1.5 rounded hover:bg-surface-3 text-content-3 hover:text-content-1"
                    title="Copy command"
                  >
                    {copied === "cmd" ? "✓" : "📋"}
                  </button>
                </div>
              </>
            )}
            {status!.hostname && (
              <p className="text-xs text-content-3">
                {status!.proxyMismatch ? "After fixing, access" : "Then access"} via: <code className="font-mono">https://{status!.hostname}/</code>
              </p>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-content-3 shrink-0" role="img" aria-label="Not detected" />
              <span className="text-sm text-content-2">Tailscale not detected</span>
            </div>
            <p className="text-xs text-content-3 mb-1">
              Enter a remote URL manually (Tailscale, VPN, tunnel, etc.):
            </p>
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="https://your-remote-url/"
                className="flex-1 bg-surface-1 border border-edge-2 rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-content-3"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && manualUrl.trim()) saveRemoteUrl();
                }}
              />
              <button
                onClick={saveRemoteUrl}
                disabled={!manualUrl.trim() || savingUrl}
                className="shrink-0 px-2.5 py-1.5 text-xs bg-accent hover:bg-accent-light disabled:opacity-40 rounded font-medium text-base"
              >
                {savingUrl ? "..." : "Save"}
              </button>
            </div>
          </>
        )}

        {/* Refresh button */}
        <div className="flex justify-end pt-1">
          <button
            onClick={() => fetchStatus(true)}
            disabled={loading}
            className="text-xs text-content-3 hover:text-content-1 disabled:opacity-40"
            title="Refresh detection"
          >
            ↻ Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
