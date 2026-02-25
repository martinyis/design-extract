#!/usr/bin/env node

import {
  writeFileSync,
  readFileSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.includes("--server")) {
  await import("./index.js");
} else if (args[0] === "init") {
  init();
} else {
  printHelp();
}

function init() {
  const cwd = process.cwd();

  writeMcpConfig(cwd);
  updateGitignore(cwd);

  console.log("");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code (or start a new conversation)");
  console.log(
    "  2. Record a screen capture of the design you want to reference"
  );
  console.log(
    '  3. Tell Claude: "extract the design from ./recording.mp4 and build the homepage"'
  );
}

function writeMcpConfig(cwd: string) {
  const mcpPath = join(cwd, ".mcp.json");

  const serverConfig = {
    command: "npx",
    args: ["-y", "design-extract@latest", "--server"],
  };

  if (existsSync(mcpPath)) {
    const existing = JSON.parse(readFileSync(mcpPath, "utf-8"));
    existing.mcpServers = existing.mcpServers || {};
    if (existing.mcpServers["design-extract"]) {
      console.log("design-extract is already configured in .mcp.json");
      return;
    }
    existing.mcpServers["design-extract"] = serverConfig;
    writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
    console.log("Added design-extract to existing .mcp.json");
  } else {
    const config = { mcpServers: { "design-extract": serverConfig } };
    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + "\n");
    console.log("Created .mcp.json with design-extract configured");
  }
}

function updateGitignore(cwd: string) {
  const gitignorePath = join(cwd, ".gitignore");
  const entry = ".design-extract/";

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(entry)) {
      return;
    }
    const prefix = content.endsWith("\n") ? "" : "\n";
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
    console.log("Added .design-extract/ to .gitignore");
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
    console.log("Created .gitignore with .design-extract/");
  }
}

function printHelp() {
  console.log(
    "design-extract - Extract design context from screen recordings for Claude Code"
  );
  console.log("");
  console.log("Usage:");
  console.log(
    "  design-extract init    Configure design-extract for this project"
  );
  console.log("  design-extract help    Show this help message");
}
