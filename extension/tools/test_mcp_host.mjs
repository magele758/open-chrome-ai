import assert from "node:assert";
import { EventEmitter } from "node:events";
import {
  MCP_TOOLS,
  attachMcpStdio,
  handleMcpRequest,
} from "../../native/pagelens-host.mjs";

console.log("Starting MCP Server test suite...");

// 1. Initialize Handshake
{
  const initReq = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
  const initRes = await handleMcpRequest(initReq);
  assert.strictEqual(initRes.jsonrpc, "2.0");
  assert.strictEqual(initRes.id, 1);
  assert.strictEqual(initRes.result.serverInfo.name, "pagelens-host");
  assert.strictEqual(Boolean(initRes.result.capabilities.tools), true);
  console.log("  PASS: MCP initialize handshake");
}

// 2. Notifications & Ping
{
  const notifyRes = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  assert.strictEqual(notifyRes, null, "notification must produce no response");

  const pingRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: "p1",
    method: "ping",
  });
  assert.strictEqual(pingRes.id, "p1");
  assert.deepStrictEqual(pingRes.result, {});
  console.log("  PASS: MCP notification and ping");
}

// 3. Tools List
{
  const listRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.strictEqual(listRes.id, 2);
  const toolNames = listRes.result.tools.map((t) => t.name);
  assert.strictEqual(toolNames.includes("exec_command"), true);
  assert.strictEqual(toolNames.includes("read_file"), true);
  assert.strictEqual(toolNames.includes("write_file"), true);
  assert.strictEqual(toolNames.includes("list_directory"), true);
  assert.strictEqual(toolNames.includes("scan_skills"), true);
  assert.strictEqual(listRes.result.tools.length, 5);
  console.log("  PASS: MCP tools/list discovery");
}

// 4. Tools Call: exec_command
{
  const callRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "exec_command",
      arguments: {
        command: "echo 'hello from mcp test'",
      },
    },
  });
  assert.strictEqual(callRes.id, 3);
  assert.strictEqual(callRes.result.isError, false);
  assert.strictEqual(callRes.result.content[0].type, "text");
  assert.strictEqual(callRes.result.content[0].text.includes("hello from mcp test"), true);
  console.log("  PASS: MCP tools/call exec_command");
}

// 5. Tools Call: list_directory
{
  const callRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "list_directory",
      arguments: {
        path: process.cwd(),
      },
    },
  });
  assert.strictEqual(callRes.id, 4);
  assert.strictEqual(callRes.result.isError, false);
  const entries = JSON.parse(callRes.result.content[0].text);
  assert.strictEqual(Array.isArray(entries), true);
  const names = entries.map((e) => e.name);
  assert.strictEqual(names.includes("extension"), true);
  console.log("  PASS: MCP tools/call list_directory");
}

// 6. Unknown tool / method error handling
{
  const errRes = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "non_existent_tool" },
  });
  assert.strictEqual(errRes.id, 5);
  assert.strictEqual(errRes.error.code, -32601);
  console.log("  PASS: MCP error handling for unknown tool");
}

// 7. Stdio stream simulation
{
  const mockStdin = new EventEmitter();
  mockStdin.setEncoding = () => {};
  let outData = "";
  const mockStdout = {
    write: (data) => {
      outData += data;
    },
  };

  attachMcpStdio(mockStdin, mockStdout);

  const testPayload = JSON.stringify({
    jsonrpc: "2.0",
    id: 99,
    method: "ping",
  }) + "\n";

  mockStdin.emit("data", testPayload);
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(outData.includes('"id":99'), true);
  assert.strictEqual(outData.endsWith("\n"), true);
  console.log("  PASS: MCP Stdio line transport simulation");
}

console.log("All MCP tests passed successfully!");
