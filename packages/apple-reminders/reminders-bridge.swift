import Foundation
import EventKit
import CoreLocation

let store = EKEventStore()

// ── Helpers ─────────────────────────────────────────────────────────────────

func requestAccess() -> Bool {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    store.requestFullAccessToReminders { g, _ in granted = g; sem.signal() }
    sem.wait()
    return granted
}

func jsonEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
     .replacingOccurrences(of: "\n", with: "\\n")
     .replacingOccurrences(of: "\r", with: "\\r")
     .replacingOccurrences(of: "\t", with: "\\t")
}

func jsonStr(_ s: String?) -> String {
    guard let s = s, !s.isEmpty else { return "null" }
    return "\"\(jsonEscape(s))\""
}

let df: DateFormatter = {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm"; f.locale = Locale(identifier: "en_US_POSIX"); return f
}()

let isoDF: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
}()

func parseDate(_ s: String) -> Date? {
    // Try ISO8601 first
    if let d = isoDF.date(from: s) { return d }
    let iso2 = ISO8601DateFormatter()
    iso2.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = iso2.date(from: s) { return d }
    // Fallback formats
    let formats = ["yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd", "MMMM d, yyyy 'at' h:mm a"]
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
    for fmt in formats { f.dateFormat = fmt; if let d = f.date(from: s) { return d } }
    return nil
}

func findReminder(_ id: String) -> EKReminder? {
    let pred = store.predicateForReminders(in: nil)
    let sem = DispatchSemaphore(value: 0)
    var found: EKReminder?
    store.fetchReminders(matching: pred) { r in found = r?.first { $0.calendarItemExternalIdentifier == id }; sem.signal() }
    sem.wait()
    return found
}

func fetchAll(includeCompleted: Bool = true) -> [EKReminder] {
    let pred = store.predicateForReminders(in: nil)
    let sem = DispatchSemaphore(value: 0)
    var result: [EKReminder] = []
    store.fetchReminders(matching: pred) { r in result = r ?? []; sem.signal() }
    sem.wait()
    if !includeCompleted { result = result.filter { !$0.isCompleted } }
    return result
}

// ── Serialization ───────────────────────────────────────────────────────────

func alarmJSON(_ a: EKAlarm) -> String {
    var parts: [String] = []
    parts.append("\"relativeOffset\":\(a.relativeOffset)")
    parts.append("\"absoluteDate\":\(a.absoluteDate.map { "\"\(isoDF.string(from: $0))\"" } ?? "null")")
    // Proximity
    let prox: String
    switch a.proximity {
    case .enter: prox = "enter"
    case .leave: prox = "leave"
    default: prox = "none"
    }
    parts.append("\"proximity\":\"\(prox)\"")
    // Structured location on alarm
    if let sl = a.structuredLocation {
        var locParts: [String] = []
        locParts.append("\"title\":\(jsonStr(sl.title))")
        locParts.append("\"radius\":\(sl.radius)")
        if let geo = sl.geoLocation {
            locParts.append("\"latitude\":\(geo.coordinate.latitude)")
            locParts.append("\"longitude\":\(geo.coordinate.longitude)")
        }
        parts.append("\"structuredLocation\":{\(locParts.joined(separator: ","))}")
    } else {
        parts.append("\"structuredLocation\":null")
    }
    return "{\(parts.joined(separator: ","))}"
}

