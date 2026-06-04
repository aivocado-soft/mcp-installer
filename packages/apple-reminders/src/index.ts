import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getLists, createList, renameList, deleteList,
  getReminders, searchReminders,
  createReminder, completeReminder, uncompleteReminder, updateReminder, deleteReminder,
} from "./reminders.js";

const server = new Server(
  { name: "apple-reminders", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Lists ───────────────────────────────────────────────────────────
    {
      name: "get_reminder_lists",
      description: "Get all Apple Reminders lists with item counts. Includes smart lists (Today, Scheduled, Flagged, All).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_reminder_list",
      description: "Create a new Reminders list",
      inputSchema: {
        type: "object", required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
    {
      name: "rename_reminder_list",
      description: "Rename an existing Reminders list",
      inputSchema: {
        type: "object", required: ["listId", "newName"],
        properties: {
          listId: { type: "string", description: "List ID from get_reminder_lists" },
          newName: { type: "string" },
        },
      },
    },
    {
      name: "delete_reminder_list",
      description: "Delete a Reminders list and ALL its reminders (irreversible!)",
      inputSchema: {
        type: "object", required: ["listId"],
        properties: { listId: { type: "string" } },
      },
    },

    // ── Reminders ────────────────────────────────────────────────────────
    {
      name: "get_reminders",
      description: "Get reminders. Filter by list name or smart list (__smart_today__, __smart_scheduled__, __smart_flagged__, __smart_all__).",
      inputSchema: {
        type: "object",
        properties: {
          listName: { type: "string", description: "List name or smart list ID" },
          includeCompleted: { type: "boolean", description: "Include completed (default false)" },
        },
      },
    },
    {
      name: "search_reminders",
      description: "Search reminders by keyword across title, notes, and list name",
      inputSchema: {
        type: "object", required: ["query"],
        properties: {
          query: { type: "string" },
          includeCompleted: { type: "boolean" },
        },
      },
    },
    {
      name: "create_reminder",
      description:
        "Create a reminder with full EventKit support.\n\n" +
        "ALARMS: JSON array of alarm objects. Types:\n" +
        '  - Relative: {"type":"relative","minutes":15}\n' +
        '  - Absolute: {"type":"absolute","date":"2026-06-01T09:00:00Z"}\n' +
        '  - Location: {"type":"location","title":"Office","latitude":50.45,"longitude":30.52,"radius":200,"proximity":"enter"}\n' +
        "  Multiple alarms supported.\n\n" +
        "RECURRENCE: colon-separated string.\n" +
        "  Frequency: daily, weekly, monthly, yearly\n" +
        "  Days: weekly:MO,WE,FR\n" +
        "  Day of month: monthly:dayOfMonth:15\n" +
        "  Interval: weekly:MO,FR:interval:2\n" +
        "  Count: daily:count:10\n" +
        "  Until: weekly:MO:until:2026-12-31\n" +
        "  Month of year: yearly:monthOfYear:1,6",
      inputSchema: {
        type: "object", required: ["title"],
        properties: {
          title: { type: "string" },
          listName: { type: "string", description: "Target list (default: Reminders)" },
          body: { type: "string", description: "Notes" },
          dueDate: { type: "string", description: "Due date (ISO 8601 or yyyy-MM-dd HH:mm)" },
          startDate: { type: "string", description: "Start date" },
          priority: { type: "number", description: "0=none, 1=high, 5=medium, 9=low" },
          url: { type: "string", description: "URL to attach" },
          location: { type: "string", description: "Location text" },
          alarms: {
            type: "array",
            description: "Array of alarm objects (see tool description for format)",
            items: { type: "object" },
          },
          recurrence: { type: "string", description: "Recurrence pattern (see tool description)" },
          timezone: { type: "string", description: "IANA timezone (e.g. Europe/Kyiv)" },
        },
      },
    },
    {
      name: "complete_reminder",
      description: "Mark a reminder as completed",
      inputSchema: {
        type: "object", required: ["reminderId"],
        properties: { reminderId: { type: "string" } },
      },
    },
    {
      name: "uncomplete_reminder",
      description: "Reopen a completed reminder (mark as not completed)",
      inputSchema: {
        type: "object", required: ["reminderId"],
        properties: { reminderId: { type: "string" } },
      },
    },
    {
      name: "update_reminder",
      description:
        "Update any reminder field. Supports all fields from create_reminder plus:\n" +
        "  - listName: move to another list\n" +
        "  - alarms: replace all alarms (use '__clear__' to remove all)\n" +
        "  - recurrence: replace pattern (use '__clear__' to remove)\n" +
        "  - Set any date/url/location to '__clear__' to remove it",
      inputSchema: {
        type: "object", required: ["reminderId"],
        properties: {
          reminderId: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          dueDate: { type: "string" },
          startDate: { type: "string" },
          priority: { type: "number" },
          url: { type: "string" },
          location: { type: "string" },
          alarms: {
            description: "Array of alarm objects or '__clear__' to remove all",
          },
          listName: { type: "string", description: "Move to this list" },
          recurrence: { type: "string", description: "New pattern or '__clear__'" },
          timezone: { type: "string" },
        },
      },
    },
    {
      name: "delete_reminder",
      description: "Permanently delete a reminder",
      inputSchema: {
        type: "object", required: ["reminderId"],
        properties: { reminderId: { type: "string" } },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "get_reminder_lists":
        return { content: [{ type: "text", text: JSON.stringify(getLists(), null, 2) }] };
      case "create_reminder_list":
        return { content: [{ type: "text", text: JSON.stringify(createList(args!.name as string), null, 2) }] };
      case "rename_reminder_list":
        renameList(args!.listId as string, args!.newName as string);
        return { content: [{ type: "text", text: "List renamed." }] };
      case "delete_reminder_list":
        deleteList(args!.listId as string);
        return { content: [{ type: "text", text: "List deleted." }] };

      case "get_reminders": {
        const r = getReminders(args?.listName as string | undefined, (args?.includeCompleted as boolean) ?? false);
        return { content: [{ type: "text", text: r.length ? JSON.stringify(r, null, 2) : "No reminders found." }] };
      }
      case "search_reminders": {
        const r = searchReminders(args!.query as string, (args?.includeCompleted as boolean) ?? false);
        return { content: [{ type: "text", text: r.length ? JSON.stringify(r, null, 2) : "No matches." }] };
      }

      case "create_reminder":
        return { content: [{ type: "text", text: JSON.stringify(createReminder({
          title: args!.title as string,
          listName: args?.listName as string | undefined,
          body: args?.body as string | undefined,
          dueDate: args?.dueDate as string | undefined,
          startDate: args?.startDate as string | undefined,
          priority: args?.priority as number | undefined,
          url: args?.url as string | undefined,
          location: args?.location as string | undefined,
          alarms: args?.alarms as any[] | undefined,
          recurrence: args?.recurrence as string | undefined,
          timezone: args?.timezone as string | undefined,
        }), null, 2) }] };

      case "complete_reminder":
        completeReminder(args!.reminderId as string);
        return { content: [{ type: "text", text: "Completed." }] };
      case "uncomplete_reminder":
        uncompleteReminder(args!.reminderId as string);
        return { content: [{ type: "text", text: "Reopened." }] };

      case "update_reminder":
        return { content: [{ type: "text", text: JSON.stringify(updateReminder(args!.reminderId as string, {
          title: args?.title as string | undefined,
          body: args?.body as string | undefined,
          dueDate: args?.dueDate as string | undefined,
          startDate: args?.startDate as string | undefined,
          priority: args?.priority as number | undefined,
          url: args?.url as string | undefined,
          location: args?.location as string | undefined,
          alarms: args?.alarms as any,
          listName: args?.listName as string | undefined,
          recurrence: args?.recurrence as string | undefined,
          timezone: args?.timezone as string | undefined,
        }), null, 2) }] };

      case "delete_reminder":
        deleteReminder(args!.reminderId as string);
        return { content: [{ type: "text", text: "Deleted." }] };

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Reminders MCP v2 running");
}
main().catch(console.error);
