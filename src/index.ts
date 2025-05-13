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

let promptSendOperate = `
You need to generate JSON data for control operations based on devices, groups, or scenes. Below is the data format and example instructions:

### Control Command Format (Array Form, each object represents a control instruction):

Each object may contain one of the following identifiers:

- device_id: Indicates device control (corresponds to a specific device)
- group_id: Indicates group control (controls a collection of devices)
- scene_id: Indicates scene control (triggers a predefined scene)

Additional fields:

- property: The functional key representing the control point of a device (e.g., switch, brightness, etc.)
- value: The target value for the function point (can be a number, boolean, or string depending on the type)
- ext_data: An object for extended control parameters, such as delayed execution; can be an empty object {}

---

### Device Control Examples

// Turn on the light:
[
  {
    "device_id": "1627491664741695488",
    "property": "countdown_1",
    "value": 1,
    "ext_data": {}
  }
]

// Turn on the light after a 10-minute delay:
[
  {
    "device_id": "1627491664741695488",
    "property": "countdown_1",
    "value": 1,
    "ext_data": {
      "delayEnabled": true,
      "delayUnit": "m",
      "delayDuration": 10
    }
  }
]

// Cancel delay:
[
  {
    "device_id": "1627491664741695488",
    "property": "countdown_1",
    "value": 1,
    "ext_data": {
      "delayEnabled": false
    }
  }
]

// Turn off the light:
[
  {
    "device_id": "1627491664741695488",
    "property": "countdown_1",
    "value": 0,
    "ext_data": {}
  }
]

// Set brightness to 50%:
[
  {
    "device_id": "1627491664741695488",
    "property": "countdown_1",
    "value": 43200,
    "ext_data": {}
  }
]

---

### Multiple Device Control Example

[
  {
    "device_id": "1684026503525539840",
    "property": "switch",
    "value": true,
    "ext_data": {}
  },
  {
    "device_id": "1627491664741695488",
    "property": "countdown_1",
    "value": 1,
    "ext_data": {}
  },
  {
    "group_id": "1684027460264136704",
    "property": "switch",
    "value": true,
    "ext_data": {}
  },
  {
    "scene_id": "1692483400815239168",
    "ext_data": {}
  }
]

---

### Scene Control Example

[
  {
    "scene_id": "1692483400815239168",
    "ext_data": {}
  }
]

---

### Group Control Example

[
  {
    "group_id": "1684027460264136704",
    "property": "switch",
    "value": true,
    "ext_data": {}
  }
]

---

### Error Code Reference (may appear in the response)

| Type          | Range | Example                |
|---------------|--------|------------------------|
| Input Error   | 1xx   | 101 Device not found   |
| Execution Error| 2xx  | 201 Device offline     |
| System Error  | 3xx   | 301 Service unavailable|

You are required to construct valid JSON control commands based on the device/group/scene IDs and their function definitions (from get_all_device).
`.trim();

let promptGetAllDevice = `
You will receive a JSON object containing information about smart home devices, groups, and scenes. The structure is as follows:

## Top-Level Fields

- deviceAndDpInfoDTO: List of devices
- deviceGroupAndDpInfoDTO: List of device groups
- sceneInfoDTO: List of scenes

## Device Field Structure (deviceAndDpInfoDTO)

Each device object includes:

- deviceId (string): Device ID, corresponds to device_id in the control interface
- deviceName (string): Device name
- assetName (string): Room name
- deviceDpInfoVOList (array): List of functional data points, each item includes:
  - key (string): Function key, corresponds to property in the control interface
  - name (string): Function name
  - value: Current value of the function point
  - specs (string): Value range or mapping description (in JSON string format)
  - type (string): Data type, can be int, bool, or string

## Group Field Structure (deviceGroupAndDpInfoDTO)

Each group object includes:

- id (string): Group ID, corresponds to group_id in the control interface
- name (string): Group name
- deviceDpInfoVOList: Same as above, representing the list of controllable function points for the group

## Scene Field Structure (sceneInfoDTO)

Each scene object includes:

- sceneId (string): Scene ID, corresponds to scene_id in the control interface
- sceneName (string): Scene name

Use this structure to understand the control logic for devices, groups, and scenes, and generate JSON control commands (e.g., for use with the send_operate tool).
`.trim();

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
  promptGetAllDevice,
  {},
  async () => {
    const { userId, homeId } = await fetchConfig();
    const url = `${MCP_API_BASE}/mcp/getAllDeviceGroupScene?userId=${userId}&homeId=${homeId}`;
    const data = await fetchWithAuthJson(url);
    logDebug("get_all_device to LLM:", data);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data)
        }
      ]
    };
  }
);


