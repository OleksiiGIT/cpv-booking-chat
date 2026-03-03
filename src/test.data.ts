export const staffIds = [
    'e1e81ca5-27fd-463e-8cbd-5d30c6ac7f0f', // both
    '9b1498a2-fbd6-4860-a292-a5e0efc62ec9', // court 1
    '5438b526-579d-4bcd-a548-abd48962ad02', // court 2
];

export const serviceId = 'cbacaf6f-370f-47c5-a11b-4bffc77642e1'; // squash

export const data = {
    serviceId,
    staffIds,
    startDateTime: {
        dateTime: '2026-03-02T00:00:00',
        timeZone: 'GMT Standard Time',
    },
    endDateTime: {
        dateTime: '2026-04-02T00:00:00',
        timeZone: 'GMT Standard Time',
    },
};

export const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Cookie: process.env.BOOKING_COOKIE || '',
    'x-owa-canary': process.env.X_OWA_CANARY || '',
    'x-anchormailbox': 'CaversamParkVillageAssociationMilestoneCentre@cpva.org.uk',
    'x-req-source': 'BookingsC2',
    'x-owa-hosted-ux': 'false',
    prefer: 'exchange.behavior="IncludeThirdPartyOnlineMeetingProviders"',
    origin: 'https://outlook.office365.com',
};

export const customerData = {
    name: 'Oleksii Matiunin',
    emailAddress: 'matalexnin@gmail.com',
    phone: '07423624107',
    notes: '-',
    timeZone: 'GMT Standard Time',
    answeredCustomQuestions: [
        {
            customQuestion: {
                id: 'bf678af9-3b12-43c3-a5e9-9552b546d75f',
                questionText: 'Membership Number',
                answerOptions: [],
                answerInputType: 'ANSWER_INPUT_TYPE_TEXT',
            },
            answer: '6080',
            isRequired: true,
            selectedOptions: [],
        },
        {
            customQuestion: {
                id: 'e6ca3919-567c-488c-93dd-b88e97415008',
                questionText: "Opponent's Name",
                answerOptions: [],
                answerInputType: 'ANSWER_INPUT_TYPE_TEXT',
            },
            answer: '-',
            isRequired: true,
            selectedOptions: [],
        },
    ],
    location: {
        displayName: '78 Curzon street',
        address: {
            street: '78 Curzon street',
            type: 'Other',
        },
    },
    smsNotificationsEnabled: false,
    instanceId: '',
    price: 0,
    priceType: 'SERVICEDEFAULTPRICETYPES_FREE',
};

export const appointmentData = {
    customers: [customerData],
    isLocationOnline: false,
    smsNotificationsEnabled: false,
    verificationCode: '',
    customerTimeZone: 'GMT Standard Time',
    trackingDataId: '',
    bookingFormInfoList: [],
    price: 0,
    priceType: 'SERVICEDEFAULTPRICETYPES_FREE',
    isAllDay: false,
    additionalRecipients: [],
};
