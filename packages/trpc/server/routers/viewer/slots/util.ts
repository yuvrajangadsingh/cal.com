// eslint-disable-next-line no-restricted-imports
import type { Logger } from "tslog";
import { v4 as uuid } from "uuid";

import type { Dayjs } from "@calcom/dayjs";
import dayjs from "@calcom/dayjs";
import { orgDomainConfig } from "@calcom/ee/organizations/lib/orgDomains";
import { checkForConflicts } from "@calcom/features/bookings/lib/conflictChecker/checkForConflicts";
import { isEventTypeLoggingEnabled } from "@calcom/features/bookings/lib/isEventTypeLoggingEnabled";
import { getShouldServeCache } from "@calcom/features/calendar-cache/lib/getShouldServeCache";
import { findQualifiedHostsWithDelegationCredentials } from "@calcom/lib/bookings/findQualifiedHostsWithDelegationCredentials";
import { shouldIgnoreContactOwner } from "@calcom/lib/bookings/routing/utils";
import { RESERVED_SUBDOMAINS } from "@calcom/lib/constants";
import { buildDateRanges } from "@calcom/lib/date-ranges";
import { getUTCOffsetByTimezone } from "@calcom/lib/dayjs";
import { getDefaultEvent } from "@calcom/lib/defaultEvents";
import { getAggregatedAvailability } from "@calcom/lib/getAggregatedAvailability";
import { getBusyTimesForLimitChecks, getStartEndDateforLimitCheck } from "@calcom/lib/getBusyTimes";
import type {
  CurrentSeats,
  EventType,
  GetAvailabilityUser,
  IFromUser,
  IToUser,
} from "@calcom/lib/getUserAvailability";
import { getPeriodStartDatesBetween, getUsersAvailability } from "@calcom/lib/getUserAvailability";
import { descendingLimitKeys, intervalLimitKeyToUnit } from "@calcom/lib/intervalLimits/intervalLimit";
import type { IntervalLimit } from "@calcom/lib/intervalLimits/intervalLimitSchema";
import { parseBookingLimit } from "@calcom/lib/intervalLimits/isBookingLimits";
import { parseDurationLimit } from "@calcom/lib/intervalLimits/isDurationLimits";
import LimitManager from "@calcom/lib/intervalLimits/limitManager";
import { checkBookingLimit } from "@calcom/lib/intervalLimits/server/checkBookingLimits";
import { isBookingWithinPeriod } from "@calcom/lib/intervalLimits/utils";
import {
  calculatePeriodLimits,
  isTimeOutOfBounds,
  isTimeViolatingFutureLimit,
  BookingDateInPastError,
} from "@calcom/lib/isOutOfBounds";
import logger from "@calcom/lib/logger";
import { isRestrictionScheduleEnabled } from "@calcom/lib/restrictionSchedule";
import { safeStringify } from "@calcom/lib/safeStringify";
import { withReporting } from "@calcom/lib/sentryWrapper";
import { getTotalBookingDuration } from "@calcom/lib/server/queries/booking";
import type { BookingRepository } from "@calcom/lib/server/repository/booking";
import type { EventTypeRepository } from "@calcom/lib/server/repository/eventType";
import type { RoutingFormResponseRepository } from "@calcom/lib/server/repository/formResponse";
import type { PrismaOOORepository } from "@calcom/lib/server/repository/ooo";
import type { ScheduleRepository } from "@calcom/lib/server/repository/schedule";
import type { SelectedSlotsRepository } from "@calcom/lib/server/repository/selectedSlots";
import type { TeamRepository } from "@calcom/lib/server/repository/team";
import type { UserRepository } from "@calcom/lib/server/repository/user";
import { withSelectedCalendars } from "@calcom/lib/server/repository/user";
import getSlots from "@calcom/lib/slots";
import { PeriodType } from "@calcom/prisma/client";
import { SchedulingType } from "@calcom/prisma/enums";
import type { EventBusyDate, EventBusyDetails } from "@calcom/types/Calendar";
import type { CredentialForCalendarService } from "@calcom/types/Credential";

import { TRPCError } from "@trpc/server";

import type { TGetScheduleInputSchema } from "./getSchedule.schema";
import { handleNotificationWhenNoSlots } from "./handleNotificationWhenNoSlots";
import type { GetScheduleOptions } from "./types";

const log = logger.getSubLogger({ prefix: ["[slots/util]"] });

type GetAvailabilityUserWithDelegationCredentials = Omit<GetAvailabilityUser, "credentials"> & {
  credentials: CredentialForCalendarService[];
};

export interface IGetAvailableSlots {
  slots: Record<
    string,
    {
      time: string;
      attendees?: number | undefined;
      bookingUid?: string | undefined;
      away?: boolean | undefined;
      fromUser?: IFromUser | undefined;
      toUser?: IToUser | undefined;
      reason?: string | undefined;
      emoji?: string | undefined;
    }[]
  >;
  troubleshooter?: any;
}

export type GetAvailableSlotsResponse = Awaited<
  ReturnType<(typeof AvailableSlotsService)["prototype"]["_getAvailableSlots"]>
>;

export interface IAvailableSlotsService {
  oooRepo: PrismaOOORepository;
  scheduleRepo: ScheduleRepository;
  selectedSlotsRepo: SelectedSlotsRepository;
  teamRepo: TeamRepository;
  userRepo: UserRepository;
  bookingRepo: BookingRepository;
  eventTypeRepo: EventTypeRepository;
  routingFormResponseRepo: RoutingFormResponseRepository;
}

export class AvailableSlotsService {
  constructor(private readonly dependencies: IAvailableSlotsService) {}

  private async _getReservedSlotsAndCleanupExpired({
    bookerClientUid,
    usersWithCredentials,
    eventTypeId,
  }: {
    bookerClientUid: string | undefined;
    usersWithCredentials: GetAvailabilityUser[];
    eventTypeId: number;
  }) {
    const currentTimeInUtc = dayjs.utc().format();
    const slotsRepo = this.dependencies.selectedSlotsRepo;

    const unexpiredSelectedSlots =
      (await slotsRepo.findManyUnexpiredSlots({
        userIds: usersWithCredentials.map((user) => user.id),
        currentTimeInUtc,
      })) || [];

    const slotsSelectedByOtherUsers = unexpiredSelectedSlots.filter((slot) => slot.uid !== bookerClientUid);

    await _cleanupExpiredSlots({ eventTypeId });

    const reservedSlots = slotsSelectedByOtherUsers;

    return reservedSlots;

    async function _cleanupExpiredSlots({ eventTypeId }: { eventTypeId: number }) {
      await slotsRepo.deleteManyExpiredSlots({ eventTypeId, currentTimeInUtc });
    }
  }

