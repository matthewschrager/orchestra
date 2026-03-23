import { useState } from "react";

interface Props {
  onAuthenticated: () => void;
}

export function AuthGate({ onAuthenticated }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);

    // Test the token
    try {
      const res = await fetch("/api/agents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        localStorage.setItem("orchestra_auth_token", token);
        onAuthenticated();
      } else {
        setError("Invalid token");
      }
    } catch {
      setError("Cannot connect to server");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-base text-content-1 p-4 relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(207,138,78,0.04)_0%,_transparent_70%)] pointer-events-none" />
      <div className="w-full max-w-sm space-y-5 relative">
        <div className="text-center">
          <div className="inline-flex items-center gap-2.5 mb-3">
            <div className="w-2.5 h-2.5 rounded-full bg-accent" />
            <h1 className="text-2xl font-semibold tracking-tight">Orchestra</h1>
          </div>
          <p className="text-content-2 text-sm">
            Enter your auth token to connect remotely.
          </p>
          <p className="text-content-3 text-xs mt-1.5">
            Find it in <code className="text-content-2 font-mono bg-surface-2 px-1 py-0.5 rounded">~/.orchestra/auth-token</code>
          </p>
        </div>

        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste auth token"
          className="w-full bg-surface-2 border border-edge-2 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent placeholder:text-content-3"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={!token || loading}
          className="w-full py-3 bg-accent hover:bg-accent-light disabled:opacity-40 rounded-lg text-sm font-medium text-base"
        >
          {loading ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  );
}
