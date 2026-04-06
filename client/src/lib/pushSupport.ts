export interface PushSupportEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isSecureContext: boolean;
  isAppleMobile: boolean;
  isStandalone: boolean;
}

export interface PushSupportStatus {
  supported: boolean;
  unsupportedReason: string | null;
  installHint: string | null;
}

export function detectPushSupport(env: PushSupportEnvironment): PushSupportStatus {
  if (!env.isSecureContext) {
    return {
      supported: false,
      unsupportedReason: "Push notifications require HTTPS when you access Orchestra remotely.",
      installHint: null,
    };
  }

  if (env.isAppleMobile && !env.isStandalone) {
    return {
      supported: false,
      unsupportedReason: "On iPhone and iPad, push notifications only work after installing Orchestra to your Home Screen.",
      installHint: "Open the Share menu, tap Add to Home Screen, then reopen Orchestra from the installed app.",
    };
  }

  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return {
      supported: false,
      unsupportedReason: "This browser does not expose the APIs needed for web push notifications.",
      installHint: null,
    };
  }

  return {
    supported: true,
    unsupportedReason: null,
    installHint: null,
  };
}

export function isAppleMobileDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function isStandaloneDisplayMode(matchesStandaloneMedia: boolean, navigatorStandalone: boolean): boolean {
  return matchesStandaloneMedia || navigatorStandalone;
}
