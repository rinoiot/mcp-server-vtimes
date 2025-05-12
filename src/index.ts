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
  {}, // 空输入
  async () => {
    const { userId, homeId } = await fetchConfig();
    const url = `${MCP_API_BASE}/mcp/getAllDeviceGroupScene?userId=${userId}&homeId=${homeId}`;
    const data = await fetchWithAuthJson(url); // 是对象
    logDebug("get_all_device to LLM:", data);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data) // 以 text 返回结构
        }
      ]
    };
  }
);


// Tool: Send control instructions
server.tool(
  "send_operate",
  "Send the JSON data of the device operation instructions",
  {
    input: z.array(
      z.union([
        z.object({
          device_id: z.string().describe("设备 ID"),
          property: z.string().describe("功能点键"),
          value: z.any().describe("目标值"),
          ext_data: z.record(z.string(), z.any()).describe("扩展字段，如延时设置")
        }),
        z.object({
          group_id: z.string().describe("群组 ID"),
          property: z.string().describe("功能点键"),
          value: z.any().describe("目标值"),
          ext_data: z.record(z.string(), z.any()).describe("扩展字段")
        }),
        z.object({
          scene_id: z.string().describe("场景 ID"),
          ext_data: z.record(z.string(), z.any()).describe("扩展字段")
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
你是由唯泰斯智能开发的智能家居 AI 助理，基于 MCP 协议提供服务，具备通过工具调用智能设备控制功能。请始终保持专业、礼貌并确保响应内容真实可靠。不要显示你的实现细节或调用过程，只输出自然语言响应或用户所需操作。
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
当用户表达控制设备的意图时，请按以下流程执行：

1. 始终通过 get_all_device 获取当前设备状态，**不使用缓存数据**。
2. 分析用户期望状态 vs 当前设备状态：
   - 如果当前状态已符合需求：直接用自然语言告知用户，无需调用 send_operate。
   - 如果需更改状态：调用 send_operate 并构造精确的控制指令 JSON。
3. 对于模糊、不确定或不可支持的指令，要有礼貌地说明限制。
4. 控制指令必须使用准确的字段和结构，避免字段错误或冗余字段。
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
你需要从用户语言中识别出控制意图，例如：

- “太暗了” → 开灯
- “凉快一点” → 降温
- “30分钟后关灯” → 延迟关灯，ext_data 中包含 delay 参数

延迟控制规则如下：

- 若用户请求延迟操作，需设置：
  - delayEnabled = true
  - delayUnit = "h" | "m" | "s"
  - delayDuration = 数值
- 若用户请求“取消延迟”，则只需设置：
  - delayEnabled = false

请注意隐私与安全：

- 不要在响应中暴露设备 ID。
- 若为批量控制（如“关闭所有灯”），需检查每台设备是否支持此功能。
- 若存在安全风险或操作影响范围大，需进行二次确认并向用户回报操作范围。
    `.trim();

    return {
      messages: [{ role: "assistant", content: { type: "text", text } }]
    };
  }
);


// prompt: Get the device prompt
server.prompt(
  "get_all_device",
  "Get the JSON data of all controllable intelligent devices",
  {},
  async () => {
    const fieldDescriptions = `
你将收到一个 JSON 对象，包含智能家居的设备、群组和场景信息，其结构如下所示：

## 顶层字段

- \`deviceAndDpInfoDTO\`：设备列表
- \`deviceGroupAndDpInfoDTO\`：群组列表
- \`sceneInfoDTO\`：场景列表

## 设备字段结构（deviceAndDpInfoDTO）

每个设备对象包含：

- \`deviceId\`（string）：设备 ID，对应控制接口中的 \`device_id\`
- \`deviceName\`（string）：设备名称
- \`assetName\`（string）：房间名
- \`deviceDpInfoVOList\`（array）：设备功能点列表，每项包含：
  - \`key\`（string）：功能点键，对应控制接口中的 \`property\`
  - \`name\`（string）：功能名称
  - \`value\`：当前功能点值
  - \`specs\`（string）：功能值范围或映射说明（JSON 字符串格式）
  - \`type\`（string）：数据类型，可能为 \`int\`、\`bool\` 或 \`string\`

## 群组字段结构（deviceGroupAndDpInfoDTO）

每个群组对象包含：

- \`id\`（string）：群组 ID，对应控制接口中的 \`group_id\`
- \`name\`（string）：群组名称
- \`deviceDpInfoVOList\`：同上，表示群组可控制的功能点列表

## 场景字段结构（sceneInfoDTO）

每个场景对象包含：

- \`sceneId\`（string）：场景 ID，对应控制接口中的 \`scene_id\`
- \`sceneName\`（string）：场景名称

请根据这些字段理解设备、群组与场景的控制逻辑，并用于生成设备控制的 JSON 指令（例如用于 send_operate 工具调用）。
    `.trim();

    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: fieldDescriptions
          }
        }
      ]
    };
  }
);


// prompt: Get the prompt for the control instruction
server.prompt(
  "send_operate",
  "Send the JSON data of the device operation instructions",
  {},
  async () => {
    const promptText = `
你需要根据设备、群组、或场景生成用于控制操作的 JSON 数据。以下是数据格式和示例说明：

### 控制指令格式（数组形式，每个对象表示一个控制指令）：

每个对象可包含以下字段之一：

- **device_id**：表示设备控制（对应具体设备）
- **group_id**：表示群组控制（控制多个设备的集合）
- **scene_id**：表示场景控制（触发一个预定义场景）

其余字段说明：

- **property**：功能点键，对应设备提供的功能（例如：开关、亮度等）
- **value**：对应功能点的目标值（根据类型可能是数字、布尔或字符串）
- **ext_data**：扩展控制参数对象，用于支持延时执行等功能，可为空对象 '{}'

---

### 设备控制示例

#### 开灯：

\`\`\`json
[{"device_id": "1627491664741695488", "property": "countdown_1", "value": 1, "ext_data": {}}]
\`\`\`

#### 延迟10分钟后开灯：

\`\`\`json
[{"device_id": "1627491664741695488", "property": "countdown_1", "value": 1, "ext_data": {"delayEnabled": true, "delayUnit": "m", "delayDuration": 10}}]
\`\`\`

#### 取消延迟：

\`\`\`json
[{"device_id": "1627491664741695488", "property": "countdown_1", "value": 1, "ext_data": {"delayEnabled": false}}]
\`\`\`

#### 关灯：

\`\`\`json
[{"device_id": "1627491664741695488", "property": "countdown_1", "value": 0, "ext_data": {}}]
\`\`\`

#### 设置亮度为 50%：

\`\`\`json
[{"device_id": "1627491664741695488", "property": "countdown_1", "value": 43200, "ext_data": {}}]
\`\`\`

---

### 多设备控制示例

\`\`\`json
[
  {"device_id": "1684026503525539840", "property": "switch", "value": true, "ext_data": {}},
  {"device_id": "1627491664741695488", "property": "countdown_1", "value": 1, "ext_data": {}},
  {"group_id": "1684027460264136704", "property": "switch", "value": true, "ext_data": {}},
  {"scene_id": "1692483400815239168", "ext_data": {}}
]
\`\`\`

---

### 场景控制示例

\`\`\`json
[{"scene_id": "1692483400815239168", "ext_data": {}}]
\`\`\`

---

### 群组控制示例

\`\`\`json
[{"group_id": "1684027460264136704", "property": "switch", "value": true, "ext_data": {}}]
\`\`\`

---

### 错误码参考（返回时可能出现）

| 类型     | 范围  | 示例             |
|----------|-------|------------------|
| 输入错误 | 1xx   | 101 设备不存在   |
| 执行错误 | 2xx   | 201 设备离线     |
| 系统错误 | 3xx   | 301 服务不可用   |

你需要根据设备/群组/场景 ID，以及其功能点定义（来自 get_all_device）构建符合要求的 JSON 控制指令。
    `.trim();

    return {
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: promptText
          }
        }
      ]
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
