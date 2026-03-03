export const BOOKINGS_CONFIG = {
    serviceId: 'cbacaf6f-370f-47c5-a11b-4bffc77642e1',

    staffIds: {
        both: 'e1e81ca5-27fd-463e-8cbd-5d30c6ac7f0f',
        court1: '9b1498a2-fbd6-4860-a292-a5e0efc62ec9',
        court2: '5438b526-579d-4bcd-a548-abd48962ad02',
    },

    /** All staff IDs sent when querying availability */
    allStaffIds: [
        'e1e81ca5-27fd-463e-8cbd-5d30c6ac7f0f',
        '9b1498a2-fbd6-4860-a292-a5e0efc62ec9',
        '5438b526-579d-4bcd-a548-abd48962ad02',
    ],

    /**
     * Court assignment by slot start minute:
     *   :30 → staffIds index 1 (court 1)
     *   :00 → staffIds index 2 (court 2)
     */
    staffIndexByMinute: {
        30: 1,
        0: 2,
    } as Record<number, number>,

    timeZone: 'GMT Standard Time',
    appointmentDurationMinutes: 50,

    /** Microsoft Bookings maximum advance booking window */
    maxAdvanceDays: 14,

    anchormailbox: 'CaversamParkVillageAssociationMilestoneCentre@cpva.org.uk',

    /** Custom question IDs defined on the Bookings service */
    questions: {
        membershipNumber: {
            id: 'bf678af9-3b12-43c3-a5e9-9552b546d75f',
            questionText: 'Membership Number',
        },
        opponentName: {
            id: 'e6ca3919-567c-488c-93dd-b88e97415008',
            questionText: "Opponent's Name",
        },
    },
} as const;