  private async _getDynamicEventType(
    input: TGetScheduleInputSchema,
    organizationDetails: { currentOrgDomain: string | null; isValidOrgDomain: boolean }
  ) {
    const { currentOrgDomain, isValidOrgDomain } = organizationDetails;
    // For dynamic booking, we need to get and update user credentials, schedule and availability in the eventTypeObject as they're required in the new availability logic
    if (!input.eventTypeSlug) {
      throw new TRPCError({
        message: "eventTypeSlug is required for dynamic booking",
        code: "BAD_REQUEST",
      });
    }
    const dynamicEventType = getDefaultEvent(input.eventTypeSlug);

    const userRepo = this.dependencies.userRepo;
    const usersForDynamicEventType = await userRepo.findManyUsersForDynamicEventType({
      currentOrgDomain: isValidOrgDomain ? currentOrgDomain : null,
      usernameList: Array.isArray(input.usernameList)
        ? input.usernameList
        : input.usernameList
        ? [input.usernameList]
        : [],
    });

    const usersWithOldSelectedCalendars = usersForDynamicEventType.map((user) => withSelectedCalendars(user));

    const isDynamicAllowed = !usersWithOldSelectedCalendars.some((user) => !user.allowDynamicBooking);
    if (!isDynamicAllowed) {
      throw new TRPCError({
        message: "Some of the users in this group do not allow dynamic booking",
        code: "UNAUTHORIZED",
      });
    }
    return Object.assign({}, dynamicEventType, {
      users: usersWithOldSelectedCalendars,
    });
  }
  private getDynamicEventType = withReporting(this._getDynamicEventType.bind(this), "getDynamicEventType");

  private applyOccupiedSeatsToCurrentSeats(
    currentSeats: CurrentSeats,
    occupiedSeats: { slotUtcStartDate: Date }[]
  ) {
    const occupiedSeatsMap = new Map<string, number>();

    occupiedSeats.forEach((item) => {
      const dateKey = item.slotUtcStartDate.toISOString();
      occupiedSeatsMap.set(dateKey, (occupiedSeatsMap.get(dateKey) || 0) + 1);
    });

    occupiedSeatsMap.forEach((count, date) => {
      currentSeats.push({
        uid: uuid(),
        startTime: dayjs(date).toDate(),
        _count: { attendees: count },
      });
    });

    return currentSeats;
  }

  private async _getEventType(
    input: TGetScheduleInputSchema,
    organizationDetails: { currentOrgDomain: string | null; isValidOrgDomain: boolean }
  ) {
    const { eventTypeSlug, usernameList, isTeamEvent } = input;
    log.info(
      "getEventType",
      safeStringify({ usernameList, eventTypeSlug, isTeamEvent, organizationDetails })
    );
    const eventTypeId =
      input.eventTypeId ||
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      (await this.getEventTypeId({
        slug: usernameList?.[0],
        eventTypeSlug: eventTypeSlug,
        isTeamEvent,
        organizationDetails,
      }));

    if (!eventTypeId) {
      return null;
    }

    const eventTypeRepo = this.dependencies.eventTypeRepo;
    return await eventTypeRepo.findForSlots({ id: eventTypeId });
  }

  private getEventType = withReporting(this._getEventType.bind(this), "getEventType");

  private doesRangeStartFromToday(periodType: PeriodType) {
    return periodType === PeriodType.ROLLING_WINDOW || periodType === PeriodType.ROLLING;
  }

  private _getAllDatesWithBookabilityStatus(availableDates: string[]) {
    const availableDatesSet = new Set(availableDates);
    const firstDate = dayjs(availableDates[0]);
    const lastDate = dayjs(availableDates[availableDates.length - 1]);
    const allDates: Record<string, { isBookable: boolean }> = {};

    let currentDate = firstDate;
    while (currentDate <= lastDate) {
      allDates[currentDate.format("YYYY-MM-DD")] = {
        isBookable: availableDatesSet.has(currentDate.format("YYYY-MM-DD")),
      };

      currentDate = currentDate.add(1, "day");
    }
    return allDates;
  }

  private getAllDatesWithBookabilityStatus = withReporting(
    this._getAllDatesWithBookabilityStatus.bind(this),
    "getAllDatesWithBookabilityStatus"
  );

  private async getUserIdFromUsername(
    username: string,
    organizationDetails: { currentOrgDomain: string | null; isValidOrgDomain: boolean }
  ) {
    const { currentOrgDomain, isValidOrgDomain } = organizationDetails;
    log.info("getUserIdFromUsername", safeStringify({ organizationDetails, username }));
    const userRepo = this.dependencies.userRepo;
    const [user] = await userRepo.findUsersByUsername({
      usernameList: [username],
      orgSlug: isValidOrgDomain ? currentOrgDomain : null,
    });
    return user?.id;
  }

  private async getEventTypeId({
    slug,
    eventTypeSlug,
    isTeamEvent,
    organizationDetails,
  }: {
    slug?: string;
    eventTypeSlug?: string;
    isTeamEvent: boolean;
    organizationDetails?: { currentOrgDomain: string | null; isValidOrgDomain: boolean };
  }) {
    if (!eventTypeSlug || !slug) return null;

    let teamId;
    let userId;
    if (isTeamEvent) {
      teamId = await this.getTeamIdFromSlug(
        slug,
        organizationDetails ?? { currentOrgDomain: null, isValidOrgDomain: false }
      );
    } else {
      userId = await this.getUserIdFromUsername(
        slug,
        organizationDetails ?? { currentOrgDomain: null, isValidOrgDomain: false }
      );
    }
    const eventTypeRepo = this.dependencies.eventTypeRepo;
    const eventType = await eventTypeRepo.findFirstEventTypeId({ slug: eventTypeSlug, teamId, userId });
    if (!eventType) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return eventType?.id;
  }

  private async getTeamIdFromSlug(
    slug: string,
    organizationDetails: { currentOrgDomain: string | null; isValidOrgDomain: boolean }
  ) {
    const { currentOrgDomain, isValidOrgDomain } = organizationDetails;
    const teamRepo = this.dependencies.teamRepo;
    const team = await teamRepo.findFirstBySlugAndParentSlug({
      slug,
      parentSlug: isValidOrgDomain && currentOrgDomain ? currentOrgDomain : null,
      select: { id: true },
    });

    return team?.id;
  }

