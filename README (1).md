# CareConnect: real family notifications and acknowledgement-based escalation

## Run it
```
npm install          # installs web-push (phone notifications). Optional: without it, everything else still works
node server.js       # open http://localhost:3000 on any phone or laptop that can reach this machine
```
Open the same address on two devices, log in as the elder on one and as family on the other. Messages, check-ins and alerts now appear on both.

## Settings (environment variables)
| Variable | What it does |
|---|---|
| `PUBLIC_URL` | The public address of your server. It goes into the acknowledge link inside SMS messages, e.g. `https://care.example.com` |
| `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Turns on real SMS through Twilio |
| `SMS_WEBHOOK_URL` | Alternative: the server POSTs `{to, body}` as JSON to this address (use it to plug in MSG91 or any provider) |
| `ADMIN_PHONE` | The admin gets an SMS for every urgent alert |
| `VAPID_PUBLIC`, `VAPID_PRIVATE` | Keep your own push keys (otherwise they are generated and saved in `data/db.json`) |
| `TZ` | Defaults to `Asia/Kolkata`. Check-in times are read in this time zone |
| `CI_GRACE_MIN` | Minutes after the check-in time before a missed check-in becomes an alert (default 30) |
| `ALLOW_RESET=1` | Lets the admin's "Reset demo data" button wipe the server data |

Phone push needs HTTPS (or `localhost`). Put the server behind any HTTPS host.

## How escalation works
1. SOS pressed, or a daily check-in missed, starts an alert **on the server**, so it keeps going even if the elder's phone is off.
2. The **first emergency contact** is alerted (push if they have an account, SMS with an acknowledge link if they have a phone). Order = the order of the elder's Trusted people list.
3. Family accounts and the admin also get an immediate update, but the alert only moves on by the timer.
4. If nobody acknowledges within **N seconds** (admin sets N, default 60), the next contact is alerted. After the contacts: free volunteers, then the admin, then "Admin to call 108 / 112".
5. It stops **only** when someone acknowledges: a family member or volunteer taps **I'm responding**, the admin taps it, or a contact without an account taps the link in their SMS.
6. The alert card, the elder's history and the family dashboard show **who acknowledged and at what time**.

## Known limits (be aware before real use)
- **No login security on the API yet.** Anyone who can reach the server can read and change data. Add real authentication before real elders use it. The same applies to passwords, which are still stored in the shared demo data.
- The door OTP code is still stored in the shared data (the SMS is real, but the code is also readable in the app's data). Move OTP creation and checking to the server before real use.
- Trusted people are one shared list in the demo data. Each person added now records which elder they belong to, but the list screen still shows everyone's.
- The push and SMS sending code was tested against mock services, not against real Twilio or a real browser push service. Test with your own account and a real phone first.
- Opening `public/index.html` directly as a file still works as the old offline demo (no sync, no background alerts).