// Tool: Send control instructions
server.tool(
  "send_operate",
  promptSendOperate,
  {
    input: z.array(
      z.union([
        z.object({
          device_id: z.string().describe("Device ID"),
          property: z.string().describe("Function key"),
          value: z.any().describe("The target value for the function point"),
          ext_data: z.record(z.string(), z.any()).describe("An object for extended control parameters, such as delayed execution")
        }),
        z.object({
          group_id: z.string().describe("Group ID"),
          property: z.string().describe("Function key"),
          value: z.any().describe("The target value for the function point"),
          ext_data: z.record(z.string(), z.any()).describe("An object for extended control parameters, such as delayed execution")
        }),
        z.object({
          scene_id: z.string().describe("Scene ID"),
          ext_data: z.record(z.string(), z.any()).describe("An object for extended control parameters, such as delayed execution")
        })
      ])
    )
  },
  async ({ input }) => {
    const url = `${MCP_API_BASE}/mcp/sendOperate`;
    const data = await fetchWithAuthJson(url, "POST", input);
    logDebug("send_operate to LLM:", data);
    return {
      content: [{ type: "text", text: JSON.stringify(data) }]
    };
  }
);


// prompt: system prompt
server.prompt(
  "system",
  "System persona and behavior definition for MCP",
  {},
  async () => {
    const text = `
This is a smart home AI assistant that provides services based on the MCP protocol and has the function of controlling smart devices through tools. Please always remain professional, polite and ensure that the response content is true and reliable. Do not display your implementation details or the calling process. Only output natural language responses or the operations required by the user.
    `.trim();

    return {
      messages: [{ role: "assistant", content: { type: "text", text } }]
    };
  }
);

server.prompt(
  "task_policy",
  "Task handling rules for device control",
  {},
  async () => {
    const text = `
When the user expresses an intent to control a device, please follow the steps below:

1. Always retrieve the current device status using get_all_device. **Do not use cached data**.

2. Compare the user's expected state with the current device state:
   - If the current state already matches the user's intent: respond with a natural language confirmation, and do not call send_operate.
   - If a state change is needed: call send_operate and construct an accurate JSON control command.

3. For vague, ambiguous, or unsupported commands, politely inform the user of the limitation.

4. Control commands must use precise fields and structure. Avoid incorrect or redundant fields.
`.trim();

    return {
      messages: [{ role: "assistant", content: { type: "text", text } }]
    };
  }
);

server.prompt(
  "intent_policy",
  "User intent recognition and delayed control logic",
  {},
  async () => {
    const text = `
You need to identify the user's control intent from natural language input. For example:

- "It's too dark" → Turn on the light
- "Make it cooler" → Lower the temperature
- "Turn off the light in 30 minutes" → Delayed light off, with delay parameters in ext_data

Rules for delayed control:

- If the user requests a delayed action, set the following:
  - delayEnabled = true
  - delayUnit = "h" | "m" | "s"
  - delayDuration = numeric value

- If the user requests to "cancel the delay", only set:
  - delayEnabled = false

Privacy and safety guidelines:

- Do **not** expose device IDs (deviceId) in responses.
- For bulk operations (e.g., "Turn off all lights"), check whether each device supports the requested function.
- If there is any security risk or the action has a wide impact, perform a secondary confirmation and report the scope of the operation to the user.
`.trim();

    return {
      messages: [{ role: "assistant", content: { type: "text", text } }]
    };
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