  private async _getBusyTimesFromLimitsForUsers(
    users: { id: number; email: string }[],
    bookingLimits: IntervalLimit | null,
    durationLimits: IntervalLimit | null,
    dateFrom: Dayjs,
    dateTo: Dayjs,
    duration: number | undefined,
    eventType: NonNullable<EventType>,
    timeZone: string,
    rescheduleUid?: string
  ) {
    const userBusyTimesMap = new Map<number, EventBusyDetails[]>();

    if (!bookingLimits && !durationLimits) {
      return userBusyTimesMap;
    }

    const { limitDateFrom, limitDateTo } = getStartEndDateforLimitCheck(
      dateFrom.toISOString(),
      dateTo.toISOString(),
      bookingLimits || durationLimits
    );

    const busyTimesFromLimitsBookings = await getBusyTimesForLimitChecks({
      userIds: users.map((user) => user.id),
      eventTypeId: eventType.id,
      startDate: limitDateFrom.format(),
      endDate: limitDateTo.format(),
      rescheduleUid,
      bookingLimits,
      durationLimits,
    });

    const globalLimitManager = new LimitManager();

    if (bookingLimits) {
      for (const key of descendingLimitKeys) {
        const limit = bookingLimits?.[key];
        if (!limit) continue;

        const unit = intervalLimitKeyToUnit(key);
        const periodStartDates = getPeriodStartDatesBetween(dateFrom, dateTo, unit, timeZone);

        for (const periodStart of periodStartDates) {
          if (globalLimitManager.isAlreadyBusy(periodStart, unit, timeZone)) continue;

          const periodEnd = periodStart.endOf(unit);
          let totalBookings = 0;

          for (const booking of busyTimesFromLimitsBookings) {
            if (!isBookingWithinPeriod(booking, periodStart, periodEnd, timeZone)) {
              continue;
            }

            totalBookings++;
            if (totalBookings >= limit) {
              globalLimitManager.addBusyTime(periodStart, unit, timeZone);
              break;
            }
          }
        }
      }
    }

    for (const user of users) {
      const userBookings = busyTimesFromLimitsBookings.filter((booking) => booking.userId === user.id);
      const limitManager = new LimitManager();

      limitManager.mergeBusyTimes(globalLimitManager);

      if (bookingLimits) {
        for (const key of descendingLimitKeys) {
          const limit = bookingLimits?.[key];
          if (!limit) continue;

          const unit = intervalLimitKeyToUnit(key);
          const periodStartDates = getPeriodStartDatesBetween(dateFrom, dateTo, unit, timeZone);

          for (const periodStart of periodStartDates) {
            if (limitManager.isAlreadyBusy(periodStart, unit, timeZone)) continue;

            if (unit === "year") {
              try {
                // TODO: DI checkBookingLimit
                await checkBookingLimit({
                  eventStartDate: periodStart.toDate(),
                  limitingNumber: limit,
                  eventId: eventType.id,
                  key,
                  user,
                  rescheduleUid,
                  timeZone,
                });
              } catch (_) {
                limitManager.addBusyTime(periodStart, unit, timeZone);
                if (
                  periodStartDates.every((start: Dayjs) => limitManager.isAlreadyBusy(start, unit, timeZone))
                ) {
                  break;
                }
              }
              continue;
            }

            const periodEnd = periodStart.endOf(unit);
            let totalBookings = 0;

            for (const booking of userBookings) {
              if (!isBookingWithinPeriod(booking, periodStart, periodEnd, timeZone)) {
                continue;
              }

              totalBookings++;
              if (totalBookings >= limit) {
                limitManager.addBusyTime(periodStart, unit, timeZone);
                break;
              }
            }
          }
        }
      }

      if (durationLimits) {
        for (const key of descendingLimitKeys) {
          const limit = durationLimits?.[key];
          if (!limit) continue;

          const unit = intervalLimitKeyToUnit(key);
          const periodStartDates = getPeriodStartDatesBetween(dateFrom, dateTo, unit, timeZone);

          for (const periodStart of periodStartDates) {
            if (limitManager.isAlreadyBusy(periodStart, unit, timeZone)) continue;

            const selectedDuration = (duration || eventType.length) ?? 0;

            if (selectedDuration > limit) {
              limitManager.addBusyTime(periodStart, unit, timeZone);
              continue;
            }

            if (unit === "year") {
              // TODO: DI getTotalBookingDuration
              const totalYearlyDuration = await getTotalBookingDuration({
                eventId: eventType.id,
                startDate: periodStart.toDate(),
                endDate: periodStart.endOf(unit).toDate(),
                rescheduleUid,
              });
              if (totalYearlyDuration + selectedDuration > limit) {
                limitManager.addBusyTime(periodStart, unit, timeZone);
                if (
                  periodStartDates.every((start: Dayjs) => limitManager.isAlreadyBusy(start, unit, timeZone))
                ) {
                  break;
                }
              }
              continue;
            }

            const periodEnd = periodStart.endOf(unit);
            let totalDuration = selectedDuration;

            for (const booking of userBookings) {
              if (!isBookingWithinPeriod(booking, periodStart, periodEnd, timeZone)) {
                continue;
              }
              totalDuration += dayjs(booking.end).diff(dayjs(booking.start), "minute");
              if (totalDuration > limit) {
                limitManager.addBusyTime(periodStart, unit, timeZone);
                break;
              }
            }
          }
        }
      }

      userBusyTimesMap.set(user.id, limitManager.getBusyTimes());
    }

    return userBusyTimesMap;
  }

  private getBusyTimesFromLimitsForUsers = withReporting(
    this._getBusyTimesFromLimitsForUsers.bind(this),
    "getBusyTimesFromLimitsForUsers"
  );

