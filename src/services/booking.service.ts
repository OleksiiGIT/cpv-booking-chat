import 'dotenv/config';
import axios, { AxiosResponse } from 'axios';
import { DateTime } from 'luxon';
import {
    AppointmentCustomer,
    AppointmentPayload,
    AppointmentResponse,
    AVAILABILITY_STATUSES,
    AvailabilityPayload,
    AvailabilityResponse,
    InstantBookingResult,
} from '../types';
import { BOOKINGS_CONFIG } from '../config/bookings.config';

const BOOKING_REMOTE_URL = process.env.BOOKING_REMOTE_URL || '';

const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Cookie: process.env.BOOKING_COOKIE || '',
    'x-owa-canary': process.env.X_OWA_CANARY || '',
    'x-anchormailbox': BOOKINGS_CONFIG.anchormailbox,
    'x-req-source': 'BookingsC2',
    'x-owa-hosted-ux': 'false',
    prefer: 'exchange.behavior="IncludeThirdPartyOnlineMeetingProviders"',
    origin: 'https://outlook.office365.com',
};

/**
 * Returns all available 1-hour slots for the given date, sorted chronologically.
 */
export async function getAvailableSlots(date: DateTime): Promise<DateTime[]> {
    const payload: AvailabilityPayload = {
        serviceId: BOOKINGS_CONFIG.serviceId,
        staffIds: [...BOOKINGS_CONFIG.allStaffIds],
        startDateTime: {
            dateTime: date.startOf('day').toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            timeZone: BOOKINGS_CONFIG.timeZone,
        },
        endDateTime: {
            dateTime: date.endOf('day').toFormat("yyyy-MM-dd'T'HH:mm:ss"),
            timeZone: BOOKINGS_CONFIG.timeZone,
        },
    };

    const {
        data: { staffAvailabilityResponse },
    } = await axios.post<
        AvailabilityResponse,
        AxiosResponse<AvailabilityResponse>,
        AvailabilityPayload
    >(`${BOOKING_REMOTE_URL}/GetStaffAvailability`, payload, { headers });

    const availableItems = staffAvailabilityResponse
        .flatMap(({ availabilityItems }) => availabilityItems)
        .filter(({ status }) => status === AVAILABILITY_STATUSES.AVAILABLE);

    const slots = availableItems.flatMap((item) => {
        const end = DateTime.fromISO(item.endDateTime.dateTime);
        const hourSlots: DateTime[] = [];
        let current = DateTime.fromISO(item.startDateTime.dateTime);
        while (current < end) {
            hourSlots.push(current);
            current = current.plus({ hours: 1 });
        }
        return hourSlots;
    });

    return slots.sort((a, b) => a.toMillis() - b.toMillis());
}

/**
 * Books a 50-minute appointment at the given slot for the given customer.
 * Returns the created appointment from the API response.
 */
export async function createAppointment(
    slot: DateTime,
    customer: AppointmentCustomer,
): Promise<{ appointment: AppointmentResponse['appointment']; staffIndex: number }> {
    const staffIndex = BOOKINGS_CONFIG.staffIndexByMinute[slot.minute] ?? 2;
    const staffId = BOOKINGS_CONFIG.allStaffIds[staffIndex];
    const slotEnd = slot.plus({ minutes: BOOKINGS_CONFIG.appointmentDurationMinutes });

    const payload: AppointmentPayload = {
        appointment: {
            serviceId: BOOKINGS_CONFIG.serviceId,
            staffMemberIds: [staffId],
            customers: [customer],
            startTime: {
                dateTime: slot.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
                timeZone: BOOKINGS_CONFIG.timeZone,
            },
            endTime: {
                dateTime: slotEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
                timeZone: BOOKINGS_CONFIG.timeZone,
            },
            isLocationOnline: false,
            smsNotificationsEnabled: false,
            verificationCode: '',
            customerTimeZone: BOOKINGS_CONFIG.timeZone,
            trackingDataId: '',
            bookingFormInfoList: [],
            price: 0,
            priceType: 'SERVICEDEFAULTPRICETYPES_FREE',
            isAllDay: false,
            additionalRecipients: [],
        },
    };

    const {
        data: { appointment },
    } = await axios.post<
        AppointmentResponse,
        AxiosResponse<AppointmentResponse>,
        AppointmentPayload
    >(`${BOOKING_REMOTE_URL}/appointments`, payload, { headers });

    return {
        appointment,
        staffIndex,
    };
}

/**
 * Books every requested time slot on `date` in a single call.
 *
 * - `date`  — ISO calendar string "YYYY-MM-DD" (as returned by `parseInstantBookingInput`)
 * - `times` — array of "HH:mm" strings to book (order is preserved in the result)
 *
 * Strategy:
 *   1. Call `getAvailableSlots` once and cache the result.
 *      If the availability fetch itself fails every slot is returned as `'failed'`.
 *   2. For each requested time:
 *      - Not in available slots  → `{ status: 'unavailable' }`
 *      - `createAppointment` succeeds → `{ status: 'booked', appointmentId }`
 *      - `createAppointment` throws  → `{ status: 'failed', error }`
 *   A failure on one slot never prevents the remaining slots from being attempted.
 */
export async function instantBook(
    date: string,
    times: string[],
    customer: AppointmentCustomer,
): Promise<InstantBookingResult[]> {
    const dateTime = DateTime.fromISO(date);

    // ── Fetch availability once ───────────────────────────────────────────────
    let availableSlots: DateTime[];
    try {
        availableSlots = await getAvailableSlots(dateTime);
    } catch (err) {
        const error = err instanceof Error ? err.message : 'Failed to fetch available slots';
        return times.map((time) => ({ time, status: 'failed', error }));
    }

    // Build an O(1) lookup: "HH:mm" → DateTime
    const slotByTime = new Map<string, DateTime>(
        availableSlots.map((slot) => [slot.toFormat('HH:mm'), slot]),
    );

    // ── Attempt each requested time independently ─────────────────────────────
    const results: InstantBookingResult[] = [];

    for (const time of times) {
        const slot = slotByTime.get(time);

        if (!slot) {
            results.push({ time, status: 'unavailable' });
            continue;
        }

        try {
            const { appointment } = await createAppointment(slot, customer);
            results.push({ time, status: 'booked', appointmentId: appointment.id });
        } catch (err) {
            const error = err instanceof Error ? err.message : 'Failed to create appointment';
            results.push({ time, status: 'failed', error });
        }
    }

    return results;
}
