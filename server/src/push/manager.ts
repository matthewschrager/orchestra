import webpush from "web-push";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { DB } from "../db";
import type { AttentionItem } from "shared";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  user_agent: string | null;
  created_at: string;
}

const VAPID_KEYS_PATH = join(process.env.HOME || "~", ".orchestra", "vapid-keys.json");
const VAPID_SUBJECT = "mailto:orchestra@localhost";

/**
 * Manages Web Push notifications via VAPID.
 * Generates/loads VAPID keys, stores push subscriptions in SQLite,
 * and dispatches notifications when attention items are created.
 */
export class PushManager {
  private vapidKeys: VapidKeys;

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
    userAgent?: string;
  }): void {
    const { nanoid } = require("nanoid");
    const id = nanoid(16);
    this.db.query(
      `INSERT OR REPLACE INTO push_subscriptions (id, endpoint, keys_p256dh, keys_auth, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, subscription.userAgent ?? null);
  }

  /** Remove a push subscription by endpoint. */
  removeSubscription(endpoint: string): void {
    this.db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  /** Send push notification for an attention item to all subscriptions. */
  async notify(attention: AttentionItem): Promise<void> {
    const subscriptions = this.db.query(
      "SELECT * FROM push_subscriptions",
    ).all() as PushSubscriptionRow[];

    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({
      title: "Orchestra — Agent needs input",
      body: attention.prompt.slice(0, 100),
      data: {
        threadId: attention.threadId,
        attentionId: attention.id,
        kind: attention.kind,
      },
    });

    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        webpush.sendNotification(
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
        }),
      ),
    );

    const sent = results.filter((r) => r.status === "fulfilled").length;
    if (sent > 0) {
      console.log(`[push] Notified ${sent}/${subscriptions.length} subscriptions`);
    }
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
