import { useEffect, useState } from "react";
import type { LspPluginDiagnostic } from "shared";
import { api } from "../hooks/useApi";

/**
 * Shown inside SettingsPanel. Renders a warning card when one or more enabled
 * LSP plugins in `~/.claude/settings.json` are missing their language-server
 * binary on PATH, or when the plugin's marketplace manifest can't be found —
 * either situation would otherwise surface as a mid-turn Agent error.
 *
 * Silent when everything is healthy (no LSP plugins enabled, or all resolve).
 * "Re-check" re-runs the doctor on the server so users can verify after
 * running the suggested install command.
 */
export function LspDiagnosticsSection() {
  const [diagnostics, setDiagnostics] = useState<LspPluginDiagnostic[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedHint, setCopiedHint] = useState<string | null>(null);

  const load = async (refresh = false) => {
    try {
      setError(null);
      if (refresh) setRefreshing(true);
      const res = await api.getLspDiagnostics(refresh);
      setDiagnostics(res.diagnostics);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render an error banner even when diagnostics failed to load — otherwise
  // API failures (auth expiry, 500, network) would be completely invisible
  // and users would assume "no warning = all good."
  if (error && diagnostics === null) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-3">
        <h4 className="text-sm font-medium text-red-200">
          Couldn't check LSP plugin health
        </h4>
        <p className="text-xs text-red-100/80 mt-0.5">{error}</p>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="mt-2 text-xs text-red-200 hover:text-red-100 disabled:opacity-50 underline underline-offset-2"
        >
          {refreshing ? "Checking…" : "Retry"}
        </button>
      </div>
    );
  }

  const unhealthy = (diagnostics ?? []).filter((d) => d.status !== "ok");

  // Silent when nothing to warn about and no error.
  if (diagnostics === null || unhealthy.length === 0) return null;

  const handleCopy = async (hint: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(hint);
        setCopiedHint(hint);
        setTimeout(() => setCopiedHint(null), 1500);
      }
      // On insecure contexts (HTTP Tailscale LAN etc.) clipboard is
      // undefined — the `select-all` class on the code element still lets
      // users triple-click to select and copy manually.
    } catch {
      // Silent — user still has select-all fallback.
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-3">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <h4 className="text-sm font-medium text-amber-200">
            {unhealthy.length === 1
              ? "LSP plugin will break agent sessions"
              : `${unhealthy.length} LSP plugins will break agent sessions`}
          </h4>
          <p className="text-xs text-amber-100/80 mt-0.5">
            These Claude Code plugins are enabled in <code className="font-mono">~/.claude/settings.json</code> but
            their language-server binaries aren't on the server's PATH (or their manifests are missing).
            Agent turns will error when they touch matching files.
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="shrink-0 text-xs text-amber-200 hover:text-amber-100 disabled:opacity-50 underline underline-offset-2"
        >
          {refreshing ? "Checking…" : "Re-check"}
        </button>
      </div>
      <ul className="space-y-2">
        {unhealthy.map((d) => (
          <li key={d.pluginId} className="text-xs">
            {d.status === "manifest-missing" ? (
              <div>
                <div className="font-mono text-amber-100">{d.pluginId}</div>
                <div className="mt-0.5 text-amber-100/80">{d.reason}</div>
              </div>
            ) : (
              <>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-amber-100">{d.pluginId}</span>
                  <span className="text-amber-100/70">expects</span>
                  <code className="font-mono text-amber-100 bg-amber-900/40 px-1 rounded">{d.command}</code>
                </div>
                {d.installHint && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-amber-100/70">Install:</span>
                    <code className="font-mono text-amber-100 bg-amber-900/40 px-1 py-0.5 rounded select-all">
                      {d.installHint}
                    </code>
                    <button
                      onClick={() => handleCopy(d.installHint!)}
                      className="text-amber-200/80 hover:text-amber-100"
                      title={copiedHint === d.installHint ? "Copied!" : "Copy install command"}
                    >
                      {copiedHint === d.installHint ? (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 8l3 3 7-7" />
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="4" y="4" width="9" height="10" rx="1" />
                          <path d="M3 11V3a1 1 0 0 1 1-1h7" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-amber-100/60 mt-2">
        Or disable the plugin by setting it to <code className="font-mono">false</code> in{" "}
        <code className="font-mono">enabledPlugins</code>.
      </p>
    </div>
  );
}
