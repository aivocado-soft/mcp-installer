"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const reminders_js_1 = require("./reminders.js");
const server = new index_js_1.Server({ name: "apple-reminders", version: "2.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
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
            description: "Create a reminder with full EventKit support.\n\n" +
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
            description: "Update any reminder field. Supports all fields from create_reminder plus:\n" +
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
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "get_reminder_lists":
                return { content: [{ type: "text", text: JSON.stringify((0, reminders_js_1.getLists)(), null, 2) }] };
            case "create_reminder_list":
                return { content: [{ type: "text", text: JSON.stringify((0, reminders_js_1.createList)(args.name), null, 2) }] };
            case "rename_reminder_list":
                (0, reminders_js_1.renameList)(args.listId, args.newName);
                return { content: [{ type: "text", text: "List renamed." }] };
            case "delete_reminder_list":
                (0, reminders_js_1.deleteList)(args.listId);
                return { content: [{ type: "text", text: "List deleted." }] };
            case "get_reminders": {
                const r = (0, reminders_js_1.getReminders)(args?.listName, args?.includeCompleted ?? false);
                return { content: [{ type: "text", text: r.length ? JSON.stringify(r, null, 2) : "No reminders found." }] };
            }
            case "search_reminders": {
                const r = (0, reminders_js_1.searchReminders)(args.query, args?.includeCompleted ?? false);
                return { content: [{ type: "text", text: r.length ? JSON.stringify(r, null, 2) : "No matches." }] };
            }
            case "create_reminder":
                return { content: [{ type: "text", text: JSON.stringify((0, reminders_js_1.createReminder)({
                                title: args.title,
                                listName: args?.listName,
                                body: args?.body,
                                dueDate: args?.dueDate,
                                startDate: args?.startDate,
                                priority: args?.priority,
                                url: args?.url,
                                location: args?.location,
                                alarms: args?.alarms,
                                recurrence: args?.recurrence,
                                timezone: args?.timezone,
                            }), null, 2) }] };
            case "complete_reminder":
                (0, reminders_js_1.completeReminder)(args.reminderId);
                return { content: [{ type: "text", text: "Completed." }] };
            case "uncomplete_reminder":
                (0, reminders_js_1.uncompleteReminder)(args.reminderId);
                return { content: [{ type: "text", text: "Reopened." }] };
            case "update_reminder":
                return { content: [{ type: "text", text: JSON.stringify((0, reminders_js_1.updateReminder)(args.reminderId, {
                                title: args?.title,
                                body: args?.body,
                                dueDate: args?.dueDate,
                                startDate: args?.startDate,
                                priority: args?.priority,
                                url: args?.url,
                                location: args?.location,
                                alarms: args?.alarms,
                                listName: args?.listName,
                                recurrence: args?.recurrence,
                                timezone: args?.timezone,
                            }), null, 2) }] };
            case "delete_reminder":
                (0, reminders_js_1.deleteReminder)(args.reminderId);
                return { content: [{ type: "text", text: "Deleted." }] };
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error("Apple Reminders MCP v2 running");
}
main().catch(console.error);
//# sourceMappingURL=index.js.map