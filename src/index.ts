import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Get the AUTH_TOKEN
const AUTH_TOKEN = process.env.VTIMES_API_KEY;
if (!AUTH_TOKEN) {
  console.error("Error: Missing VTIMES_API_KEY environment variable.");
  process.exit(1);
}

// Get the base URI of the MCP API
let MCP_API_BASE = process.env.VTIMES_API_BASE;
if (!MCP_API_BASE) {
  MCP_API_BASE = "https://ai-app.rinoiot.com/v1";
}

// Configure the cache
let configCache: { userId: string; homeId: string } | null = null;

function logDebug(...args: any[]) {
  if (process.env.DEBUG === "1") {
    console.error("[DEBUG]", ...args);
  }
}

// Get the config
async function fetchConfig() {
  if (configCache) return configCache;

  const response = await fetch(`${MCP_API_BASE}/mcp/getMcpData/param`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch config: ${response.status}`);
  }

  const json = await response.json();
  if (json.code !== 200) {
    throw new Error(`Config API returned error: ${json.message}`);
  }

  configCache = {
    userId: json.data.userId,
    homeId: json.data.homeId
  };

  return configCache;
}

// Encapsulate the fetch tool function
async function fetchWithAuthText(url: string, method = "GET", body?: any): Promise<string> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  if (!response.ok) {
    logDebug("Request failed:", response.status, text);
    throw new Error(`Request failed with status ${response.status}`);
  }

  return text;
}

async function fetchWithAuthJson(url: string, method = "GET", body?: any): Promise<any> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  if (!response.ok) {
    logDebug("Request failed:", response.status, text);
    throw new Error(`Request failed with status ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    logDebug("Failed to parse JSON:", text);
    throw e;
  }
}

// Create an instance of MCP Server
const server = new McpServer({
  name: "mcp-server-vtimes",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {}
  }
});

// Tool: Get all device data
server.tool(
  "get_all_device",
  "Get the JSON data of all controllable intelligent devices",
  {},
  async () => {
    const { userId, homeId } = await fetchConfig();
    const url = `${MCP_API_BASE}/mcp/getAllDeviceGroupScene?userId=${userId}&homeId=${homeId}`;
    const data = await fetchWithAuthText(url);
    logDebug("get_all_device to LLM:", data);
    return {
      content: [{ type: "text", text: data }]
    };
  }
);

// Tool: Send control instructions
server.tool(
  "send_operate",
  "Send the JSON data of the device operation instructions",
  {
    input: z.record(z.any())
  },
  async ({ input }) => {
    const url = `${MCP_API_BASE}/mcp/sendOperate`;
    const data = await fetchWithAuthText(url, "POST", input);
    logDebug("send_operate to LLM:", data);
    return {
      content: [{ type: "text", text: data }]
    };
  }
);

// prompt: Get the device prompt
server.prompt(
  "get_all_device",
  "Get the JSON data of all controllable intelligent devices",
  {},
  async () => {
    try {
      const json = await fetchWithAuthJson(`${MCP_API_BASE}/mcp/getMcpData/promptGetAllDevice`);
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: json.data || ""
            }
          }
        ]
      };
    } catch (e) {
      logDebug("get_all_device prompt error:", e);
      return { messages: [] };
    }
  }
);

// prompt: Get the prompt for the control instruction
server.prompt(
  "send_operate",
  "Send the JSON data of the device operation instructions",
  {},
  async () => {
    try {
      const json = await fetchWithAuthJson(`${MCP_API_BASE}/mcp/getMcpData/promptSendOperate`);
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: json.data || ""
            }
          }
        ]
      };
    } catch (e) {
      logDebug("send_operate prompt error:", e);
      return { messages: [] };
    }
  }
);

// Startup entry
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logDebug("RINO MCP Server running on stdio");
  const config = await fetchConfig();
  logDebug("Fetched Config:", config);
}

main().catch((err) => {
  logDebug("Fatal error in main():", err);
  process.exit(1);
});
