import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppointmentCustomer, UserProfile } from '../types';
import { BOOKINGS_CONFIG } from '../config/bookings.config';

const BASE_DIR = path.join(os.homedir(), '.cpv-booking', 'profiles');

function profilePath(userId: string): string {
    return path.join(BASE_DIR, `${userId}.json`);
}

export function loadProfile(userId: string): UserProfile | null {
    const filePath = profilePath(userId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as UserProfile;
}

export function saveProfile(userId: string, profile: UserProfile): void {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(profilePath(userId), JSON.stringify(profile, null, 2), 'utf-8');
}

export function deleteProfile(userId: string): void {
    const filePath = profilePath(userId);
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
}

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
