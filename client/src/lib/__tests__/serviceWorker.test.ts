import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

type FetchHandler = (event: {
  request: Request;
  respondWith: (response: Response | Promise<Response>) => void;
}) => void;

const listeners = new Map<string, EventListener>();
const originalSelf = globalThis.self;
const originalClients = globalThis.clients;
const originalCaches = globalThis.caches;
const originalFetch = globalThis.fetch;

let fetchHandler: FetchHandler;
let cacheMatch: (request: Request | string) => Promise<Response | undefined>;

beforeAll(async () => {
  cacheMatch = async () => undefined;

  const serviceWorkerGlobal = {
    addEventListener(type: string, handler: EventListener) {
      listeners.set(type, handler);
    },
    skipWaiting() {},
    location: { origin: "http://localhost" },
    registration: {
      scope: "http://localhost/",
      showNotification: () => Promise.resolve(),
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
      openWindow: () => Promise.resolve(undefined),
    },
  };

  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: serviceWorkerGlobal,
  });
  Object.defineProperty(globalThis, "clients", {
    configurable: true,
    value: serviceWorkerGlobal.clients,
  });
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({ addAll: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: (request: Request | string) => cacheMatch(request),
    },
  });

  await import(new URL("../../../public/sw.js", import.meta.url).href);
  fetchHandler = listeners.get("fetch") as FetchHandler;
});

beforeEach(() => {
  cacheMatch = async () => undefined;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: originalSelf,
  });
  Object.defineProperty(globalThis, "clients", {
    configurable: true,
    value: originalClients,
  });
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: originalCaches,
  });
  globalThis.fetch = originalFetch;
});

describe("service worker fetch handling", () => {
  test("ignores cross-origin requests", () => {
    let responded = false;

    fetchHandler({
      request: new Request("https://fonts.googleapis.com/css2?family=Outfit"),
      respondWith() {
        responded = true;
      },
    });

    expect(responded).toBe(false);
  });

  test("returns an error response when same-origin fetch and cache both fail", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;

    let responsePromise: Promise<Response> | undefined;

    fetchHandler({
      request: new Request("http://localhost/assets/app.js"),
      respondWith(response) {
        responsePromise = Promise.resolve(response);
      },
    });

    const response = await responsePromise;
    expect(response).toBeInstanceOf(Response);
    expect(response?.type).toBe("error");
  });
});