func recurrenceJSON(_ rule: EKRecurrenceRule) -> String {
    var parts: [String] = []
    let freq: String
    switch rule.frequency {
    case .daily: freq = "daily"; case .weekly: freq = "weekly"
    case .monthly: freq = "monthly"; case .yearly: freq = "yearly"
    @unknown default: freq = "unknown"
    }
    parts.append("\"frequency\":\"\(freq)\"")
    parts.append("\"interval\":\(rule.interval)")

    if let days = rule.daysOfTheWeek {
        let dayNames = days.map { d -> String in
            switch d.dayOfTheWeek {
            case .sunday: return "SU"; case .monday: return "MO"; case .tuesday: return "TU"
            case .wednesday: return "WE"; case .thursday: return "TH"; case .friday: return "FR"
            case .saturday: return "SA"; @unknown default: return "??"
            }
        }
        parts.append("\"daysOfWeek\":[\(dayNames.map { "\"\($0)\"" }.joined(separator: ","))]")
    }
    if let dom = rule.daysOfTheMonth {
        parts.append("\"daysOfMonth\":[\(dom.map { "\($0)" }.joined(separator: ","))]")
    }
    if let months = rule.monthsOfTheYear {
        parts.append("\"monthsOfYear\":[\(months.map { "\($0)" }.joined(separator: ","))]")
    }
    if let end = rule.recurrenceEnd {
        if let endDate = end.endDate {
            parts.append("\"until\":\"\(isoDF.string(from: endDate))\"")
        } else {
            parts.append("\"count\":\(end.occurrenceCount)")
        }
    } else {
        parts.append("\"forever\":true")
    }
    return "{\(parts.joined(separator: ","))}"
}

func reminderJSON(_ r: EKReminder) -> String {
    var p: [String] = []
    p.append("\"id\":\(jsonStr(r.calendarItemExternalIdentifier))")
    p.append("\"name\":\(jsonStr(r.title))")
    p.append("\"body\":\(jsonStr(r.notes))")
    p.append("\"listName\":\(jsonStr(r.calendar.title))")
    p.append("\"completed\":\(r.isCompleted)")
    p.append("\"priority\":\(r.priority)")

    // Dates
    p.append("\"dueDate\":\(r.dueDateComponents?.date.map { "\"\(df.string(from: $0))\"" } ?? "null")")
    p.append("\"startDate\":\(r.startDateComponents?.date.map { "\"\(df.string(from: $0))\"" } ?? "null")")
    p.append("\"completionDate\":\(r.completionDate.map { "\"\(df.string(from: $0))\"" } ?? "null")")
    p.append("\"createdAt\":\(r.creationDate.map { "\"\(isoDF.string(from: $0))\"" } ?? "null")")
    p.append("\"modifiedAt\":\(r.lastModifiedDate.map { "\"\(isoDF.string(from: $0))\"" } ?? "null")")

    // URL, location, timezone
    p.append("\"url\":\(r.url.map { jsonStr($0.absoluteString) } ?? "null")")
    p.append("\"location\":\(jsonStr(r.location))")
    p.append("\"timezone\":\(r.timeZone.map { jsonStr($0.identifier) } ?? "null")")

    // Flags
    p.append("\"hasAlarms\":\(r.hasAlarms)")
    p.append("\"hasRecurrenceRules\":\(r.hasRecurrenceRules)")
    p.append("\"hasAttendees\":\(r.hasAttendees)")

    // Alarms (multiple)
    if let alarms = r.alarms, !alarms.isEmpty {
        p.append("\"alarms\":[\(alarms.map { alarmJSON($0) }.joined(separator: ","))]")
    } else {
        p.append("\"alarms\":[]")
    }

    // Recurrence rules
    if let rules = r.recurrenceRules, !rules.isEmpty {
        p.append("\"recurrence\":[\(rules.map { recurrenceJSON($0) }.joined(separator: ","))]")
    } else {
        p.append("\"recurrence\":[]")
    }

    // Attendees (read-only)
    if let attendees = r.attendees, !attendees.isEmpty {
        let att = attendees.map { a -> String in
            let status: String
            switch a.participantStatus {
            case .accepted: status = "accepted"; case .declined: status = "declined"
            case .tentative: status = "tentative"; case .pending: status = "pending"
            default: status = "unknown"
            }
            return "{\"name\":\(jsonStr(a.name)),\"url\":\(jsonStr(a.url.absoluteString)),\"status\":\"\(status)\"}"
        }
        p.append("\"attendees\":[\(att.joined(separator: ","))]")
    } else {
        p.append("\"attendees\":[]")
    }

    return "{\(p.joined(separator: ","))}"
}

