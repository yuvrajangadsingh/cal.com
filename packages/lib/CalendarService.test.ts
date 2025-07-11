import { describe, it, expect } from "vitest";

import { addScheduleAgentClient } from "./CalendarService";

describe("addScheduleAgentClient", () => {
  it("should add SCHEDULE-AGENT=CLIENT to simple ATTENDEE lines", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:123456",
      "DTSTART:20240101T120000Z",
      "DTEND:20240101T130000Z",
      "SUMMARY:Test Event",
      "ATTENDEE:mailto:user1@example.com",
      "ATTENDEE:mailto:user2@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const expected = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:123456",
      "DTSTART:20240101T120000Z",
      "DTEND:20240101T130000Z",
      "SUMMARY:Test Event",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:user1@example.com",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:user2@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should add SCHEDULE-AGENT=CLIENT to ATTENDEE lines with existing parameters", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN="John Doe":mailto:john@example.com',
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:jane@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const expected = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      'ATTENDEE;PARTSTAT=NEEDS-ACTION;CN="John Doe";SCHEDULE-AGENT=CLIENT:mailto:john@example.com',
      "ATTENDEE;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:jane@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should not modify ATTENDEE lines that already have SCHEDULE-AGENT", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "ATTENDEE;SCHEDULE-AGENT=SERVER:mailto:user@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:user2@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const expected = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "ATTENDEE;SCHEDULE-AGENT=SERVER:mailto:user@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:user2@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should handle empty strings", () => {
    const input = "";
    const result = addScheduleAgentClient(input);
    expect(result).toBe("");
  });

  it("should handle iCal strings without ATTENDEE lines", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:123456",
      "DTSTART:20240101T120000Z",
      "DTEND:20240101T130000Z",
      "SUMMARY:Test Event Without Attendees",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const expected = input.split("\n").join("\r\n");

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should handle malformed ATTENDEE lines without colon", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "ATTENDEE_MALFORMED_NO_COLON",
      "ATTENDEE:mailto:valid@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const expected = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "ATTENDEE_MALFORMED_NO_COLON",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:valid@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should preserve line endings (CRLF)", () => {
    const input = "BEGIN:VCALENDAR\r\nATTENDEE:mailto:user@example.com\r\nEND:VCALENDAR";
    const expected =
      "BEGIN:VCALENDAR\r\nATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:user@example.com\r\nEND:VCALENDAR";

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should handle real-world iCalendar format", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Cal.com Inc.//Cal.com Event//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:12345-67890-abcdef",
      "DTSTART:20240115T140000Z",
      "DTEND:20240115T150000Z",
      "SUMMARY:Team Meeting",
      "DESCRIPTION:Weekly team sync",
      "LOCATION:https://meet.google.com/abc-defg-hij",
      "ORGANIZER;CN=John Organizer:mailto:organizer@example.com",
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Alice:mailto:alice@example.com",
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;RSVP=TRUE;CN=Bob:mailto:bob@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const result = addScheduleAgentClient(input);

    // Check that SCHEDULE-AGENT=CLIENT was added to both attendees
    expect(result).toContain(
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=Alice;SCHEDULE-AGENT=CLIENT:mailto:alice@example.com"
    );
    expect(result).toContain(
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;RSVP=TRUE;CN=Bob;SCHEDULE-AGENT=CLIENT:mailto:bob@example.com"
    );
    // Organizer line should not be modified
    expect(result).toContain("ORGANIZER;CN=John Organizer:mailto:organizer@example.com");
  });

  it("should handle case-insensitive ATTENDEE lines", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "attendee:mailto:lowercase@example.com",
      "Attendee:mailto:capitalized@example.com",
      "ATTENDEE:mailto:uppercase@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const expected = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "attendee;SCHEDULE-AGENT=CLIENT:mailto:lowercase@example.com",
      "Attendee;SCHEDULE-AGENT=CLIENT:mailto:capitalized@example.com",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:uppercase@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = addScheduleAgentClient(input);
    expect(result).toBe(expected);
  });

  it("should handle folded lines (RFC 5545 line folding)", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=",
      ' "Very Long Name That Causes Line Folding":mailto:verylongemailaddress@exam',
      " ple.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const result = addScheduleAgentClient(input);

    // The folded line should be unfolded and processed as one line
    expect(result).toContain(
      'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Very Long Name That Causes Line Folding";SCHEDULE-AGENT=CLIENT:mailto:verylongemailaddress@example.com'
    );
  });

  it("should not add SCHEDULE-AGENT if already present (case-insensitive)", () => {
    const input = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "ATTENDEE;schedule-agent=CLIENT:mailto:lowercase@example.com",
      "ATTENDEE;Schedule-Agent=SERVER:mailto:mixedcase@example.com",
      "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:uppercase@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\n");

    const result = addScheduleAgentClient(input);

    // None of these should be modified since they already have SCHEDULE-AGENT
    expect(result).toContain("ATTENDEE;schedule-agent=CLIENT:mailto:lowercase@example.com");
    expect(result).toContain("ATTENDEE;Schedule-Agent=SERVER:mailto:mixedcase@example.com");
    expect(result).toContain("ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:uppercase@example.com");
  });
});
