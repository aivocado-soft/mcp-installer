"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLists = getLists;
exports.createList = createList;
exports.renameList = renameList;
exports.deleteList = deleteList;
exports.getReminders = getReminders;
exports.searchReminders = searchReminders;
exports.createReminder = createReminder;
exports.completeReminder = completeReminder;
exports.uncompleteReminder = uncompleteReminder;
exports.updateReminder = updateReminder;
exports.deleteReminder = deleteReminder;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const BRIDGE = path.join(path.dirname(__dirname), "reminders-bridge");
function runBridge(...args) {
    return (0, child_process_1.execFileSync)(BRIDGE, args, { encoding: "utf8", timeout: 30000 }).trim();
}
function s(val) {
    return val ?? "__none__";
}
function parse(raw) {
    const result = JSON.parse(raw);
    if (result.error)
        throw new Error(result.error);
    return result;
}
// ── Lists ───────────────────────────────────────────────────────────────────
function getLists() {
    const raw = runBridge("getLists");
    return raw ? JSON.parse(raw) : [];
}
function createList(name) {
    return parse(runBridge("createList", name));
}
function renameList(listId, newName) {
    return parse(runBridge("renameList", listId, newName));
}
function deleteList(listId) {
    return parse(runBridge("deleteList", listId));
}
// ── Reminders ───────────────────────────────────────────────────────────────
function getReminders(listName, includeCompleted = false) {
    const raw = runBridge("getReminders", listName || "__all__", includeCompleted ? "true" : "false");
    return raw ? JSON.parse(raw) : [];
}
function searchReminders(query, includeCompleted = false) {
    const raw = runBridge("searchReminders", query, includeCompleted ? "true" : "false");
    return raw ? JSON.parse(raw) : [];
}
function createReminder(params) {
    const alarmsJSON = params.alarms ? JSON.stringify(params.alarms) : "__none__";
    return parse(runBridge("createReminder", params.title, params.listName || "__default__", s(params.body), s(params.dueDate), s(params.startDate), String(params.priority || 0), s(params.url), s(params.location), alarmsJSON, s(params.recurrence), s(params.timezone)));
}
function completeReminder(reminderId) {
    return parse(runBridge("completeReminder", reminderId)).ok === true;
}
function uncompleteReminder(reminderId) {
    return parse(runBridge("uncompleteReminder", reminderId)).ok === true;
}
function updateReminder(reminderId, fields) {
    let alarmsVal = "__none__";
    if (fields.alarms === "__clear__")
        alarmsVal = "__clear__";
    else if (Array.isArray(fields.alarms))
        alarmsVal = JSON.stringify(fields.alarms);
    let recurrenceVal = s(typeof fields.recurrence === "string" ? fields.recurrence : undefined);
    return parse(runBridge("updateReminder", reminderId, s(fields.title), fields.body !== undefined ? fields.body : "__none__", s(fields.dueDate), s(fields.startDate), fields.priority !== undefined ? String(fields.priority) : "__none__", s(fields.url), s(fields.location), alarmsVal, s(fields.listName), recurrenceVal, s(fields.timezone)));
}
function deleteReminder(reminderId) {
    return parse(runBridge("deleteReminder", reminderId)).ok === true;
}
//# sourceMappingURL=reminders.js.map