  private async _getBusyTimesFromTeamLimitsForUsers(
    users: { id: number; email: string }[],
    bookingLimits: IntervalLimit,
    dateFrom: Dayjs,
    dateTo: Dayjs,
    teamId: number,
    includeManagedEvents: boolean,
    timeZone: string,
    rescheduleUid?: string
  ) {
    const { limitDateFrom, limitDateTo } = getStartEndDateforLimitCheck(
      dateFrom.toISOString(),
      dateTo.toISOString(),
      bookingLimits
    );

    const bookingRepo = this.dependencies.bookingRepo;
    const bookings = await bookingRepo.getAllAcceptedTeamBookingsOfUsers({
      users,
      teamId,
      startDate: limitDateFrom.toDate(),
      endDate: limitDateTo.toDate(),
      excludedUid: rescheduleUid,
      includeManagedEvents,
    });

    const busyTimes = bookings.map(({ id, startTime, endTime, eventTypeId, title, userId }) => ({
      start: dayjs(startTime).toDate(),
      end: dayjs(endTime).toDate(),
      title,
      source: `eventType-${eventTypeId}-booking-${id}`,
      userId,
    }));

    const globalLimitManager = new LimitManager();

    for (const key of descendingLimitKeys) {
      const limit = bookingLimits?.[key];
      if (!limit) continue;

      const unit = intervalLimitKeyToUnit(key);
      const periodStartDates = getPeriodStartDatesBetween(dateFrom, dateTo, unit, timeZone);

      for (const periodStart of periodStartDates) {
        if (globalLimitManager.isAlreadyBusy(periodStart, unit, timeZone)) continue;

        const periodEnd = periodStart.endOf(unit);
        let totalBookings = 0;

        for (const booking of busyTimes) {
          if (!isBookingWithinPeriod(booking, periodStart, periodEnd, timeZone)) {
            continue;
          }

          totalBookings++;
          if (totalBookings >= limit) {
            globalLimitManager.addBusyTime(periodStart, unit, timeZone);
            break;
          }
        }
      }
    }

    const userBusyTimesMap = new Map();

    for (const user of users) {
      const userBusyTimes = busyTimes.filter((busyTime) => busyTime.userId === user.id);
      const limitManager = new LimitManager();

      limitManager.mergeBusyTimes(globalLimitManager);

      const bookingLimitsParams = {
        bookings: userBusyTimes,
        bookingLimits,
        dateFrom,
        dateTo,
        limitManager,
        rescheduleUid,
        teamId,
        user,
        includeManagedEvents,
        timeZone,
      };

      for (const key of descendingLimitKeys) {
        const limit = bookingLimits?.[key];
        if (!limit) continue;

        const unit = intervalLimitKeyToUnit(key);
        const periodStartDates = getPeriodStartDatesBetween(dateFrom, dateTo, unit, timeZone);

        for (const periodStart of periodStartDates) {
          if (limitManager.isAlreadyBusy(periodStart, unit, timeZone)) continue;

          if (unit === "year") {
            try {
              // TODO: DI checkBookingLimit
              await checkBookingLimit({
                eventStartDate: periodStart.toDate(),
                limitingNumber: limit,
                key,
                teamId,
                user,
                rescheduleUid,
                includeManagedEvents,
                timeZone,
              });
            } catch (_) {
              limitManager.addBusyTime(periodStart, unit, timeZone);
              if (
                periodStartDates.every((start: Dayjs) => limitManager.isAlreadyBusy(start, unit, timeZone))
              ) {
                return;
              }
            }
            continue;
          }

          const periodEnd = periodStart.endOf(unit);
          let totalBookings = 0;

          for (const booking of userBusyTimes) {
            if (!isBookingWithinPeriod(booking, periodStart, periodEnd, timeZone)) {
              continue;
            }

            totalBookings++;
            if (totalBookings >= limit) {
              limitManager.addBusyTime(periodStart, unit, timeZone);
              break;
            }
          }
        }
      }

      userBusyTimesMap.set(user.id, limitManager.getBusyTimes());
    }

    return userBusyTimesMap;
  }
  private getBusyTimesFromTeamLimitsForUsers = withReporting(
    this._getBusyTimesFromTeamLimitsForUsers.bind(this),
    "getBusyTimesFromTeamLimitsForUsers"
  );

  private async _getOOODates(startTimeDate: Date, endTimeDate: Date, allUserIds: number[]) {
    return this.dependencies.oooRepo.findManyOOO({ startTimeDate, endTimeDate, allUserIds });
  }
  private getOOODates = withReporting(this._getOOODates.bind(this), "getOOODates");

  private _getUsersWithCredentials({
    hosts,
  }: {
    hosts: {
      isFixed?: boolean;
      user: GetAvailabilityUserWithDelegationCredentials;
    }[];
  }) {
    return hosts.map(({ isFixed, user }) => ({ isFixed, ...user }));
  }

  private getUsersWithCredentials = withReporting(
    this._getUsersWithCredentials.bind(this),
    "getUsersWithCredentials"
  );

