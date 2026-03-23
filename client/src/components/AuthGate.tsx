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
    <div className="h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-1">Orchestra</h1>
          <p className="text-slate-400 text-sm">
            Enter your auth token to connect remotely.
          </p>
          <p className="text-slate-500 text-xs mt-1">
            Find it in <code className="text-slate-400">~/.orchestra/auth-token</code>
          </p>
        </div>

        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste auth token"
          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-slate-500"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
        />

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          onClick={handleSubmit}
          disabled={!token || loading}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-medium"
        >
          {loading ? "Connecting..." : "Connect"}
        </button>
      </div>
    </div>
  );
}
