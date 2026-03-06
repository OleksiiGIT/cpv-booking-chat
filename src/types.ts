export const AVAILABILITY_STATUSES = {
    AVAILABLE: 'BOOKINGSAVAILABILITYSTATUS_AVAILABLE',
    NOT_AVAILABLE: 'BOOKINGSAVAILABILITYSTATUS_OUT_OF_OFFICE',
    BUSY: 'BOOKINGSAVAILABILITYSTATUS_BUSY',
} as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[keyof typeof AVAILABILITY_STATUSES];

type DataTime = {
    dateTime: string;
    timeZone: string;
};

export type AvailabilityPayload = {
    serviceId: string;
    staffIds: Array<string>;
    startDateTime: DataTime;
    endDateTime: DataTime;
};

type AvailabilityItem = {
    status: AvailabilityStatus;
    startDateTime: DataTime;
    endDateTime: DataTime;
    serviceId: string;
};

export type AvailabilityResponse = {
    staffAvailabilityResponse: Array<{
        staffId: string;
        availabilityItems: Array<AvailabilityItem>;
    }>;
};

type CustomQuestion = {
    id: string;
    questionText: string;
    answerOptions: Array<string>;
    answerInputType: string;
};

type AnsweredCustomQuestion = {
    customQuestion: CustomQuestion;
    answer: string;
    isRequired: boolean;
    selectedOptions: Array<string>;
};

export type CustomerLocation = {
    displayName: string;
    address: {
        street: string;
        type: string;
    };
};

export type AppointmentCustomer = {
    name: string;
    emailAddress: string;
    phone: string;
    notes: string;
    timeZone: string;
    answeredCustomQuestions: Array<AnsweredCustomQuestion>;
    location: CustomerLocation;
    smsNotificationsEnabled: boolean;
    instanceId: string;
    price: number;
    priceType: string;
};

export type AppointmentPayload = {
    appointment: {
        startTime: DataTime;
        endTime: DataTime;
        serviceId: string;
        staffMemberIds: Array<string>;
        customers: Array<AppointmentCustomer>;
        isLocationOnline: boolean;
        smsNotificationsEnabled: boolean;
        verificationCode: string;
        customerTimeZone: string;
        trackingDataId: string;
        bookingFormInfoList: Array<unknown>;
        price: number;
        priceType: string;
        isAllDay: boolean;
        additionalRecipients: Array<string>;
    };
};

type LocationAddress = {
    postOfficeBox: string;
    postalCode: string;
    countryOrRegion: string;
    state: string;
    city: string;
    street: string;
    type: string;
    name: string;
    locationSource: string;
};

type LocationCoordinates = {
    accuracy: number;
    altitude: number;
    altitudeAccuracy: number;
    latitude: number;
    longitude: number;
};

type BookingLocation = {
    address: LocationAddress;
    coordinates: LocationCoordinates;
    displayName: string;
    locationEmailAddress: string;
    locationType: string;
    locationUri: string;
};

type ResponseCustomer = {
    id: string;
    name: string;
    emailAddress: string;
    phone: string;
    location: BookingLocation;
    notes: string;
    timeZone: string;
    answeredCustomQuestions: Array<AnsweredCustomQuestion>;
    smsNotificationsEnabled: boolean;
    instanceId: string;
    price: number;
    priceType: string;
};

type AppointmentReminder = {
    message: string;
    offset: string;
    bookingsReminderRecipients: string;
};

type BookingAppointmentStatus = {
    state: string;
    stateModifiedBy: string;
};

type AppointmentBody = {
    contentType: string;
    content: string;
    contentTruncated: boolean;
};

export type AppointmentResponse = {
    appointment: {
        id: string;
        startTime: DataTime;
        endTime: DataTime;
        customers: Array<ResponseCustomer>;
        staffMemberIds: Array<string>;
        serviceId: string;
        serviceName: string;
        serviceNotes: string;
        isLocationOnline: boolean;
        joinWebUrl: string;
        preBuffer: string;
        postBuffer: string;
        price: number;
        priceType: string;
        maximumAttendeesCount: number;
        filledAttendeesCount: number;
        optOutOfCustomerEmail: boolean;
        smsNotificationsEnabled: boolean;
        duration: string;
        serviceLocation: BookingLocation;
        selfServiceAppointmentId: string;
        reminders: Array<AppointmentReminder>;
        customerTimeZone: string;
        bookingAppointmentStatus: BookingAppointmentStatus;
        verificationCode: string;
        bookingFormInfoList: Array<unknown>;
        bookingMultiStaffSupportEnabled: boolean;
        additionalInformation: string;
        isSelfServiceEnabled: boolean;
        body: AppointmentBody;
        meetingDuration: string;
        joinedStaffMemberIds: Array<string>;
        bookingAppointmentType: string;
        onlineMeetingCustomRoutingUrl: string;
        isWebrtcOnlineMeetingEnabled: boolean;
        additionalRecipients: Array<string>;
        sendMeetingInviteToCustomer: boolean;
        trackingDataId: string;
        createTime: string;
        updateTime: string;
        appointmentLabel: string;
        isAllDay: boolean;
        canOverrideOtpValidation: boolean;
    };
};

export type UserProfile = {
    name: string;
    emailAddress: string;
    phone: string;
    membershipNumber: string;
    timeZone: string;
    location: CustomerLocation;
};

export type WatchlistEntry = {
    wantedDate: string;
    wantedTime: string;
    addedAt: string;
    status: 'pending' | 'booked' | 'missed' | 'cancelled';
};

export type BookingRecord = {
    /** Microsoft Bookings appointment ID */
    appointmentId: string;
    startTime: string; // ISO datetime
    endTime: string; // ISO datetime
    court: string; // 'Court 1' | 'Court 2' | 'Court'
    createdAt: string; // ISO datetime
};

export type ConversationStep =
    | 'onboarding_name'
    | 'onboarding_email'
    | 'onboarding_phone'
    | 'onboarding_membership'
    | 'onboarding_address'
    | 'awaiting_date'
    | 'awaiting_slot'
    | 'awaiting_watchlist_time'
    | 'confirming'
    | 'done';

export type ConversationSession = {
    step: ConversationStep;
    /** Onboarding accumulator — cleared once the profile is saved */
    onboardingName?: string;
    onboardingEmail?: string;
    onboardingPhone?: string;
    onboardingMembership?: string;
    /** Booking flow */
    selectedDate?: string; // 'yyyy-MM-dd'
    availableSlots?: string[]; // ISO datetime strings fetched for selectedDate
    selectedSlot?: string; // ISO datetime string chosen by the user
};