  private getStartTime(startTimeInput: string, timeZone?: string, minimumBookingNotice?: number) {
    const startTimeMin = dayjs.utc().add(minimumBookingNotice || 1, "minutes");
    const startTime = timeZone === "Etc/GMT" ? dayjs.utc(startTimeInput) : dayjs(startTimeInput).tz(timeZone);

    return startTimeMin.isAfter(startTime) ? startTimeMin.tz(timeZone) : startTime;
  }
  private async calculateHostsAndAvailabilities({
    input,
    eventType,
    hosts,
    loggerWithEventDetails,
    startTime,
    endTime,
    bypassBusyCalendarTimes,
    shouldServeCache,
  }: {
    input: TGetScheduleInputSchema;
    eventType: Exclude<
      Awaited<ReturnType<(typeof AvailableSlotsService)["prototype"]["getRegularOrDynamicEventType"]>>,
      null
    >;
    hosts: {
      isFixed?: boolean;
      user: GetAvailabilityUserWithDelegationCredentials;
    }[];
    loggerWithEventDetails: Logger<unknown>;
    startTime: ReturnType<(typeof AvailableSlotsService)["prototype"]["getStartTime"]>;
    endTime: Dayjs;
    bypassBusyCalendarTimes: boolean;
    shouldServeCache?: boolean;
  }) {
    const usersWithCredentials = this.getUsersWithCredentials({
      hosts,
    });

    loggerWithEventDetails.debug("Using users", {
      usersWithCredentials: usersWithCredentials.map((user) => user.email),
    });

    const durationToUse = input.duration || 0;
    let currentSeats: CurrentSeats | undefined;

    const startTimeDate =
      input.rescheduleUid && durationToUse
        ? startTime.subtract(durationToUse, "minute").toDate()
        : startTime.toDate();

    const endTimeDate =
      input.rescheduleUid && durationToUse ? endTime.add(durationToUse, "minute").toDate() : endTime.toDate();

    const userIdAndEmailMap = new Map(usersWithCredentials.map((user) => [user.id, user.email]));
    const allUserIds = Array.from(userIdAndEmailMap.keys());

    const bookingRepo = this.dependencies.bookingRepo;
    const [currentBookingsAllUsers, outOfOfficeDaysAllUsers] = await Promise.all([
      bookingRepo.findAllExistingBookingsForEventTypeBetween({
        startDate: startTimeDate,
        endDate: endTimeDate,
        eventTypeId: eventType.id,
        seatedEvent: Boolean(eventType.seatsPerTimeSlot),
        userIdAndEmailMap,
      }),
      this.getOOODates(startTimeDate, endTimeDate, allUserIds),
    ]);

    const bookingLimits =
      eventType?.bookingLimits &&
      typeof eventType?.bookingLimits === "object" &&
      Object.keys(eventType?.bookingLimits).length > 0
        ? parseBookingLimit(eventType?.bookingLimits)
        : null;

    const durationLimits =
      eventType?.durationLimits &&
      typeof eventType?.durationLimits === "object" &&
      Object.keys(eventType?.durationLimits).length > 0
        ? parseDurationLimit(eventType?.durationLimits)
        : null;

    let busyTimesFromLimitsBookingsAllUsers: Awaited<ReturnType<typeof getBusyTimesForLimitChecks>> = [];

    if (eventType && (bookingLimits || durationLimits)) {
      // TODO: DI getBusyTimesForLimitChecks
      busyTimesFromLimitsBookingsAllUsers = await getBusyTimesForLimitChecks({
        userIds: allUserIds,
        eventTypeId: eventType.id,
        startDate: startTime.format(),
        endDate: endTime.format(),
        rescheduleUid: input.rescheduleUid,
        bookingLimits,
        durationLimits,
      });
    }

    let busyTimesFromLimitsMap: Map<number, EventBusyDetails[]> | undefined = undefined;
    if (eventType && (bookingLimits || durationLimits)) {
      const usersForLimits = usersWithCredentials.map((user) => ({ id: user.id, email: user.email }));
      busyTimesFromLimitsMap = await this.getBusyTimesFromLimitsForUsers(
        usersForLimits,
        bookingLimits,
        durationLimits,
        startTime,
        endTime,
        typeof input.duration === "number" ? input.duration : undefined,
        eventType,
        usersWithCredentials[0]?.timeZone || "UTC",
        input.rescheduleUid || undefined
      );
    }

    const teamForBookingLimits =
      eventType?.team ??
      (eventType?.parent?.team?.includeManagedEventsInLimits ? eventType?.parent?.team : null);

    const teamBookingLimits = parseBookingLimit(teamForBookingLimits?.bookingLimits);

    let teamBookingLimitsMap: Map<number, EventBusyDetails[]> | undefined = undefined;
    if (teamForBookingLimits && teamBookingLimits) {
      const usersForTeamLimits = usersWithCredentials.map((user) => ({ id: user.id, email: user.email }));
      teamBookingLimitsMap = await this.getBusyTimesFromTeamLimitsForUsers(
        usersForTeamLimits,
        teamBookingLimits,
        startTime,
        endTime,
        teamForBookingLimits.id,
        teamForBookingLimits.includeManagedEventsInLimits,
        usersWithCredentials[0]?.timeZone || "UTC",
        input.rescheduleUid || undefined
      );
    }

    function _enrichUsersWithData() {
      return usersWithCredentials.map((currentUser) => {
        return {
          ...currentUser,
          currentBookings: currentBookingsAllUsers
            .filter(
              (b) => b.userId === currentUser.id || b.attendees?.some((a) => a.email === currentUser.email)
            )
            .map((bookings) => {
              const { attendees: _attendees, ...bookingWithoutAttendees } = bookings;
              return bookingWithoutAttendees;
            }),
          outOfOfficeDays: outOfOfficeDaysAllUsers.filter((o) => o.user.id === currentUser.id),
        };
      });
    }
    const enrichUsersWithData = withReporting(_enrichUsersWithData.bind(this), "enrichUsersWithData");
    const users = enrichUsersWithData();

    // TODO: DI getUsersAvailability
    const premappedUsersAvailability = await getUsersAvailability({
      users,
      query: {
        dateFrom: startTime.format(),
        dateTo: endTime.format(),
        eventTypeId: eventType.id,
        afterEventBuffer: eventType.afterEventBuffer,
        beforeEventBuffer: eventType.beforeEventBuffer,
        duration: input.duration || 0,
        returnDateOverrides: false,
        bypassBusyCalendarTimes,
        shouldServeCache,
      },
      initialData: {
        eventType,
        currentSeats,
        rescheduleUid: input.rescheduleUid,
        busyTimesFromLimitsBookings: busyTimesFromLimitsBookingsAllUsers,
        busyTimesFromLimits: busyTimesFromLimitsMap,
        eventTypeForLimits: eventType && (bookingLimits || durationLimits) ? eventType : null,
        teamBookingLimits: teamBookingLimitsMap,
        teamForBookingLimits: teamForBookingLimits,
      },
    });
    /* We get all users working hours and busy slots */
    const allUsersAvailability = premappedUsersAvailability.map(
      (
        { busy, dateRanges, oooExcludedDateRanges, currentSeats: _currentSeats, timeZone, datesOutOfOffice },
        index
      ) => {
        const currentUser = users[index];
        if (!currentSeats && _currentSeats) currentSeats = _currentSeats;
        return {
          timeZone,
          dateRanges,
          oooExcludedDateRanges,
          busy,
          user: currentUser,
          datesOutOfOffice,
        };
      }
    );

    return {
      allUsersAvailability,
      usersWithCredentials,
      currentSeats,
    };
  }

  private async _getRegularOrDynamicEventType(
    input: TGetScheduleInputSchema,
    organizationDetails: { currentOrgDomain: string | null; isValidOrgDomain: boolean }
  ) {
    const isDynamicBooking = input.usernameList && input.usernameList.length > 1;
    return isDynamicBooking
      ? await this.getDynamicEventType(input, organizationDetails)
      : await this.getEventType(input, organizationDetails);
  }

  private getRegularOrDynamicEventType = withReporting(
    this._getRegularOrDynamicEventType.bind(this),
    "getRegularOrDynamicEventType"
  );

  getAvailableSlots = withReporting(this._getAvailableSlots.bind(this), "getAvailableSlots");

