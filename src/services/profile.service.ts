import {AppointmentCustomer, UserProfile} from '../types';
import {BOOKINGS_CONFIG} from '../config/bookings.config';

/**
 * Converts a stored UserProfile into an AppointmentCustomer
 * ready to be sent to the Bookings API.
 */
export function profileToCustomer(profile: UserProfile): AppointmentCustomer {
    return {
        name: profile.name,
        emailAddress: profile.emailAddress,
        phone: profile.phone,
        notes: '-',
        timeZone: profile.timeZone,
        answeredCustomQuestions: [
            {
                customQuestion: {
                    id: BOOKINGS_CONFIG.questions.membershipNumber.id,
                    questionText: BOOKINGS_CONFIG.questions.membershipNumber.questionText,
                    answerOptions: [],
                    answerInputType: 'ANSWER_INPUT_TYPE_TEXT',
                },
                answer: profile.membershipNumber,
                isRequired: true,
                selectedOptions: [],
            },
            {
                customQuestion: {
                    id: BOOKINGS_CONFIG.questions.opponentName.id,
                    questionText: BOOKINGS_CONFIG.questions.opponentName.questionText,
                    answerOptions: [],
                    answerInputType: 'ANSWER_INPUT_TYPE_TEXT',
                },
                answer: '-',
                isRequired: true,
                selectedOptions: [],
            },
        ],
        location: profile.location,
        smsNotificationsEnabled: false,
        instanceId: '',
        price: 0,
        priceType: 'SERVICEDEFAULTPRICETYPES_FREE',
    };
}