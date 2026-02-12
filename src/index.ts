#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { discoverCoverageDir } from "./discovery.js";
import { CoverageData } from "./coverage.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const coverageDir = discoverCoverageDir();
  console.error(`SimpleCov MCP: coverage directory found at ${coverageDir}`);

  const coverage = new CoverageData(coverageDir);
  console.error(`SimpleCov MCP: loaded coverage data`);

  const server = new McpServer({
    name: "simplecov",
    version: "0.1.0",
  });

  registerTools(server, coverage);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SimpleCov MCP: server running on stdio");
}

main().catch((error) => {
  console.error("SimpleCov MCP: fatal error:", error);
  process.exit(1);
});