  async _getAvailableSlots({ input, ctx }: GetScheduleOptions): Promise<IGetAvailableSlots> {
    const {
      _enableTroubleshooter: enableTroubleshooter = false,
      _bypassCalendarBusyTimes: bypassBusyCalendarTimes = false,
      _shouldServeCache,
      routingFormResponseId,
      queuedFormResponseId,
    } = input;
    const orgDetails = input?.orgSlug
      ? {
          currentOrgDomain: input.orgSlug,
          isValidOrgDomain: !!input.orgSlug && !RESERVED_SUBDOMAINS.includes(input.orgSlug),
        }
      : orgDomainConfig(ctx?.req);

    if (process.env.INTEGRATION_TEST_MODE === "true") {
      logger.settings.minLevel = 2;
    }

    const eventType = await this.getRegularOrDynamicEventType(input, orgDetails);

    if (!eventType) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }

    // TODO: DI getShouldServeCache
    const shouldServeCache = await getShouldServeCache(_shouldServeCache, eventType.team?.id);
    if (isEventTypeLoggingEnabled({ eventTypeId: eventType.id })) {
      logger.settings.minLevel = 2;
    }

    const isRollingWindowPeriodType = eventType.periodType === PeriodType.ROLLING_WINDOW;
    const startTimeAsIsoString = input.startTime;
    const isStartTimeInPast = dayjs(startTimeAsIsoString).isBefore(dayjs().subtract(1, "day").startOf("day"));

    // If startTime is already sent in the past, we don't need to adjust it.
    // We assume that the client is already sending startTime as per their requirement.
    // Note: We could optimize it further to go back 1 month in past only for the 2nd month because that is what we are putting a hard limit at.
    const startTimeAdjustedForRollingWindowComputation =
      isStartTimeInPast || !isRollingWindowPeriodType
        ? startTimeAsIsoString
        : dayjs(startTimeAsIsoString).subtract(1, "month").toISOString();

    const loggerWithEventDetails = logger.getSubLogger({
      type: "json",
      prefix: ["getAvailableSlots", `${eventType.id}:${input.usernameList}/${input.eventTypeSlug}`],
    });

    const startTime = this.getStartTime(
      startTimeAdjustedForRollingWindowComputation,
      input.timeZone,
      eventType.minimumBookingNotice
    );
    const endTime =
      input.timeZone === "Etc/GMT" ? dayjs.utc(input.endTime) : dayjs(input.endTime).utc().tz(input.timeZone);

    if (!startTime.isValid() || !endTime.isValid()) {
      throw new TRPCError({ message: "Invalid time range given.", code: "BAD_REQUEST" });
    }
    // when an empty array is given we should prefer to have it handled as if this wasn't given at all
    // we don't want to return no availability in this case.
    const routedTeamMemberIds = input.routedTeamMemberIds ?? [];
    const contactOwnerEmailFromInput = input.teamMemberEmail ?? null;

    const skipContactOwner = shouldIgnoreContactOwner({
      skipContactOwner: input.skipContactOwner ?? null,
      rescheduleUid: input.rescheduleUid ?? null,
      routedTeamMemberIds: input.routedTeamMemberIds ?? null,
    });

    const contactOwnerEmail = skipContactOwner ? null : contactOwnerEmailFromInput;

    let routingFormResponse = null;
    if (routingFormResponseId) {
      const formResponseRepo = this.dependencies.routingFormResponseRepo;
      routingFormResponse = await formResponseRepo.findFormResponseIncludeForm({
        routingFormResponseId,
      });
    } else if (queuedFormResponseId) {
      const formResponseRepo = this.dependencies.routingFormResponseRepo;
      routingFormResponse = await formResponseRepo.findQueuedFormResponseIncludeForm({
        queuedFormResponseId,
      });
    }

    // TODO: DI findQualifiedHostsWithDelegationCredentials
    const { qualifiedRRHosts, allFallbackRRHosts, fixedHosts } =
      await findQualifiedHostsWithDelegationCredentials({
        eventType,
        rescheduleUid: input.rescheduleUid ?? null,
        routedTeamMemberIds,
        contactOwnerEmail,
        routingFormResponse,
      });

    const allHosts = [...qualifiedRRHosts, ...fixedHosts];

    const twoWeeksFromNow = dayjs().add(2, "week");

    const hasFallbackRRHosts = allFallbackRRHosts && allFallbackRRHosts.length > qualifiedRRHosts.length;

    let { allUsersAvailability, usersWithCredentials, currentSeats } =
      await this.calculateHostsAndAvailabilities({
        input,
        eventType,
        hosts: allHosts,
        loggerWithEventDetails,
        // adjust start time so we can check for available slots in the first two weeks
        startTime:
          hasFallbackRRHosts && startTime.isBefore(twoWeeksFromNow)
            ? this.getStartTime(dayjs().format(), input.timeZone, eventType.minimumBookingNotice)
            : startTime,
        // adjust end time so we can check for available slots in the first two weeks
        endTime:
          hasFallbackRRHosts && endTime.isBefore(twoWeeksFromNow)
            ? this.getStartTime(twoWeeksFromNow.format(), input.timeZone, eventType.minimumBookingNotice)
            : endTime,
        bypassBusyCalendarTimes,
        shouldServeCache,
      });

    let aggregatedAvailability = getAggregatedAvailability(allUsersAvailability, eventType.schedulingType);

    // Fairness and Contact Owner have fallbacks because we check for within 2 weeks
    if (hasFallbackRRHosts) {
      let diff = 0;
      if (startTime.isBefore(twoWeeksFromNow)) {
        //check if first two week have availability
        diff =
          aggregatedAvailability.length > 0
            ? aggregatedAvailability[0].start.diff(twoWeeksFromNow, "day")
            : 1; // no aggregatedAvailability so we diff to +1
      } else {
        // if start time is not within first two weeks, check if there are any available slots
        if (!aggregatedAvailability.length) {
          // if no available slots check if first two weeks are available, otherwise fallback
          const firstTwoWeeksAvailabilities = await this.calculateHostsAndAvailabilities({
            input,
            eventType,
            hosts: [...qualifiedRRHosts, ...fixedHosts],
            loggerWithEventDetails,
            startTime: dayjs(),
            endTime: twoWeeksFromNow,
            bypassBusyCalendarTimes,
            shouldServeCache,
          });
          if (
            !getAggregatedAvailability(
              firstTwoWeeksAvailabilities.allUsersAvailability,
              eventType.schedulingType
            ).length
          ) {
            diff = 1;
          }
        }
      }

      if (input.email) {
        loggerWithEventDetails.info({
          email: input.email,
          contactOwnerEmail,
          qualifiedRRHosts: qualifiedRRHosts.map((host) => host.user.id),
          fallbackRRHosts: allFallbackRRHosts.map((host) => host.user.id),
          fallBackActive: diff > 0,
        });
      }

      if (diff > 0) {
        // if the first available slot is more than 2 weeks from now, round robin as normal
        ({ allUsersAvailability, usersWithCredentials, currentSeats } =
          await this.calculateHostsAndAvailabilities({
            input,
            eventType,
            hosts: [...allFallbackRRHosts, ...fixedHosts],
            loggerWithEventDetails,
            startTime,
            endTime,
            bypassBusyCalendarTimes,
            shouldServeCache,
          }));
        aggregatedAvailability = getAggregatedAvailability(allUsersAvailability, eventType.schedulingType);
      }
    }

