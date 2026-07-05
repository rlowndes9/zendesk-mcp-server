#!/usr/bin/env node
/*
 * Zendesk MCP Server, v1 read-only audit MCP.
 *
 * SMOKE TEST (manual; requires real Zendesk credentials):
 *   1. Create ~/.config/zendesk-mcp/instances.json with at least one instance:
 *        {
 *          "instances": {
 *            "yourname": {
 *              "subdomain": "yoursub",
 *              "email": "you@example.com",
 *              "token": "xxx",
 *              "env": "prod"
 *            }
 *          }
 *        }
 *   2. npm run inspect
 *   3. In the Inspector, call:
 *        list_instances
 *        set_instance({ name: "yourname" })
 *        list_triggers
 *      Verify the response shape:
 *        { ok: true, instance: "yourname", fetched_at: "...",
 *          cached_at: null, data: { count, truncated, items: [...] } }
 *   4. Call list_triggers again → same `fetched_at`, `cached_at` populated.
 *   5. Call refresh_instance({ instance: "yourname" }) → next list_triggers
 *      returns `cached_at: null` again.
 *   6. Call get_trigger({ id: <some id> }).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './server.js';
import dotenv from 'dotenv';

// Load environment variables (legacy single-instance compatibility).
dotenv.config();

// stderr only, stdout is reserved for JSON-RPC.
console.error('Starting Zendesk API MCP server...');

const transport = new StdioServerTransport();
await server.connect(transport);
