import { Hono } from "hono";
import type { AgentRegistry } from "../agents/registry";

export function createAgentRoutes(registry: AgentRegistry) {
  const app = new Hono();

  // List agents with detection status
  app.get("/", async (c) => {
    const agents = await registry.detectAll();
    return c.json(agents);
  });

  return app;
}
