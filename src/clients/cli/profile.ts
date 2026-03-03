import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import promptSync from 'prompt-sync';
import { AppointmentCustomer, UserProfile } from '../../types';
import { BOOKINGS_CONFIG } from '../../config/bookings.config';

const prompt = promptSync();

const PROFILE_DIR = path.join(os.homedir(), '.cpv-booking');
const PROFILE_PATH = path.join(PROFILE_DIR, 'profile.json');

export function loadProfile(): UserProfile | null {
    if (!fs.existsSync(PROFILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) as UserProfile;
}

export function saveProfile(profile: UserProfile): void {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

export function runOnboarding(): UserProfile {
    console.log('\n👋 Welcome! Please set up your profile first.\n');

    const name = prompt('Full name: ').trim();
    const emailAddress = prompt('Email address: ').trim();
    const phone = prompt('Phone number: ').trim();
    const membershipNumber = prompt('Membership number: ').trim();
    const street = prompt('Address (street): ').trim();

    const profile: UserProfile = {
        name,
        emailAddress,
        phone,
        membershipNumber,
        timeZone: BOOKINGS_CONFIG.timeZone,
        location: {
            displayName: street,
            address: { street, type: 'Other' },
        },
    };

    saveProfile(profile);
    console.log('\n✅ Profile saved!\n');
    return profile;
}

export function getOrCreateProfile(): UserProfile {
    return loadProfile() ?? runOnboarding();
}

/**
 * Converts a stored user profile into an AppointmentCustomer
 * ready to send to the Bookings API.
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
