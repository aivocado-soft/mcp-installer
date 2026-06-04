/**
 * Managed Bots & User Data - Bot API 9.6+ / 10.0+
 *
 * Methods:
 * - getManagedBotToken
 * - replaceManagedBotToken
 * - getManagedBotAccessSettings
 * - setManagedBotAccessSettings
 * - getUserPersonalChatMessages
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callTelegramAPI, createToolResult } from "../telegram-api.js";

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

export const managedTools: Tool[] = [
  {
    name: "getManagedBotToken",
    description:
      "Get the token of a bot managed by the current bot. Returns BotToken object with the token string.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: {
          type: "integer",
          description: "Unique identifier of the managed bot.",
        },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "replaceManagedBotToken",
    description:
      "Replace the token of a managed bot with a new one. Returns BotToken object with the new token. The old token becomes invalid immediately.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: {
          type: "integer",
          description: "Unique identifier of the managed bot.",
        },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "getManagedBotAccessSettings",
    description:
      "Get the current access settings for a managed bot. Returns ManagedBotAccessSettings object.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: {
          type: "integer",
          description: "Unique identifier of the managed bot.",
        },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "setManagedBotAccessSettings",
    description:
      "Set access settings for a managed bot. Controls what the managing bot can do with the managed bot. Returns True on success.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: {
          type: "integer",
          description: "Unique identifier of the managed bot.",
        },
        can_read_messages: {
          type: "boolean",
          description: "Pass True to allow the managing bot to read messages of the managed bot.",
        },
        can_send_messages: {
          type: "boolean",
          description: "Pass True to allow the managing bot to send messages on behalf of the managed bot.",
        },
        can_manage_settings: {
          type: "boolean",
          description: "Pass True to allow the managing bot to manage settings of the managed bot.",
        },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "getUserPersonalChatMessages",
    description:
      "Get messages from a user's personal chat with the bot. Returns an array of Message objects.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: {
          type: "integer",
          description: "Unique identifier of the target user.",
        },
        offset: {
          type: "integer",
          description: "Identifier of the first message to return.",
        },
        limit: {
          type: "integer",
          description: "Limits the number of messages to retrieve (1-100, default 100).",
        },
      },
      required: ["user_id"],
    },
  },
];

// =============================================================================
// TOOL HANDLER
// =============================================================================

export async function handleManagedTool(
  name: string,
  args: Record<string, unknown>
) {
  const response = await callTelegramAPI(name, args);
  return createToolResult(response);
}