    const isTeamEvent =
      eventType.schedulingType === SchedulingType.COLLECTIVE ||
      eventType.schedulingType === SchedulingType.ROUND_ROBIN ||
      allUsersAvailability.length > 1;

    const timeSlots = getSlots({
      inviteeDate: startTime,
      eventLength: input.duration || eventType.length,
      offsetStart: eventType.offsetStart,
      dateRanges: aggregatedAvailability,
      minimumBookingNotice: eventType.minimumBookingNotice,
      frequency: eventType.slotInterval || input.duration || eventType.length,
      datesOutOfOffice: !isTeamEvent ? allUsersAvailability[0]?.datesOutOfOffice : undefined,
    });

    let availableTimeSlots: typeof timeSlots = [];
    const bookerClientUid = ctx?.req?.cookies?.uid;
    // TODO: DI isRestrictionScheduleEnabled
    const isRestrictionScheduleFeatureEnabled = await isRestrictionScheduleEnabled(eventType.team?.id);
    if (eventType.restrictionScheduleId && isRestrictionScheduleFeatureEnabled) {
      const restrictionSchedule = await this.dependencies.scheduleRepo.findScheduleByIdForBuildDateRanges({
        scheduleId: eventType.restrictionScheduleId,
      });
      if (restrictionSchedule) {
        if (!eventType.useBookerTimezone && !restrictionSchedule.timeZone) {
          throw new TRPCError({
            message: "No timezone is set for the restricted schedule",
            code: "BAD_REQUEST",
          });
        }

        const restrictionTimezone = eventType.useBookerTimezone
          ? input.timeZone
          : restrictionSchedule.timeZone!;
        const eventLength = input.duration || eventType.length;

        const restrictionAvailability = restrictionSchedule.availability.map((rule) => ({
          days: rule.days,
          startTime: rule.startTime,
          endTime: rule.endTime,
          date: rule.date,
        }));

        // Include travel schedules if restriction schedule is the user's default schedule
        const isDefaultSchedule = restrictionSchedule.user.defaultScheduleId === restrictionSchedule.id;
        const travelSchedules =
          isDefaultSchedule && !eventType.useBookerTimezone
            ? restrictionSchedule.user.travelSchedules.map((schedule) => ({
                startDate: dayjs(schedule.startDate),
                endDate: schedule.endDate ? dayjs(schedule.endDate) : undefined,
                timeZone: schedule.timeZone,
              }))
            : [];

        const { dateRanges: restrictionRanges } = buildDateRanges({
          availability: restrictionAvailability,
          timeZone: restrictionTimezone || "UTC",
          dateFrom: startTime,
          dateTo: endTime,
          travelSchedules,
        });

        availableTimeSlots = timeSlots.filter((slot) => {
          const slotStart = slot.time;
          const slotEnd = slot.time.add(eventLength, "minute");

          return restrictionRanges.some(
            (range) =>
              (slotStart.isAfter(range.start) || slotStart.isSame(range.start)) &&
              (slotEnd.isBefore(range.end) || slotEnd.isSame(range.end))
          );
        });
      } else {
        availableTimeSlots = timeSlots;
      }
    } else {
      availableTimeSlots = timeSlots;
    }

    const reservedSlots = await this._getReservedSlotsAndCleanupExpired({
      bookerClientUid,
      eventTypeId: eventType.id,
      usersWithCredentials,
    });

    const availabilityCheckProps = {
      eventLength: input.duration || eventType.length,
      currentSeats,
    };

    if (reservedSlots?.length > 0) {
      let occupiedSeats: typeof reservedSlots = reservedSlots.filter(
        (item) => item.isSeat && item.eventTypeId === eventType.id
      );
      if (occupiedSeats?.length) {
        const addedToCurrentSeats: string[] = [];
        if (typeof availabilityCheckProps.currentSeats !== "undefined") {
          availabilityCheckProps.currentSeats = availabilityCheckProps.currentSeats.map((item) => {
            const attendees =
              occupiedSeats.filter(
                (seat) => seat.slotUtcStartDate.toISOString() === item.startTime.toISOString()
              )?.length || 0;
            if (attendees) addedToCurrentSeats.push(item.startTime.toISOString());
            return {
              ...item,
              _count: {
                attendees: item._count.attendees + attendees,
              },
            };
          });
          occupiedSeats = occupiedSeats.filter(
            (item) => !addedToCurrentSeats.includes(item.slotUtcStartDate.toISOString())
          );
        }

        availabilityCheckProps.currentSeats = this.applyOccupiedSeatsToCurrentSeats(
          availabilityCheckProps.currentSeats || [],
          occupiedSeats
        );

        currentSeats = availabilityCheckProps.currentSeats;
      }
      const busySlotsFromReservedSlots = reservedSlots.reduce<EventBusyDate[]>((r, c) => {
        if (!c.isSeat) {
          r.push({ start: c.slotUtcStartDate, end: c.slotUtcEndDate });
        }
        return r;
      }, []);

      availableTimeSlots = availableTimeSlots
        .map((slot) => {
          if (
            !checkForConflicts({
              time: slot.time,
              busy: busySlotsFromReservedSlots,
              ...availabilityCheckProps,
            })
          ) {
            return slot;
          }
          return undefined;
        })
        .filter(
          (
            item:
              | {
                  time: dayjs.Dayjs;
                  userIds?: number[] | undefined;
                }
              | undefined
          ): item is {
            time: dayjs.Dayjs;
            userIds?: number[] | undefined;
          } => {
            return !!item;
          }
        );
    }

