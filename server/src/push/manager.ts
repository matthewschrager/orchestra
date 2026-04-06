import webpush from "web-push";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { nanoid } from "nanoid";
import type { DB } from "../db";
import type { AttentionItem, Thread } from "shared";
import { shouldNotifyThreadBecameIdle } from "./thread-status";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  device_id: string;
  user_agent: string | null;
  origin: string;
  created_at: string;
}

const VAPID_KEYS_PATH = join(process.env.HOME || "~", ".orchestra", "vapid-keys.json");
const VAPID_SUBJECT = "mailto:orchestra@localhost";

/**
 * Manages Web Push notifications via VAPID.
 * Generates/loads VAPID keys, stores push subscriptions in SQLite,
 * and dispatches notifications when attention items are created or runs finish.
 */
export class PushManager {
  private vapidKeys: VapidKeys;
  private lastThreadStatus = new Map<string, Thread["status"]>();
  private activeConnections = new Map<string, { deviceId: string; threadId: string | null }>();

  constructor(private db: DB) {
    this.vapidKeys = this.loadOrGenerateVapidKeys();
    webpush.setVapidDetails(VAPID_SUBJECT, this.vapidKeys.publicKey, this.vapidKeys.privateKey);
  }

  get publicKey(): string {
    return this.vapidKeys.publicKey;
  }

  /** Save a push subscription from a client. */
  addSubscription(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    deviceId?: string;
    userAgent?: string;
    origin?: string;
  }): void {
    const id = nanoid(16);
    this.db.query(
      `INSERT OR REPLACE INTO push_subscriptions (id, endpoint, keys_p256dh, keys_auth, device_id, user_agent, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      subscription.deviceId ?? "",
      subscription.userAgent ?? null,
      subscription.origin ?? "",
    );
  }

  /** Remove a push subscription by endpoint. */
  removeSubscription(endpoint: string): void {
    this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  /** Send push notification for an attention item to all subscriptions. */
  async notify(attention: AttentionItem): Promise<void> {
    const relativePath = `/?thread=${attention.threadId}&attention=${attention.id}`;
    await this.sendToAllSubscriptions(relativePath, {
      title: "Orchestra — Agent needs input",
      body: attention.prompt.slice(0, 100),
      data: {
        threadId: attention.threadId,
        attentionId: attention.id,
        kind: attention.kind,
      },
    });
  }

  async notifyThreadBecameIdle(thread: Thread): Promise<void> {
    const previousStatus = this.lastThreadStatus.get(thread.id);
    this.lastThreadStatus.set(thread.id, thread.status);

    if (!shouldNotifyThreadBecameIdle(previousStatus, thread.status)) {
      return;
    }

    const relativePath = `/?thread=${thread.id}`;
    const title = thread.status === "error"
      ? "Orchestra — Thread hit an error"
      : "Orchestra — Thread is ready";
    const body = thread.status === "error"
      ? `${thread.title} needs review.`
      : `${thread.title} finished its current run.`;

    await this.sendToAllSubscriptions(relativePath, {
      title,
      body,
      data: {
        threadId: thread.id,
        status: thread.status,
      },
    }, thread.id);
  }

  setDeviceActiveThread(connectionId: string, deviceId: string, threadId: string | null): void {
    this.activeConnections.set(connectionId, { deviceId, threadId });
  }

  clearDeviceActiveThread(connectionId: string): void {
    this.activeConnections.delete(connectionId);
  }

  private async sendToAllSubscriptions(
    relativePath: string,
    payloadBase: {
      title: string;
      body: string;
      data: Record<string, unknown>;
    },
    suppressIfDeviceViewingThreadId?: string,
  ): Promise<void> {
    const subscriptions = this.db.query(
      "SELECT * FROM push_subscriptions",
    ).all() as PushSubscriptionRow[];

    if (subscriptions.length === 0) return;

    const deliverableSubscriptions = subscriptions.filter(
      (sub) => !this.shouldSuppressForActiveDevice(sub.device_id, suppressIfDeviceViewingThreadId),
    );

    if (deliverableSubscriptions.length === 0) return;

    const results = await Promise.allSettled(
      deliverableSubscriptions.map((sub) => {
        // Per-subscription origin: compute targetUrl from stored origin
        const targetUrl = sub.origin
          ? `${sub.origin}${relativePath}`
          : relativePath; // Legacy subscriptions without origin get relative path

        const payload = JSON.stringify({
          title: payloadBase.title,
          body: payloadBase.body,
          data: {
            ...payloadBase.data,
            targetUrl,
          },
        });

        return webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
          },
          payload,
        ).catch((err) => {
          // 410 Gone = subscription expired, remove it
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log(`[push] Removing expired subscription: ${sub.endpoint.slice(0, 50)}...`);
            this.removeSubscription(sub.endpoint);
          } else {
            console.warn(`[push] Failed to send to ${sub.endpoint.slice(0, 50)}...:`, err.statusCode ?? err.message);
          }
        });
      }),
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    if (sent > 0) {
      console.log(`[push] Notified ${sent}/${deliverableSubscriptions.length} subscriptions`);
    }
  }

  private shouldSuppressForActiveDevice(deviceId: string, threadId: string | undefined): boolean {
    if (!deviceId || !threadId) return false;

    for (const presence of this.activeConnections.values()) {
      if (presence.deviceId === deviceId && presence.threadId === threadId) {
        return true;
      }
    }

    return false;
  }

  private loadOrGenerateVapidKeys(): VapidKeys {
    if (existsSync(VAPID_KEYS_PATH)) {
      try {
        const raw = readFileSync(VAPID_KEYS_PATH, "utf-8");
        return JSON.parse(raw) as VapidKeys;
      } catch {
        console.warn("[push] Failed to read VAPID keys, regenerating");
      }
    }

    const keys = webpush.generateVAPIDKeys();
    const vapidKeys: VapidKeys = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };

    mkdirSync(join(process.env.HOME || "~", ".orchestra"), { recursive: true });
    writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
    console.log("[push] Generated new VAPID keys");

    return vapidKeys;
  }
}
