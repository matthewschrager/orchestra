import { useState, useEffect, useCallback } from "react";
import { getStoredToken } from "../lib/auth";
import { getOrCreateDeviceId } from "../lib/deviceId";
import { detectPushSupport, isAppleMobileDevice, isStandaloneDisplayMode } from "../lib/pushSupport";

interface PushState {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  unsupportedReason: string | null;
  installHint: string | null;
}

/**
 * Hook for managing Web Push notification subscriptions.
 * Registers with the server's VAPID key, manages permission, and subscribes/unsubscribes.
 */
export function usePushNotifications(): PushState & {
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
} {
  const [state, setState] = useState<PushState>({
    supported: false,
    permission: "unsupported",
    subscribed: false,
    loading: false,
    unsupportedReason: null,
    installHint: null,
  });

  useEffect(() => {
    const isAppleMobile = isAppleMobileDevice(
      navigator.userAgent,
      navigator.platform,
      navigator.maxTouchPoints ?? 0,
    );
    const isStandalone = isStandaloneDisplayMode(
      window.matchMedia?.("(display-mode: standalone)")?.matches ?? false,
      "standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    );
    const status = detectPushSupport({
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: "PushManager" in window,
      hasNotification: "Notification" in window,
      isSecureContext: window.isSecureContext,
      isAppleMobile,
      isStandalone,
    });

    if (!status.supported) {
      setState((s) => ({
        ...s,
        supported: false,
        permission: "unsupported",
        unsupportedReason: status.unsupportedReason,
        installHint: status.installHint,
      }));
      return;
    }

    setState((s) => ({
      ...s,
      supported: true,
      permission: Notification.permission,
      unsupportedReason: null,
      installHint: null,
    }));

    // Check if already subscribed
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      setState((s) => ({ ...s, subscribed: !!sub }));
      if (!sub) return;

      const token = getStoredToken();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(sub.getKey("p256dh")!),
            auth: arrayBufferToBase64(sub.getKey("auth")!),
          },
          userAgent: navigator.userAgent,
          origin: window.location.origin,
          deviceId: getOrCreateDeviceId(),
        }),
      }).catch((err) => {
        console.warn("Push subscription refresh failed:", err);
      });
    });
  }, []);

  const subscribe = useCallback(async () => {
    if (!state.supported) return;
    setState((s) => ({ ...s, loading: true }));

    try {
      // Register service worker if not already
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Get VAPID key from server
      const token = getStoredToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const vapidResp = await fetch("/api/push/vapid-key", { headers });
      const { publicKey } = await vapidResp.json();

      // Request notification permission
      const permission = await Notification.requestPermission();
      setState((s) => ({ ...s, permission }));
      if (permission !== "granted") {
        setState((s) => ({ ...s, loading: false }));
        return;
      }

      // Subscribe to push
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // Send subscription to server
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(sub.getKey("p256dh")!),
            auth: arrayBufferToBase64(sub.getKey("auth")!),
          },
          userAgent: navigator.userAgent,
          origin: window.location.origin,
          deviceId: getOrCreateDeviceId(),
        }),
      });

      // Also store token in IndexedDB for service worker access
      await storeTokenInIndexedDB(token);

      setState((s) => ({ ...s, subscribed: true, loading: false }));
    } catch (err) {
      console.error("Push subscription failed:", err);
      setState((s) => ({ ...s, loading: false }));
    }
  }, [state.supported]);

  const unsubscribe = useCallback(async () => {
    if (!state.supported) return;
    setState((s) => ({ ...s, loading: true }));

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const token = getStoredToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers,
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState((s) => ({ ...s, subscribed: false, loading: false }));
    } catch (err) {
      console.error("Push unsubscribe failed:", err);
      setState((s) => ({ ...s, loading: false }));
    }
  }, [state.supported]);

  return { ...state, subscribe, unsubscribe };
}

// ── Helpers ──────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Store auth token in IndexedDB so the service worker can access it. */
async function storeTokenInIndexedDB(token: string | null): Promise<void> {
  if (!token) return;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("orchestra", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("auth");
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("auth", "readwrite");
      tx.objectStore("auth").put(token, "token");
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  });
}