    // fr-CA uses YYYY-MM-DD
    const formatter = new Intl.DateTimeFormat("fr-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: input.timeZone,
    });

    function _mapSlotsToDate() {
      const currentSeatsMap = new Map();

      if (currentSeats && currentSeats.length > 0) {
        currentSeats.forEach((booking) => {
          const timeKey = booking.startTime.toISOString();
          currentSeatsMap.set(timeKey, {
            attendees: booking._count.attendees,
            uid: booking.uid,
          });
        });
      }

      return availableTimeSlots.reduce(
        (
          r: Record<string, { time: string; attendees?: number; bookingUid?: string }[]>,
          { time, ...passThroughProps }
        ) => {
          // This used to be _time.tz(input.timeZone) but Dayjs tz() is slow.
          // toLocaleDateString slugish, using Intl.DateTimeFormat we get the desired speed results.
          const dateString = formatter.format(time.toDate());
          const timeISO = time.toISOString();

          r[dateString] = r[dateString] || [];
          if (eventType?.onlyShowFirstAvailableSlot && r[dateString].length > 0) {
            return r;
          }

          const existingBooking = currentSeatsMap.get(timeISO);

          r[dateString].push({
            ...passThroughProps,
            time: timeISO,
            ...(existingBooking && {
              attendees: existingBooking.attendees,
              bookingUid: existingBooking.uid,
            }),
          });
          return r;
        },
        Object.create(null)
      );
    }
    const mapSlotsToDate = withReporting(_mapSlotsToDate.bind(this), "mapSlotsToDate");
    const slotsMappedToDate = mapSlotsToDate();

    const availableDates = Object.keys(slotsMappedToDate);
    const allDatesWithBookabilityStatus = this.getAllDatesWithBookabilityStatus(availableDates);

    // timeZone isn't directly set on eventType now(So, it is legacy)
    // schedule is always expected to be set for an eventType now so it must never fallback to allUsersAvailability[0].timeZone(fallback is again legacy behavior)
    // TODO: Also, handleNewBooking only seems to be using eventType?.schedule?.timeZone which seems to confirm that we should simplify it as well.
    const eventTimeZone =
      eventType.timeZone || eventType?.schedule?.timeZone || allUsersAvailability?.[0]?.timeZone;

    const eventUtcOffset = getUTCOffsetByTimezone(eventTimeZone) ?? 0;
    const bookerUtcOffset = input.timeZone ? getUTCOffsetByTimezone(input.timeZone) ?? 0 : 0;
    const periodLimits = calculatePeriodLimits({
      periodType: eventType.periodType,
      periodDays: eventType.periodDays,
      periodCountCalendarDays: eventType.periodCountCalendarDays,
      periodStartDate: eventType.periodStartDate,
      periodEndDate: eventType.periodEndDate,
      allDatesWithBookabilityStatusInBookerTz: allDatesWithBookabilityStatus,
      eventUtcOffset,
      bookerUtcOffset,
    });

    const _mapWithinBoundsSlotsToDate = () => {
      let foundAFutureLimitViolation = false;
      // This should never happen. Just for type safety, we already check in the upper scope
      if (!eventType) throw new TRPCError({ code: "NOT_FOUND" });

      const withinBoundsSlotsMappedToDate = {} as typeof slotsMappedToDate;
      const doesStartFromToday = this.doesRangeStartFromToday(eventType.periodType);

      for (const [date, slots] of Object.entries(slotsMappedToDate)) {
        if (foundAFutureLimitViolation && doesStartFromToday) {
          break; // Instead of continuing the loop, we can break since all future dates will be skipped
        }

        const filteredSlots = slots.filter((slot) => {
          const isFutureLimitViolationForTheSlot = isTimeViolatingFutureLimit({
            time: slot.time,
            periodLimits,
          });

          let isOutOfBounds = false;
          try {
            isOutOfBounds = isTimeOutOfBounds({
              time: slot.time,
              minimumBookingNotice: eventType.minimumBookingNotice,
            });
          } catch (error) {
            if (error instanceof BookingDateInPastError) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: error.message,
              });
            }
            throw error;
          }

          if (isFutureLimitViolationForTheSlot) {
            foundAFutureLimitViolation = true;
          }

          return (
            !isFutureLimitViolationForTheSlot &&
            // TODO: Perf Optimization: Slots calculation logic already seems to consider the minimum booking notice and past booking time and thus there shouldn't be need to filter out slots here.
            !isOutOfBounds
          );
        });

        if (filteredSlots.length) {
          withinBoundsSlotsMappedToDate[date] = filteredSlots;
        }
      }

      return withinBoundsSlotsMappedToDate;
    };
    const mapWithinBoundsSlotsToDate = withReporting(
      _mapWithinBoundsSlotsToDate.bind(this),
      "mapWithinBoundsSlotsToDate"
    );
    const withinBoundsSlotsMappedToDate = mapWithinBoundsSlotsToDate();

    // We only want to run this on single targeted events and not dynamic
    if (!Object.keys(withinBoundsSlotsMappedToDate).length && input.usernameList?.length === 1) {
      try {
        // TODO: DI handleNotificationWhenNoSlots
        await handleNotificationWhenNoSlots({
          eventDetails: {
            username: input.usernameList?.[0],
            startTime: startTime,
            endTime: endTime,
            eventSlug: eventType.slug,
          },
          orgDetails,
          teamId: eventType.team?.id,
        });
      } catch (e) {
        loggerWithEventDetails.error(
          `Something has gone wrong. Upstash could be down and we have caught the error to not block availability:
 ${e}`
        );
      }
    }

    const troubleshooterData = enableTroubleshooter
      ? {
          troubleshooter: {
            routedTeamMemberIds: routedTeamMemberIds,
            // One that Salesforce asked for
            askedContactOwner: contactOwnerEmailFromInput,
            // One that we used as per Routing skipContactOwner flag
            consideredContactOwner: contactOwnerEmail,
            // All hosts that have been checked for availability. If no routedTeamMemberIds are provided, this will be same as hosts.
            routedHosts: usersWithCredentials.map((user) => {
              return {
                userId: user.id,
              };
            }),
            hostsAfterSegmentMatching: allHosts.map((host) => ({
              userId: host.user.id,
            })),
          },
        }
      : null;

    return {
      slots: withinBoundsSlotsMappedToDate,
      ...troubleshooterData,
    };
  }
}