// ── Lists ───────────────────────────────────────────────────────────────────

func getLists() {
    let calendars = store.calendars(for: .reminder)
    var items: [String] = []

    let all = fetchAll(includeCompleted: false)
    let now = Date()
    let cal = Calendar.current
    let todayStart = cal.startOfDay(for: now)
    let todayEnd = cal.date(byAdding: .day, value: 1, to: todayStart)!

    let todayCount = all.filter { r in
        guard let due = r.dueDateComponents?.date else { return false }
        return due >= todayStart && due < todayEnd
    }.count
    let scheduledCount = all.filter { $0.dueDateComponents?.date != nil }.count
    // Flagged: priority 1-4 maps to "high" per RFC 5545 = closest to Apple's flag
    let flaggedCount = all.filter { $0.priority >= 1 && $0.priority <= 4 }.count
    let allCount = all.count

    items.append("{\"id\":\"__smart_today__\",\"name\":\"Today\",\"count\":\(todayCount),\"smart\":true}")
    items.append("{\"id\":\"__smart_scheduled__\",\"name\":\"Scheduled\",\"count\":\(scheduledCount),\"smart\":true}")
    items.append("{\"id\":\"__smart_flagged__\",\"name\":\"Flagged\",\"count\":\(flaggedCount),\"smart\":true}")
    items.append("{\"id\":\"__smart_all__\",\"name\":\"All\",\"count\":\(allCount),\"smart\":true}")

    for c in calendars {
        let pred = store.predicateForReminders(in: [c])
        let sem = DispatchSemaphore(value: 0)
        var count = 0
        store.fetchReminders(matching: pred) { r in count = (r ?? []).filter { !$0.isCompleted }.count; sem.signal() }
        sem.wait()
        items.append("{\"id\":\"\(jsonEscape(c.calendarIdentifier))\",\"name\":\"\(jsonEscape(c.title))\",\"count\":\(count),\"color\":\"\(c.cgColor?.components?.prefix(3).map { String(format: "#%02X", Int($0 * 255)) }.joined() ?? "")\"}")
    }
    print("[\(items.joined(separator: ","))]")
}

func createList(name: String) {
    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = name
    cal.source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first { $0.sourceType == .local }!
    do {
        try store.saveCalendar(cal, commit: true)
        print("{\"id\":\"\(jsonEscape(cal.calendarIdentifier))\",\"name\":\"\(jsonEscape(cal.title))\"}")
    } catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

func renameList(listId: String, newName: String) {
    guard let cal = store.calendar(withIdentifier: listId) else { print("{\"error\":\"List not found\"}"); return }
    cal.title = newName
    do { try store.saveCalendar(cal, commit: true); print("{\"ok\":true,\"name\":\"\(jsonEscape(cal.title))\"}") }
    catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

func deleteList(listId: String) {
    guard let cal = store.calendar(withIdentifier: listId) else { print("{\"error\":\"List not found\"}"); return }
    do { try store.removeCalendar(cal, commit: true); print("{\"ok\":true}") }
    catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

// ── Reminders ───────────────────────────────────────────────────────────────

func getReminders(listName: String?, includeCompleted: Bool) {
    var reminders: [EKReminder]

    if let name = listName, name.hasPrefix("__smart_") {
        reminders = fetchAll(includeCompleted: includeCompleted)
        let now = Date()
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: now)
        let todayEnd = cal.date(byAdding: .day, value: 1, to: todayStart)!

        switch name {
        case "__smart_today__":
            reminders = reminders.filter { r in
                guard let due = r.dueDateComponents?.date else { return false }
                return due >= todayStart && due < todayEnd
            }
        case "__smart_scheduled__":
            reminders = reminders.filter { $0.dueDateComponents?.date != nil }
        case "__smart_flagged__":
            reminders = reminders.filter { $0.priority >= 1 && $0.priority <= 4 }
        case "__smart_all__": break
        default: break
        }
    } else {
        var calendars = store.calendars(for: .reminder)
        if let name = listName { calendars = calendars.filter { $0.title == name } }
        if calendars.isEmpty { print("[]"); return }
        let pred = store.predicateForReminders(in: calendars)
        let sem = DispatchSemaphore(value: 0)
        reminders = []
        store.fetchReminders(matching: pred) { r in reminders = r ?? []; sem.signal() }
        sem.wait()
        if !includeCompleted { reminders = reminders.filter { !$0.isCompleted } }
    }
    print("[\(reminders.map { reminderJSON($0) }.joined(separator: ","))]")
}

func searchReminders(query: String, includeCompleted: Bool) {
    let all = fetchAll(includeCompleted: includeCompleted)
    let q = query.lowercased()
    let matches = all.filter {
        ($0.title ?? "").lowercased().contains(q) ||
        ($0.notes ?? "").lowercased().contains(q) ||
        $0.calendar.title.lowercased().contains(q)
    }
    print("[\(matches.map { reminderJSON($0) }.joined(separator: ","))]")
}

// ── Parse alarms JSON ───────────────────────────────────────────────────────

func parseAlarmsJSON(_ json: String) -> [EKAlarm] {
    guard let data = json.data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    var alarms: [EKAlarm] = []
    for item in arr {
        let type = item["type"] as? String ?? "relative"
        switch type {
        case "relative":
            let minutes = item["minutes"] as? Int ?? 0
            alarms.append(EKAlarm(relativeOffset: TimeInterval(-minutes * 60)))
        case "absolute":
            if let dateStr = item["date"] as? String, let date = parseDate(dateStr) {
                alarms.append(EKAlarm(absoluteDate: date))
            }
        case "location":
            let title = item["title"] as? String ?? ""
            let lat = item["latitude"] as? Double
            let lon = item["longitude"] as? Double
            let radius = item["radius"] as? Double ?? 100
            let proximityStr = item["proximity"] as? String ?? "enter"
            let alarm = EKAlarm()
            let loc = EKStructuredLocation(title: title)
            if let lat = lat, let lon = lon {
                loc.geoLocation = CLLocation(latitude: lat, longitude: lon)
            }
            loc.radius = radius
            alarm.structuredLocation = loc
            alarm.proximity = proximityStr == "leave" ? .leave : .enter
            alarms.append(alarm)
        default: break
        }
    }
    return alarms
}

// ── Parse recurrence ────────────────────────────────────────────────────────

func parseRecurrence(_ rec: String) -> EKRecurrenceRule? {
    // Format: "frequency[:days][:key:value]*"
    // Examples: "daily", "weekly:MO,WE,FR", "weekly:MO,FR:interval:2:count:10", "monthly:dayOfMonth:15"
    let parts = rec.split(separator: ":").map { String($0) }
    guard !parts.isEmpty else { return nil }

    let freqStr = parts[0].lowercased()
    let freq: EKRecurrenceFrequency
    switch freqStr {
    case "daily": freq = .daily; case "weekly": freq = .weekly
    case "monthly": freq = .monthly; case "yearly": freq = .yearly
    default: return nil
    }

    var daysOfWeek: [EKRecurrenceDayOfWeek]? = nil
    var daysOfMonth: [NSNumber]? = nil
    var monthsOfYear: [NSNumber]? = nil
    var end: EKRecurrenceEnd? = nil
    var interval = 1

    let dayMap: [String: EKWeekday] = ["SU": .sunday, "MO": .monday, "TU": .tuesday,
        "WE": .wednesday, "TH": .thursday, "FR": .friday, "SA": .saturday]

    var i = 1
    while i < parts.count {
        let p = parts[i]
        let pLower = p.lowercased()

        // Check if it's day codes
        let dayTokens = p.uppercased().split(separator: ",").map { String($0) }
        if dayTokens.allSatisfy({ dayMap[$0] != nil }) && !dayTokens.isEmpty {
            daysOfWeek = dayTokens.compactMap { dayMap[$0] }.map { EKRecurrenceDayOfWeek($0) }
            i += 1
        } else if pLower == "interval" && i + 1 < parts.count {
            interval = Int(parts[i + 1]) ?? 1; i += 2
        } else if pLower == "count" && i + 1 < parts.count {
            if let c = Int(parts[i + 1]) { end = EKRecurrenceEnd(occurrenceCount: c) }; i += 2
        } else if pLower == "until" && i + 1 < parts.count {
            if let d = parseDate(parts[i + 1]) { end = EKRecurrenceEnd(end: d) }; i += 2
        } else if pLower == "dayofmonth" && i + 1 < parts.count {
            daysOfMonth = parts[i + 1].split(separator: ",").compactMap { Int($0) }.map { NSNumber(value: $0) }; i += 2
        } else if pLower == "monthofyear" && i + 1 < parts.count {
            monthsOfYear = parts[i + 1].split(separator: ",").compactMap { Int($0) }.map { NSNumber(value: $0) }; i += 2
        } else {
            i += 1
        }
    }

    return EKRecurrenceRule(recurrenceWith: freq, interval: interval, daysOfTheWeek: daysOfWeek,
                             daysOfTheMonth: daysOfMonth, monthsOfTheYear: monthsOfYear, weeksOfTheYear: nil,
                             daysOfTheYear: nil, setPositions: nil, end: end)
}

// ── Create/Update/Complete/Delete ───────────────────────────────────────────

func createReminder(title: String, listName: String?, body: String?, dueDate: String?,
                    startDate: String?, priority: Int, url: String?, location: String?,
                    alarmsJSON: String?, recurrence: String?, timezone: String?) {
    let reminder = EKReminder(eventStore: store)
    reminder.title = title
    reminder.notes = body
    reminder.priority = priority

    if let name = listName {
        reminder.calendar = store.calendars(for: .reminder).first { $0.title == name } ?? store.defaultCalendarForNewReminders()
    } else {
        reminder.calendar = store.defaultCalendarForNewReminders()
    }

    if let s = dueDate, let d = parseDate(s) {
        reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
    }
    if let s = startDate, let d = parseDate(s) {
        reminder.startDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
    }
    if let u = url, let parsed = URL(string: u) { reminder.url = parsed }
    if let l = location { reminder.location = l }
    if let tz = timezone { reminder.timeZone = TimeZone(identifier: tz) }

    // Alarms (multiple, different types)
    if let aj = alarmsJSON {
        for alarm in parseAlarmsJSON(aj) { reminder.addAlarm(alarm) }
    }

    // Recurrence
    if let rec = recurrence, let rule = parseRecurrence(rec) {
        reminder.addRecurrenceRule(rule)
    }

    do {
        try store.save(reminder, commit: true)
        print(reminderJSON(reminder))
    } catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

func completeReminder(reminderId: String) {
    guard let r = findReminder(reminderId) else { print("{\"error\":\"Not found\"}"); return }
    r.isCompleted = true
    do { try store.save(r, commit: true); print("{\"ok\":true}") }
    catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

func uncompleteReminder(reminderId: String) {
    guard let r = findReminder(reminderId) else { print("{\"error\":\"Not found\"}"); return }
    r.isCompleted = false
    do { try store.save(r, commit: true); print("{\"ok\":true}") }
    catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

func updateReminder(reminderId: String, title: String?, body: String?, dueDate: String?,
                    startDate: String?, priority: Int?, url: String?, location: String?,
                    alarmsJSON: String?, listName: String?, recurrence: String?, timezone: String?) {
    guard let r = findReminder(reminderId) else { print("{\"error\":\"Not found\"}"); return }
    if let t = title { r.title = t }
    if let b = body { r.notes = b == "__clear__" ? nil : b }
    if let p = priority { r.priority = p }
    if let s = dueDate {
        r.dueDateComponents = s == "__clear__" ? nil : parseDate(s).map { Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: $0) }
    }
    if let s = startDate {
        r.startDateComponents = s == "__clear__" ? nil : parseDate(s).map { Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: $0) }
    }
    if let u = url { r.url = u == "__clear__" ? nil : URL(string: u) }
    if let l = location { r.location = l == "__clear__" ? nil : l }
    if let tz = timezone { r.timeZone = tz == "__clear__" ? nil : TimeZone(identifier: tz) }

    // Alarms: replace all
    if let aj = alarmsJSON {
        if let existing = r.alarms { for a in existing { r.removeAlarm(a) } }
        if aj != "__clear__" {
            for alarm in parseAlarmsJSON(aj) { r.addAlarm(alarm) }
        }
    }

    // Recurrence: replace
    if let rec = recurrence {
        if let existing = r.recurrenceRules { for rule in existing { r.removeRecurrenceRule(rule) } }
        if rec != "__clear__", let rule = parseRecurrence(rec) { r.addRecurrenceRule(rule) }
    }

    // Move to list
    if let name = listName {
        if let cal = store.calendars(for: .reminder).first(where: { $0.title == name }) { r.calendar = cal }
    }

    do { try store.save(r, commit: true); print(reminderJSON(r)) }
    catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

func deleteReminder(reminderId: String) {
    guard let r = findReminder(reminderId) else { print("{\"error\":\"Not found\"}"); return }
    do { try store.remove(r, commit: true); print("{\"ok\":true}") }
    catch { print("{\"error\":\"\(jsonEscape(error.localizedDescription))\"}") }
}

// ── Main ────────────────────────────────────────────────────────────────────

guard requestAccess() else { fputs("{\"error\":\"Reminders access denied\"}\n", stderr); exit(1) }

let args = CommandLine.arguments
guard args.count >= 2 else { fputs("Usage: reminders-bridge <command> [args...]\n", stderr); exit(1) }

func arg(_ i: Int) -> String? {
    guard args.count > i else { return nil }
    let v = args[i]; return (v == "__none__" || v == "__default__" || v == "__all__") ? nil : v
}

switch args[1] {
case "getLists": getLists()
case "createList": createList(name: args.count > 2 ? args[2] : "New List")
case "renameList": renameList(listId: args.count > 2 ? args[2] : "", newName: args.count > 3 ? args[3] : "")
case "deleteList": deleteList(listId: args.count > 2 ? args[2] : "")
case "getReminders": getReminders(listName: arg(2), includeCompleted: args.count > 3 && args[3] == "true")
case "searchReminders": searchReminders(query: args.count > 2 ? args[2] : "", includeCompleted: args.count > 3 && args[3] == "true")
case "createReminder":
    createReminder(title: args.count > 2 ? args[2] : "", listName: arg(3), body: arg(4),
                   dueDate: arg(5), startDate: arg(6), priority: Int(arg(7) ?? "") ?? 0,
                   url: arg(8), location: arg(9), alarmsJSON: arg(10), recurrence: arg(11), timezone: arg(12))
case "completeReminder": completeReminder(reminderId: args.count > 2 ? args[2] : "")
case "uncompleteReminder": uncompleteReminder(reminderId: args.count > 2 ? args[2] : "")
case "updateReminder":
    updateReminder(reminderId: args.count > 2 ? args[2] : "", title: arg(3), body: arg(4),
                   dueDate: arg(5), startDate: arg(6), priority: Int(arg(7) ?? "") ?? nil,
                   url: arg(8), location: arg(9), alarmsJSON: arg(10), listName: arg(11),
                   recurrence: arg(12), timezone: arg(13))
case "deleteReminder": deleteReminder(reminderId: args.count > 2 ? args[2] : "")
default: fputs("Unknown command: \(args[1])\n", stderr); exit(1)
}
