import 'dotenv/config';
import {
    AppointmentPayload,
    AppointmentResponse,
    AVAILABILITY_STATUSES,
    AvailabilityPayload,
    AvailabilityResponse,
} from './types';
import axios, {AxiosError, AxiosResponse, isAxiosError} from 'axios';
import {appointmentData, data, headers, serviceId, staffIds} from './test.data';
import promptSync from 'prompt-sync';
import {DateTime} from 'luxon';

const prompt = promptSync();
const BOOKING_REMOTE_URL = process.env.BOOKING_REMOTE_URL || '';

export async function main() {
    const dateInput = prompt('Enter date (YYYY-MM-DD): ').trim();
    const startDate = DateTime.fromFormat(dateInput, 'yyyy-MM-dd');

    if (!startDate.isValid) {
        console.error(`Invalid date: ${startDate.invalidExplanation}`);
        process.exit(1);
    }

    const endDate = startDate.endOf('day');

    const payload = {
        ...data,
        startDateTime: {
            ...data.startDateTime,
            dateTime: startDate.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        },
        endDateTime: {...data.endDateTime, dateTime: endDate.toFormat("yyyy-MM-dd'T'HH:mm:ss")},
    };

    console.log(
        `Fetching staff availability from ${startDate.toISODate()} to ${endDate.toISODate()}`,
    );

    try {
        const {
            data: {staffAvailabilityResponse},
        } = await axios.post<
            AvailabilityResponse,
            AxiosResponse<AvailabilityResponse>,
            AvailabilityPayload
        >(`${BOOKING_REMOTE_URL}/GetStaffAvailability`, payload, {headers});

        const availableItems = staffAvailabilityResponse
            .flatMap(({availabilityItems}) => availabilityItems)
            .filter(({status}) => status === AVAILABILITY_STATUSES.AVAILABLE);

        const slots = availableItems.flatMap((item) => {
            const end = DateTime.fromISO(item.endDateTime.dateTime);
            const hourSlots: DateTime[] = [];
            let current = DateTime.fromISO(item.startDateTime.dateTime);
            while (current < end) {
                hourSlots.push(current);
                current = current.plus({hours: 1});
            }
            return hourSlots;
        });

        console.log(
            `Found ${slots.length} available slot(s) for ${startDate.toFormat('dd MMM yyyy')}:\n`,
        );

        const sortedItems = slots.sort((a, b) => a.toMillis() - b.toMillis());

        sortedItems.forEach((slot, index) => {
            console.log(`(${index + 1}) - ${slot.toFormat('HH:mm')}`);
        });

        const slotInput = prompt(`Select slot (number 1-${slots.length}): `).trim();
        const selectedSlot = sortedItems[Number(slotInput) - 1];

        console.log(`Selected slot: ${selectedSlot}`);

        const staffIdIndex = selectedSlot.minute === 30 ? 1 : 2;
        const staffId = staffIds[staffIdIndex]

        const slotEnd = selectedSlot.plus({minutes: 50});
        const timeZone = data.startDateTime.timeZone;

        const appointmentPayload = {
            appointment: {
                ...appointmentData,
                serviceId,
                startTime: {
                    dateTime: selectedSlot.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
                    timeZone,
                },
                endTime: {
                    dateTime: slotEnd.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
                    timeZone,
                },
                staffMemberIds: [staffId],
            },
        };

        const {
            data: {appointment},
        } = await axios.post<
            AppointmentResponse,
            AxiosResponse<AppointmentResponse>,
            AppointmentPayload
        >(`${BOOKING_REMOTE_URL}/appointments`, appointmentPayload, {headers});

        const bookedStart = DateTime.fromISO(appointment.startTime.dateTime).toFormat(
            'dd MMM yyyy, HH:mm',
        );
        const bookedEnd = DateTime.fromISO(appointment.endTime.dateTime).toFormat('HH:mm');
        console.log(`\n✅ Booking confirmed!`);
        console.log(`   ID:    ${appointment.id}`);
        console.log(`   Time:  ${bookedStart} – ${bookedEnd}`);
        console.log(`   Court: ${appointment.serviceName} ${staffIdIndex}`);
        process.exit(0);
    } catch (error) {
        if (isAxiosError(error)) {
            const axiosError = error as AxiosError;
            console.error('HTTP error fetching availability', {
                message: axiosError.message,
                status: axiosError.response?.status,
                statusText: axiosError.response?.statusText,
                data: axiosError.response?.data,
            });
        } else {
            console.error('Unexpected error fetching availability', error);
        }
        throw error;
    }
}

main().catch((error) => {
    process.exit(1);
});
