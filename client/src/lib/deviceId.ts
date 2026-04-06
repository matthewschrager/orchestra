const DEVICE_ID_STORAGE_KEY = "orchestra_device_id";

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing) return existing;

  const next = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, next);
  return next;
}
