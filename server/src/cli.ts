#!/usr/bin/env bun

import { parseArgs } from "util";
import { regenerateToken, readToken } from "./auth";

const { positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];

switch (command) {
  case "serve":
  case undefined:
    // Default — start the server (just import the main entry)
    await import("./index");
    break;

  case "auth": {
    const subCommand = positionals[1];
    if (subCommand === "regenerate") {
      const token = regenerateToken();
      console.log("New auth token generated:");
      console.log(token);
    } else if (subCommand === "show") {
      const token = readToken();
      if (token) {
        console.log(token);
      } else {
        console.log("No auth token found. Start the server with ORCHESTRA_HOST=0.0.0.0 to generate one.");
      }
    } else {
      console.log("Usage: orchestra auth <show|regenerate>");
    }
    break;
  }

  case "help":
    console.log(`
Orchestra — Agent-first development interface

Usage:
  orchestra [serve]          Start the Orchestra server (default)
  orchestra auth show        Show the current auth token
  orchestra auth regenerate  Generate a new auth token

Environment variables:
  ORCHESTRA_PORT   Server port (default: 3000)
  ORCHESTRA_HOST   Bind address (default: 127.0.0.1, use 0.0.0.0 for remote)
`.trim());
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.log("Run 'orchestra help' for usage.");
    process.exit(1);
}
