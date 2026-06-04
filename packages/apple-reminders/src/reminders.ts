import { execFileSync } from "child_process";
import * as path from "path";

const BRIDGE = path.join(path.dirname(__dirname), "reminders-bridge");

function runBridge(...args: string[]): string {
  return execFileSync(BRIDGE, args, { encoding: "utf8", timeout: 30000 }).trim();
}

function s(val: string | undefined | null): string {
  return val ?? "__none__";
}

function parse(raw: string): any {
  const result = JSON.parse(raw);
  if (result.error) throw new Error(result.error);
  return result;
}

// ── Lists ───────────────────────────────────────────────────────────────────

export function getLists(): any[] {
  const raw = runBridge("getLists");
  return raw ? JSON.parse(raw) : [];
}

export function createList(name: string): any {
  return parse(runBridge("createList", name));
}

export function renameList(listId: string, newName: string): any {
  return parse(runBridge("renameList", listId, newName));
}

export function deleteList(listId: string): any {
  return parse(runBridge("deleteList", listId));
}

// ── Reminders ───────────────────────────────────────────────────────────────

export function getReminders(listName?: string, includeCompleted = false): any[] {
  const raw = runBridge("getReminders", listName || "__all__", includeCompleted ? "true" : "false");
  return raw ? JSON.parse(raw) : [];
}

export function searchReminders(query: string, includeCompleted = false): any[] {
  const raw = runBridge("searchReminders", query, includeCompleted ? "true" : "false");
  return raw ? JSON.parse(raw) : [];
}

export function createReminder(params: {
  title: string;
  listName?: string;
  body?: string;
  dueDate?: string;
  startDate?: string;
  priority?: number;
  url?: string;
  location?: string;
  alarms?: any[];
  recurrence?: string;
  timezone?: string;
}): any {
  const alarmsJSON = params.alarms ? JSON.stringify(params.alarms) : "__none__";
  return parse(runBridge(
    "createReminder",
    params.title,
    params.listName || "__default__",
    s(params.body),
    s(params.dueDate),
    s(params.startDate),
    String(params.priority || 0),
    s(params.url),
    s(params.location),
    alarmsJSON,
    s(params.recurrence),
    s(params.timezone),
  ));
}

export function completeReminder(reminderId: string): boolean {
  return parse(runBridge("completeReminder", reminderId)).ok === true;
}

export function uncompleteReminder(reminderId: string): boolean {
  return parse(runBridge("uncompleteReminder", reminderId)).ok === true;
}

export function updateReminder(
  reminderId: string,
  fields: {
    title?: string;
    body?: string;
    dueDate?: string;
    startDate?: string;
    priority?: number;
    url?: string;
    location?: string;
    alarms?: any[] | "__clear__";
    listName?: string;
    recurrence?: string | "__clear__";
    timezone?: string;
  }
): any {
  let alarmsVal = "__none__";
  if (fields.alarms === "__clear__") alarmsVal = "__clear__";
  else if (Array.isArray(fields.alarms)) alarmsVal = JSON.stringify(fields.alarms);

  let recurrenceVal = s(typeof fields.recurrence === "string" ? fields.recurrence : undefined);

  return parse(runBridge(
    "updateReminder",
    reminderId,
    s(fields.title),
    fields.body !== undefined ? fields.body : "__none__",
    s(fields.dueDate),
    s(fields.startDate),
    fields.priority !== undefined ? String(fields.priority) : "__none__",
    s(fields.url),
    s(fields.location),
    alarmsVal,
    s(fields.listName),
    recurrenceVal,
    s(fields.timezone),
  ));
}

export function deleteReminder(reminderId: string): boolean {
  return parse(runBridge("deleteReminder", reminderId)).ok === true;
}
