import express from 'express';
import readline from 'readline';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import { google } from 'googleapis';
import axios from 'axios';
import ICAL from 'ical.js'; // Add this for ICS parsing
dotenv.config();

const app = express();
app.use(express.json());
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CREDENTIALS = JSON.parse(fs.readFileSync('credentials.json'));
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
];

const TOKEN_PATH = 'token.json';

// ---------- OAuth2 Auth ----------
function authorize(credentials, callback) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
        oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
        callback(oAuth2Client);
    } else {
        getNewToken(oAuth2Client, callback);
    }
}

function getNewToken(oAuth2Client, callback) {
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    console.log('Authorize this app by visiting this URL:', authUrl);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Enter the code from that page here: ', (code) => {
        rl.close();
        oAuth2Client.getToken(code).then(({ tokens }) => {
            oAuth2Client.setCredentials(tokens);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
            callback(oAuth2Client);
        }).catch(err => console.error('Error retrieving access token', err));
    });
}

// ---------- Parse ICS File ----------
function parseIcsFile(icsContent) {
    try {
        const jcalData = ICAL.parse(icsContent);
        const comp = new ICAL.Component(jcalData);
        const vevent = comp.getFirstSubcomponent('vevent');
        if (!vevent) return { isMeeting: false };

        const event = new ICAL.Event(vevent);
        return {
            isMeeting: true, // Explicitly indicate a valid meeting
            summary: event.summary || 'Meeting',
            description: event.description || '',
            location: event.location || 'Unknown',
            start: event.startDate.toJSDate().toISOString(),
            end: event.endDate.toJSDate().toISOString(),
            timeZone: event.startDate.timezone || 'UTC',
            attendees: vevent.getAllProperties('attendee').map(att => {
                const email = att.getFirstValue().replace('mailto:', '');
                return { email };
            }),
        };
    } catch (err) {
        console.error('Error parsing ICS file:', err.message);
        return { isMeeting: false };
    }
}
// ---------- Email Check Job ----------
async function listRecentUnreadEmails(auth) {
    const gmail = google.gmail({ version: 'v1', auth });

    // Get time 2 minutes ago in RFC 3339 format
    const afterTimestamp = Math.floor((Date.now() - 2 * 60 * 1000) / 1000); // UNIX timestamp

    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: `is:unread after:${afterTimestamp}`,
        });

        const messages = res.data.messages || [];
        console.log(`Unread emails in last 2 minutes: ${messages.length}`);

        for (const msg of messages) {
            const mail = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full', });

            const headers = mail.data.payload?.headers || [];
            const subject = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
            const snippet = mail.data.snippet;
            const from = mail.from?.toLowerCase() || '';

            // Extract email body and attachments
            let emailBody = '';
            let icsAttachment = null;
            // Function to recursively extract parts
            function extractParts(parts) {
                let body = '';
                let ics = null;

                for (const part of parts) {
                    if (part.mimeType === 'multipart/alternative' && part.parts) {
                        for (const subpart of part.parts) {
                            if (subpart.mimeType === 'text/plain' || subpart.mimeType === 'text/html') {
                                body = Buffer.from(subpart.body.data || '', 'base64').toString('utf-8');
                            }
                        }
                    }

                    if (part.mimeType === 'application/ics' || part.mimeType === 'text/calendar') {
                        ics = part;
                    }
                }

                return { body, ics };
            }

            if (mail.data.payload.parts) {
                const { body, ics } = extractParts(mail.data.payload.parts);
                emailBody = body;

                if (ics) {
                    const attachmentData = await gmail.users.messages.attachments.get({
                        userId: 'me',
                        messageId: msg.id,
                        id: ics.body.attachmentId,
                    });
                    icsAttachment = Buffer.from(attachmentData.data.data, 'base64').toString('utf-8');
                }
            } else if (mail.data.payload.body?.data) {
                emailBody = Buffer.from(mail.data.payload.body.data, 'base64').toString('utf-8');
            }


            // if (icsAttachment) console.log('ICS Attachment:', icsAttachment);

            // Optional: call OpenAI classifier
            await classifyEmail(subject, snippet, auth, msg, icsAttachment, emailBody);
        }
    } catch (error) {
        console.error('Error fetching unread emails:', error.message);
    }
}
// ---------- Email Classification ----------
async function classifyEmail(subject, snippet, auth, msg, icsAttachment, emailBody) {
    try {
        const userMessage = `Subject: ${subject}\n\nBody: ${snippet}`;
        const response = await openai.chat.completions.create({
            model: "gpt-4.1-nano",
            messages: [
                {
                    role: "system",
                    content: `
      You are a smart email classifier for a productivity assistant. Classify emails into one of the following categories based on their content, sender, and context. Return only one word: urgent, meeting, job_application, job_interview, work, ad, fraud, or personal.
      
      **Categories and Guidelines**:
      - **urgent**: Emails requiring immediate action, such as emergencies or critical issues. Keywords: "urgent," "immediate," "ASAP," "critical," "overdue." Example: "Server outage, fix now."
      - **meeting**: Calendar invites, meeting schedules, or follow-ups, excluding job interviews. Keywords: "meeting," "invite," "schedule," "Zoom," "call," "agenda," excluding "interview." Example: "Team sync at 3 PM tomorrow."
      - **job_application**: Job application confirmations or submissions from platforms like LinkedIn, eJobs, Indeed. Keywords: "application," "applied," "submitted," "job posting." Sender domains: linkedin.com, ejobs.ro, indeed.com. Example: "Your application was sent to Neurones IT Asia."
      - **job_interview**: Interview invites or recruitment follow-ups. Keywords: "interview," "hiring," "recruiter," "schedule" with job context. Sender domains: linkedin.com, ejobs.ro, indeed.com, or recruiter emails. Example: "Schedule your interview with TrustedTrucks."
      - **work**: Work-related emails like project updates, client communications, or team tasks, excluding job applications/interviews. Keywords: "project," "client," "team," "task," "deadline." Example: "Q3 project milestone update."
      - **ad**: Promotions, marketing, or newsletters. Keywords: "sale," "offer," "subscribe," "discount," "promotion." Example: "50% off Black Friday sale."
      - **fraud**: Scams, phishing, or suspicious emails. Keywords: "verify account," "password reset," "win," "prize," "bank details." Example: "Click to verify your bank account."
      - **personal**: Informal emails from friends, family, or known contacts. Keywords: "hi," "hello," "dinner," "plans," personal names in sender. Example: "Dinner this weekend?"
      - **social**: Notifications from social platforms like LinkedIn, Instagram, Facebook, Twitter, YouTube (e.g., "you have a new follower").
      - **system**: Automated system alerts like password resets, login codes, security notifications (e.g., "Your OTP is 123456", "New device login").
      
                `.trim()
                },
                { role: "user", content: userMessage }
            ]
        });
        const classification = response.choices[0].message.content.trim().toLowerCase();
        console.log(`Classified as: ${classification}\n`);


        if (classification === 'urgent') { // needs attention, so send WhatsApp
            const response = await openai.chat.completions.create({
                model: 'gpt-4.1-nano',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a smart reminder. Modify this email to make it more suitable and attention-grabbing for WhatsApp.',
                    },
                    {
                        role: 'user',
                        content: `Subject: ${subject}\n\nBody: ${snippet}`
                    }
                ]
            });
            const whatsappMessage = response.choices[0].message.content;
            const encodedMessage = encodeURIComponent(whatsappMessage);
            await sendWhatsApp(process.env.MY_WHATSAPP_NUMBER, encodedMessage);
        } else if (classification === 'meeting') {
            let meetingDetails = null;

            // Step 1: Try parsing ICS attachment
            if (icsAttachment) {
                meetingDetails = parseIcsFile(icsAttachment);
            }
            const messageResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a smart assistant. Summarize this meeting invitation for WhatsApp in a short, clear format.',
                    },
                    {
                        role: 'user',
                        content: `
                            Subject: ${meetingDetails.summary}
                            Description: ${meetingDetails.description}
                            Location: ${meetingDetails.location}
                            Start: ${meetingDetails.start}
                            End: ${meetingDetails.end}
                            body: ${emailBody}
                        `,
                    },
                ],
            });
            const EmailmessageResponse = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a smart assistant. Reply to the email politely. example: Acknowled, i will be available on time.',
                    },
                    {
                        role: 'user',
                        content: `${emailBody}, ${meetingDetails}`,
                    },
                ],
            });

            const whatsappMessage = messageResponse.choices[0].message.content;
            const encodedMessage = encodeURIComponent(whatsappMessage);
            await sendWhatsApp(process.env.MY_WHATSAPP_NUMBER, encodedMessage);
            await sendReplyEmail(auth, msg.id, EmailmessageResponse.choices[0].message.content);
        } else if (classification === 'ad' || classification === 'fraud' || classification === 'social') {
            // Move email to trash
            await moveToTrash(auth, msg.id);
            console.log('Ad or fraud email moved to trash');
        } else if (classification === 'work' || classification === 'personal' || classification === 'job') {
            // Send reply email
            const replyResponse = await openai.chat.completions.create({
                model: 'gpt-4.1-nano',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a smart email assistant. Reply to the email politely.',
                    },
                    { role: 'user', content: `Subject: ${subject}\n\nBody: ${snippet}` }
                ]
            });

            const replyText = replyResponse.choices[0].message.content;
            await sendReplyEmail(auth, msg.id, replyText);
        } else {

        }
    } catch (error) {
        console.error('OpenAI API error:', error.response?.data || error.message);
    }
}
// ---------- WhatsApp Notification ----------
async function sendWhatsApp(toNumber, message) {
    console.log(message, 'message')
    const url = `https://app-server.wati.io/api/v1/sendSessionMessage/918919022059?messageText=${message}`;

    axios.post(url, null, {
        headers: {
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJhM2RlZmZmNi1kMDEwLTRhZDItODczMS1hYzQyYjRhYTA3OTIiLCJ1bmlxdWVfbmFtZSI6ImJyYWhtYW1hbnVtdWtvbmRhMDAwQGdtYWlsLmNvbSIsIm5hbWVpZCI6ImJyYWhtYW1hbnVtdWtvbmRhMDAwQGdtYWlsLmNvbSIsImVtYWlsIjoiYnJhaG1hbWFudW11a29uZGEwMDBAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMDUvMTkvMjAyNSAxMDowNDo0MSIsImRiX25hbWUiOiJ3YXRpX2FwcF90cmlhbCIsImh0dHA6Ly9zY2hlbWFzLm1pY3Jvc29mdC5jb20vd3MvMjAwOC8wNi9pZGVudGl0eS9jbGFpbXMvcm9sZSI6IlRSSUFMIiwiZXhwIjoxNzQ4MzA0MDAwLCJpc3MiOiJDbGFyZV9BSSIsImF1ZCI6IkNsYXJlX0FJIn0.w2qN3BCgaPh-tF5d2oBwZWalzoI-LQoPRHb4wvrfZg8', // Replace this with your actual token
            Accept: "*/*"
        }
    })
        .then(response => {
            console.log("✅ WhatsApp notification sent:", response.data);
        })
        .catch(error => {
            console.error("❌ Error sending WhatsApp message:", error.response?.data || error.message);
        });
}
// ---------- Move Email to Trash ----------
async function moveToTrash(auth, messageId) {
    const gmail = google.gmail({ version: 'v1', auth });
    try {
        await gmail.users.messages.trash({ userId: 'me', id: messageId });
        console.log('🗑️ Moved ad email to trash.');
    } catch (err) {
        console.error('❌ Failed to move email to trash:', err.message);
    }
}
// ---------- Send Reply Email ----------
async function sendReplyEmail(auth, messageId, replyText) {
    const gmail = google.gmail({ version: 'v1', auth });

    const message = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata' });
    const headers = message.data.payload.headers;
    const to = headers.find(h => h.name === 'From')?.value;
    const subject = headers.find(h => h.name === 'Subject')?.value;

    const raw = Buffer.from(
        `To: ${to}\r\n` +
        `Subject: Re: ${subject}\r\n` +
        `In-Reply-To: ${messageId}\r\n` +
        `References: ${messageId}\r\n\r\n` +
        replyText
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw,
            threadId: message.data.threadId
        }
    });

    console.log('✅ Auto-reply sent.');
}

// ---------- Schedule Email Check ----------
setInterval(() => {
    authorize(CREDENTIALS, async (auth) => {
        console.log('Authorized successfully');
        await listRecentUnreadEmails(auth);
    });

}, 2 * 60 * 1000); // every 2 minutes


app.listen(3000, () => console.log('✅ Server running on port 3000'));