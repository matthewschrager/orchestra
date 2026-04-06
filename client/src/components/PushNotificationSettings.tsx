import { usePushNotifications } from "../hooks/usePushNotifications";

export function PushNotificationSettings() {
  const push = usePushNotifications();

  let title = "Push notifications unavailable";
  let toneClass = "bg-amber-500/10 border-amber-500/20 text-amber-200";
  let body = push.unsupportedReason ?? "This browser cannot receive Orchestra push notifications.";
  let action: { label: string; onClick: () => Promise<void> | void } | null = null;

  if (push.supported && push.subscribed) {
    title = "Push notifications enabled";
    toneClass = "bg-emerald-500/10 border-emerald-500/20 text-emerald-200";
    body = "This device will receive alerts when an agent needs input.";
    action = { label: "Disable", onClick: push.unsubscribe };
  } else if (push.supported && push.permission === "denied") {
    title = "Push notifications blocked";
    toneClass = "bg-amber-500/10 border-amber-500/20 text-amber-200";
    body = "Notifications are blocked in this browser. Re-enable them in the browser or OS notification settings, then come back here.";
  } else if (push.supported) {
    title = "Push notifications available";
    toneClass = "bg-blue-500/10 border-blue-500/20 text-blue-100";
    body = "Enable notifications on this device so Orchestra can alert you when an agent needs input.";
    action = { label: "Enable", onClick: push.subscribe };
  }

  return (
    <div>
      <label className="block text-sm font-medium text-content-2 mb-1.5">
        Push Notifications
      </label>
      <div className={`border rounded-lg p-3 space-y-2 ${toneClass}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">{title}</div>
            <p className="text-xs mt-1 text-current/90">{body}</p>
          </div>
          {action && (
            <button
              onClick={() => action?.onClick()}
              disabled={push.loading}
              className="shrink-0 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 disabled:opacity-50 text-xs font-medium text-current"
            >
              {push.loading ? "..." : action.label}
            </button>
          )}
        </div>

        {push.installHint && (
          <p className="text-xs text-current/80">
            {push.installHint}
          </p>
        )}

        {!push.supported && (
          <p className="text-xs text-current/80">
            Orchestra already sends web-push for attention items. The missing piece here is browser capability on this device.
          </p>
        )}
      </div>
    </div>
  );
}
